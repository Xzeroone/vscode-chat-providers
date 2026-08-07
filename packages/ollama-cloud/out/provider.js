/**
 * VS Code LanguageModelChatProvider for Ollama Cloud.
 */
import * as vscode from 'vscode';
import { discoverModels, streamChatCompletions, DEFAULT_BASE_URL } from './client.js';
import { convertMessages, convertTools, convertToolChoice } from './messages.js';
import {
	resolveThinkingConfig,
	clampThinkingLevel,
	wireForLevel,
	THINKING_LABELS,
	THINKING_DESCRIPTIONS,
} from './thinking-levels.js';
import { debug, logAlways } from './debug.js';

/**
 * @typedef {import('./client.js').CloudModel} CloudModel
 * @typedef {import('./auth.js').AuthStore} AuthStore
 */

export class OllamaCloudChatProvider {
	/**
	 * @param {AuthStore} auth
	 */
	constructor(auth) {
		this.auth = auth;
		/** @type {CloudModel[] | null} */
		this._cache = null;
		/** @type {number} */
		this._cacheAt = 0;
		/** @type {Map<string, CloudModel>} */
		this._byId = new Map();
		this._onDidChangeLanguageModelChatInformation = new vscode.EventEmitter();
		this.onDidChangeLanguageModelChatInformation =
			this._onDidChangeLanguageModelChatInformation.event;
	}

	fireDidChangeModels() {
		this._cache = null;
		this._cacheAt = 0;
		this._byId.clear();
		this._onDidChangeLanguageModelChatInformation.fire();
	}

	getConfig() {
		const cfg = vscode.workspace.getConfiguration('ollamaCloud');
		return {
			baseUrl: /** @type {string} */ (cfg.get('baseUrl') || DEFAULT_BASE_URL),
			toolsOnly: cfg.get('toolsOnly') !== false,
			// 0 / unset = fully auto (models.dev or derived from context)
			defaultMaxTokens: /** @type {number} */ (cfg.get('defaultMaxTokens') ?? 0),
			refreshIntervalMinutes: /** @type {number} */ (cfg.get('refreshIntervalMinutes') ?? 60),
			defaultThinkingLevel: /** @type {string} */ (cfg.get('defaultThinkingLevel') || 'off'),
			includeReasoningInResponse: cfg.get('includeReasoningInResponse') === true,
			useRegistry: cfg.get('useModelsDevRegistry') !== false,
		};
	}

	/**
	 * @param {boolean} force
	 * @param {vscode.CancellationToken} [token]
	 * @returns {Promise<CloudModel[]>}
	 */
	async getModels(force, token) {
		const { refreshIntervalMinutes } = this.getConfig();
		const ttlMs = Math.max(0, refreshIntervalMinutes) * 60_000;
		const fresh =
			this._cache &&
			!force &&
			(ttlMs === 0 || Date.now() - this._cacheAt < ttlMs);

		if (fresh && this._cache) {
			return this._cache;
		}

		const apiKey = await this.auth.getApiKey();
		if (!apiKey) {
			return [];
		}

		const { baseUrl, toolsOnly, defaultMaxTokens, useRegistry } = this.getConfig();
		const controller = new AbortController();
		const sub = token?.onCancellationRequested(() => controller.abort());
		try {
			const models = await discoverModels({
				apiKey,
				baseUrl,
				toolsOnly,
				defaultMaxTokens:
					typeof defaultMaxTokens === 'number' && defaultMaxTokens > 0
						? defaultMaxTokens
						: null,
				useRegistry,
				resolveThinking: (id, thinking, reasoningOptions) =>
					resolveThinkingConfig(id, thinking, reasoningOptions),
				signal: controller.signal,
			});
			this._cache = models;
			this._cacheAt = Date.now();
			this._byId = new Map(models.map((m) => [m.id, m]));
			return models;
		} finally {
			sub?.dispose();
		}
	}

	/**
	 * @param {{ silent: boolean }} options
	 * @param {vscode.CancellationToken} token
	 */
	async provideLanguageModelChatInformation(options, token) {
		let apiKey = await this.auth.getApiKey();
		if (!apiKey) {
			if (options.silent) {
				return [];
			}
			const result = await this.auth.manage();
			if (result !== 'set') {
				return [];
			}
			apiKey = await this.auth.getApiKey();
			if (!apiKey) return [];
		}

		try {
			const models = await this.getModels(false, token);
			const defaultThinking = this.getConfig().defaultThinkingLevel;
			return models.map((m) => this.toModelInfo(m, defaultThinking));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logAlways('[provider] discover failed:', msg);
			if (!options.silent) {
				vscode.window.showErrorMessage(`Ollama Cloud: ${msg}`);
			}
			return [];
		}
	}

	/**
	 * @param {CloudModel} m
	 * @param {string} defaultThinking
	 * @returns {vscode.LanguageModelChatInformation & { configurationSchema?: object }}
	 */
	toModelInfo(m, defaultThinking) {
		const family = m.id.split(':')[0] || m.id;
		const levels = m.thinkingLevels ?? [];
		const modelDefault =
			levels.length > 0 ? clampThinkingLevel(levels, defaultThinking) : 'off';

		/** @type {vscode.LanguageModelChatInformation & { configurationSchema?: object }} */
		const info = {
			id: m.id,
			name: m.id,
			family,
			version: m.id,
			maxInputTokens: Math.max(1024, m.contextWindow - m.maxTokens),
			maxOutputTokens: m.maxTokens,
			tooltip: [
				'Ollama Cloud',
				m.toolCalling ? 'tools' : null,
				m.thinking
					? levels.length
						? `thinking: ${levels.join(', ')}`
						: 'thinking'
					: null,
				m.imageInput ? 'vision' : null,
				`ctx ${m.contextWindow}`,
				`max_out ${m.maxTokens}${m.meta?.maxSource ? ` (${m.meta.maxSource})` : ''}`,
			]
				.filter(Boolean)
				.join(' · '),
			detail: [
				m.thinking && levels.length ? `think:${levels.join('/')}` : null,
				`out:${m.maxTokens}`,
			]
				.filter(Boolean)
				.join(' · ') || 'ollama.com',
			capabilities: {
				toolCalling: m.toolCalling,
				imageInput: m.imageInput,
			},
		};

		// Thinking Effort submenu (same pattern as pi-chat-provider)
		if (levels.length >= 2) {
			info.configurationSchema = this.buildThinkingConfigurationSchema(levels, modelDefault);
		}

		return info;
	}

	/**
	 * @param {string[]} levels
	 * @param {string} defaultLevel
	 */
	buildThinkingConfigurationSchema(levels, defaultLevel) {
		const effectiveDefault = levels.includes(defaultLevel) ? defaultLevel : levels[0];
		return {
			type: 'object',
			properties: {
				thinkingLevel: {
					type: 'string',
					title: 'Thinking Effort',
					description:
						'Reasoning effort for this Ollama Cloud model (from capabilities + family map)',
					group: 'navigation',
					enum: levels,
					default: effectiveDefault,
					enumItemLabels: levels.map((l) => THINKING_LABELS[l] || l),
					enumDescriptions: levels.map((l) => THINKING_DESCRIPTIONS[l] || l),
				},
			},
		};
	}

	/**
	 * @param {object} options
	 * @param {CloudModel | undefined} meta
	 */
	resolveThinkingLevel(options, meta) {
		const fromConfig =
			options?.modelConfiguration?.thinkingLevel ??
			options?.configuration?.thinkingLevel ??
			options?.modelOptions?.thinkingLevel ??
			options?.modelOptions?.reasoningEffort ??
			options?.modelOptions?.effort;

		let level =
			typeof fromConfig === 'string' && fromConfig.trim()
				? fromConfig.trim().toLowerCase()
				: this.getConfig().defaultThinkingLevel;

		const levels = meta?.thinkingLevels;
		if (levels?.length) {
			level = clampThinkingLevel(levels, level);
		}
		return level;
	}

	/**
	 * @param {vscode.LanguageModelChatInformation} model
	 * @param {readonly vscode.LanguageModelChatRequestMessage[]} messages
	 * @param {vscode.ProvideLanguageModelChatResponseOptions} options
	 * @param {vscode.Progress<vscode.LanguageModelResponsePart>} progress
	 * @param {vscode.CancellationToken} token
	 */
	async provideLanguageModelChatResponse(model, messages, options, progress, token) {
		const apiKey = await this.auth.getApiKey();
		if (!apiKey) {
			throw new Error(
				'Ollama Cloud API key not configured. Run “Ollama Cloud: Manage API Key”.',
			);
		}

		const { baseUrl, defaultMaxTokens, includeReasoningInResponse } = this.getConfig();
		const modelId = model.id;
		const meta = this._byId.get(modelId);
		const thinkingLevel = this.resolveThinkingLevel(options, meta);
		const wire =
			meta?.thinking && meta.thinkingLevelMap
				? wireForLevel(meta.thinkingLevelMap, thinkingLevel)
				: meta?.thinking
					? // thinking capability but no level map — honor default on/off-ish
						thinkingLevel === 'off'
						? { reasoning_effort: 'none', think: false }
						: { reasoning_effort: thinkingLevel === 'max' ? 'max' : 'high', think: true }
					: {};

		const openaiMessages = convertMessages(messages);
		const tools = convertTools(options.tools);
		const toolChoice = convertToolChoice(options.toolMode, Boolean(tools?.length));

		if (!openaiMessages.length) {
			debug('[provider] empty messages — skip');
			return;
		}

		debug('[provider] request', {
			modelId,
			thinkingLevel,
			wire,
			hasThinkingMap: Boolean(meta?.thinkingLevelMap),
		});

		const controller = new AbortController();
		const sub = token.onCancellationRequested(() => controller.abort());

		/** @type {Map<number, { id: string, name: string, arguments: string }>} */
		const toolAcc = new Map();
		/** @type {string[]} */
		const reasoningChunks = [];

		try {
			const { finishReason } = await streamChatCompletions({
				apiKey,
				baseUrl,
				model: modelId,
				messages: openaiMessages,
				tools,
				toolChoice,
				maxTokens: model.maxOutputTokens || defaultMaxTokens,
				reasoningEffort: wire.reasoning_effort,
				think: wire.think,
				signal: controller.signal,
				onText: (delta) => {
					progress.report(new vscode.LanguageModelTextPart(delta));
				},
				onReasoning: (delta) => {
					reasoningChunks.push(delta);
				},
				onToolCallDelta: (delta) => {
					let entry = toolAcc.get(delta.index);
					if (!entry) {
						entry = {
							id: delta.id || `call_${delta.index}`,
							name: delta.name || '',
							arguments: '',
						};
						toolAcc.set(delta.index, entry);
					}
					if (delta.id) entry.id = delta.id;
					if (delta.name) entry.name = delta.name;
					if (delta.arguments) entry.arguments += delta.arguments;
				},
			});

			// Optionally surface reasoning after the answer (no stable ThinkingPart API yet)
			if (includeReasoningInResponse && reasoningChunks.length) {
				const block = reasoningChunks.join('');
				if (block.trim()) {
					progress.report(
						new vscode.LanguageModelTextPart(
							`\n\n<details><summary>Reasoning (${thinkingLevel})</summary>\n\n${block}\n\n</details>\n`,
						),
					);
				}
			}

			// Emit completed tool calls for the host agent to execute
			for (const [, tc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
				if (!tc.name) continue;
				let input = {};
				try {
					input = tc.arguments ? JSON.parse(tc.arguments) : {};
				} catch {
					input = { raw: tc.arguments };
				}
				progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, input));
			}

			debug('[provider] finish_reason=', finishReason, 'toolCalls=', toolAcc.size, {
				reasoningChars: reasoningChunks.join('').length,
			});
		} catch (err) {
			if (err instanceof Error && err.message.includes('cancelled')) {
				debug('[provider] cancelled');
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			logAlways('[provider] chat error:', msg);
			throw new Error(msg);
		} finally {
			sub.dispose();
		}
	}

	/**
	 * @param {vscode.LanguageModelChatInformation} _model
	 * @param {string | vscode.LanguageModelChatRequestMessage} text
	 * @param {vscode.CancellationToken} _token
	 */
	async provideTokenCount(_model, text, _token) {
		if (typeof text === 'string') {
			return Math.ceil(text.length / 4);
		}
		let n = 0;
		for (const part of text.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				n += part.value.length;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				n += JSON.stringify(part.input ?? {}).length + (part.name?.length ?? 0);
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				for (const c of part.content ?? []) {
					if (c instanceof vscode.LanguageModelTextPart) n += c.value.length;
				}
			}
		}
		return Math.ceil(n / 4);
	}
}
