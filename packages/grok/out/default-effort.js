/**
 * Fixed smart defaults for thinking effort (not adaptive auto).
 *
 * - Ladder includes medium → default medium
 * - Ladder is off/high style (no low, no medium) → default high
 * - Otherwise first useful level (prefer high over low if only those)
 */

/**
 * @param {string[] | undefined} levels
 * @returns {string | undefined}
 */
export function smartDefaultThinkingLevel(levels) {
	const L = (levels || []).map((x) => String(x).toLowerCase());
	if (!L.length) return undefined;

	if (L.includes('medium')) return 'medium';

	// off → high (or off → high → max): no low/medium steps
	const hasLow = L.includes('low') || L.includes('minimal');
	const hasMedium = L.includes('medium');
	if (L.includes('high') && !hasLow && !hasMedium) return 'high';

	if (L.includes('high')) return 'high';
	if (L.includes('low')) return 'low';
	if (L.includes('max')) return 'max';
	// skip pure off as default when anything else exists
	const nonOff = L.find((l) => l !== 'off' && l !== 'none');
	return nonOff || L[0];
}
