/** dsh-switchman constraint-recognition layer (refactor guide §4.1, P0 item 1)
 * + skill annotation layer (§4.2, P0 item 2).
 *
 * Recognizes WHEN a dispatch-relevant constraint applies to the current turn
 * and surfaces it as ONE short advisory tag line near the pools table:
 * `[SWITCHMAN:CONSTRAINTS] hit: skill_match, verification_required(classifier)`.
 * P0 scope: advice only — nothing here changes dispatch behavior; the pools
 * doctrine text is untouched (the tag line states facts, it adds no rule).
 *
 * Recognition is layered by determinism (guide §4.1):
 * - deterministic: context_pressure (watermark counters via context-watch's
 *   pure helpers) and skill_match (word-boundary match of annotated skill
 *   names against the newest human message). No classifier involved.
 * - classifier: host/intent.js's chat classifier may return an optional
 *   `constraints` array in its strict-JSON verdict (weak signal, confidence
 *   carried). Old verdicts without the field stay byte-compatible.
 * - advisory: P0 has no runtime advisory source (verification_required's
 *   "core/security/data-consistency" self-assessment is doctrine guidance,
 *   not a computed signal); the renderer already supports the source label
 *   for later phases.
 *
 * Fail-open everywhere: any shape mismatch, missing service, or throw inside
 * the section closure renders "" — the session keeps its current prompt and
 * only loses the advisory line. The whole layer is off unless
 * `constraintsEnabled` is true (default false), in which case the section
 * renders "" on every assembly = zero prompt diff vs. the layer not existing.
 *
 * Skill annotation layer (§4.2): bundled skills may declare `constraints: a,
 * b` in their SKILL.md frontmatter; annotated skills are listed in a compact
 * `[SWITCHMAN:SKILLS]` table (name + tags + estimated size) so the dispatch
 * layer can later (P1) match requests to constrained skills WITHOUT reading
 * every skill body. Un-annotated skills are NOT listed — the host's native
 * available-skills catalog already carries them; this table only adds the
 * annotation enrichment (the §4.2 progressive-disclosure pattern).
 *
 * MODEL-VISIBILITY: the injected line carries no numeric watermark values
 * (same policy as context-watch.js:266) — only tag names, source labels, and
 * the skills table's coarse size estimates.
 *
 * Zero new dependencies; ESM; same conventions as the other host/*.js layers.
 */

import { readFileSync } from "node:fs";
import { sessionIdOf, measureNow, readThresholds, levelOf } from "./context-watch.js";

/** Final position of the constraints section: right after dispatch (10400),
 * before context-trim (10450) — constraint tags read best beside the pools
 * table they qualify, and every later section stays the "last word". */
const CONSTRAINTS_ORDER = 10405;

/** The closed constraint vocabulary (guide §4.1). Anything outside this set
 * is dropped wherever it enters (frontmatter, classifier output, calls). */
const CONSTRAINT_VOCABULARY = Object.freeze([
	"context_pressure",
	"verification_required",
	"capability_gap",
	"parallelizable",
	"permission_boundary",
	"skill_match",
]);

/** Signal sources, strongest first. A tag recognized by multiple layers
 * keeps only its strongest source. */
const SOURCE_PRECEDENCE = Object.freeze(["deterministic", "advisory", "classifier"]);

/** Skill-table row cap: bounds the injected block for pathological skill
 * sets; rows beyond the cap are silently dropped (annotated sets are small
 * by construction — the three bundled skills annotate at most three rows). */
const MAX_SKILL_ROWS = 12;

/** Newest-human-message text cap per session: skill_match only needs the
 * head of the message, never the whole body. */
const USER_TEXT_CAP = 2000;

/** Session-map cap: the per-session stores are keyed by session id and
 * evicted oldest-first; sessions are long-lived but bounded in practice. */
const SESSION_MAP_CAP = 256;

// ---------------------------------------------------------------------------
// Per-session stores (fail-open, plain Maps, oldest-first eviction)
// ---------------------------------------------------------------------------

/** sessionKey → { id, text, t } for the newest HUMAN user/message event. */
const lastUserBySession = new Map();

/** sessionKey → { turnKey, tags, t } recorded by host/intent.js when its
 * chat classifier returns an optional constraints payload. */
const classifierBySession = new Map();

/** sessionKey → turnKey last logged; keeps the constraint-hit log to one
 * line per turn instead of one per model call. */
const loggedTurnBySession = new Map();

function storeBounded(map, key, value) {
	if (map.has(key)) map.delete(key);
	map.set(key, value);
	if (map.size > SESSION_MAP_CAP) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
}

// ---------------------------------------------------------------------------
// Pure vocabulary helpers
// ---------------------------------------------------------------------------

/** Validated tag list from any raw input (string, array, junk): vocabulary
 * members only, deduped, canonical vocabulary order. */
function cleanConstraintTags(value) {
	const raw = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	const seen = new Set();
	for (const item of raw) {
		const tag = typeof item === "string" ? item.trim() : "";
		if (CONSTRAINT_VOCABULARY.includes(tag)) seen.add(tag);
	}
	return CONSTRAINT_VOCABULARY.filter((tag) => seen.has(tag));
}

/** Validated classifier constraints payload: accepts either a tag-string
 * array or `[{ tag, confidence }]` objects; clamps confidence into [0,1],
 * caps at 3 entries (the classifier is told the same cap). Returns null for
 * absent/empty/invalid input — callers treat null as "no weak signal",
 * never an error (backward compatibility with pre-constraints verdicts). */
function cleanClassifierConstraints(value) {
	if (value === null || value === undefined) return null;
	const raw = Array.isArray(value) ? value : [];
	const out = [];
	for (const item of raw) {
		if (out.length >= 3) break;
		const tag = typeof item === "object" && item !== null && typeof item.tag === "string" ? item.tag : typeof item === "string" ? item : "";
		if (!CONSTRAINT_VOCABULARY.includes(tag)) continue;
		if (out.some((entry) => entry.tag === tag)) continue;
		const confidence = Number(typeof item === "object" && item !== null ? item.confidence : 0.5);
		out.push({ tag, confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5 });
	}
	return out.length > 0 ? out : null;
}

/** Merge hit lists; per tag the strongest source wins (SOURCE_PRECEDENCE
 * order). Output keeps canonical vocabulary order for byte-stable lines. */
function mergeConstraints(...lists) {
	const byTag = new Map();
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			if (typeof entry?.tag !== "string" || !CONSTRAINT_VOCABULARY.includes(entry.tag)) continue;
			const source = SOURCE_PRECEDENCE.includes(entry.source) ? entry.source : "classifier";
			const prev = byTag.get(entry.tag);
			if (prev === undefined || SOURCE_PRECEDENCE.indexOf(source) < SOURCE_PRECEDENCE.indexOf(prev.source)) {
				byTag.set(entry.tag, { tag: entry.tag, source });
			}
		}
	}
	return CONSTRAINT_VOCABULARY.filter((tag) => byTag.has(tag)).map((tag) => byTag.get(tag));
}

// ---------------------------------------------------------------------------
// Deterministic recognition
// ---------------------------------------------------------------------------

/** Deterministic hits from the watermark counters: context_pressure fires
 * once the used-token count reaches ANY intervention tier (soft+), mirroring
 * context-watch's own levelOf — the same number on the same boundary. */
function deterministicPressureHits(ctx, agent, config) {
	const used = measureNow(ctx, agent);
	if (typeof used !== "number" || !Number.isFinite(used)) return [];
	const th = readThresholds(config);
	return levelOf(used, th) === "ok" ? [] : [{ tag: "context_pressure", source: "deterministic" }];
}

/** Word-boundary match of annotated skill names in the newest human message
 * (case-insensitive). False positives are acceptable — the line is advice,
 * and a mentioned skill name is exactly the signal skill_match models. */
function skillMatchHits(latestUserText, annotatedSkills) {
	if (typeof latestUserText !== "string" || latestUserText === "") return [];
	const lower = latestUserText.toLowerCase();
	for (const skill of annotatedSkills) {
		const name = typeof skill?.name === "string" ? skill.name.toLowerCase() : "";
		if (name !== "" && new RegExp(`(^|[^a-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`).test(lower)) {
			return [{ tag: "skill_match", source: "deterministic" }];
		}
	}
	return [];
}

// ---------------------------------------------------------------------------
// Rendering (byte-stable, no numeric watermark values)
// ---------------------------------------------------------------------------

/** The one-line advisory tag line: `[SWITCHMAN:CONSTRAINTS] hit: a, b(classifier)`.
 * Deterministic tags render bare; weaker sources carry a parenthesized
 * source label. Empty set renders "" — the zero-diff choice (no `hit: none`
 * line): with the switch off or nothing recognized, the section contributes
 * zero bytes. Six vocabulary tags bound the line well under 60 tokens. */
function renderConstraintsLine(constraints) {
	if (!Array.isArray(constraints) || constraints.length === 0) return "";
	const parts = constraints.map((entry) =>
		entry.source === "deterministic" ? entry.tag : `${entry.tag}(${entry.source})`,
	);
	return `[SWITCHMAN:CONSTRAINTS] hit: ${parts.join(", ")}`;
}

/** The annotated-skills table: one row per annotated skill — name, tags,
 * estimated size in coarse k-tokens (size estimate only; never a watermark
 * value). Returns "" when no skill carries annotations (nothing injected —
 * the host's native available-skills catalog already lists these skills). */
function renderSkillsTable(annotatedSkills) {
	if (!Array.isArray(annotatedSkills) || annotatedSkills.length === 0) return "";
	const rows = [];
	for (const skill of annotatedSkills.slice(0, MAX_SKILL_ROWS)) {
		const name = typeof skill?.name === "string" ? skill.name : "";
		const tags = cleanConstraintTags(skill?.tags);
		if (name === "" || tags.length === 0) continue;
		const size = typeof skill?.estimatedTokens === "number" && Number.isFinite(skill.estimatedTokens) ? Math.max(0.1, Math.round(skill.estimatedTokens / 100) / 10) : null;
		rows.push(`- ${name}: ${tags.join(", ")}${size === null ? "" : ` (~${size}k tok)`}`);
	}
	if (rows.length === 0) return "";
	return ["[SWITCHMAN:SKILLS] annotated skills (constraints tags; estimated size):", ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Skill annotation frontmatter (§4.2)
// ---------------------------------------------------------------------------

/** Parse a SKILL.md's frontmatter for the annotation: the `constraints:` line
 * (comma-separated vocabulary tags) plus an automatic token estimate from
 * the file's byte size (bytes / 3.5 — the codebase's own prose-to-token
 * ratio; measured at scan time, never hand-filled). Unknown tags are
 * dropped; a skill with zero valid tags is not annotated. */
function parseSkillAnnotations(rawText) {
	if (typeof rawText !== "string" || !rawText.startsWith("---")) return null;
	const end = rawText.indexOf("\n---", 3);
	if (end < 0) return null;
	const head = rawText.slice(0, end);
	const match = head.match(/^constraints:[ \t]*(.*)$/m);
	if (match === null) return null;
	const tags = cleanConstraintTags(match[1]);
	if (tags.length === 0) return null;
	const bytes = textByteLength(rawText) ?? Buffer.byteLength(rawText, "utf8");
	return { tags, estimatedTokens: Math.round(bytes / 3.5) };
}

/** Byte length of a text value (null never happens today, kept defensive so
 * the caller's fallback chain stays total if the helper grows I/O later). */
function textByteLength(rawText) {
	try {
		return Buffer.byteLength(rawText, "utf8");
	} catch {
		return null;
	}
}


/** Annotate the bundled skill candidates ({ name, locator } entries from
 * index.js's scan): read each SKILL.md once, parse annotations, keep only
 * skills with at least one valid tag. Broken/unreadable files are dropped
 * silently (fail-open) — the annotation table is advisory only. */
function annotateSkillCandidates(candidates) {
	const out = [];
	if (!Array.isArray(candidates)) return out;
	for (const candidate of candidates) {
		if (candidate === null || typeof candidate !== "object" || typeof candidate.name !== "string" || typeof candidate.locator !== "string") continue;
		let raw;
		try {
			raw = readFileSync(candidate.locator, "utf8");
		} catch {
			continue;
		}
		const parsed = parseSkillAnnotations(raw);
		if (parsed === null) continue;
		out.push({ name: candidate.name, tags: parsed.tags, estimatedTokens: parsed.estimatedTokens });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Classifier-side plumbing (called from host/intent.js)
// ---------------------------------------------------------------------------

/** Per-turn pin key for the classifier store — mirrors intent.js's
 * turnKeyOf for the LAST recorded user event: `<sessionId>:<event id>`
 * (`seq:` fallback). A constraints payload from an older turn is stale and
 * dropped at render time; both sides use the same key so the pin boundary
 * stays consistent with the classifier input window. */
function turnKeyFor(sessionKey, lastUser) {
	if (lastUser === null || typeof lastUser !== "object" || typeof lastUser.id !== "string" || lastUser.id === "") {
		return `${sessionKey}:no-user`;
	}
	return `${sessionKey}:${lastUser.id}`;
}

/** Record the chat classifier's optional constraints payload for the turn it
 * classified (called by host/intent.js right after a successful parse).
 * Invalid payloads record nothing; any throw is swallowed (the intent layer's
 * routing decision never depends on this bookkeeping). */
function recordClassifierConstraints(sessionId, turnKey, constraints) {
	try {
		if (typeof sessionId !== "string" || sessionId === "" || typeof turnKey !== "string" || turnKey === "") return;
		const tags = cleanClassifierConstraints(constraints);
		if (tags === null) return;
		storeBounded(classifierBySession, sessionId, { turnKey, tags, t: Date.now() });
	} catch {
		/* fail open */
	}
}

/** The current turn's classifier constraints, or [] — empty when the session
 * has none or when the recorded payload belongs to an older turn (the
 * newest human event moved on since classification). */
function classifierConstraintsForTurn(sessionKey) {
	try {
		const record = classifierBySession.get(sessionKey);
		if (record === undefined) return [];
		const lastUser = lastUserBySession.get(sessionKey) ?? null;
		if (record.turnKey !== turnKeyFor(sessionKey, lastUser)) return [];
		return record.tags.map((entry) => ({ tag: entry.tag, source: "classifier" }));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Section wiring
// ---------------------------------------------------------------------------

/** Mount the constraint-recognition layer: human-message tracking, disposal
 * cleanup, and the systemPrompt section. Registration is defensive like
 * every other layer; failures warn and disable the layer, never throw. */
function applyConstraints(ctx, config, annotatedSkills) {
	const warn = (message) => ctx.logger?.warn?.(`dsh-switchman: ${message}`);
	try {
		ctx.on("session/event", (session, event) => {
			try {
				// Master switch early-exit: while disabled nothing is captured,
				// not even the bounded 2k user-text snapshot (review F1).
				if (config?.constraintsEnabled?.get() !== true) return;
				if (event?.type !== "user/message") return;
				if (event?.data?.source?.kind !== "user") return;
				const key = sessionIdOf(session);
				if (key === null) return;
				const text = contentTextOf(event?.data?.content);
				storeBounded(lastUserBySession, key, { id: eventIdOf(event), text, t: Date.now() });
			} catch {
				/* fail open */
			}
		});
		ctx.on("session/disposed", (session) => {
			try {
				const key = sessionIdOf(session);
				if (key === null) return;
				lastUserBySession.delete(key);
				classifierBySession.delete(key);
				loggedTurnBySession.delete(key);
			} catch {
				/* fail open */
			}
		});
	} catch (error) {
		warn(`constraints event wiring failed: ${error?.message ?? error}`);
		return;
	}
	try {
		ctx.systemPrompt.section({
			name: "switchman:constraints",
			order: CONSTRAINTS_ORDER,
			interpolate: false,
			text: (context) => {
				try {
					// Master switch: off renders "" on every assembly — the
					// section exists but contributes zero bytes (zero diff).
					if (config?.constraintsEnabled?.get() !== true) return "";
					const agent = context?.agent;
					const sessionKey = sessionIdOf(agent);
					if (sessionKey === null) return "";
					const lastUser = lastUserBySession.get(sessionKey) ?? null;
					const hits = mergeConstraints(
						deterministicPressureHits(ctx, agent, config),
						classifierConstraintsForTurn(sessionKey),
						skillMatchHits(lastUser?.text ?? null, annotatedSkills),
					);
					const line = renderConstraintsLine(hits);
					const table = renderSkillsTable(annotatedSkills);
					if (line === "" && table === "") return "";
					logHitsOnce(ctx, sessionKey, turnKeyFor(sessionKey, lastUser), hits);
					return line === "" ? table : table === "" ? line : `${line}\n\n${table}`;
				} catch {
					return "";
				}
			},
		});
	} catch (error) {
		warn(`systemPrompt.section registration failed — constraint advisory line disabled: ${error?.message ?? error}`);
	}
}

/** Log a constraint hit once per turn (context-watch's logger pattern):
 * `dsh-switchman: constraints hit (turn <key>): tag[source, ...] at <ISO>`.
 * Logs are host-side only — timestamps and turn keys never reach the model. */
function logHitsOnce(ctx, sessionKey, turnKey, hits) {
	try {
		if (hits.length === 0 || turnKey === loggedTurnBySession.get(sessionKey)) return;
		loggedTurnBySession.set(sessionKey, turnKey);
		if (loggedTurnBySession.size > SESSION_MAP_CAP) {
			const oldest = loggedTurnBySession.keys().next().value;
			if (oldest !== undefined) loggedTurnBySession.delete(oldest);
		}
		ctx.logger?.info?.(
			`dsh-switchman: constraints hit (turn ${turnKey}): ${hits.map((entry) => `${entry.tag}[${entry.source}]`).join(", ")} at ${new Date().toISOString()}`,
		);
	} catch {
		/* fail open */
	}
}

/** First text chunk of a message-content array (ptc-bindings' shape). */
function contentTextOf(content) {
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") return part.text.slice(0, USER_TEXT_CAP);
	}
	return "";
}

/** Event id for the turn pin (intent.js's convention: data.id, seq
 *  fallback). Known deviation (review F2): intent's degenerate no-seq
 *  fallback uses the array index (`seq:${i}`), unreachable here because
 *  live session events always carry seq — a missing id+seq degrades to
 *  "seq:" and that turn's weak signal is silently skipped (safe side). */
function eventIdOf(event) {
	const id = event?.data?.id;
	if (typeof id === "string" && id !== "") return id;
	const seq = event?.seq;
	return typeof seq === "number" ? `seq:${seq}` : `seq:${String(event?.seq ?? "")}`;
}

export {
	CONSTRAINT_VOCABULARY,
	MAX_SKILL_ROWS,
	applyConstraints,
	annotateSkillCandidates,
	cleanClassifierConstraints,
	cleanConstraintTags,
	classifierConstraintsForTurn,
	mergeConstraints,
	parseSkillAnnotations,
	recordClassifierConstraints,
	renderConstraintsLine,
	renderSkillsTable,
	skillMatchHits,
	deterministicPressureHits,
	turnKeyFor,
};
