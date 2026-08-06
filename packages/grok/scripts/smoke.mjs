#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverModels } from '../out/models.js';
import { streamChat } from '../out/client.js';

function loadAccess() {
	// Prefer Grok CLI
	const grokPath = path.join(os.homedir(), '.grok', 'auth.json');
	if (fs.existsSync(grokPath)) {
		const raw = JSON.parse(fs.readFileSync(grokPath, 'utf8'));
		const entry = Object.values(raw).find((v) => v?.key || v?.access_token);
		if (entry) return entry.key || entry.access_token;
	}
	const piPath = path.join(os.homedir(), '.pi', 'agent', 'auth.json');
	const pi = JSON.parse(fs.readFileSync(piPath, 'utf8')).xai;
	return pi.access;
}

const access = loadAccess();
const models = await discoverModels({ access });
console.log(`models (${models.length}):`);
for (const m of models) {
	console.log(
		`  ${m.id}  think=[${m.thinkingLevels.join(',') || '-'}] ctx=${m.contextWindow}`,
	);
}
const pick = models.find((m) => m.id === 'grok-4.5') || models[0];
process.stdout.write(`\nstream ${pick.id}: `);
let text = '';
await streamChat({
	access,
	model: pick.id,
	messages: [{ role: 'user', content: 'Reply with exactly: hello grok' }],
	reasoningEffort: pick.thinkingLevels.includes('low') ? 'low' : pick.thinkingLevels[0],
	maxTokens: 64,
	onText: (d) => {
		text += d;
		process.stdout.write(d);
	},
});
console.log('\n---', text.toLowerCase().includes('hello') ? 'OK' : 'WARN');
