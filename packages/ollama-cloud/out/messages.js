/**
 * Convert VS Code LanguageModelChatRequestMessage[] → OpenAI chat messages.
 */
import * as vscode from 'vscode';
import { debug } from './debug.js';

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

		/** @type {string[]} */
		const textParts = [];
		/** @type {object[]} */
		const toolCalls = [];
		/** @type {{ callId: string, content: string }[]} */
		const toolResults = [];
		/** @type {string[]} */
		const imageDataUris = [];

		const content = Array.isArray(msg.content) ? msg.content : [];
		for (const part of content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value) textParts.push(part.value);
				continue;
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
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
				continue;
			}
			if (part instanceof vscode.LanguageModelToolResultPart) {
				const text = (part.content ?? [])
					.map((c) => {
						if (c instanceof vscode.LanguageModelTextPart) return c.value;
						if (typeof c === 'string') return c;
						try {
							return JSON.stringify(c);
						} catch {
							return String(c);
						}
					})
					.join('');
				toolResults.push({ callId: part.callId, content: text });
				continue;
			}
			// Vision: image data parts → OpenAI image_url content parts
			if (
				part &&
				typeof part === 'object' &&
				'mimeType' in part &&
				'data' in part &&
				typeof part.mimeType === 'string' &&
				part.mimeType.startsWith('image/') &&
				part.data
			) {
				try {
					const bytes =
						part.data instanceof Uint8Array
							? part.data
							: new Uint8Array(part.data);
					const b64 = Buffer.from(bytes).toString('base64');
					imageDataUris.push(`data:${part.mimeType};base64,${b64}`);
				} catch {
					/* ignore bad image part */
				}
			}
		}

		// Tool results must be role: tool messages in OpenAI format
		if (toolResults.length) {
			for (const tr of toolResults) {
				out.push({
					role: 'tool',
					tool_call_id: tr.callId,
					content: tr.content,
				});
			}
			// If the user message only carried tool results, don't also emit empty user
			if (!textParts.some((t) => t.length) && !toolCalls.length && !imageDataUris.length) {
				continue;
			}
		}

		if (toolCalls.length && role === 'assistant') {
			/** @type {Record<string, unknown>} */
			const assistantMsg = {
				role: 'assistant',
				tool_calls: toolCalls,
			};
			const joined = textParts.join('');
			if (joined) assistantMsg.content = joined;
			out.push(assistantMsg);
			continue;
		}

		const text = textParts.join('');
		if (imageDataUris.length) {
			/** @type {object[]} */
			const multi = [];
			if (text) multi.push({ type: 'text', text });
			for (const url of imageDataUris) {
				multi.push({ type: 'image_url', image_url: { url } });
			}
			out.push({ role, content: multi });
			continue;
		}

		if (text || role === 'user') {
			out.push({ role, content: text });
		}
	}

	debug('[messages] converted', out.length, 'openai messages from', messages.length);
	return out;
}

/**
 * @param {readonly vscode.LanguageModelChatTool[] | undefined} tools
 * @returns {object[] | undefined}
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
 * @returns {string | undefined}
 */
export function convertToolChoice(mode, hasTools) {
	if (!hasTools) return undefined;
	// Required = 2 in the enum
	if (mode === vscode.LanguageModelChatToolMode?.Required || mode === 2) {
		return 'required';
	}
	return 'auto';
}
