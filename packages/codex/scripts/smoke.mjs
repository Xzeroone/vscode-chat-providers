#!/usr/bin/env node
/**
 * Smoke: load OAuth from ~/.codex, list models, stream a short reply.
 * Avoids importing out/auth.js (depends on vscode module).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverModels } from '../out/models.js';
import { streamCodexResponse } from '../out/client.js';

function loadCodex() {
	const p = path.join(os.homedir(), '.codex', 'auth.json');
	const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
	const t = raw.tokens;
	return {
		access: t.access_token,
		accountId: t.account_id,
		refresh: t.refresh_token,
	};
}

const tokens = loadCodex();
console.log('account', tokens.accountId.slice(0, 8) + '…');

const models = await discoverModels({
	access: tokens.access,
	accountId: tokens.accountId,
	hideHidden: true,
});
console.log(`models (${models.length}):`);
for (const m of models) {
	console.log(
		`  ${m.id}  levels=[${m.thinkingLevels.join(',')}] ctx=${m.contextWindow} max=${m.maxTokens}`,
	);
}

const pick = models.find((m) => m.id.includes('luna')) || models[0];
process.stdout.write(`\nstream ${pick.id}: `);
let text = '';
await streamCodexResponse({
	access: tokens.access,
	accountId: tokens.accountId,
	model: pick.id,
	input: [
		{
			role: 'user',
			content: [{ type: 'input_text', text: 'Reply with exactly: hello codex' }],
		},
	],
	reasoningEffort: pick.thinkingLevels.includes('low') ? 'low' : pick.thinkingLevels[0],
	onText: (d) => {
		text += d;
		process.stdout.write(d);
	},
});
console.log('\n---');
console.log(text.trim() === 'hello codex' || text.toLowerCase().includes('hello') ? 'OK' : 'WARN: ' + text);
