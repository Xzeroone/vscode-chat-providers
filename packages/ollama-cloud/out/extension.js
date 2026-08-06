/**
 * Ollama Cloud Chat Provider — extension entry.
 */
import * as vscode from 'vscode';
import { AuthStore } from './auth.js';
import { OllamaCloudChatProvider } from './provider.js';
import { setClientDebug } from './client.js';
import { debug, getChannel, logAlways } from './debug.js';

/** @type {ReturnType<typeof setInterval> | undefined} */
let refreshTimer;

/**
 * @param {vscode.ExtensionContext} context
 */
export function activate(context) {
	setClientDebug(debug);
	const auth = new AuthStore(context);
	const provider = new OllamaCloudChatProvider(auth);

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('ollama-cloud', provider),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ollama-cloud.manage', async () => {
			const result = await auth.manage();
			if (result === 'set' || result === 'cleared') {
				provider.fireDidChangeModels();
			}
		}),
		vscode.commands.registerCommand('ollama-cloud.setApiKey', async () => {
			const key = await vscode.window.showInputBox({
				title: 'Ollama Cloud API Key',
				prompt: 'Paste your key from https://ollama.com/settings/keys',
				password: true,
				ignoreFocusOut: true,
				validateInput: (v) => (v?.trim() ? undefined : 'API key is required'),
			});
			if (!key) return;
			await auth.setApiKey(key);
			provider.fireDidChangeModels();
			vscode.window.showInformationMessage('Ollama Cloud API key saved.');
		}),
		vscode.commands.registerCommand('ollama-cloud.clearApiKey', async () => {
			await auth.clearApiKey();
			provider.fireDidChangeModels();
			vscode.window.showInformationMessage('Ollama Cloud API key cleared.');
		}),
		vscode.commands.registerCommand('ollama-cloud.refreshModels', async () => {
			provider.fireDidChangeModels();
			try {
				const models = await provider.getModels(true);
				vscode.window.showInformationMessage(
					`Ollama Cloud: ${models.length} model(s) discovered.`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Ollama Cloud refresh failed: ${msg}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('ollamaCloud')) {
				debug('[ext] config changed — refreshing models');
				provider.fireDidChangeModels();
				scheduleRefresh(provider, context);
			}
		}),
	);

	scheduleRefresh(provider, context);
	logAlways('[ext] Ollama Cloud Chat Provider activated');
	getChannel(); // ensure channel exists
}

/**
 * @param {OllamaCloudChatProvider} provider
 * @param {vscode.ExtensionContext} context
 */
function scheduleRefresh(provider, context) {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}
	const minutes = vscode.workspace
		.getConfiguration('ollamaCloud')
		.get('refreshIntervalMinutes');
	const n = typeof minutes === 'number' ? minutes : 60;
	if (n <= 0) return;

	refreshTimer = setInterval(
		() => {
			debug('[ext] periodic model refresh');
			provider.fireDidChangeModels();
		},
		n * 60_000,
	);
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
