/**
 * Discover Codex models: live API → ~/.codex/models_cache.json → static fallback.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_CLIENT_VERSION = '0.146.0';
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   contextWindow: number,
 *   maxTokens: number,
 *   thinkingLevels: string[],
 *   defaultThinking: string,
 *   imageInput: boolean,
 *   toolCalling: boolean,
 *   visibility?: string,
 * }} CodexModel
 */

/**
 * @param {string} [override]
 */
export function resolveClientVersion(override) {
	if (override && override.trim()) return override.trim();
	try {
		const p = path.join(os.homedir(), '.codex', 'version.json');
		if (fs.existsSync(p)) {
			const v = JSON.parse(fs.readFileSync(p, 'utf8'));
			// installed CLI version is often elsewhere; latest_version is ok for API
			if (typeof v.latest_version === 'string' && v.latest_version) {
				return v.latest_version;
			}
		}
	} catch {
		/* ignore */
	}
	// try package version of codex if present
	try {
		const pkg = path.join(
			os.homedir(),
			'.npm-global/lib/node_modules/@openai/codex/package.json',
		);
		if (fs.existsSync(pkg)) {
			const v = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
			if (v) return v;
		}
	} catch {
		/* ignore */
	}
	return DEFAULT_CLIENT_VERSION;
}

/**
 * @param {object} raw
 * @param {number} defaultMaxTokens  0 = derive
 * @returns {CodexModel | null}
 */
function normalizeModel(raw, defaultMaxTokens) {
	const id = raw.slug || raw.id;
	if (!id || typeof id !== 'string') return null;

	const levels = (raw.supported_reasoning_levels || [])
		.map((x) => (typeof x === 'string' ? x : x?.effort))
		.filter((x) => typeof x === 'string' && x.length > 0);

	const ctx =
		(typeof raw.context_window === 'number' && raw.context_window) ||
		(typeof raw.max_context_window === 'number' && raw.max_context_window) ||
		272_000;

	let maxTokens =
		typeof defaultMaxTokens === 'number' && defaultMaxTokens > 0
			? defaultMaxTokens
			: Math.min(65_536, Math.max(8_192, Math.floor(ctx * 0.2)));

	const modalities = raw.input_modalities || [];
	const imageInput = Array.isArray(modalities)
		? modalities.includes('image')
		: false;

	const defaultThinking =
		(typeof raw.default_reasoning_level === 'string' && raw.default_reasoning_level) ||
		levels[0] ||
		'low';

	return {
		id,
		name: raw.display_name || raw.title || id,
		contextWindow: ctx,
		maxTokens,
		thinkingLevels: levels.length ? levels : ['low', 'medium', 'high'],
		defaultThinking,
		imageInput,
		toolCalling: raw.supports_parallel_tool_calls !== false,
		visibility: raw.visibility,
	};
}

/**
 * @param {{
 *   access: string,
 *   accountId: string,
 *   clientVersion?: string,
 *   hideHidden?: boolean,
 *   defaultMaxTokens?: number,
 *   signal?: AbortSignal,
 *   fetchFn?: typeof fetch,
 * }} opts
 * @returns {Promise<CodexModel[]>}
 */
export async function discoverModels(opts) {
	const {
		access,
		accountId,
		clientVersion,
		hideHidden = true,
		defaultMaxTokens = 0,
		signal,
		fetchFn = fetch,
	} = opts;

	const cv = resolveClientVersion(clientVersion);
	const url = `${MODELS_URL}?client_version=${encodeURIComponent(cv)}`;

	try {
		const res = await fetchFn(url, {
			headers: {
				Authorization: `Bearer ${access}`,
				'chatgpt-account-id': accountId,
				'User-Agent': `vscode-codex-provider (${os.platform()})`,
				originator: 'vscode-codex-provider',
			},
			signal,
		});
		if (res.ok) {
			const data = await res.json();
			const list = Array.isArray(data?.models) ? data.models : [];
			return finalize(
				list.map((m) => normalizeModel(m, defaultMaxTokens)).filter(Boolean),
				hideHidden,
			);
		}
	} catch {
		/* fall through to cache */
	}

	// Disk cache from Codex CLI
	const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
	if (fs.existsSync(cachePath)) {
		try {
			const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
			const list = Array.isArray(cache?.models) ? cache.models : [];
			const models = finalize(
				list.map((m) => normalizeModel(m, defaultMaxTokens)).filter(Boolean),
				hideHidden,
			);
			if (models.length) return models;
		} catch {
			/* ignore */
		}
	}

	// Static minimal fallback
	return finalize(
		[
			normalizeModel(
				{
					slug: 'gpt-5.6-luna',
					display_name: 'GPT-5.6-Luna',
					context_window: 272000,
					default_reasoning_level: 'medium',
					supported_reasoning_levels: [
						{ effort: 'low' },
						{ effort: 'medium' },
						{ effort: 'high' },
						{ effort: 'xhigh' },
						{ effort: 'max' },
					],
					input_modalities: ['text', 'image'],
					supports_parallel_tool_calls: true,
					visibility: 'list',
				},
				defaultMaxTokens,
			),
			normalizeModel(
				{
					slug: 'gpt-5.6-sol',
					display_name: 'GPT-5.6-Sol',
					context_window: 272000,
					default_reasoning_level: 'low',
					supported_reasoning_levels: [
						{ effort: 'low' },
						{ effort: 'medium' },
						{ effort: 'high' },
						{ effort: 'xhigh' },
						{ effort: 'max' },
						{ effort: 'ultra' },
					],
					input_modalities: ['text', 'image'],
					supports_parallel_tool_calls: true,
					visibility: 'list',
				},
				defaultMaxTokens,
			),
		].filter(Boolean),
		hideHidden,
	);
}

/**
 * @param {CodexModel[]} models
 * @param {boolean} hideHidden
 */
function finalize(models, hideHidden) {
	let out = models.filter((m) => m && m.id);
	if (hideHidden) {
		out = out.filter((m) => m.visibility !== 'hide');
	}
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}
