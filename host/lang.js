/** dsh-switchman language-preference layer (Phase 1).
 *
 * Ported from opencode-switchman's project language preference
 * (oc/src/lang-config.ts, oc/src/index.ts:1594-1604) onto DSH services.
 * Two storage scopes for the three language slots (conversation / comments /
 * docs), selected by the `langScope` setting:
 *
 *  - "global"  — this plugin's profile-level volatile settings fields (live
 *    references, re-read at every assembly; ask-once latch per process);
 *  - "project" — a per-project `<cwd>/.switchman/lang.json`, resolved from
 *    each session's own working directory (`context.agent.session.header.
 *    cwd`, the same source the watermark handover and dsh-agent-loop's
 *    "cwd" variable use). A session without a usable file is
 *    "unconfigured": it gets the one-shot ask guidance (latched per
 *    session, so every new session asks again until the file exists) and
 *    the captured answers are written into that file. A session whose
 *    header carries no cwd falls back to the global fields (fail-open).
 *
 * The per-model-request system transform becomes one dynamic systemPrompt
 * section (order 10300, after the persona suffix at 10200); the
 * tool.execute.after capture becomes a `tools/post-execute` waterfall
 * listener. The text callback must stay synchronous (dsh-system-prompt
 * calls it without await), so project files are read with readFileSync —
 * a sub-100-byte JSON once per step per session.
 *
 * Model-facing protocol text is English and byte-stable: the configured
 * `[SWITCHMAN:LANG]` anchor line is a function of the effective values
 * only and never varies with UI locale, so bundled skills can match it
 * textually. The unconfigured ask guidance additionally names the language
 * to phrase the three questions in — the DSH UI language when known
 * (explicit settings preference, else the client-reported active locale,
 * else English). All parsing is defensive — any unexpected shape abandons
 * silently (fail-open) and never disturbs the tool result flowing through
 * the waterfall. Zero new dependencies.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reportedUiLocale } from "./ui-locale.js";

/** Marker embedded in the ask's question texts and matched on capture. */
const LANG_ASK_MARKER = "switchman-lang";

/** Longest stored/displayed language value (defensive bound, not truncated). */
const MAX_LANG_LEN = 48;

/** Anchor-line value shown for an empty comments/docs field (= follow conversation). */
const SAME = "same";

/** Project-scope config directory and file name (inside the session cwd). */
const PROJECT_DIR = ".switchman";
const PROJECT_FILE = "lang.json";

/** How long a cached settings-describe locale stays fresh (ms). */
const LOCALE_CACHE_MS = 10_000;

/** Normalize one language value: trim and bound the length; anything else → null. */
function normalizeLangValue(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_LANG_LEN) return null;
	return trimmed;
}

/** Read one volatile settings field as a plain string (live `.get()` reference). */
function readField(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			const value = field.get();
			return typeof value === "string" ? value : "";
		} catch {
			return "";
		}
	}
	return typeof field === "string" ? field : "";
}

/** Current scope setting: "project" when explicitly chosen, else "global". */
function readScope(config) {
	return readField(config?.langScope) === "project" ? "project" : "global";
}

/** Current language-preference snapshot from the live plugin config. */
function readLangPref(config) {
	return {
		conversation: normalizeLangValue(readField(config?.langConversation)) ?? "",
		comments: normalizeLangValue(readField(config?.langComments)) ?? "",
		docs: normalizeLangValue(readField(config?.langDocs)) ?? "",
	};
}

/** Parse the project file's three slots; null when missing/broken/empty-file.
 *  Same semantics as the global fields: comments/docs "" = follow conversation. */
function readProjectPref(cwd) {
	let raw;
	try {
		raw = readFileSync(join(cwd, PROJECT_DIR, PROJECT_FILE), "utf8");
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const conversation = normalizeLangValue(parsed.langConversation);
	if (conversation === null) return null;
	return {
		conversation,
		comments: normalizeLangValue(parsed.langComments) ?? "",
		docs: normalizeLangValue(parsed.langDocs) ?? "",
	};
}

/** Persist a captured preference as the project's `<cwd>/.switchman/lang.json`. */
function writeProjectPref(cwd, pref) {
	const directory = join(cwd, PROJECT_DIR);
	const path = join(directory, PROJECT_FILE);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				langConversation: pref.conversation,
				langComments: pref.comments,
				langDocs: pref.docs,
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);
	return path;
}

/** Configured block: byte-stable anchor line + English iron rules. */
function renderLangBlock(pref) {
	const anchor = (value) => (value === "" ? SAME : value);
	const rule = (value) => (value === "" ? `${pref.conversation} (same as conversation)` : value);
	return [
		`[SWITCHMAN:LANG] conversation=${anchor(pref.conversation)} comments=${anchor(pref.comments)} docs=${anchor(pref.docs)}`,
		`IRON RULE — project language preferences:`,
		`- Replies and reasoning: ${pref.conversation}.`,
		`- Code comments and commit messages: ${rule(pref.comments)}.`,
		`- Documents you author (plans, PRDs, design docs, reports): ${rule(pref.docs)}.`,
		`This line overrides any bundled skill's English-by-default. Ad-hoc user language requests are`,
		`single-turn exceptions: honor that one reply, then revert to these preferences.`,
	].join("\n");
}

/** Unconfigured block: gentle one-shot ask guidance (English, ≤7 lines, never
 *  blocking). `askLanguage` names the language to phrase the questions in. */
function renderAskGuidance(askLanguage) {
	return [
		`[SWITCHMAN:LANG] not configured for this project yet.`,
		`Optionally, ask the user ONCE via a single ask_user_question call with exactly three questions —`,
		`conversation language, code-comments language, generated-documents language — and include the marker`,
		`"${LANG_ASK_MARKER}" in each question text so the answers are captured and persisted for you.`,
		`Phrase the three questions and their answer options in ${askLanguage} (the user's UI language).`,
		`If the user declines or skips, infer the language from their current message and do not ask again.`,
		`Never block or delay any tool call on this preference; proceed with useful work regardless.`,
	].join("\n");
}

/** True when one ask_user_question question entry carries the capture marker. */
function carriesMarker(question) {
	if (question === null || typeof question !== "object") return false;
	for (const field of [question.question, question.header, question.id]) {
		if (typeof field === "string" && field.includes(LANG_ASK_MARKER)) return true;
	}
	return false;
}

/** Marker-carrying questions from a (defensively checked) arguments object. */
function markerQuestions(args) {
	if (args === null || typeof args !== "object" || !Array.isArray(args.questions)) return [];
	return args.questions.filter(carriesMarker);
}

/** Resolve the three answers positionally: 1st conversation, 2nd comments, 3rd docs.
 *  A skipped or unusable comments/docs slot follows the conversation language;
 *  no usable conversation answer at all → null (persist abandoned).
 *  The success value of ask_user_question is `{ answers: [{ id, selected:
 *  string[], custom?: string }] }` (dsh-tool-ask-user lib/index.js execute). */
function parseLangAnswers(questions, value) {
	const slots = questions.slice(0, 3);
	if (slots.length < 3 || value === null || typeof value !== "object" || !Array.isArray(value.answers))
		return null;
	const byId = new Map();
	for (const answer of value.answers) {
		if (answer !== null && typeof answer === "object" && typeof answer.id === "string")
			byId.set(answer.id, answer);
	}
	const rawAnswer = (question) => {
		const answer = byId.get(typeof question.id === "string" ? question.id : "");
		if (answer === undefined) return "";
		if (typeof answer.custom === "string" && answer.custom.trim() !== "") return answer.custom;
		if (Array.isArray(answer.selected) && typeof answer.selected[0] === "string") return answer.selected[0];
		return "";
	};
	const conversation = normalizeLangValue(rawAnswer(slots[0]));
	if (conversation === null) return null;
	const follow = (raw) => normalizeLangValue(raw) ?? conversation;
	return { conversation, comments: follow(rawAnswer(slots[1])), docs: follow(rawAnswer(slots[2])) };
}

/** Session id off an agent (shared agent/session id; null when unusable). */
function sessionIdOf(agent) {
	const id = agent?.session?.id ?? agent?.id;
	return typeof id === "string" && id !== "" ? id : null;
}

/** True when the agent is a runtime root (owner-less); unknown registries
 *  count as root. Subagents cannot reach the user, so only roots may ask. */
function isRoot(ctx, agent) {
	try {
		const roots = ctx.agents?.roots?.();
		return !Array.isArray(roots) || roots.includes(agent);
	} catch {
		return true;
	}
}

/** Read the explicit DSH UI-language preference (settings ns "locale", field
 *  "preference"; "" when unset/unreadable). Cached — describe() serializes
 *  every settings schema, and the section text runs once per step. */
function readLocalePreference(ctx, cache) {
	const now = Date.now();
	if (cache.tag !== null && now - cache.at < LOCALE_CACHE_MS) return cache.tag;
	cache.at = now;
	try {
		const described = ctx.settings?.describe?.();
		if (Array.isArray(described)) {
			const row = described.find((entry) => entry?.ns === "locale");
			const preference = row?.value?.preference;
			cache.tag = typeof preference === "string" ? preference.trim().toLowerCase() : "";
			return cache.tag;
		}
	} catch {
		// fall through
	}
	cache.tag = "";
	return cache.tag;
}

/** Language name the ask guidance tells the agent to phrase questions in. */
function askLanguageOf(ctx, cache) {
	const tag = readLocalePreference(ctx, cache) || reportedUiLocale();
	return tag.startsWith("zh") ? "Chinese (简体中文)" : "English";
}

/** Mount the language-preference layer: dynamic prompt section + answer capture.
 *  `exec` here is the prepared ToolExecution ({ name, arguments, agent, ... })
 *  and `result` the ToolExecutionResult ({ isError, value?, content, ... });
 *  the waterfall contract requires the listener to call and return next(). */
function applyLanguage(ctx, config) {
	/** Global-scope ask latch (one ask per process, declined counts). */
	let asked = false;
	/** Project-scope ask latches, per session id (each new session may ask). */
	const askedSessions = new Set();
	/** Cached locale-preference read (see readLocalePreference). */
	const localeCache = { at: 0, tag: null };

	/** Effective preference for one assembly: project scope reads the
	 *  session's project file only (a missing file counts as unconfigured
	 *  and asks — global fields never shadow it); a session without a
	 *  usable cwd degrades to the global fields (fail-open). */
	const effectivePref = (context) => {
		if (readScope(config) !== "project") return readLangPref(config);
		const cwd = context?.agent?.session?.header?.cwd;
		if (typeof cwd !== "string" || cwd === "") return readLangPref(config);
		return readProjectPref(cwd) ?? { conversation: "", comments: "", docs: "" };
	};

	ctx.systemPrompt.section({
		name: "switchman:lang",
		order: 10300,
		interpolate: false,
		text: (context) => {
			try {
				const agent = context?.agent;
				const pref = effectivePref(context);
				if (pref.conversation !== "") return renderLangBlock(pref);
				// Unconfigured: one ask per process (global) or per session
				// (project); subagents never see the ask guidance.
				if (readScope(config) === "project") {
					const sessionId = sessionIdOf(agent);
					if (sessionId !== null ? askedSessions.has(sessionId) : asked) return "";
				} else if (asked) return "";
				if (!isRoot(ctx, agent)) return "";
				return renderAskGuidance(askLanguageOf(ctx, localeCache));
			} catch {
				return "";
			}
		},
	});

	ctx.on("tools/post-execute", (exec, result, next) => {
		try {
			if (exec?.name === "ask_user_question") {
				const questions = markerQuestions(exec.arguments);
				if (questions.length > 0) {
					// Latch before parsing: a declined, pending, or unparsable
					// ask still counts — fail-open, no re-ask.
					const sessionId = sessionIdOf(exec?.agent);
					if (readScope(config) === "project" && sessionId !== null) askedSessions.add(sessionId);
					else asked = true;
					const pref = parseLangAnswers(questions, result?.isError ? null : result?.value);
					if (pref !== null) {
						const cwd = exec?.agent?.session?.header?.cwd;
						if (readScope(config) === "project" && typeof cwd === "string" && cwd !== "") {
							// Project scope: persist into the project file
							// (a failed write logs and drops — the answer is
							// re-asked in the next session, never leaked into
							// the inert global fields).
							try {
								const path = writeProjectPref(cwd, pref);
								ctx.logger?.info?.(
									`dsh-switchman: language preferences saved to ${path} (conversation=${pref.conversation} comments=${pref.comments || SAME} docs=${pref.docs || SAME})`,
								);
							} catch (error) {
								ctx.logger?.warn?.(
									`dsh-switchman: failed to write project language preferences: ${error?.message ?? error}`,
								);
							}
						} else {
							void ctx.settings
								.update("dsh-switchman-host", {
									langConversation: pref.conversation,
									langComments: pref.comments,
									langDocs: pref.docs,
								})
								.then(() => {
									ctx.logger.info(
										`dsh-switchman: language preferences saved (conversation=${pref.conversation} comments=${pref.comments} docs=${pref.docs})`,
									);
								})
								.catch((error) => {
									ctx.logger.warn(
										`dsh-switchman: failed to save language preferences: ${error?.message ?? error}`,
									);
								});
						}
					}
				}
			}
		} catch (error) {
			ctx.logger.warn(`dsh-switchman: language answer capture failed: ${error?.message ?? error}`);
		}
		return next();
	});
}

export { applyLanguage };
