/**
 * Discover Grok models:
 *  1. Grok CLI proxy catalog (reasoning_efforts) — primary metadata
 *  2. api.x.ai/v1/models — broader list
 *  3. ~/.grok/models_cache.json
 *
 * Max output is auto-resolved from catalog (when trustworthy) or context.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	catalogMaxOutput,
	resolveMaxOutputTokens,
} from './token-limits.js';

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   contextWindow: number,
 *   maxTokens: number,
 *   maxSource?: string,
 *   thinkingLevels: string[],
 *   defaultThinking?: string,
 *   supportsThinking: boolean,
 *   toolCalling: boolean,
 * }} GrokModel
 */

/**
 * @param {object} raw
 * @param {number} defaultMaxTokens
 * @returns {GrokModel | null}
 */
function normalize(raw, defaultMaxTokens) {
	const id = raw.id || raw.model;
	if (!id || typeof id !== 'string') return null;

	const ctx =
		(typeof raw.context_window === 'number' && raw.context_window) ||
		(typeof raw.context_length === 'number' && raw.context_length) ||
		256_000;

	const { maxTokens, maxSource } = resolveMaxOutputTokens({
		contextWindow: ctx,
		catalogMax: catalogMaxOutput(raw),
		settingMax:
			typeof defaultMaxTokens === 'number' && defaultMaxTokens > 0
				? defaultMaxTokens
				: undefined,
	});

	/** @type {string[]} */
	let levels = [];
	let defaultThinking;
	// Only expose effort when the catalog explicitly lists values or the flag.
	// Do NOT invent levels from the model id name — e.g. "grok-*-reasoning"
	// models often reject the reasoning_effort parameter on api.x.ai.
	if (Array.isArray(raw.reasoning_efforts) && raw.reasoning_efforts.length) {
		for (const e of raw.reasoning_efforts) {
			const v = typeof e === 'string' ? e : e?.value || e?.id;
			if (typeof v === 'string') levels.push(v);
			if (e?.default && typeof v === 'string') defaultThinking = v;
		}
	} else if (raw.supports_reasoning_effort === true) {
		// Explicit flag but no enum — safe default ladder (Grok CLI uses these)
		levels = ['low', 'medium', 'high'];
		defaultThinking =
			typeof raw.reasoning_effort === 'string' ? raw.reasoning_effort : 'low';
	}

	if (/non-reasoning/i.test(id)) {
		levels = [];
		defaultThinking = undefined;
	}

	return {
		id,
		name: raw.name || raw.display_name || id,
		contextWindow: ctx,
		maxTokens,
		maxSource,
		thinkingLevels: levels,
		defaultThinking: defaultThinking || levels[0],
		supportsThinking: levels.length > 0,
		toolCalling: true,
	};
}

function isChatModel(id, excludeImage) {
	if (!id) return false;
	if (excludeImage && /imagine|image|video|tts|voice|embedding/i.test(id)) return false;
	return true;
}

/**
 * @param {{
 *   access: string,
 *   apiBaseUrl?: string,
 *   modelsProxyUrl?: string,
 *   excludeImageModels?: boolean,
 *   defaultMaxTokens?: number,
 *   signal?: AbortSignal,
 *   fetchFn?: typeof fetch,
 * }} opts
 * @returns {Promise<GrokModel[]>}
 */
export async function discoverModels(opts) {
	const {
		access,
		apiBaseUrl = 'https://api.x.ai/v1',
		modelsProxyUrl = 'https://cli-chat-proxy.grok.com/v1/models',
		excludeImageModels = true,
		defaultMaxTokens = 0,
		signal,
		fetchFn = fetch,
	} = opts;

	/** @type {Map<string, GrokModel>} */
	const byId = new Map();

	const headers = {
		Authorization: `Bearer ${access}`,
		Accept: 'application/json',
		'User-Agent': 'vscode-grok-provider',
	};

	// 1) Grok CLI proxy (rich reasoning metadata)
	try {
		const res = await fetchFn(modelsProxyUrl, { headers, signal });
		if (res.ok) {
			const data = await res.json();
			for (const m of data.data || []) {
				const n = normalize(m, defaultMaxTokens);
				if (n && isChatModel(n.id, excludeImageModels)) byId.set(n.id, n);
			}
		}
	} catch {
		/* ignore */
	}

	// 2) api.x.ai
	try {
		const res = await fetchFn(`${apiBaseUrl.replace(/\/+$/, '')}/models`, {
			headers,
			signal,
		});
		if (res.ok) {
			const data = await res.json();
			for (const m of data.data || []) {
				const n = normalize(m, defaultMaxTokens);
				if (!n || !isChatModel(n.id, excludeImageModels)) continue;
				const prev = byId.get(n.id);
				if (!prev) {
					byId.set(n.id, n);
				} else {
					// merge: keep proxy thinking levels if richer
					if (!prev.thinkingLevels.length && n.thinkingLevels.length) {
						prev.thinkingLevels = n.thinkingLevels;
						prev.supportsThinking = true;
						prev.defaultThinking = n.defaultThinking;
					}
					if (n.contextWindow > prev.contextWindow) prev.contextWindow = n.contextWindow;
				}
			}
		}
	} catch {
		/* ignore */
	}

	// 3) Grok CLI disk cache
	if (byId.size === 0) {
		const cachePath = path.join(os.homedir(), '.grok', 'models_cache.json');
		if (fs.existsSync(cachePath)) {
			try {
				const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
				const models = cache.models || {};
				for (const [id, wrap] of Object.entries(models)) {
					const info = wrap?.info || wrap;
					const n = normalize({ ...info, id: info.id || id }, defaultMaxTokens);
					if (n && isChatModel(n.id, excludeImageModels)) byId.set(n.id, n);
				}
			} catch {
				/* ignore */
			}
		}
	}

	// Static fallback
	if (byId.size === 0) {
		for (const m of [
			{
				id: 'grok-4.5',
				name: 'Grok 4.5',
				context_window: 500000,
				supports_reasoning_effort: true,
				reasoning_efforts: [
					{ value: 'high', default: true },
					{ value: 'medium' },
					{ value: 'low' },
				],
			},
			// No invented efforts — only when live catalog says so
			{ id: 'grok-4.3', name: 'Grok 4.3', context_window: 1000000 },
		]) {
			const n = normalize(m, defaultMaxTokens);
			if (n) byId.set(n.id, n);
		}
	}

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
