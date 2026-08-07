import * as vscode from 'vscode';
import { GrokChatProvider } from './provider.js';
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
	const provider = new GrokChatProvider();

	context.subscriptions.push(
		// Vendor id must NOT be 'xai' — GitHub Copilot Chat BYOK already
		// registers 'xai' and VS Code rejects the second registration
		// ("Chat model provider for vendor xai is already registered"),
		// which makes models appear then vanish / show as duplicates.
		vscode.lm.registerLanguageModelChatProvider('grok', provider),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('xai.signIn', async () => {
			if (await signInInteractive()) provider.fireDidChangeModels();
		}),
		vscode.commands.registerCommand('xai.manage', async () => {
			const r = await manageAuth();
			if (['signed-in', 'refreshed', 'signed-out'].includes(r)) {
				provider.fireDidChangeModels();
			}
		}),
		vscode.commands.registerCommand('xai.refreshAuth', async () => {
			const r = await manageAuth();
			if (r === 'refreshed' || r === 'signed-in') provider.fireDidChangeModels();
		}),
		vscode.commands.registerCommand('xai.refreshModels', async () => {
			provider.fireDidChangeModels();
			try {
				const models = await provider.getModels(true);
				vscode.window.showInformationMessage(
					`Grok: ${models.length} model(s) · ${await authStatusText()}`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const act = await vscode.window.showErrorMessage(
					`Grok refresh failed: ${msg}`,
					'Sign in',
				);
				if (act && (await signInInteractive())) provider.fireDidChangeModels();
			}
		}),
		vscode.commands.registerCommand('xai.status', async () => {
			vscode.window.showInformationMessage(`Grok: ${await authStatusText()}`);
		}),
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('xai')) {
				provider.fireDidChangeModels();
				scheduleRefresh(provider, context);
			}
		}),
	);

	scheduleRefresh(provider, context);
	logAlways('[ext] Grok Chat Provider activated');
	getChannel();
}

/**
 * @param {GrokChatProvider} provider
 * @param {vscode.ExtensionContext} context
 */
function scheduleRefresh(provider, context) {
	if (refreshTimer) clearInterval(refreshTimer);
	const n = vscode.workspace.getConfiguration('xai').get('refreshIntervalMinutes');
	const minutes = typeof n === 'number' ? n : 60;
	if (minutes <= 0) return;
	refreshTimer = setInterval(() => provider.fireDidChangeModels(), minutes * 60_000);
	context.subscriptions.push({
		dispose: () => {
			if (refreshTimer) clearInterval(refreshTimer);
		},
	});
}

export function deactivate() {
	if (refreshTimer) clearInterval(refreshTimer);
}
