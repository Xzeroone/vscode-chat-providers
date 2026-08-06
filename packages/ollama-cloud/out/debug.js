/**
 * Debug logging to the "Ollama Cloud" output channel.
 */
import * as vscode from 'vscode';

/** @type {vscode.OutputChannel | undefined} */
let channel;

export function getChannel() {
	if (!channel) {
		channel = vscode.window.createOutputChannel('Ollama Cloud');
	}
	return channel;
}

export function debug(...args) {
	const enabled = vscode.workspace.getConfiguration('ollamaCloud').get('debug') === true;
	if (!enabled) {
		return;
	}
	const line = args
		.map((a) => {
			if (typeof a === 'string') return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(' ');
	getChannel().appendLine(`[${new Date().toISOString()}] ${line}`);
}

export function logAlways(...args) {
	const line = args
		.map((a) => {
			if (typeof a === 'string') return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(' ');
	getChannel().appendLine(`[${new Date().toISOString()}] ${line}`);
}
