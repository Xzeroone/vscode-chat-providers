/**
 * Adaptive thinking effort: prefer the lowest level, raise only when
 * the request looks hard enough (no extra LLM call).
 *
 * Used when the user/UI selects "auto" or when defaultThinkingLevel is auto
 * (typical in Agents window where there is no Thinking Effort submenu).
 */

const COMPLEX_RE =
	/\b(refactor|architect|architecture|redesign|migrate|migration|debug|root\s*cause|investigate|why\s+does|how\s+does|design\s+system|multi[- ]?file|codebase|entire\s+project|prove|formal|security|vulnerabilit|race\s*condition|deadlock|performance|optimize|trade-?off|compare|evaluate|plan\s+out|step\s+by\s+step|complex|non-?trivial)\b/i;

const SIMPLE_RE =
	/\b(typo|rename|format|lint|what\s+is\s+\d|hello|hi\b|thanks|simple|quick|one[- ]liner|change\s+color|add\s+comment)\b/i;

/**
 * @param {string[]} available  e.g. ['low','medium','high'] or with 'off'
 * @returns {string[]} usable ladder lowest → highest (auto excluded)
 */
export function effortLadder(available) {
	const order = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
	const set = new Set((available || []).map((l) => String(l).toLowerCase()));
	return order.filter((l) => set.has(l));
}

/**
 * @param {string[]} available
 * @returns {string} lowest real level
 */
export function lowestEffort(available) {
	const ladder = effortLadder(available);
	return ladder[0] || 'low';
}

/**
 * Score 0..n → pick index on ladder.
 * @param {{
 *   text: string,
 *   messageCount?: number,
 *   toolCount?: number,
 *   availableLevels: string[],
 * }} opts
 * @returns {{ level: string, score: number, reasons: string[] }}
 */
export function pickAutoThinkingLevel(opts) {
	const ladder = effortLadder(opts.availableLevels);
	if (!ladder.length) {
		return { level: 'low', score: 0, reasons: ['no-levels'] };
	}

	const text = (opts.text || '').trim();
	const reasons = [];
	let score = 0;

	// Prefer lowest; only add when signals fire
	if (SIMPLE_RE.test(text) && text.length < 400) {
		reasons.push('simple-phrase');
		return { level: ladder[0], score: 0, reasons };
	}

	const len = text.length;
	if (len > 4000) {
		score += 3;
		reasons.push('long-prompt');
	} else if (len > 1500) {
		score += 2;
		reasons.push('medium-prompt');
	} else if (len > 600) {
		score += 1;
		reasons.push('short-plus-prompt');
	}

	if (COMPLEX_RE.test(text)) {
		score += 2;
		reasons.push('complex-keywords');
	}

	const turns = opts.messageCount ?? 1;
	if (turns >= 6) {
		score += 2;
		reasons.push('long-thread');
	} else if (turns >= 3) {
		score += 1;
		reasons.push('multi-turn');
	}

	const tools = opts.toolCount ?? 0;
	// Agent mode usually ships many tools — mild bump only
	if (tools >= 8) {
		score += 1;
		reasons.push('agent-tools');
	}

	// Map score → ladder index (0 = lowest)
	// 0 → 0, 1 → 0 or 1, 2–3 → mid, 4+ → high end
	let idx = 0;
	if (score >= 5) idx = ladder.length - 1;
	else if (score >= 3) idx = Math.min(ladder.length - 1, Math.ceil((ladder.length - 1) * 0.66));
	else if (score >= 2) idx = Math.min(ladder.length - 1, Math.ceil((ladder.length - 1) * 0.4));
	else if (score >= 1) idx = Math.min(1, ladder.length - 1);
	else idx = 0;

	// Never jump to absolute max unless score is high (save cost)
	if (idx === ladder.length - 1 && score < 5 && ladder.length > 2) {
		idx = ladder.length - 2;
		reasons.push('cap-below-max');
	}

	return { level: ladder[idx], score, reasons };
}

/**
 * Extract plain text from VS Code LM messages or OpenAI-ish arrays.
 * @param {readonly any[]} messages
 */
export function extractTextFromMessages(messages) {
	if (!messages?.length) return '';
	const parts = [];
	for (const msg of messages) {
		const content = msg?.content;
		if (typeof content === 'string') {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const p of content) {
			if (typeof p === 'string') parts.push(p);
			else if (p && typeof p.value === 'string') parts.push(p.value);
			else if (p && typeof p.text === 'string') parts.push(p.text);
			else if (p && p.type === 'input_text' && typeof p.text === 'string') parts.push(p.text);
			else if (p && p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
		}
	}
	return parts.join('\n');
}
