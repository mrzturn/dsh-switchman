/** dsh-switchman PTC automatic binding ledger.
 *
 * Symptom (2026-11-15, log audit): 29 of 69 recent PTC sessions hit the real
 * runtime rejection \`Identifier 'x' has already been declared\` (63 hits,
 * concentrated on draft names r/fs/res/execSync/results/idx). Every affected
 * session ALREADY carried the [SWITCHMAN:PTC] advice clauses (41 also the
 * manual \`globalThis.__dshSwitchmanPtcBindings\` ledger clause), so prompt-only
 * mitigation is proven ineffective: old programs fold out of the model's view
 * and it cannot see what it declared rounds ago.
 *
 * Fix: host-side automatic bookkeeping over the outer \`run_code\` transport
 * (nested SDK calls arrive under their own tool names and are ignored):
 * - tools/pre-execute scans the program text for top-level declarations
 *   (const/let/var/using/class/function/enum/namespace) with a zero-dependency
 *   scanner — comments, strings, template literals, and regex literals are
 *   stripped first so keywords inside literals never match; bracket depth
 *   gates "top level" so IIFE-wrapped bodies, for-loop heads, and blocks are
 *   excluded — and parks the name list on the exec (WeakMap: the SAME exec
 *   object flows through pre- and post-execute, so parallel calls stay
 *   independent and denied/abandoned entries are garbage-collected).
 * - tools/post-execute commits the parked names into the session ledger on
 *   success; on a parse-level failure nothing ran, so the parked names roll
 *   back — and when the error quotes a duplicate identifier, that name is
 *   force-added (self-heal for anything the scanner missed); on other failures
 *   the names commit anyway, because partial execution leaves earlier
 *   top-level declarations live (over-reporting is the safe direction).
 *
 * Injection: host/ptc-guard.js appends renderPtcLedgerClause(sessionKey) to
 * its final-say section (order 10510 — re-rendered on every model step and
 * never folded), listing the session's used names plus the no-redeclare rule.
 * An empty ledger renders "" so a session's first program is unannotated.
 *
 * Lifecycle: the ledger is process-lifetime memory keyed by session id
 * (agent.session.id ?? agent.id); session/disposed drops it, and a PTC
 * environment-reset notice (user/message, source.kind "ptc-mode", the fixed
 * reset text emitted by PtcExecutor.reset) clears it since the runtime's
 * bindings are gone with the environment.
 *
 * Known scanner limits (documented, accepted): an unterminated-regex fallback
 * treats the slash as division (keywords inside such text can over-report;
 * never under-report silently — the self-heal covers real collisions);
 * computed destructuring keys capture nothing. Everything fails open: a
 * scanning/listener error costs the mitigation, never the tool call. Zero new
 * dependencies.
 */

const RUN_CODE_NAME = "run_code";

/** Session ledger: sessionKey -> Set<name> (insertion-ordered; Set preserves
 *  first-declaration order for display). Process-lifetime memory. */
const ledgers = new Map();

/** Parked scan result per in-flight outer run_code exec. */
const pending = new WeakMap();

/** Clause display cap: the section renders on every model step, so an
 *  over-long list would tax every turn; the most recent names matter most. */
const LEDGER_DISPLAY_CAP = 120;

/** Fixed prefix of the model-visible notice PtcExecutor.reset injects after
 *  clearing one agent's retained environment (tool-executor-ptc index.ts). */
const PTC_RESET_NOTICE = "Program environment reset; retained variables cleared.";

const DECL_KEYWORDS = new Set(["const", "let", "var", "using", "class", "function", "enum", "namespace"]);
/** Keywords whose declaration is <keyword> <ident> (no declarator list). */
const CLASS_LIKE_KEYWORDS = new Set(["class", "function", "enum", "namespace"]);

const REDECLARE_RE = /has already been declared/i;
const REDECLARE_NAME_RE = /['"]([A-Za-z_$][A-Za-z0-9_$]*)['"]\s+has already been declared/g;
/** Parse-level failures: the program never ran, so nothing it declared is live. */
const PARSE_FAIL_RE = /SyntaxError|parse error|Expected ident|Unexpected token|Unexpected identifier/i;

function isIdStart(c) {
	return c !== undefined && /[A-Za-z_$]/.test(c);
}

function readWord(src, pos) {
	const n = src.length;
	let end = pos;
	while (end < n && /[A-Za-z0-9_$]/.test(src[end])) end += 1;
	return src.slice(pos, end);
}

function skipWs(src, pos) {
	const n = src.length;
	while (pos < n && /\s/.test(src[pos])) pos += 1;
	return pos;
}

/** Blank every literal region (comments, strings, templates — except the
 *  code inside interpolation braces, whose braces stay balanced) so the depth
 *  scanner only ever sees real code. Returns a same-length string. */
function stripLiterals(src) {
	const out = src.split("");
	const n = src.length;
	const stack = ["code"];
	let i = 0;
	const blank = (from, to) => {
		for (let k = from; k < to; k += 1) out[k] = " ";
	};
	/** Regex literal vs division: look back at the last significant emitted
	 *  char; /= is always the division-assign operator, never a regex. */
	const tryRegex = (pos) => {
		let j = pos - 1;
		while (j >= 0 && out[j] === " ") j -= 1;
		const prev = j >= 0 ? out[j] : "";
		if (!(prev === "" || "(=,:[!&|?{};+*-%<>~^".includes(prev))) return pos;
		if (src[pos + 1] === "=") return pos; // /= operator
		let k = pos + 1;
		let inClass = false;
		while (k < n) {
			const d = src[k];
			if (d === "\\") { k += 2; continue; }
			if (d === "[") { inClass = true; k += 1; continue; }
			if (d === "]") { inClass = false; k += 1; continue; }
			if (d === "/" && !inClass) {
				blank(pos, k + 1);
				return k + 1;
			}
			if (d === "\n") return pos; // unterminated: treat as division
			k += 1;
		}
		return pos;
	};
	while (i < n) {
		const frame = stack[stack.length - 1];
		const c = src[i];
		if (frame === "code" || frame === "interp") {
			const interp = frame === "interp";
			if (c === "'") { stack.push("sq"); blank(i, i + 1); i += 1; continue; }
			if (c === '"') { stack.push("dq"); blank(i, i + 1); i += 1; continue; }
			if (c === "\`") { stack.push("tpl"); blank(i, i + 1); i += 1; continue; }
			if (c === "/" && src[i + 1] === "/") { stack.push("line"); blank(i, i + 2); i += 2; continue; }
			if (c === "/" && src[i + 1] === "*") { stack.push("block"); blank(i, i + 2); i += 2; continue; }
			if (c === "/") {
				const next = tryRegex(i);
				if (next !== i) { i = next; continue; }
				i += 1; continue;
			}
			// Interpolation code: each "{" opens a nested frame, each "}" pops one,
			// so the interpolation's closing brace returns to the template text.
			if (interp && c === "{") { stack.push("interp"); i += 1; continue; }
			if (interp && c === "}") { stack.pop(); i += 1; continue; }
			i += 1; continue;
		}
		if (frame === "sq" || frame === "dq") {
			if (c === "\\") { blank(i, i + 2); i += 2; continue; }
			blank(i, i + 1);
			if ((frame === "sq" && c === "'") || (frame === "dq" && c === '"')) stack.pop();
			i += 1;
			continue;
		}
		if (frame === "line") {
			if (c === "\n") { stack.pop(); i += 1; continue; }
			blank(i, i + 1); i += 1; continue;
		}
		if (frame === "block") {
			if (c === "*" && src[i + 1] === "/") { stack.pop(); blank(i, i + 2); i += 2; continue; }
			if (c !== "\n") blank(i, i + 1);
			i += 1; continue;
		}
		if (frame === "tpl") {
			if (c === "\\") { blank(i, i + 2); i += 2; continue; }
			if (c === "\`") { stack.pop(); blank(i, i + 1); i += 1; continue; }
			if (c === "$" && src[i + 1] === "{") {
				// Interpolation: emit ONE "{" so bracket depth stays balanced with
				// the interpolation's closing "}", then scan its code as code.
				out[i] = "{";
				blank(i + 1, i + 2);
				stack.push("interp");
				i += 2;
				continue;
			}
			blank(i, i + 1); i += 1; continue;
		}
	}
	return out.join("");
}

/** Skip one balanced bracket group starting at src[pos]; returns the index
 *  just past the matching closer (EOF if unbalanced). */
function skipBalanced(src, pos) {
	const open = src[pos];
	const close = open === "{" ? "}" : open === "[" ? "]" : ")";
	const n = src.length;
	let depth = 0;
	let i = pos;
	while (i < n) {
		const c = src[i];
		if (c === open) depth += 1;
		else if (c === close) {
			depth -= 1;
			if (depth === 0) return i + 1;
		}
		i += 1;
	}
	return i;
}

/** Scan one destructuring pattern; returns captured binding names and the
 *  index just past the pattern. Property keys are skipped, computed keys are
 *  skipped balanced, defaults are skipped after =, nested patterns recurse,
 *  ...rest binds. */
function scanPattern(src, pos) {
	const obj = src[pos] === "{";
	const names = [];
	const n = src.length;
	let depth = 0;
	let bind = true; // pattern position where a binding may start
	let expectKey = obj; // object: the slot after "{" or "," holds a key
	let afterEq = false;
	let i = pos + 1;
	while (i < n) {
		const c = src[i];
		if (depth === 0) {
			if (c === "=") { afterEq = true; bind = false; i += 1; continue; }
			if (c === ",") { afterEq = false; bind = true; expectKey = obj; i += 1; continue; }
			if (obj && c === ":") { bind = true; afterEq = false; expectKey = false; i += 1; continue; }
		}
		if (c === "(" || c === "{" || c === "[") {
			if (depth > 0) { depth += 1; i += 1; continue; }
			if (obj && c === "[" && expectKey && !afterEq) {
				i = skipBalanced(src, i); // computed key expression — never a binding
				bind = false;
				continue;
			}
			if (afterEq || !bind) { depth += 1; i += 1; continue; } // default-value expression
			const sub = scanPattern(src, i);
			for (const name of sub.names) names.push(name);
			i = sub.i;
			bind = false;
			expectKey = false;
			continue;
		}
		if (c === ")" || c === "}" || c === "]") {
			if (depth > 0) { depth -= 1; i += 1; continue; }
			if ((obj && c === "}") || (!obj && c === "]")) return { names, i: i + 1 };
			i += 1; // mismatched closer: skip defensively
			continue;
		}
		if (depth === 0 && !afterEq && isIdStart(c)) {
			const word = readWord(src, i);
			const j = skipWs(src, i + word.length);
			if (obj && expectKey && src[j] === ":") {
				i = j + 1; // property key: the binding follows the colon
				bind = true;
				expectKey = false;
				continue;
			}
			if (bind) names.push(word);
			i += word.length;
			bind = false;
			expectKey = false;
			continue;
		}
		i += 1;
	}
	return { names, i };
}

/** Scan a const/let/var/using declarator list beginning just after the
 *  keyword; returns the resume index. Handles const a = 1, b = 2; patterns,
 *  ASI before the next declaration keyword, and bails cleanly on malformed
 *  shapes (the main scanner reprocesses the resume char). */
function scanDeclaratorList(src, pos, names) {
	const n = src.length;
	let i = pos;
	for (;;) {
		i = skipWs(src, i);
		if (i >= n) return i;
		const c = src[i];
		if (isIdStart(c)) {
			const word = readWord(src, i);
			if (DECL_KEYWORDS.has(word)) return i; // ASI: next statement reached
			names.push(word);
			i += word.length;
		} else if (c === "{" || c === "[") {
			const res = scanPattern(src, i);
			for (const name of res.names) names.push(name);
			i = res.i;
		} else {
			return i; // malformed: bail to the main scanner
		}
		// Skip the initializer up to ";" (statement end) or a top-level ","
		// (next declarator); a following declaration keyword ends the list (ASI).
		let rel = 0;
		while (i < n) {
			const d = src[i];
			if (d === "(" || d === "[" || d === "{") { rel += 1; i += 1; continue; }
			if (d === ")" || d === "]" || d === "}") { if (rel > 0) rel -= 1; i += 1; continue; }
			if (rel === 0) {
				if (d === ";") return i + 1;
				if (d === ",") { i += 1; break; }
				if (isIdStart(d)) {
					const word = readWord(src, i);
					if (DECL_KEYWORDS.has(word)) return i; // ASI: next statement
					i += word.length;
					continue;
				}
			}
			i += 1;
		}
		if (i >= n) return i;
	}
}

/** Top-level declared names of one (already literal-stripped) program text. */
function topLevelDeclarations(src) {
	if (typeof src !== "string" || src === "") return [];
	const stripped = stripLiterals(src);
	const names = [];
	const n = stripped.length;
	let depth = 0;
	let i = 0;
	while (i < n) {
		const c = stripped[i];
		if (c === "(" || c === "[" || c === "{") { depth += 1; i += 1; continue; }
		if (c === ")" || c === "]" || c === "}") { if (depth > 0) depth -= 1; i += 1; continue; }
		if (isIdStart(c)) {
			const word = readWord(stripped, i);
			i += word.length;
			if (depth !== 0 || !DECL_KEYWORDS.has(word)) continue;
			if (CLASS_LIKE_KEYWORDS.has(word)) {
				let j = skipWs(stripped, i);
				if (word === "function" && stripped[j] === "*") j = skipWs(stripped, j + 1);
				if (isIdStart(stripped[j])) {
					const name = readWord(stripped, j);
					names.push(name);
					i = j + name.length;
				}
				continue;
			}
			// const / let / var / using — peek a "const enum X" class-like form.
			let j = skipWs(stripped, i);
			if (isIdStart(stripped[j]) && readWord(stripped, j) === "enum") {
				j = skipWs(stripped, j + 4);
				if (isIdStart(stripped[j])) {
					const name = readWord(stripped, j);
					names.push(name);
					i = j + name.length;
				}
				continue;
			}
			i = scanDeclaratorList(stripped, i, names);
			continue;
		}
		i += 1;
	}
	return names;
}

/** Stable session key off an Agent or Session object: session.id first, id as
 *  the fallback (Agent.id IS the SessionId; Session only has id). */
function sessionKeyOf(agentLike) {
	if (agentLike === null || typeof agentLike !== "object") return null;
	const sid = agentLike.session?.id;
	if (typeof sid === "string" && sid !== "") return sid;
	const id = agentLike.id;
	return typeof id === "string" && id !== "" ? id : null;
}

function ledgerOf(key) {
	let set = ledgers.get(key);
	if (set === undefined) {
		set = new Set();
		ledgers.set(key, set);
	}
	return set;
}

function commitNames(key, names) {
	if (!Array.isArray(names) || names.length === 0) return;
	const set = ledgerOf(key);
	for (const name of names) {
		if (typeof name === "string" && name !== "") set.add(name);
	}
}

function contentTextOf(blocks) {
	if (!Array.isArray(blocks)) return "";
	const out = [];
	for (const block of blocks) {
		if (block?.type === "text" && typeof block.text === "string") out.push(block.text);
	}
	return out.join("\n");
}

/** Model-visible failure text: error.message plus any text content, since the
 *  runtime surfaces the SyntaxError in either place. */
function failureTextOf(result) {
	const parts = [];
	const message = result?.error?.message;
	if (typeof message === "string" && message !== "") parts.push(message);
	const text = contentTextOf(result?.content);
	if (text !== "") parts.push(text);
	return parts.length > 0 ? parts.join("\n") : null;
}

/** Self-heal: force-add every identifier the rejection quotes as already
 *  declared (covers names the scanner missed in earlier programs). */
function addSelfHealNames(set, text) {
	REDECLARE_NAME_RE.lastIndex = 0;
	for (;;) {
		const match = REDECLARE_NAME_RE.exec(text);
		if (match === null) break;
		set.add(match[1]);
	}
}

/** The ledger clause for one session, or "" when the session has no recorded
 *  names (first program, unknown session, disabled state). Byte-stable apart
 *  from the name list itself. */
function renderPtcLedgerClause(sessionKey) {
	try {
		if (sessionKey === null) return "";
		const set = ledgers.get(sessionKey);
		if (set === undefined || set.size === 0) return "";
		const all = [...set];
		const shown = all.slice(-LEDGER_DISPLAY_CAP);
		const noun = all.length === 1 ? "1 top-level binding" : String(all.length) + " top-level bindings";
		const head = shown.length < all.length
			? noun + " already declared by earlier run_code programs in THIS session (host-tracked; showing the most recent " + shown.length + ")"
			: noun + " already declared by earlier run_code programs in THIS session (host-tracked)";
		return [
			"[SWITCHMAN:PTC-LEDGER] " + head + ": " + shown.join(", ") + ".",
			"- Never redeclare these names at the top level (const/let/var/using/class/function/enum/namespace): reuse the existing binding, reassign it, or keep new code inside an async IIFE where fresh local names are always safe.",
			"- If you still hit the has-already-been-declared rejection, rewrite the program in the IIFE form instead of rerunning it.",
		].join("\n");
	} catch {
		return "";
	}
}

function clearSessionLedger(sessionKey) {
	if (typeof sessionKey === "string" && sessionKey !== "") ledgers.delete(sessionKey);
}

/** Mount the ledger: two tools-waterfall listeners plus session lifecycle
 *  cleanup. Every listener fails open (best-effort, then next()). */
function applyPtcBindings(ctx) {
	ctx.on("tools/pre-execute", (exec, next) => {
		try {
			if (exec?.name === RUN_CODE_NAME && typeof exec?.arguments?.code === "string") {
				const key = sessionKeyOf(exec?.agent);
				if (key !== null) {
					pending.set(exec, { key, names: topLevelDeclarations(exec.arguments.code) });
				}
			}
		} catch {
			/* fail open: the call proceeds unscanned */
		}
		return next();
	});
	ctx.on("tools/post-execute", (exec, result, next) => {
		try {
			if (exec?.name === RUN_CODE_NAME) {
				const rec = pending.get(exec);
				pending.delete(exec);
				const key = rec !== undefined ? rec.key : sessionKeyOf(exec?.agent);
				if (key !== null) {
					if (result?.isError === true) {
						const text = failureTextOf(result);
						if (text !== null && REDECLARE_RE.test(text)) {
							// Parse-level rejection before any code ran: roll back the
							// parked names, then self-heal the quoted duplicate(s).
							addSelfHealNames(ledgerOf(key), text);
						} else if (text === null || !PARSE_FAIL_RE.test(text)) {
							// Runtime failure: earlier top-level declarations are live.
							commitNames(key, rec?.names);
						}
						// else: other parse failure — nothing ran, nothing to record.
					} else {
						commitNames(key, rec?.names);
					}
				}
			}
		} catch {
			/* fail open */
		}
		return next();
	});
	ctx.on("session/event", (session, event) => {
		try {
			if (event?.type !== "user/message") return;
			if (event?.data?.source?.kind !== "ptc-mode") return;
			const text = contentTextOf(event?.data?.content);
			if (typeof text === "string" && text.includes(PTC_RESET_NOTICE)) {
				clearSessionLedger(sessionKeyOf(session));
			}
		} catch {
			/* fail open */
		}
	});
	ctx.on("session/disposed", (session) => {
		try {
			clearSessionLedger(sessionKeyOf(session));
		} catch {
			/* fail open */
		}
	});
}

export {
	applyPtcBindings,
	clearSessionLedger,
	renderPtcLedgerClause,
	sessionKeyOf,
	stripLiterals,
	topLevelDeclarations,
};
