/**
 * VS Code messages → OpenAI chat.completions format (api.x.ai).
 */
import * as vscode from 'vscode';

/**
 * @param {readonly vscode.LanguageModelChatRequestMessage[]} messages
 * @returns {object[]}
 */
export function convertMessages(messages) {
	/** @type {object[]} */
	const out = [];

	for (const msg of messages) {
		const role =
			msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const parts = Array.isArray(msg.content) ? msg.content : [];

		/** @type {string[]} */
		const texts = [];
		/** @type {object[]} */
		const toolCalls = [];
		/** @type {{ callId: string, content: string }[]} */
		const toolResults = [];

		for (const part of parts) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value) texts.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments:
							typeof part.input === 'string'
								? part.input
								: JSON.stringify(part.input ?? {}),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				const text = (part.content ?? [])
					.map((c) =>
						c instanceof vscode.LanguageModelTextPart
							? c.value
							: typeof c === 'string'
								? c
								: JSON.stringify(c),
					)
					.join('');
				toolResults.push({ callId: part.callId, content: text });
			}
		}

		for (const tr of toolResults) {
			out.push({
				role: 'tool',
				tool_call_id: tr.callId,
				content: tr.content,
			});
		}

		if (toolCalls.length && role === 'assistant') {
			/** @type {Record<string, unknown>} */
			const m = { role: 'assistant', tool_calls: toolCalls };
			const t = texts.join('');
			if (t) m.content = t;
			out.push(m);
			continue;
		}

		const text = texts.join('');
		if (text || role === 'user') {
			out.push({ role, content: text });
		}
	}

	return out;
}

/**
 * @param {readonly vscode.LanguageModelChatTool[] | undefined} tools
 */
export function convertTools(tools) {
	if (!tools?.length) return undefined;
	return tools.map((t) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description || '',
			parameters:
				t.inputSchema && typeof t.inputSchema === 'object'
					? t.inputSchema
					: { type: 'object', properties: {} },
		},
	}));
}

/**
 * @param {vscode.LanguageModelChatToolMode | undefined} mode
 * @param {boolean} hasTools
 */
export function convertToolChoice(mode, hasTools) {
	if (!hasTools) return undefined;
	if (mode === vscode.LanguageModelChatToolMode?.Required || mode === 2) return 'required';
	return 'auto';
}
