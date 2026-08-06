#!/usr/bin/env node
/**
 * Smoke-test discovery + thinking levels + streamed completion.
 * Usage: OLLAMA_API_KEY=... node scripts/smoke-discover.mjs
 */
import { discoverModels, streamChatCompletions } from '../out/client.js';
import { resolveThinkingConfig, wireForLevel } from '../out/thinking-levels.js';

const apiKey = process.env.OLLAMA_API_KEY;
if (!apiKey) {
	console.error('Set OLLAMA_API_KEY');
	process.exit(1);
}

const models = await discoverModels({
	apiKey,
	toolsOnly: true,
	defaultMaxTokens: null,
	useRegistry: true,
	resolveThinking: (id, thinking, opts) => resolveThinkingConfig(id, thinking, opts),
});
console.log(`discovered ${models.length} tool-capable models:`);
for (const m of models) {
	const levels = m.thinkingLevels?.join(',') || '-';
	console.log(
		`  - ${m.id}  ctx=${m.contextWindow} max_out=${m.maxTokens}(${m.meta?.maxSource}) ` +
			`think=${m.thinking} levels=[${levels}](${m.meta?.thinkingSource || '-'}) vision=${m.imageInput}`,
	);
}

const pick =
	models.find((m) => m.id.startsWith('gpt-oss')) ||
	models.find((m) => m.thinkingLevels?.includes('high')) ||
	models[0];
if (!pick) {
	console.error('no models');
	process.exit(1);
}

const level = pick.thinkingLevels?.includes('low')
	? 'low'
	: pick.thinkingLevels?.includes('high')
		? 'high'
		: pick.thinkingLevels?.[0] || 'off';
const wire = pick.thinkingLevelMap
	? wireForLevel(pick.thinkingLevelMap, level)
	: {};

process.stdout.write(`\nstream ${pick.id} thinking=${level} wire=${JSON.stringify(wire)}: `);
let text = '';
let reasoning = '';
await streamChatCompletions({
	apiKey,
	model: pick.id,
	messages: [{ role: 'user', content: 'What is 12*12? one number only' }],
	maxTokens: 80,
	reasoningEffort: wire.reasoning_effort,
	think: wire.think,
	onText: (d) => {
		text += d;
		process.stdout.write(d);
	},
	onReasoning: (d) => {
		reasoning += d;
	},
});
console.log('\n---');
console.log('content:', text.trim() || '(empty)');
console.log('reasoning_chars:', reasoning.length);
console.log(text.trim() || reasoning.length ? 'OK' : 'WARN: empty');
