/**
 * VS Code LanguageModelChatProvider for OpenAI Codex (ChatGPT OAuth).
 */
import * as vscode from 'vscode';
import { getValidTokens, manageAuth, authStatusText } from './auth.js';
import { discoverModels } from './models.js';
import { convertMessages, convertTools, convertToolChoice } from './messages.js';
import { streamCodexResponse } from './client.js';
import { debug, logAlways } from './debug.js';
import { smartDefaultThinkingLevel } from './default-effort.js';
import {
	clampMaxTokens,
	HARD_MAX_OUTPUT_TOKENS,
} from './token-limits.js';

const THINKING_LABELS = {
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra High',
	max: 'Max',
	ultra: 'Ultra',
};

/**
 * @typedef {import('./models.js').CodexModel} CodexModel
 */

export class CodexChatProvider {
	constructor() {
		/** @type {CodexModel[] | null} */
		this._cache = null;
		this._cacheAt = 0;
		/** @type {Map<string, CodexModel>} */
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
		const cfg = vscode.workspace.getConfiguration('openaiCodex');
		return {
			clientVersion: /** @type {string} */ (cfg.get('clientVersion') || ''),
			hideHidden: cfg.get('hideHiddenModels') !== false,
			defaultThinkingLevel: /** @type {string} */ (cfg.get('defaultThinkingLevel') || 'medium'),
			defaultMaxTokens: /** @type {number} */ (cfg.get('defaultMaxTokens') ?? 0),
			refreshIntervalMinutes: /** @type {number} */ (cfg.get('refreshIntervalMinutes') ?? 60),
		};
	}

	/**
	 * @param {boolean} force
	 * @param {vscode.CancellationToken} [token]
	 */
	async getModels(force, token) {
		const { refreshIntervalMinutes } = this.getConfig();
		const ttlMs = Math.max(0, refreshIntervalMinutes) * 60_000;
		const fresh =
			this._cache && !force && (ttlMs === 0 || Date.now() - this._cacheAt < ttlMs);
		if (fresh && this._cache) return this._cache;

		const controller = new AbortController();
		const sub = token?.onCancellationRequested(() => controller.abort());
		try {
			const tokens = await getValidTokens(controller.signal);
			const cfg = this.getConfig();
			const models = await discoverModels({
				access: tokens.access,
				accountId: tokens.accountId,
				clientVersion: cfg.clientVersion || undefined,
				hideHidden: cfg.hideHidden,
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
			const defaultThinking = this.getConfig().defaultThinkingLevel;
			return models.map((m) => this.toModelInfo(m, defaultThinking));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logAlways('[provider] discover failed:', msg);
			if (!options.silent) {
				const act = await vscode.window.showErrorMessage(
					`Codex: ${msg}`,
					'Sign in with ChatGPT',
					'Manage Auth',
				);
				if (act === 'Sign in with ChatGPT') {
					const { signInInteractive } = await import('./auth.js');
					const ok = await signInInteractive();
					if (ok) this.fireDidChangeModels();
				} else if (act === 'Manage Auth') {
					await manageAuth();
					this.fireDidChangeModels();
				}
			}
			return [];
		}
	}

	/**
	 * @param {CodexModel} m
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
		const levels = m.thinkingLevels?.length ? m.thinkingLevels : ['low', 'medium', 'high'];
		const modelDefault = this.pickDefaultThinking(levels, m.defaultThinking, defaultThinking);
		const maxOut = clampMaxTokens(m.maxTokens);
		const maxIn = Math.max(1024, (m.contextWindow || 128_000) - maxOut);

		/** @type {vscode.LanguageModelChatInformation & { configurationSchema?: object }} */
		const info = {
			id: m.id,
			name: m.name || m.id,
			family: m.id.replace(/-\w+$/, '') || m.id,
			version: m.id,
			maxInputTokens: maxIn,
			maxOutputTokens: maxOut,
			tooltip: [
				'Codex · ChatGPT OAuth',
				`thinking: ${levels.join(', ')}`,
				m.imageInput ? 'vision' : null,
				`ctx ${m.contextWindow}`,
				`max_out ${maxOut}${m.maxSource ? ` (${m.maxSource})` : ''}`,
			]
				.filter(Boolean)
				.join(' · '),
			detail: `effort · ${levels.join('/')} · out:${maxOut}`,
			capabilities: {
				toolCalling: m.toolCalling !== false,
				imageInput: Boolean(m.imageInput),
			},
		};

		if (levels.length >= 2) {
			info.configurationSchema = {
				type: 'object',
				properties: {
					thinkingLevel: {
						type: 'string',
						title: 'Thinking Effort',
						description: 'Codex reasoning effort for this model',
						group: 'navigation',
						enum: levels,
						default: modelDefault,
						enumItemLabels: levels.map((l) => THINKING_LABELS[l] || l),
					},
				},
			};
		}

		return info;
	}

	/**
	 * @param {object} options
	 * @param {CodexModel | undefined} meta
	 */
	resolveThinkingLevel(options, meta) {
		const fromConfig =
			options?.modelConfiguration?.thinkingLevel ??
			options?.configuration?.thinkingLevel ??
			options?.modelOptions?.thinkingLevel ??
			options?.modelOptions?.reasoningEffort;

		const levels = meta?.thinkingLevels?.length
			? meta.thinkingLevels
			: ['low', 'medium', 'high'];
		let level =
			typeof fromConfig === 'string' && fromConfig.trim()
				? fromConfig.trim().toLowerCase()
				: this.pickDefaultThinking(
						levels,
						meta?.defaultThinking,
						this.getConfig().defaultThinkingLevel,
					);

		if (!levels.includes(level)) {
			level = this.pickDefaultThinking(
				levels,
				meta?.defaultThinking,
				this.getConfig().defaultThinkingLevel,
			);
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
		const controller = new AbortController();
		const sub = token.onCancellationRequested(() => controller.abort());

		try {
			const tokens = await getValidTokens(controller.signal);
			const meta = this._byId.get(model.id);
			const effort = this.resolveThinkingLevel(options, meta);
			const { instructions, input } = convertMessages(messages);
			const tools = convertTools(options.tools);
			const toolChoice = convertToolChoice(options.toolMode, Boolean(tools?.length));

			if (!input.length) {
				debug('[provider] empty input — skip');
				return;
			}

			const maxTokens = clampMaxTokens(
				(typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
					? model.maxOutputTokens
					: undefined) ||
					meta?.maxTokens ||
					HARD_MAX_OUTPUT_TOKENS,
			);
			// Prefer live discovery cap when host value is stale/high
			const safeMax = Math.min(maxTokens, meta?.maxTokens || HARD_MAX_OUTPUT_TOKENS);

			debug('[provider]', {
				model: model.id,
				effort,
				tools: tools?.length ?? 0,
				maxTokens: safeMax,
			});

			await streamCodexResponse({
				access: tokens.access,
				accountId: tokens.accountId,
				model: model.id,
				instructions,
				input,
				tools,
				toolChoice,
				reasoningEffort: effort,
				maxTokens: safeMax,
				signal: controller.signal,
				onText: (delta) => {
					progress.report(new vscode.LanguageModelTextPart(delta));
				},
				onToolCall: (tc) => {
					let inputObj = {};
					try {
						inputObj = tc.arguments ? JSON.parse(tc.arguments) : {};
					} catch {
						inputObj = { raw: tc.arguments };
					}
					progress.report(
						new vscode.LanguageModelToolCallPart(tc.callId, tc.name, inputObj),
					);
				},
			});
		} catch (err) {
			if (err instanceof Error && err.message.includes('cancelled')) return;
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
	 */
	async provideTokenCount(_model, text) {
		if (typeof text === 'string') return Math.ceil(text.length / 4);
		let n = 0;
		for (const part of text.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) n += part.value.length;
			else if (part instanceof vscode.LanguageModelToolCallPart) {
				n += JSON.stringify(part.input ?? {}).length;
			}
		}
		return Math.ceil(n / 4);
	}

	status() {
		return authStatusText();
	}
}
