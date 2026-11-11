/** Transparent tool-argument sanitation layer (`tools/pre-execute`).
 *
 * Production session logs (4 days, 5961 tool calls, 300 failures) show a
 * recurring failure class where the model emits a composite argument in the
 * wrong JSON shape and the tool's own validation rejects it — the retry loop
 * then often repeats the SAME shape (worst observed: 8 identical failures in
 * a row). Two shapes dominate:
 *
 * 1. Stringified JSON composites: `view_range: "[100, 145]"` (a JSON string
 *    instead of the native array; 24 failures), `input: "{...}"` for
 *    cordis_inspect_query (3). The deterministic fix is one JSON.parse.
 * 2. Empty string for an enum-ish field: `read` with `encoding: ""`
 *    (26 failures) — the tool wants the field absent, not blank.
 *
 * This layer coerces those shapes BEFORE the tool implementations validate
 * (better-edit's requireViewRange / normalizeEncoding, or the native
 * defineTool INVALID_ARGS check) and before guards/approvals observe the
 * arguments, so the call succeeds transparently instead of burning a retry.
 *
 * Conservative by construction:
 * - ONLY whitelisted field names are touched (observed-broken plus same-shape
 *   kin); content-bearing string fields like `command` are never parsed.
 * - A stringified value is replaced only when JSON.parse yields a value that
 *   satisfies the field's structural assertion. Anything else keeps the
 *   original string so the tool's own [TO MODEL] error reaches the model
 *   unchanged — sanitation must never swallow or rewrite a real error.
 * - Any internal error fails open (next()), never denies, never throws.
 */

/** Structural assertions for whitelisted fields (tool-level code validates
 *  the contents; we only gate the composite SHAPE). */
const isPairRange = (value) =>
	Array.isArray(value) && value.length === 2 &&
	value.every((item) => Number.isInteger(item) && item > 0);
const isPlainArray = (value) => Array.isArray(value);
const isPlainObject = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Field-name whitelist → structural assertion. Field names are narrow enough
 *  to stand alone (view_range/edits: str_replace_editor; windows: read;
 *  input: cordis_inspect_query) — no tool-name gate, so future tools reusing
 *  the same names get the same tolerance. */
const SHAPE_FIELDS = {
	view_range: isPairRange,
	windows: isPlainArray,
	edits: isPlainArray,
	input: isPlainObject,
};

/** Fields where an empty string means "not provided" (tool default applies). */
const EMPTY_UNSET_FIELDS = ["encoding"];

/** Coerce known broken argument shapes. Returns `{ args, fixes }` when at
 *  least one coercion applied, `null` when the arguments are clean (or not a
 *  plain object). Pure: never mutates the input object. */
export function sanitizeToolArgs(args) {
	if (args === null || typeof args !== "object" || Array.isArray(args))
		return null;
	const out = { ...args };
	const fixes = [];
	for (const [field, assert] of Object.entries(SHAPE_FIELDS)) {
		const value = out[field];
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) continue;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!assert(parsed)) continue;
		out[field] = parsed;
		fixes.push(`${field}: stringified JSON -> ${Array.isArray(parsed) ? "array" : "object"}`);
	}
	for (const field of EMPTY_UNSET_FIELDS) {
		if (out[field] === "") {
			delete out[field];
			fixes.push(`${field}: "" -> unset`);
		}
	}
	return fixes.length > 0 ? { args: out, fixes } : null;
}

/** Mount the sanitation layer (one `tools/pre-execute` listener). Runs before
 *  guards and before every tool implementation's own validation; replaces
 *  `exec.arguments` wholesale (lossless plain JSON) when a known shape was
 *  coerced, then always calls next(). */
export function applyToolArgsSanitize(ctx, config) {
	const warn = (message) => ctx.logger.warn(`dsh-switchman: ${message}`);
	ctx.on("tools/pre-execute", (exec, next) => {
		try {
			const result = sanitizeToolArgs(exec?.arguments);
			if (result !== null) {
				exec.arguments = result.args;
				ctx.logger.debug(
					`dsh-switchman: sanitized ${exec?.name ?? "?"} arguments (${result.fixes.join("; ")})`,
				);
			}
			return next();
		} catch (error) {
			warn(`tool-args sanitation failed open: ${error?.message ?? error}`);
			return next();
		}
	});
}
