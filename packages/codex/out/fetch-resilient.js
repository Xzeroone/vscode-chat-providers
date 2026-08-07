/**
 * Resilient fetch for long agent runs.
 * Retries transient network failures and gateway errors on the *initial*
 * response only (never mid-stream body reads).
 */

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * @param {unknown} err
 * @returns {string}
 */
export function formatFetchError(err) {
	if (!(err instanceof Error)) return String(err);
	const parts = [err.message || 'fetch failed'];
	/** @type {unknown} */
	let c = /** @type {{ cause?: unknown }} */ (err).cause;
	let depth = 0;
	while (c && depth < 4) {
		if (c instanceof Error) {
			const code = /** @type {{ code?: string }} */ (c).code;
			parts.push(code ? `${code}: ${c.message}` : c.message);
			c = /** @type {{ cause?: unknown }} */ (c).cause;
		} else if (typeof c === 'object' && c && 'code' in c) {
			parts.push(String(/** @type {{ code: unknown }} */ (c).code));
			break;
		} else {
			parts.push(String(c));
			break;
		}
		depth++;
	}
	return parts.filter(Boolean).join(' · ');
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientFetchError(err) {
	if (!err) return false;
	if (err instanceof Error && /aborted|cancelled/i.test(err.message)) return false;
	const msg = formatFetchError(err).toLowerCase();
	if (msg.includes('fetch failed')) return true;
	if (msg.includes('econnreset') || msg.includes('econnrefused')) return true;
	if (msg.includes('etimedout') || msg.includes('enotfound')) return true;
	if (msg.includes('socket') || msg.includes('network')) return true;
	if (msg.includes('und_err') || msg.includes('other side closed')) return true;
	return false;
}

/**
 * @param {number} status
 */
export function isTransientHttpStatus(status) {
	return TRANSIENT_STATUS.has(status);
}

/**
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {RequestInit} init
 * @param {{
 *   retries?: number,
 *   baseDelayMs?: number,
 *   signal?: AbortSignal,
 *   debug?: (...args: unknown[]) => void,
 *   label?: string,
 * }} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(fetchFn, url, init, opts = {}) {
	const retries = opts.retries ?? 3;
	const baseDelayMs = opts.baseDelayMs ?? 500;
	const signal = opts.signal ?? init.signal ?? undefined;
	const debug = opts.debug;
	const label = opts.label || 'fetch';

	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (signal?.aborted) {
			throw new Error('cancelled');
		}
		try {
			const res = await fetchFn(url, { ...init, signal });
			// Retry only before consuming body — safe for POST chat if no stream started.
			if (
				attempt < retries &&
				isTransientHttpStatus(res.status) &&
				!res.bodyUsed
			) {
				debug?.(
					`[${label}] HTTP ${res.status} — retry ${attempt + 1}/${retries}`,
				);
				// Drain/cancel body so connection can close cleanly
				try {
					await res.body?.cancel();
				} catch {
					/* ignore */
				}
				await sleep(baseDelayMs * 2 ** attempt, signal);
				continue;
			}
			return res;
		} catch (err) {
			lastErr = err;
			if (signal?.aborted) throw new Error('cancelled');
			if (attempt >= retries || !isTransientFetchError(err)) {
				throw new Error(formatFetchError(err));
			}
			debug?.(
				`[${label}] ${formatFetchError(err)} — retry ${attempt + 1}/${retries}`,
			);
			await sleep(baseDelayMs * 2 ** attempt, signal);
		}
	}
	throw new Error(formatFetchError(lastErr));
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('cancelled'));
			return;
		}
		const t = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new Error('cancelled'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
