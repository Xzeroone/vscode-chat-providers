/**
 * Auto max-output resolution for Codex (no vscode dependency).
 *
 * Catalog rarely exposes a dedicated output cap; we derive from context and
 * always hard-clamp so max_output_tokens never blows past API limits.
 */

/** Safe ceiling observed / Chat-friendly for Codex Responses */
export const HARD_MAX_OUTPUT_TOKENS = 65_536;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/**
 * @param {number} contextWindow
 * @param {number} [hardCap]
 */
export function deriveMaxOutputTokens(contextWindow, hardCap = HARD_MAX_OUTPUT_TOKENS) {
	const ctx = Math.max(4096, contextWindow || 128_000);
	// ~20% of context, floor 8k, ceiling hardCap
	const raw = Math.floor(ctx * 0.2);
	return Math.min(hardCap, Math.max(8_192, raw));
}

/**
 * Pull a catalog-declared max output if present.
 * @param {object} raw
 * @returns {number | undefined}
 */
export function catalogMaxOutput(raw) {
	if (!raw || typeof raw !== 'object') return undefined;
	const candidates = [
		raw.max_output_tokens,
		raw.max_completion_tokens,
		raw.max_tokens,
		raw.output_token_limit,
		raw.limit?.output,
	];
	for (const c of candidates) {
		if (typeof c === 'number' && Number.isFinite(c) && c > 0) return Math.floor(c);
	}
	return undefined;
}

/**
 * Trust catalog output only when it is clearly an output budget, not context.
 * @param {number | undefined} catalogMax
 * @param {number} contextWindow
 */
export function trustworthyCatalogOutput(catalogMax, contextWindow) {
	if (typeof catalogMax !== 'number' || !(catalogMax > 0)) return undefined;
	if (contextWindow > 0 && catalogMax >= contextWindow * 0.5) return undefined;
	if (catalogMax > HARD_MAX_OUTPUT_TOKENS) return undefined;
	return Math.floor(catalogMax);
}

/**
 * @param {{
 *   contextWindow: number,
 *   catalogMax?: number,
 *   settingMax?: number,
 *   hardCap?: number,
 * }} p
 * @returns {{ maxTokens: number, maxSource: 'catalog' | 'setting' | 'derived' }}
 */
export function resolveMaxOutputTokens(p) {
	const hardCap = p.hardCap ?? HARD_MAX_OUTPUT_TOKENS;
	const ctx = Math.max(1024, p.contextWindow || 128_000);
	const cat = trustworthyCatalogOutput(p.catalogMax, ctx);
	const setting =
		typeof p.settingMax === 'number' && p.settingMax > 0
			? Math.min(Math.floor(p.settingMax), hardCap)
			: undefined;

	let maxTokens = cat || setting || deriveMaxOutputTokens(ctx, hardCap);
	const maxFit = Math.max(1024, ctx - 1024);
	maxTokens = Math.min(maxTokens, maxFit, hardCap);
	if (maxTokens >= ctx * 0.9) {
		maxTokens = deriveMaxOutputTokens(ctx, hardCap);
	}

	return {
		maxTokens: Math.max(1024, Math.floor(maxTokens)),
		maxSource: cat ? 'catalog' : setting ? 'setting' : 'derived',
	};
}

/**
 * Final wire clamp (request path).
 * @param {unknown} n
 * @param {number} [hardCap]
 */
export function clampMaxTokens(n, hardCap = HARD_MAX_OUTPUT_TOKENS) {
	const v = Math.floor(Number(n));
	if (!Number.isFinite(v) || v <= 0) {
		return Math.min(DEFAULT_MAX_OUTPUT_TOKENS, hardCap);
	}
	return Math.min(hardCap, Math.max(1, v));
}
