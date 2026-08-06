/**
 * Codex Chat Provider — extension entry.
 */
import * as vscode from 'vscode';
import { CodexChatProvider } from './provider.js';
import {
	setAuthContext,
	manageAuth,
	signInInteractive,
	authStatusText,
} from './auth.js';
import { setClientDebug } from './client.js';
import { debug, getChannel, logAlways } from './debug.js';

/** @type {ReturnType<typeof setInterval> | undefined} */
let refreshTimer;

/**
 * @param {vscode.ExtensionContext} context
 */
export function activate(context) {
	setAuthContext(context);
	setClientDebug(debug);
	const provider = new CodexChatProvider();

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('openai-codex', provider),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('openai-codex.manage', async () => {
			const r = await manageAuth();
			if (
				r === 'signed-in' ||
				r === 'refreshed' ||
				r === 'signed-out' ||
				r === 'missing'
			) {
				provider.fireDidChangeModels();
			}
		}),
		vscode.commands.registerCommand('openai-codex.signIn', async () => {
			const ok = await signInInteractive();
			if (ok) provider.fireDidChangeModels();
		}),
		vscode.commands.registerCommand('openai-codex.refreshAuth', async () => {
			const r = await manageAuth();
			if (r === 'refreshed' || r === 'signed-in') provider.fireDidChangeModels();
		}),
		vscode.commands.registerCommand('openai-codex.refreshModels', async () => {
			provider.fireDidChangeModels();
			try {
				const models = await provider.getModels(true);
				vscode.window.showInformationMessage(
					`Codex: ${models.length} model(s) · ${await authStatusText()}`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const act = await vscode.window.showErrorMessage(
					`Codex refresh failed: ${msg}`,
					'Sign in with ChatGPT',
				);
				if (act) {
					const ok = await signInInteractive();
					if (ok) provider.fireDidChangeModels();
				}
			}
		}),
		vscode.commands.registerCommand('openai-codex.status', async () => {
			vscode.window.showInformationMessage(`Codex: ${await authStatusText()}`);
		}),
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('openaiCodex')) {
				provider.fireDidChangeModels();
				scheduleRefresh(provider, context);
			}
		}),
	);

	scheduleRefresh(provider, context);
	logAlways('[ext] Codex Chat Provider activated');
	getChannel();
}

/**
 * @param {import('./provider.js').CodexChatProvider} provider
 * @param {vscode.ExtensionContext} context
 */
function scheduleRefresh(provider, context) {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}
	const minutes = vscode.workspace
		.getConfiguration('openaiCodex')
		.get('refreshIntervalMinutes');
	const n = typeof minutes === 'number' ? minutes : 60;
	if (n <= 0) return;
	refreshTimer = setInterval(() => provider.fireDidChangeModels(), n * 60_000);
	context.subscriptions.push({
		dispose: () => {
			if (refreshTimer) clearInterval(refreshTimer);
		},
	});
}

export function deactivate() {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}
}
