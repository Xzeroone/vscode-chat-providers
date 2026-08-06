/**
 * Debug logging to the "Codex" output channel.
 */
import * as vscode from 'vscode';

/** @type {vscode.OutputChannel | undefined} */
let channel;

export function getChannel() {
	if (!channel) {
		channel = vscode.window.createOutputChannel('Codex');
	}
	return channel;
}

function line(...args) {
	return args
		.map((a) => {
			if (typeof a === 'string') return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(' ');
}

export function debug(...args) {
	const enabled = vscode.workspace.getConfiguration('openaiCodex').get('debug') === true;
	if (!enabled) return;
	getChannel().appendLine(`[${new Date().toISOString()}] ${line(...args)}`);
}

export function logAlways(...args) {
	getChannel().appendLine(`[${new Date().toISOString()}] ${line(...args)}`);
}
