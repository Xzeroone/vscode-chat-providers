/**
 * Ollama Cloud HTTP client: model discovery + streaming chat completions.
 * Cloud only — https://ollama.com (OpenAI-compatible /v1).
 * No vscode dependency (safe for Node smoke tests).
 *
 * Discovery stack:
 *  1. Live /v1/models + /api/show  (ids, caps, context_length)
 *  2. models.dev ollama-cloud       (max output, reasoning_options)
 *  3. Derived fallbacks             (max out from context if still unknown)
 */

import {
	fetchOllamaCloudRegistry,
	lookupRegistryModel,
	resolveTokenLimits,
} from './registry.js';

export const DEFAULT_BASE_URL = 'https://ollama.com';
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_CONTEXT = 128_000;

/** @type {((...args: unknown[]) => void) | undefined} */
let _debug;

/** Optional logger hook (extension sets this to the OutputChannel debug). */
export function setClientDebug(fn) {
	_debug = typeof fn === 'function' ? fn : undefined;
}

function debug(...args) {
	_debug?.(...args);
}

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   contextWindow: number,
 *   maxTokens: number,
 *   toolCalling: boolean,
 *   imageInput: boolean,
 *   thinking: boolean,
 *   thinkingLevels?: string[],
 *   thinkingLevelMap?: Record<string, { reasoning_effort?: string, think?: boolean } | null>,
 *   meta?: { maxSource?: string, contextSource?: string, thinkingSource?: string },
 * }} CloudModel
 */

/**
 * @param {string} [baseUrl]
 */
export function normalizeBaseUrl(baseUrl) {
	const raw = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
	return raw || DEFAULT_BASE_URL;
}

/**
 * @param {string} baseUrl
 */
export function apiBase(baseUrl) {
	return `${normalizeBaseUrl(baseUrl)}/v1`;
}

/**
 * @param {Record<string, unknown> | undefined} modelInfo
 * @returns {number | undefined}
 */
function contextLengthFromInfo(modelInfo) {
	if (!modelInfo || typeof modelInfo !== 'object') return undefined;
	for (const [key, value] of Object.entries(modelInfo)) {
		if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
			return value;
		}
	}
	return undefined;
}

/**
 * List models from Ollama Cloud and enrich with /api/show + models.dev.
 *
 * @param {{
 *   apiKey: string,
 *   baseUrl?: string,
 *   toolsOnly?: boolean,
 *   defaultMaxTokens?: number | null,
 *   useRegistry?: boolean,
 *   resolveThinking?: (
 *     id: string,
 *     thinking: boolean,
 *     reasoningOptions?: Array<{ type?: string, values?: string[] }>,
 *   ) => { levels: string[], levelMap: Record<string, unknown>, source?: string } | null,
 *   signal?: AbortSignal,
 *   fetchFn?: typeof fetch,
 * }} opts
 * @returns {Promise<CloudModel[]>}
 */
export async function discoverModels(opts) {
	const {
		apiKey,
		baseUrl = DEFAULT_BASE_URL,
		toolsOnly = true,
		defaultMaxTokens = null,
		useRegistry = true,
		resolveThinking,
		signal,
		fetchFn = fetch,
	} = opts;

	const root = normalizeBaseUrl(baseUrl);
	const auth = { Authorization: `Bearer ${apiKey}` };

	const listRes = await fetchFn(`${root}/v1/models`, {
		headers: auth,
		signal,
	});
	if (!listRes.ok) {
		const body = await listRes.text().catch(() => '');
		throw new Error(
			`Ollama Cloud /v1/models failed: HTTP ${listRes.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
		);
	}

	/** @type {{ data?: Array<{ id?: string }> }} */
	const list = await listRes.json();
	const ids = (list.data ?? [])
		.map((m) => m.id)
		.filter((id) => typeof id === 'string' && id.length > 0);

	debug(`[discover] /v1/models returned ${ids.length} ids`);

	/** @type {Map<string, import('./registry.js').RegistryModel>} */
	let registry = new Map();
	if (useRegistry) {
		registry = await fetchOllamaCloudRegistry({ signal, fetchFn });
		debug(`[discover] models.dev registry entries: ${registry.size}`);
	}

	/** @type {CloudModel[]} */
	const models = [];

	await Promise.all(
		ids.map(async (id) => {
			try {
				const reg = lookupRegistryModel(registry, id);
				const showRes = await fetchFn(`${root}/api/show`, {
					method: 'POST',
					headers: { ...auth, 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: id }),
					signal,
				});

				if (!showRes.ok) {
					if (!toolsOnly) {
						const limits = resolveTokenLimits({
							registry: reg,
							defaultMaxTokens:
								typeof defaultMaxTokens === 'number' ? defaultMaxTokens : undefined,
						});
						models.push({
							id,
							name: reg?.name || id,
							contextWindow: limits.contextWindow,
							maxTokens: limits.maxTokens,
							toolCalling: reg?.toolCall ?? false,
							imageInput: reg?.imageInput ?? false,
							thinking: reg?.reasoning ?? false,
							meta: {
								maxSource: limits.maxSource,
								contextSource: limits.contextSource,
							},
						});
					}
					return;
				}

				/** @type {{
				 *   capabilities?: string[],
				 *   model_info?: Record<string, unknown>,
				 *   details?: { family?: string },
				 * }} */
				const show = await showRes.json();
				const caps = show.capabilities ?? [];
				// Live /api/show is authoritative for tool filter
				if (toolsOnly && !caps.includes('tools')) {
					return;
				}

				const thinking = caps.includes('thinking');
				const liveContext = contextLengthFromInfo(show.model_info);
				const limits = resolveTokenLimits({
					liveContext,
					registry: reg,
					// Only use setting as last-resort override when > 0; null = fully auto
					defaultMaxTokens:
						typeof defaultMaxTokens === 'number' && defaultMaxTokens > 0
							? defaultMaxTokens
							: undefined,
				});

				// Prefer live vision; registry can fill if show omits (rare)
				const imageInput = caps.includes('vision') || reg?.imageInput === true;

				/** @type {CloudModel} */
				const entry = {
					id,
					name: reg?.name || id,
					contextWindow: limits.contextWindow,
					maxTokens: limits.maxTokens,
					toolCalling: caps.includes('tools'),
					imageInput,
					thinking,
					meta: {
						maxSource: limits.maxSource,
						contextSource: limits.contextSource,
					},
				};

				if (typeof resolveThinking === 'function') {
					const t = resolveThinking(id, thinking, reg?.reasoningOptions);
					if (t?.levels?.length) {
						entry.thinkingLevels = t.levels;
						entry.thinkingLevelMap = /** @type {CloudModel['thinkingLevelMap']} */ (
							t.levelMap
						);
						entry.meta.thinkingSource = t.source || 'heuristic';
					}
				}

				models.push(entry);
			} catch (err) {
				debug(`[discover] skip ${id}:`, err instanceof Error ? err.message : String(err));
			}
		}),
	);

	models.sort((a, b) => a.id.localeCompare(b.id));
	debug(
		`[discover] enriched ${models.length} models (toolsOnly=${toolsOnly})`,
		models.slice(0, 3).map((m) => ({
			id: m.id,
			ctx: m.contextWindow,
			max: m.maxTokens,
			maxSrc: m.meta?.maxSource,
			think: m.thinkingLevels,
			thinkSrc: m.meta?.thinkingSource,
		})),
	);
	return models;
}

/**
 * Stream OpenAI-compatible chat completions.
 *
 * @param {{
 *   apiKey: string,
 *   baseUrl?: string,
 *   model: string,
 *   messages: object[],
 *   tools?: object[],
 *   toolChoice?: string | object,
 *   maxTokens?: number,
 *   reasoningEffort?: string,
 *   think?: boolean,
 *   signal?: AbortSignal,
 *   fetchFn?: typeof fetch,
 *   onText: (delta: string) => void,
 *   onReasoning?: (delta: string) => void,
 *   onToolCallDelta?: (delta: { index: number, id?: string, name?: string, arguments?: string }) => void,
 * }} opts
 * @returns {Promise<{ finishReason: string | undefined }>}
 */
export async function streamChatCompletions(opts) {
	const {
		apiKey,
		baseUrl = DEFAULT_BASE_URL,
		model,
		messages,
		tools,
		toolChoice,
		maxTokens = DEFAULT_MAX_TOKENS,
		reasoningEffort,
		think,
		signal,
		fetchFn = fetch,
		onText,
		onReasoning,
		onToolCallDelta,
	} = opts;

	const url = `${apiBase(baseUrl)}/chat/completions`;
	/** @type {Record<string, unknown>} */
	const body = {
		model,
		messages,
		stream: true,
		max_tokens: maxTokens,
	};
	if (tools?.length) {
		body.tools = tools;
		body.tool_choice = toolChoice ?? 'auto';
	}
	// Ollama Cloud accepts both; family-specific maps set the useful combo.
	if (typeof reasoningEffort === 'string' && reasoningEffort.length) {
		body.reasoning_effort = reasoningEffort;
	}
	if (typeof think === 'boolean') {
		body.think = think;
	}

	debug('[chat] POST', url, {
		model,
		messageCount: messages.length,
		tools: tools?.length ?? 0,
		reasoning_effort: body.reasoning_effort,
		think: body.think,
	});

	const res = await fetchFn(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw new Error(
			`Ollama Cloud chat failed: HTTP ${res.status}${errText ? ` — ${errText.slice(0, 400)}` : ''}`,
		);
	}

	if (!res.body) {
		throw new Error('Ollama Cloud chat response had no body');
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	/** @type {string | undefined} */
	let finishReason;

	while (true) {
		if (signal?.aborted) {
			try {
				await reader.cancel();
			} catch {
				/* ignore */
			}
			throw new Error('cancelled');
		}

		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const rawLine of lines) {
			const line = rawLine.trim();
			if (!line || line.startsWith(':')) continue;
			if (!line.startsWith('data:')) continue;

			const data = line.slice(5).trim();
			if (data === '[DONE]') {
				return { finishReason };
			}

			let parsed;
			try {
				parsed = JSON.parse(data);
			} catch {
				debug('[chat] skip non-JSON SSE line');
				continue;
			}

			const choice = parsed?.choices?.[0];
			if (!choice) continue;

			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
			}

			const delta = choice.delta ?? {};
			if (typeof delta.content === 'string' && delta.content.length) {
				onText(delta.content);
			}
			// Reasoning / chain-of-thought (separate field on Ollama Cloud)
			const reasoningDelta =
				(typeof delta.reasoning === 'string' && delta.reasoning) ||
				(typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
				'';
			if (reasoningDelta && onReasoning) {
				onReasoning(reasoningDelta);
			}

			if (Array.isArray(delta.tool_calls) && onToolCallDelta) {
				for (const tc of delta.tool_calls) {
					onToolCallDelta({
						index: typeof tc.index === 'number' ? tc.index : 0,
						id: typeof tc.id === 'string' ? tc.id : undefined,
						name: typeof tc.function?.name === 'string' ? tc.function.name : undefined,
						arguments:
							typeof tc.function?.arguments === 'string' ? tc.function.arguments : undefined,
					});
				}
			}
		}
	}

	return { finishReason };
}
