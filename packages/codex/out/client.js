/**
 * Codex Responses API client (ChatGPT backend SSE).
 * No vscode dependency.
 */
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

const DEFAULT_BASE = 'https://chatgpt.com/backend-api';

/** @type {((...args: unknown[]) => void) | undefined} */
let _debug;
export function setClientDebug(fn) {
	_debug = typeof fn === 'function' ? fn : undefined;
}
function debug(...args) {
	_debug?.(...args);
}

/**
 * @param {{
 *   access: string,
 *   accountId: string,
 *   model: string,
 *   instructions?: string,
 *   input: object[],
 *   tools?: object[],
 *   toolChoice?: string,
 *   reasoningEffort?: string,
 *   maxTokens?: number,
 *   signal?: AbortSignal,
 *   fetchFn?: typeof fetch,
 *   onText: (delta: string) => void,
 *   onToolCall?: (tc: { callId: string, name: string, arguments: string }) => void,
 * }} opts
 */
export async function streamCodexResponse(opts) {
	const {
		access,
		accountId,
		model,
		instructions = 'You are a helpful coding assistant.',
		input,
		tools,
		toolChoice,
		reasoningEffort = 'low',
		maxTokens,
		signal,
		fetchFn = fetch,
		onText,
		onToolCall,
	} = opts;

	const url = `${DEFAULT_BASE}/codex/responses`;
	const sessionId = randomUUID();

	/** @type {Record<string, unknown>} */
	const body = {
		model,
		store: false,
		stream: true,
		instructions,
		input,
		text: { verbosity: 'low' },
		include: ['reasoning.encrypted_content'],
		prompt_cache_key: sessionId,
		parallel_tool_calls: true,
	};

	if (tools?.length) {
		body.tools = tools;
		body.tool_choice = toolChoice ?? 'auto';
	}

	if (reasoningEffort) {
		body.reasoning = {
			effort: reasoningEffort,
			summary: 'auto',
		};
	}

	if (typeof maxTokens === 'number' && maxTokens > 0) {
		body.max_output_tokens = maxTokens;
	}

	debug('[codex] POST', url, {
		model,
		inputItems: input.length,
		tools: tools?.length ?? 0,
		effort: reasoningEffort,
	});

	const res = await fetchFn(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${access}`,
			'chatgpt-account-id': accountId,
			'OpenAI-Beta': 'responses=experimental',
			accept: 'text/event-stream',
			'content-type': 'application/json',
			originator: 'vscode-codex-provider',
			'User-Agent': `vscode-codex-provider (${os.platform()} ${os.release()})`,
			'session-id': sessionId,
			'x-client-request-id': sessionId,
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw new Error(
			`Codex chat failed: HTTP ${res.status}${errText ? ` — ${errText.slice(0, 400)}` : ''}`,
		);
	}
	if (!res.body) throw new Error('Codex response had no body');

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	/** @type {Map<string, { callId?: string, name?: string, arguments: string }>} */
	const toolByItem = new Map();

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
		const chunks = buffer.split('\n\n');
		buffer = chunks.pop() ?? '';

		for (const chunk of chunks) {
			let dataLine = '';
			for (const line of chunk.split('\n')) {
				const t = line.trim();
				if (t.startsWith('data:')) dataLine = t.slice(5).trim();
			}
			if (!dataLine || dataLine === '[DONE]') continue;

			let ev;
			try {
				ev = JSON.parse(dataLine);
			} catch {
				continue;
			}

			const type = ev.type || '';

			if (type === 'response.output_text.delta' && typeof ev.delta === 'string') {
				onText(ev.delta);
				continue;
			}

			if (type === 'response.function_call_arguments.delta') {
				const id = ev.item_id || 'unknown';
				let entry = toolByItem.get(id);
				if (!entry) {
					entry = { arguments: '' };
					toolByItem.set(id, entry);
				}
				if (typeof ev.delta === 'string') entry.arguments += ev.delta;
				continue;
			}

			if (type === 'response.function_call_arguments.done') {
				const id = ev.item_id || 'unknown';
				let entry = toolByItem.get(id);
				if (!entry) {
					entry = { arguments: '' };
					toolByItem.set(id, entry);
				}
				if (typeof ev.arguments === 'string') entry.arguments = ev.arguments;
				continue;
			}

			if (type === 'response.output_item.done' && ev.item?.type === 'function_call') {
				const item = ev.item;
				const id = item.id || ev.item_id || randomUUID();
				const entry = toolByItem.get(id) || { arguments: item.arguments || '' };
				entry.name = item.name || entry.name;
				entry.callId = item.call_id || entry.callId || id;
				if (typeof item.arguments === 'string' && item.arguments) {
					entry.arguments = item.arguments;
				}
				toolByItem.set(id, entry);

				if (onToolCall && entry.name) {
					onToolCall({
						callId: entry.callId || id,
						name: entry.name,
						arguments: entry.arguments || '{}',
					});
				}
				continue;
			}

			if (type === 'response.failed' || type === 'error') {
				const msg =
					ev.response?.error?.message ||
					ev.error?.message ||
					ev.message ||
					'Codex response failed';
				throw new Error(msg);
			}
		}
	}
}
