/**
 * VS Code LM messages → Codex Responses API `input` items.
 */
import * as vscode from 'vscode';

/**
 * @param {readonly vscode.LanguageModelChatRequestMessage[]} messages
 * @returns {{ instructions: string, input: object[] }}
 */
export function convertMessages(messages) {
	/** @type {string[]} */
	const systemChunks = [];
	/** @type {object[]} */
	const input = [];

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
		/** @type {object[]} */
		const images = [];

		for (const part of parts) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value) texts.push(part.value);
				continue;
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					type: 'function_call',
					call_id: part.callId,
					name: part.name,
					arguments:
						typeof part.input === 'string'
							? part.input
							: JSON.stringify(part.input ?? {}),
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
			if (
				part &&
				typeof part === 'object' &&
				'mimeType' in part &&
				'data' in part &&
				typeof part.mimeType === 'string' &&
				part.mimeType.startsWith('image/')
			) {
				try {
					const bytes =
						part.data instanceof Uint8Array
							? part.data
							: new Uint8Array(part.data);
					const b64 = Buffer.from(bytes).toString('base64');
					images.push({
						type: 'input_image',
						image_url: `data:${part.mimeType};base64,${b64}`,
					});
				} catch {
					/* ignore */
				}
			}
		}

		// Heuristic: first user message that looks like system is rare;
		// VS Code usually doesn't send a separate system role. Host may put
		// instructions in the first user blob — we keep as user content.
		void systemChunks;

		for (const tr of toolResults) {
			input.push({
				type: 'function_call_output',
				call_id: tr.callId,
				output: tr.content,
			});
		}

		if (toolCalls.length && role === 'assistant') {
			const text = texts.join('');
			if (text) {
				input.push({
					role: 'assistant',
					content: [{ type: 'output_text', text, annotations: [] }],
				});
			}
			for (const tc of toolCalls) {
				input.push(tc);
			}
			continue;
		}

		const text = texts.join('');
		if (role === 'assistant') {
			if (text) {
				input.push({
					role: 'assistant',
					content: [{ type: 'output_text', text, annotations: [] }],
				});
			}
			continue;
		}

		/** @type {object[]} */
		const content = [];
		if (text) content.push({ type: 'input_text', text });
		content.push(...images);
		if (content.length) {
			input.push({ role: 'user', content });
		}
	}

	return {
		instructions: 'You are a helpful coding assistant.',
		input,
	};
}

/**
 * @param {readonly vscode.LanguageModelChatTool[] | undefined} tools
 * @returns {object[] | undefined}
 */
export function convertTools(tools) {
	if (!tools?.length) return undefined;
	return tools.map((t) => ({
		type: 'function',
		name: t.name,
		description: t.description || '',
		parameters:
			t.inputSchema && typeof t.inputSchema === 'object'
				? t.inputSchema
				: { type: 'object', properties: {} },
	}));
}

/**
 * @param {vscode.LanguageModelChatToolMode | undefined} mode
 * @param {boolean} hasTools
 */
export function convertToolChoice(mode, hasTools) {
	if (!hasTools) return undefined;
	if (mode === vscode.LanguageModelChatToolMode?.Required || mode === 2) {
		return 'required';
	}
	return 'auto';
}
