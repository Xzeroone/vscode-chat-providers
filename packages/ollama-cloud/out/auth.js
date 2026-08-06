/**
 * API key resolution: SecretStorage → settings → OLLAMA_API_KEY env.
 */
import * as vscode from 'vscode';
import { debug, logAlways } from './debug.js';

const SECRET_KEY = 'ollamaCloud.apiKey';

/**
 * @param {vscode.ExtensionContext} context
 */
export class AuthStore {
	/** @param {vscode.ExtensionContext} context */
	constructor(context) {
		this.context = context;
	}

	/**
	 * @returns {Promise<string | undefined>}
	 */
	async getApiKey() {
		const secret = await this.context.secrets.get(SECRET_KEY);
		if (secret && secret.trim()) {
			debug('[auth] key from SecretStorage');
			return secret.trim();
		}

		const settingsKey = vscode.workspace.getConfiguration('ollamaCloud').get('apiKey');
		if (typeof settingsKey === 'string' && settingsKey.trim()) {
			debug('[auth] key from settings ollamaCloud.apiKey');
			return settingsKey.trim();
		}

		const envKey = process.env.OLLAMA_API_KEY;
		if (envKey && envKey.trim()) {
			debug('[auth] key from OLLAMA_API_KEY');
			return envKey.trim();
		}

		return undefined;
	}

	/**
	 * @param {string} key
	 */
	async setApiKey(key) {
		await this.context.secrets.store(SECRET_KEY, key.trim());
		logAlways('[auth] API key stored in SecretStorage');
	}

	async clearApiKey() {
		await this.context.secrets.delete(SECRET_KEY);
		logAlways('[auth] API key cleared from SecretStorage');
	}

	/**
	 * Interactive set/clear/status.
	 * @returns {Promise<'set' | 'cleared' | 'status' | 'cancelled'>}
	 */
	async manage() {
		const existing = await this.getApiKey();
		const hasKey = Boolean(existing);

		const pick = await vscode.window.showQuickPick(
			[
				{
					label: hasKey ? '$(key) Update API Key' : '$(key) Set API Key',
					description: hasKey ? 'Replace stored key' : 'Store in SecretStorage',
					action: 'set',
				},
				...(hasKey
					? [
							{
								label: '$(trash) Clear API Key',
								description: 'Remove from SecretStorage',
								action: 'clear',
							},
						]
					: []),
				{
					label: '$(info) Status',
					description: hasKey
						? `Key present (ends with …${existing.slice(-4)})`
						: 'No key (SecretStorage / settings / OLLAMA_API_KEY)',
					action: 'status',
				},
			],
			{ title: 'Ollama Cloud', placeHolder: 'Manage API key' },
		);

		if (!pick) {
			return 'cancelled';
		}

		if (pick.action === 'status') {
			vscode.window.showInformationMessage(
				hasKey
					? `Ollama Cloud API key is configured (…${existing.slice(-4)}).`
					: 'No Ollama Cloud API key. Use “Set API Key” or set OLLAMA_API_KEY.',
			);
			return 'status';
		}

		if (pick.action === 'clear') {
			await this.clearApiKey();
			vscode.window.showInformationMessage('Ollama Cloud API key cleared.');
			return 'cleared';
		}

		const key = await vscode.window.showInputBox({
			title: 'Ollama Cloud API Key',
			prompt: 'Paste your key from https://ollama.com/settings/keys',
			password: true,
			ignoreFocusOut: true,
			placeHolder: 'ollama-… or key string',
			validateInput: (v) => (v?.trim() ? undefined : 'API key is required'),
		});
		if (!key) {
			return 'cancelled';
		}
		await this.setApiKey(key);
		vscode.window.showInformationMessage('Ollama Cloud API key saved.');
		return 'set';
	}
}
