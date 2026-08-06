/**
 * Per-model thinking / reasoning levels for Ollama Cloud.
 *
 * Priority:
 *  1. Live flag: /api/show capabilities includes "thinking"
 *  2. models.dev reasoning_options (effort values / toggle) when present
 *  3. Family heuristics by model id (fallback for brand-new models)
 *
 * API wire formats:
 *   - reasoning_effort: "none" | "low" | "medium" | "high" | "max"
 *   - think: boolean
 */

/** UI ladder (order matters for clamping). */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'];

export const THINKING_LABELS = {
	off: 'Off',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	max: 'Max',
};

export const THINKING_DESCRIPTIONS = {
	off: 'No extra reasoning (or minimal)',
	low: 'Light reasoning',
	medium: 'Moderate reasoning',
	high: 'Deep reasoning',
	max: 'Maximum reasoning',
};

/**
 * @typedef {{ reasoning_effort?: string, think?: boolean } | null} LevelWire
 * @typedef {Record<string, LevelWire>} LevelMap
 */

const DEFAULT_MAP = {
	off: { reasoning_effort: 'none', think: false },
	low: { reasoning_effort: 'low', think: true },
	medium: { reasoning_effort: 'medium', think: true },
	high: { reasoning_effort: 'high', think: true },
	max: { reasoning_effort: 'max', think: true },
};

const DEEPSEEK_GLM_MAP = {
	off: { reasoning_effort: 'none', think: false },
	low: null,
	medium: null,
	high: { reasoning_effort: 'high', think: true },
	max: { reasoning_effort: 'max', think: true },
};

const GPT_OSS_MAP = {
	off: { reasoning_effort: 'none', think: false },
	low: { reasoning_effort: 'low', think: true },
	medium: { reasoning_effort: 'medium', think: true },
	high: { reasoning_effort: 'high', think: true },
	max: null,
};

const NEMOTRON_SUPER_MAP = {
	off: { reasoning_effort: 'none', think: false },
	low: { reasoning_effort: 'low', think: true },
	medium: null,
	high: { reasoning_effort: 'high', think: true },
	max: null,
};

const NEMOTRON_ULTRA_MAP = {
	off: { reasoning_effort: 'none', think: false },
	low: null,
	medium: { reasoning_effort: 'medium', think: true },
	high: { reasoning_effort: 'high', think: true },
	max: null,
};

const KIMI_K3_MAP = {
	off: { reasoning_effort: 'none', think: false },
	low: { reasoning_effort: 'low', think: true },
	medium: null,
	high: { reasoning_effort: 'high', think: true },
	max: { reasoning_effort: 'max', think: true },
};

const BOOLEAN_MAP = {
	off: { reasoning_effort: 'none', think: false },
	low: null,
	medium: null,
	high: { reasoning_effort: 'high', think: true },
	max: null,
};

/**
 * @param {string} id
 * @param {boolean} thinkingCapability
 * @param {Array<{ type?: string, values?: string[] }> | undefined} reasoningOptions  from models.dev
 * @returns {{ levels: string[], levelMap: LevelMap, source: string } | null}
 */
export function resolveThinkingConfig(id, thinkingCapability, reasoningOptions) {
	if (!thinkingCapability) {
		return null;
	}

	const fromRegistry = levelMapFromReasoningOptions(reasoningOptions);
	const levelMap = fromRegistry || pickLevelMap(id);
	const source = fromRegistry ? 'models.dev' : 'heuristic';

	const levels = THINKING_LEVELS.filter((l) => levelMap[l] != null);
	if (levels.length < 2) {
		return null;
	}
	return { levels, levelMap, source };
}

/**
 * Build a level map from models.dev reasoning_options.
 * @param {Array<{ type?: string, values?: string[] }> | undefined} options
 * @returns {LevelMap | null}
 */
function levelMapFromReasoningOptions(options) {
	if (!Array.isArray(options) || options.length === 0) {
		return null;
	}

	/** @type {Set<string>} */
	const efforts = new Set();
	let hasToggle = false;

	for (const opt of options) {
		if (!opt || typeof opt !== 'object') continue;
		if (opt.type === 'toggle') {
			hasToggle = true;
		}
		if (opt.type === 'effort' && Array.isArray(opt.values)) {
			for (const v of opt.values) {
				const n = normalizeEffort(v);
				if (n) efforts.add(n);
			}
		}
	}

	if (efforts.size === 0 && hasToggle) {
		return { ...BOOLEAN_MAP };
	}
	if (efforts.size === 0) {
		return null;
	}

	// Always offer Off when we have effort values (toggle implies off/on).
	/** @type {LevelMap} */
	const map = {
		off: { reasoning_effort: 'none', think: false },
		low: null,
		medium: null,
		high: null,
		max: null,
	};

	for (const e of efforts) {
		if (e === 'off' || e === 'none') {
			map.off = { reasoning_effort: 'none', think: false };
			continue;
		}
		if (THINKING_LEVELS.includes(e) && e !== 'off') {
			map[e] = { reasoning_effort: e === 'max' ? 'max' : e, think: true };
		}
	}

	// If registry only listed efforts without none, still keep off.
	const enabled = THINKING_LEVELS.filter((l) => map[l] != null);
	return enabled.length >= 2 ? map : null;
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function normalizeEffort(v) {
	if (typeof v !== 'string') return null;
	const s = v.toLowerCase().trim();
	if (s === 'none' || s === 'off') return 'off';
	if (s === 'minimal' || s === 'min') return 'low';
	if (s === 'xhigh' || s === 'extra-high' || s === 'extra_high') return 'max';
	if (['low', 'medium', 'high', 'max'].includes(s)) return s;
	return null;
}

/**
 * @param {string} id
 * @returns {LevelMap}
 */
function pickLevelMap(id) {
	const m = (id || '').toLowerCase();

	if (m.startsWith('deepseek')) return DEEPSEEK_GLM_MAP;
	if (m.startsWith('glm')) return DEEPSEEK_GLM_MAP;
	if (m.startsWith('gpt-oss')) return GPT_OSS_MAP;
	if (m.startsWith('nemotron-3-super')) return NEMOTRON_SUPER_MAP;
	if (m.startsWith('nemotron-3-ultra')) return NEMOTRON_ULTRA_MAP;
	if (m === 'kimi-k3' || m.startsWith('kimi-k3:')) return KIMI_K3_MAP;

	if (m.startsWith('kimi-k2')) return BOOLEAN_MAP;
	if (m.startsWith('qwen')) return BOOLEAN_MAP;
	if (m.startsWith('gemma')) return BOOLEAN_MAP;
	if (m.startsWith('minimax')) return BOOLEAN_MAP;
	if (m.startsWith('nemotron-3-nano')) return BOOLEAN_MAP;
	if (m.startsWith('mistral')) return BOOLEAN_MAP;

	return DEFAULT_MAP;
}

/**
 * @param {string[]} levels
 * @param {string} requested
 */
export function clampThinkingLevel(levels, requested) {
	const level = (requested || 'off').toLowerCase().trim();
	if (levels.includes(level)) return level;

	const order = THINKING_LEVELS;
	const idx = order.indexOf(level);
	if (idx === -1) return levels[0] ?? 'off';

	for (let i = idx; i < order.length; i++) {
		if (levels.includes(order[i])) return order[i];
	}
	for (let i = idx; i >= 0; i--) {
		if (levels.includes(order[i])) return order[i];
	}
	return levels[0] ?? 'off';
}

/**
 * @param {LevelMap} levelMap
 * @param {string} uiLevel
 * @returns {{ reasoning_effort?: string, think?: boolean }}
 */
export function wireForLevel(levelMap, uiLevel) {
	const wire = levelMap[uiLevel];
	if (wire && typeof wire === 'object') {
		return { ...wire };
	}
	return { reasoning_effort: 'none', think: false };
}
