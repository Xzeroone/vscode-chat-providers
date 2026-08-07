/**
 * VS Code LanguageModelChatProvider for xAI Grok.
 */
import * as vscode from 'vscode';
import { getValidTokens, manageAuth, signInInteractive } from './auth.js';
import { discoverModels } from './models.js';
import { convertMessages, convertTools, convertToolChoice } from './messages.js';
import { streamChat } from './client.js';
import { debug, logAlways } from './debug.js';
import { smartDefaultThinkingLevel } from './default-effort.js';

const LABELS = { low: 'Low', medium: 'Medium', high: 'High' };

/**
 * @typedef {import('./models.js').GrokModel} GrokModel
 */

export class GrokChatProvider {
	constructor() {
		/** @type {GrokModel[] | null} */
		this._cache = null;
		this._cacheAt = 0;
		/** @type {Map<string, GrokModel>} */
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
		const cfg = vscode.workspace.getConfiguration('xai');
		return {
			apiBaseUrl: /** @type {string} */ (cfg.get('apiBaseUrl') || 'https://api.x.ai/v1'),
			modelsProxyUrl: /** @type {string} */ (
				cfg.get('modelsProxyUrl') || 'https://cli-chat-proxy.grok.com/v1/models'
			),
			excludeImageModels: cfg.get('excludeImageModels') !== false,
			defaultThinkingLevel: /** @type {string} */ (cfg.get('defaultThinkingLevel') || 'medium'),
			defaultMaxTokens: /** @type {number} */ (cfg.get('defaultMaxTokens') ?? 0),
			refreshIntervalMinutes: /** @type {number} */ (cfg.get('refreshIntervalMinutes') ?? 60),
			includeReasoningInResponse: cfg.get('includeReasoningInResponse') === true,
		};
	}

	/**
	 * @param {boolean} force
	 * @param {vscode.CancellationToken} [token]
	 */
	async getModels(force, token) {
		const { refreshIntervalMinutes } = this.getConfig();
		const ttlMs = Math.max(0, refreshIntervalMinutes) * 60_000;
		if (this._cache && !force && (ttlMs === 0 || Date.now() - this._cacheAt < ttlMs)) {
			return this._cache;
		}
		const controller = new AbortController();
		const sub = token?.onCancellationRequested(() => controller.abort());
		try {
			const tokens = await getValidTokens(controller.signal);
			const cfg = this.getConfig();
			const models = await discoverModels({
				access: tokens.access,
				apiBaseUrl: cfg.apiBaseUrl,
				modelsProxyUrl: cfg.modelsProxyUrl,
				excludeImageModels: cfg.excludeImageModels,
				defaultMaxTokens: cfg.defaultMaxTokens,
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
		try {
			const models = await this.getModels(false, token);
			const def = this.getConfig().defaultThinkingLevel;
			return models.map((m) => this.toModelInfo(m, def));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logAlways('[provider] discover failed', msg);
			if (!options.silent) {
				const act = await vscode.window.showErrorMessage(
					`Grok: ${msg}`,
					'Sign in with SuperGrok',
					'Manage Auth',
				);
				if (act === 'Sign in with SuperGrok') {
					if (await signInInteractive()) this.fireDidChangeModels();
				} else if (act === 'Manage Auth') {
					await manageAuth();
					this.fireDidChangeModels();
				}
			}
			return [];
		}
	}

	/**
	 * @param {GrokModel} m
	 * @param {string} defaultThinking
	 */
	/**
	 * Prefer ladder-aware default: medium when available, high for off→high.
	 * @param {string[]} levels
	 * @param {string | undefined} catalogDefault
	 * @param {string} userDefault
	 */
	pickDefaultThinking(levels, catalogDefault, userDefault) {
		const smart = smartDefaultThinkingLevel(levels);
		if (smart && levels.includes(smart)) return smart;
		if (catalogDefault && levels.includes(catalogDefault)) return catalogDefault;
		if (userDefault && levels.includes(userDefault)) return userDefault;
		return levels[0];
	}

	toModelInfo(m, defaultThinking) {
		const levels = m.thinkingLevels || [];
		const modelDefault = levels.length
			? this.pickDefaultThinking(levels, m.defaultThinking, defaultThinking)
			: undefined;

		/** @type {vscode.LanguageModelChatInformation & { configurationSchema?: object }} */
		const info = {
			id: m.id,
			name: m.name || m.id,
			family: m.id.split('-').slice(0, 2).join('-') || m.id,
			version: m.id,
			maxInputTokens: Math.max(1024, m.contextWindow - m.maxTokens),
			maxOutputTokens: m.maxTokens,
			tooltip: [
				'Grok · xAI OAuth',
				levels.length ? `thinking: ${levels.join(', ')}` : null,
				`ctx ${m.contextWindow}`,
			]
				.filter(Boolean)
				.join(' · '),
			detail: levels.length ? `effort · ${levels.join('/')}` : 'x.ai',
			capabilities: {
				toolCalling: m.toolCalling !== false,
				imageInput: false,
			},
		};

		if (levels.length >= 2 && modelDefault) {
			info.configurationSchema = {
				type: 'object',
				properties: {
					thinkingLevel: {
						type: 'string',
						title: 'Thinking Effort',
						description: 'Grok reasoning effort (from Grok CLI / model catalog)',
						group: 'navigation',
						enum: levels,
						default: modelDefault,
						enumItemLabels: levels.map((l) => LABELS[l] || l),
					},
				},
			};
		}
		return info;
	}

	/**
	 * @param {object} options
	 * @param {GrokModel | undefined} meta
	 */
	resolveThinking(options, meta) {
		const from =
			options?.modelConfiguration?.thinkingLevel ??
			options?.configuration?.thinkingLevel ??
			options?.modelOptions?.thinkingLevel ??
			options?.modelOptions?.reasoningEffort;
		const levels = meta?.thinkingLevels || [];
		let level =
			typeof from === 'string' && from.trim()
				? from.trim().toLowerCase()
				: this.pickDefaultThinking(
						levels,
						meta?.defaultThinking,
						this.getConfig().defaultThinkingLevel,
					);
		if (levels.length && !levels.includes(level)) {
			level = this.pickDefaultThinking(
				levels,
				meta?.defaultThinking,
				this.getConfig().defaultThinkingLevel,
			);
		}
		return meta?.supportsThinking ? level : undefined;
	}

	/**
	 * @param {vscode.LanguageModelChatInformation} model
	 * @param {readonly vscode.LanguageModelChatRequestMessage[]} messages
	 * @param {vscode.ProvideLanguageModelChatResponseOptions} options
	 * @param {vscode.Progress<vscode.LanguageModelResponsePart>} progress
	 * @param {vscode.CancellationToken} token
	 */
	async provideLanguageModelChatResponse(model, messages, options, progress, token) {
		const controller = new AbortController();
		const sub = token.onCancellationRequested(() => controller.abort());
		try {
			const tokens = await getValidTokens(controller.signal);
			const meta = this._byId.get(model.id);
			const effort = this.resolveThinking(options, meta);
			const openaiMessages = convertMessages(messages);
			const tools = convertTools(options.tools);
			const toolChoice = convertToolChoice(options.toolMode, Boolean(tools?.length));
			if (!openaiMessages.length) return;

			const cfg = this.getConfig();
			/** @type {Map<number, { id: string, name: string, arguments: string }>} */
			const toolAcc = new Map();
			/** @type {string[]} */
			const reasoning = [];

			debug('[provider]', { model: model.id, effort });

			await streamChat({
				access: tokens.access,
				apiBaseUrl: cfg.apiBaseUrl,
				model: model.id,
				messages: openaiMessages,
				tools,
				toolChoice,
				reasoningEffort: effort,
				maxTokens: model.maxOutputTokens || meta?.maxTokens,
				signal: controller.signal,
				onText: (d) => progress.report(new vscode.LanguageModelTextPart(d)),
				onReasoning: (d) => reasoning.push(d),
				onToolCallDelta: (delta) => {
					let e = toolAcc.get(delta.index);
					if (!e) {
						e = { id: delta.id || `call_${delta.index}`, name: '', arguments: '' };
						toolAcc.set(delta.index, e);
					}
					if (delta.id) e.id = delta.id;
					if (delta.name) e.name = delta.name;
					if (delta.arguments) e.arguments += delta.arguments;
				},
			});

			if (cfg.includeReasoningInResponse && reasoning.length) {
				const block = reasoning.join('');
				if (block.trim()) {
					progress.report(
						new vscode.LanguageModelTextPart(
							`\n\n<details><summary>Reasoning (${effort || 'default'})</summary>\n\n${block}\n\n</details>\n`,
						),
					);
				}
			}

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
		} catch (err) {
			if (err instanceof Error && err.message.includes('cancelled')) return;
			const msg = err instanceof Error ? err.message : String(err);
			logAlways('[provider] chat error', msg);
			throw new Error(msg);
		} finally {
			sub.dispose();
		}
	}

	/**
	 * @param {vscode.LanguageModelChatInformation} _model
	 * @param {string | vscode.LanguageModelChatRequestMessage} text
	 */
	async provideTokenCount(_model, text) {
		if (typeof text === 'string') return Math.ceil(text.length / 4);
		let n = 0;
		for (const part of text.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) n += part.value.length;
		}
		return Math.ceil(n / 4);
	}
}
