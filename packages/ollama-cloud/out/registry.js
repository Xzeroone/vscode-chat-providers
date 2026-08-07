/**
 * Optional enrichment from models.dev (ollama-cloud provider catalog).
 * Live Ollama Cloud API remains the source of truth for which models exist;
 * this registry fills gaps the API does not expose (max output tokens,
 * structured reasoning_options).
 *
 * No vscode dependency.
 */

const MODELS_DEV_URL = 'https://models.dev/api.json';
const PROVIDER_ID = 'ollama-cloud';

/** @type {{ at: number, byId: Map<string, RegistryModel> } | null} */
let cache = null;

/**
 * @typedef {{
 *   id: string,
 *   name?: string,
 *   context?: number,
 *   maxOutput?: number,
 *   reasoning?: boolean,
 *   toolCall?: boolean,
 *   imageInput?: boolean,
 *   reasoningOptions?: Array<{ type?: string, values?: string[] }>,
 * }} RegistryModel
 */

/**
 * @param {{
 *   ttlMs?: number,
 *   signal?: AbortSignal,
 *   fetchFn?: typeof fetch,
 *   force?: boolean,
 * }} [opts]
 * @returns {Promise<Map<string, RegistryModel>>}
 */
export async function fetchOllamaCloudRegistry(opts = {}) {
	const {
		ttlMs = 60 * 60_000,
		signal,
		fetchFn = fetch,
		force = false,
	} = opts;

	if (!force && cache && Date.now() - cache.at < ttlMs) {
		return cache.byId;
	}

	try {
		const res = await fetchFn(MODELS_DEV_URL, {
			signal,
			headers: { Accept: 'application/json' },
		});
		if (!res.ok) {
			return cache?.byId ?? new Map();
		}
		const data = await res.json();
		const provider = data?.[PROVIDER_ID];
		const models = provider?.models;
		if (!models || typeof models !== 'object') {
			return cache?.byId ?? new Map();
		}

		/** @type {Map<string, RegistryModel>} */
		const byId = new Map();
		for (const [id, raw] of Object.entries(models)) {
			if (!raw || typeof raw !== 'object') continue;
			const limit = raw.limit && typeof raw.limit === 'object' ? raw.limit : {};
			const modalities = raw.modalities && typeof raw.modalities === 'object' ? raw.modalities : {};
			const input = Array.isArray(modalities.input) ? modalities.input : [];
			byId.set(id, {
				id,
				name: typeof raw.name === 'string' ? raw.name : id,
				context: positiveInt(limit.context),
				maxOutput: positiveInt(limit.output),
				reasoning: raw.reasoning === true,
				toolCall: raw.tool_call === true,
				imageInput: input.includes('image'),
				reasoningOptions: Array.isArray(raw.reasoning_options)
					? raw.reasoning_options
					: undefined,
			});
		}

		cache = { at: Date.now(), byId };
		return byId;
	} catch {
		return cache?.byId ?? new Map();
	}
}

/**
 * Lookup with light id normalization (strip tags, try base id).
 * @param {Map<string, RegistryModel>} byId
 * @param {string} id
 * @returns {RegistryModel | undefined}
 */
export function lookupRegistryModel(byId, id) {
	if (!byId?.size || !id) return undefined;
	if (byId.has(id)) return byId.get(id);
	// deepseek-v4-flash:0731 → also try deepseek-v4-flash
	const base = id.split(':')[0];
	if (base && byId.has(base)) return byId.get(base);
	// reverse: registry has tagged, live has untagged
	for (const [k, v] of byId) {
		if (k.split(':')[0] === id || k.split(':')[0] === base) return v;
	}
	return undefined;
}

/**
 * @param {unknown} n
 * @returns {number | undefined}
 */
function positiveInt(n) {
	if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
		return Math.floor(n);
	}
	return undefined;
}

/**
 * Ollama Cloud hard-rejects max_tokens above this on several models
 * (e.g. deepseek-v4-flash: "maximum output tokens (65536)").
 * models.dev often lists limit.output == context (1M) which is not the API cap.
 */
export const OLLAMA_CLOUD_MAX_OUTPUT_TOKENS = 65_536;

/**
 * Derive a practical max output when neither API nor registry has a trustworthy one.
 * Prefer a slice of context, with sane floor/ceiling for Chat budgeting.
 *
 * @param {number} contextWindow
 * @returns {number}
 */
export function deriveMaxOutputTokens(contextWindow) {
	const ctx = Math.max(4096, contextWindow || 128_000);
	// ~25% of context, never below 8k, never above Ollama Cloud's hard output cap
	const raw = Math.floor(ctx * 0.25);
	return clamp(raw, 8_192, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS);
}

/**
 * models.dev sometimes copies context into limit.output (e.g. 1M/1M). That is
 * not a real completion budget and must not be sent as max_tokens.
 *
 * @param {number | undefined} regOut
 * @param {number} contextWindow
 * @returns {number | undefined}
 */
export function trustworthyRegistryOutput(regOut, contextWindow) {
	if (typeof regOut !== 'number' || !(regOut > 0)) return undefined;
	// Equal/near-equal to context → catalog placeholder, ignore
	if (contextWindow > 0 && regOut >= contextWindow * 0.5) return undefined;
	// Above known API hard cap → not usable as-is
	if (regOut > OLLAMA_CLOUD_MAX_OUTPUT_TOKENS) return undefined;
	return Math.floor(regOut);
}

/**
 * Resolve final context + max output from live show + registry + derivation.
 *
 * @param {{
 *   liveContext?: number,
 *   registry?: RegistryModel,
 *   defaultMaxTokens?: number,
 * }} p
 */
export function resolveTokenLimits(p) {
	const regCtx = p.registry?.context;
	const liveCtx = p.liveContext;

	const contextWindow = liveCtx || regCtx || 128_000;

	const regOut = trustworthyRegistryOutput(p.registry?.maxOutput, contextWindow);
	const settingOut =
		typeof p.defaultMaxTokens === 'number' && p.defaultMaxTokens > 0
			? Math.min(p.defaultMaxTokens, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS)
			: undefined;

	let maxTokens = regOut || settingOut || deriveMaxOutputTokens(contextWindow);

	// Output cannot exceed context; leave room for at least a small prompt.
	const maxFit = Math.max(1024, contextWindow - 1024);
	maxTokens = Math.min(maxTokens, maxFit, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS);

	// If still equal to almost whole context, shrink to a practical share.
	if (maxTokens >= contextWindow * 0.9) {
		maxTokens = deriveMaxOutputTokens(contextWindow);
	}

	return {
		contextWindow,
		maxTokens: Math.max(1024, Math.floor(maxTokens)),
		maxSource: regOut
			? 'models.dev'
			: settingOut
				? 'setting'
				: 'derived',
		contextSource: liveCtx ? 'api/show' : regCtx ? 'models.dev' : 'default',
	};
}

function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}
