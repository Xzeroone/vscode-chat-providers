/**
 * xAI chat.completions streaming (api.x.ai/v1).
 * No vscode dependency.
 */

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
 *   apiBaseUrl?: string,
 *   model: string,
 *   messages: object[],
 *   tools?: object[],
 *   toolChoice?: string,
 *   reasoningEffort?: string,
 *   maxTokens?: number,
 *   signal?: AbortSignal,
 *   fetchFn?: typeof fetch,
 *   onText: (d: string) => void,
 *   onReasoning?: (d: string) => void,
 *   onToolCallDelta?: (d: { index: number, id?: string, name?: string, arguments?: string }) => void,
 * }} opts
 */
export async function streamChat(opts) {
	const {
		access,
		apiBaseUrl = 'https://api.x.ai/v1',
		model,
		messages,
		tools,
		toolChoice,
		reasoningEffort,
		maxTokens = 32768,
		signal,
		fetchFn = fetch,
		onText,
		onReasoning,
		onToolCallDelta,
	} = opts;

	const base = apiBaseUrl.replace(/\/+$/, '');
	const url = `${base}/chat/completions`;

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
	if (reasoningEffort) {
		body.reasoning_effort = reasoningEffort;
	}

	debug('[chat] POST', url, { model, messages: messages.length, tools: tools?.length ?? 0, reasoningEffort });

	const res = await fetchFn(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${access}`,
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			'User-Agent': 'vscode-grok-provider',
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const t = await res.text().catch(() => '');
		throw new Error(`Grok chat failed: HTTP ${res.status}${t ? ` — ${t.slice(0, 400)}` : ''}`);
	}
	if (!res.body) throw new Error('Empty response body');

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

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

		for (const raw of lines) {
			const line = raw.trim();
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') return;
			let parsed;
			try {
				parsed = JSON.parse(data);
			} catch {
				continue;
			}
			const delta = parsed?.choices?.[0]?.delta || {};
			if (typeof delta.content === 'string' && delta.content) onText(delta.content);
			if (typeof delta.reasoning_content === 'string' && delta.reasoning_content && onReasoning) {
				onReasoning(delta.reasoning_content);
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
}
