/** dsh-switchman language-preference layer (Phase 1).
 *
 * Ported from opencode-switchman's project language preference
 * (oc/src/lang-config.ts, oc/src/index.ts:1594-1604) onto DSH services:
 * the on-disk settings.json / AGENTS.md marker pair becomes this plugin's
 * volatile settings fields (live references — re-read at every assembly),
 * the per-model-request system transform becomes one dynamic systemPrompt
 * section (order 10300, after the persona suffix at 10200), and the
 * tool.execute.after capture becomes a `tools/post-execute` waterfall
 * listener.
 *
 * Model-facing protocol text is English and byte-stable: the
 * `[SWITCHMAN:LANG]` anchor line is a function of the settings values only
 * and never varies with UI locale, so bundled skills can match it
 * textually. All parsing is defensive — any unexpected shape abandons
 * silently (fail-open) and never disturbs the tool result flowing through
 * the waterfall. Zero new dependencies.
 */

/** Marker embedded in the ask's question texts and matched on capture. */
const LANG_ASK_MARKER = "switchman-lang";

/** Longest stored/displayed language value (defensive bound, not truncated). */
const MAX_LANG_LEN = 48;

/** Anchor-line value shown for an empty comments/docs field (= follow conversation). */
const SAME = "same";

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

/** Current language-preference snapshot from the live plugin config. */
function readLangPref(config) {
	return {
		conversation: normalizeLangValue(readField(config?.langConversation)) ?? "",
		comments: normalizeLangValue(readField(config?.langComments)) ?? "",
		docs: normalizeLangValue(readField(config?.langDocs)) ?? "",
	};
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

/** Unconfigured block: gentle one-shot ask guidance (English, ≤6 lines, never blocking). */
function renderAskGuidance() {
	return [
		`[SWITCHMAN:LANG] not configured for this project yet.`,
		`Optionally, ask the user ONCE via a single ask_user_question call with exactly three questions —`,
		`conversation language, code-comments language, generated-documents language — and include the marker`,
		`"${LANG_ASK_MARKER}" in each question text so the answers are captured and persisted for you.`,
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

/** Mount the language-preference layer: dynamic prompt section + answer capture.
 *  `exec` here is the prepared ToolExecution ({ name, arguments, ... }) and
 *  `result` the ToolExecutionResult ({ isError, value?, content, ... }); the
 *  waterfall contract requires the listener to call and return next(). */
function applyLanguage(ctx, config) {
	/** Latched once any marker-carrying ask executes, so the ask guidance never nags
	 *  (a declined, pending, or unparsable ask still counts — fail-open, no re-ask). */
	let asked = false;

	ctx.systemPrompt.section({
		name: "switchman:lang",
		order: 10300,
		interpolate: false,
		text: () => {
			const pref = readLangPref(config);
			if (pref.conversation !== "") return renderLangBlock(pref);
			return asked ? "" : renderAskGuidance();
		},
	});

	ctx.on("tools/post-execute", (exec, result, next) => {
		try {
			if (exec?.name === "ask_user_question") {
				const questions = markerQuestions(exec.arguments);
				if (questions.length > 0) {
					asked = true;
					const pref = parseLangAnswers(questions, result?.isError ? null : result?.value);
					if (pref !== null) {
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
		} catch (error) {
			ctx.logger.warn(`dsh-switchman: language answer capture failed: ${error?.message ?? error}`);
		}
		return next();
	});
}

export { applyLanguage };
