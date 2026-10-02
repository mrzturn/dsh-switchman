/** dsh-switchman UI-locale bridge store (host half).
 *
 * The DeepSeek Harness UI language resolves on the renderer as
 * Host preference (settings ns "locale", field "preference") ??
 * navigator.languages ?? "en" (dsh-client-locale/lib/client.js). The host
 * half can read only the first link — when the user never explicitly chose
 * a language there is no host-side trace of the navigator fallback. So the
 * browser half reports the final active locale through
 * POST /api/dsh-switchman/ui-locale whenever it mounts; lang.js merges the
 * two sources (explicit preference wins, reported locale fills the gap).
 *
 * Module-level singleton on purpose: exactly one host bundle instance runs
 * per profile process, and the route family shares the value with the
 * language layer without extra wiring. Fail-open everywhere.
 */

/** Last locale tag reported by the client half ("" = never reported). */
let reported = "";

/** Normalize a reported tag: lowercase, trimmed, bounded (defensive). */
function normalizeTag(value) {
	if (typeof value !== "string") return "";
	const tag = value.trim().toLowerCase();
	return tag.length > 0 && tag.length <= 16 ? tag : "";
}

/** Store the client-reported active UI locale (unusable values ignored). */
export function setReportedUiLocale(value) {
	reported = normalizeTag(value);
}

/** The client-reported active UI locale ("" when none arrived yet). */
export function reportedUiLocale() {
	return reported;
}
