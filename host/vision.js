/**
 * Vision dispatch gate: the /vision command + vision-state helper.
 *
 * DSH refuses plain prompts containing images while the session model
 * reports no image input (MODEL_DOES_NOT_SUPPORT_IMAGES, thrown at
 * prompt admission — the composer never blocks attaching). The command
 * channel is the sanctioned unlock: a command declaring
 * input.attachments: true passes NO model-capability check (the same
 * channel /goal and /plan use), so /vision admits pasted images on a
 * text-only session, resolves each admitted object's host path through
 * the attachment store, and re-emits them as a TEXT followup — paths
 * plus dispatch instructions — that any model can act on by delegating
 * to the vision pool. The store's content-addressed objects carry NO
 * file extension, which MCP image-analysis tools reject on sight
 * ("Unsupported image format"), and normalization may hand us formats
 * some tools refuse outright (e.g. image/webp) — so each image is
 * first materialized into <DSH_HOME>/dsh-switchman/vision/ as a
 * durable, extension-named copy (native copy for PNG/JPEG, transcoded
 * to PNG via the first available converter for everything else).
 * Calling read_image in a text-only context would only yield a
 * placeholder, so the followup forbids that. With an empty vision
 * pool the command refuses with setup guidance instead, and the client
 * composer-dock hint (fed by GET /api/dsh-switchman/vision-state)
 * points at the same setting. The route's optional `session` query
 * parameter judges the named session's own model (via the session-query
 * observeSession channel shared with host/subagent-model.js), so a child
 * session on a different route no longer misreports — unknown sessions
 * report null (unknown), never another conversation's verdict; only
 * session-less probes fall back to a best-effort root verdict. Auto
 * pseudo-model selections are judged through the intent layer's current
 * decided route; the hint itself renders only on a positively confirmed
 * text-only verdict (client.js), so "unknown" stays silent.
 */

import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { dshHome } from "./lib/dsh-home.js";
import { AUTO_PROVIDER, intentStateOf } from "./intent.js";
import { sessionModelSelectionOf } from "./subagent-model.js";
import { reportedUiLocale } from "./ui-locale.js";

const execFile = promisify(execFileCb);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read one volatile settings field's plain value (live `.get()` ref or raw). */
function readPool(field) {
	const value =
		field !== null && typeof field === "object" && typeof field.get === "function" ? field.get() : field;
	return Array.isArray(value) ? value : [];
}

/** Host path of one admitted normalized image object: prefer the store's
 * authoritative imageHostPath, else derive the content-addressed path
 * from the attachmentId (sha256 of the NORMALIZED bytes — mediaType and
 * dimensions on the ref also describe the normalized object, not the
 * user's original file). Returns undefined when neither works. */
function imageHostPathOf(store, ref) {
	const viaStore = store?.imageHostPath?.(ref);
	if (typeof viaStore === "string") return viaStore;
	const match = /^sha256:([a-f0-9]{64})$/.exec(String(ref?.attachmentId ?? ""));
	if (match === null) return undefined;
	return join(dshHome(), "attachments", "v1", "objects", match[1].slice(0, 2), match[1]);
}

/** Formats MCP image tools accept verbatim — copied as-is with their
 * native extension. Everything else gets transcoded to PNG. */
const NATIVE_EXT = new Map([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/pjpeg", "jpg"],
]);

/** Extension for the best-effort raw fallback when no converter exists. */
const FALLBACK_EXT = new Map([
	["image/webp", "webp"],
	["image/gif", "gif"],
	["image/bmp", "bmp"],
	["image/tiff", "tiff"],
	["image/avif", "avif"],
]);

/** Transcode-to-PNG chain, first executable wins (sips: macOS built-in;
 * magick/ffmpeg: common cross-platform installs). */
const CONVERTERS = [
	{ bin: "sips", args: (src, dst) => ["-s", "format", "png", src, "--out", dst] },
	{ bin: "magick", args: (src, dst) => [src, dst] },
	{ bin: "ffmpeg", args: (src, dst) => ["-y", "-i", src, dst] },
];

const exists = (path) =>
	access(path, constants.F_OK)
		.then(() => true)
		.catch(() => false);

/** First-8-bytes PNG signature check — a converter killed mid-write
 * (timeout, full disk) or exiting 0 with garbage output must not leave
 * a corrupt file behind that the exists() cache would serve forever. */
async function looksLikePng(path) {
	let handle;
	try {
		handle = await open(path, "r");
		const buf = Buffer.alloc(8);
		const { bytesRead } = await handle.read(buf, 0, 8, 0);
		return bytesRead === 8 && buf.equals(PNG_MAGIC);
	} catch {
		return false;
	} finally {
		await handle?.close?.().catch(() => {});
	}
}

const drop = (path) => rm(path, { force: true }).catch(() => {});

/** Materialize one admitted image into <DSH_HOME>/dsh-switchman/vision/
 * as an extension-named, tool-readable copy keyed by its content hash
 * (re-admitting the same object reuses the same file). PNG/JPEG copy
 * natively; other formats transcode to PNG when a converter is
 * available, else fall back to a native-extension copy the followup
 * flags for manual conversion. Absolute last resort: the extension-less
 * store path itself, clearly marked.
 * @returns {Promise<{path: string, note?: string} | undefined>}
 *     undefined only when the store path itself is unresolvable. */
async function materializeImage(store, ref, warn) {
	const src = imageHostPathOf(store, ref);
	if (src === undefined) return undefined;
	const idMatch = /^sha256:([a-f0-9]{64})$/.exec(String(ref?.attachmentId ?? ""));
	const hash =
		idMatch?.[1] ??
		(String(ref?.attachmentId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || randomUUID());
	const dir = join(dshHome(), "dsh-switchman", "vision");
	const native = NATIVE_EXT.get(String(ref?.mediaType ?? "").toLowerCase());

	// Native PNG/JPEG: a plain copy is exactly what image tools want.
	if (native !== undefined) {
		const dst = join(dir, `${hash}.${native}`);
		if (await exists(dst)) return { path: dst };
		try {
			await mkdir(dir, { recursive: true });
			await copyFile(src, dst);
			return { path: dst };
		} catch (error) {
			warn(`vision: native copy failed (${error?.message ?? error})`);
			return {
				path: src,
				note: "extension-less store path — copy it to a .png/.jpg file before image tools can read it",
			};
		}
	}

	// Everything else: transcode to PNG via the first usable converter.
	const dst = join(dir, `${hash}.png`);
	if (await exists(dst)) {
		if (await looksLikePng(dst)) return { path: dst, note: "transcoded to PNG" };
		await drop(dst); // cached file is corrupt — rebuild it
	}
	try {
		await mkdir(dir, { recursive: true });
	} catch (error) {
		warn(`vision: vision dir unavailable (${error?.message ?? error})`);
		return {
			path: src,
			note: "extension-less store path — copy it to a .png file before image tools can read it",
		};
	}
	for (const { bin, args } of CONVERTERS) {
		try {
			await execFile(bin, args(src, dst), { timeout: 20_000, windowsHide: true });
		} catch {
			// Converter missing or failed on this input — drop any partial
			// output, then try the next one.
			await drop(dst);
			continue;
		}
		if (await looksLikePng(dst)) return { path: dst, note: `transcoded to PNG via ${bin}` };
		await drop(dst); // exited 0 but output is not a PNG — keep trying
	}

	// No converter: best-effort native-extension copy + explicit flag.
	const ext = FALLBACK_EXT.get(String(ref?.mediaType ?? "").toLowerCase()) ?? "img";
	const raw = join(dir, `${hash}.${ext}`);
	try {
		await copyFile(src, raw);
		warn(`vision: no PNG converter available; kept ${ref?.mediaType} copy at ${raw}`);
		return {
			path: raw,
			note: "not transcoded — some image tools reject this format; convert it to PNG yourself first (e.g. sips -s format png <path> --out <out>.png)",
		};
	} catch (error) {
		warn(`vision: fallback copy failed (${error?.message ?? error})`);
		return {
			path: src,
			note: "extension-less store path — copy it to a .png file before image tools can read it",
		};
	}
}

/** Whether ONE exact model route accepts image input — the shared core of
 *  the root and per-session verdicts. Mirrors the prompt-admission gate's
 *  exact semantics: undefined inputModalities pass (no restriction
 *  declared); anything else must include "image". Returns null when
 *  unknowable (bad route, no llm service, resolution failure) — callers
 *  treat null as "don't know", never as capable/incapable.
 *
 *  The resolveModelInfo call MUST stay receiver-bound: LlmRuntime methods
 *  read `this` (this.resolveModelInfoFor), so detaching the method turned
 *  every probe into a TypeError → null (the "hint always shows" bug). */
async function modelImageCapableOf(ctx, provider, model) {
	try {
		if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") return null;
		const llm = ctx.get?.("llm", false);
		if (llm === null || typeof llm !== "object" || typeof llm.resolveModelInfo !== "function") return null;
		const info = await llm.resolveModelInfo(provider, model);
		if (info?.inputModalities === undefined) return true;
		return Array.isArray(info.inputModalities) && info.inputModalities.includes("image");
	} catch {
		return null;
	}
}

/** Image verdict for one session's model SELECTION. A concrete route is
 *  judged directly; the dsh-switchman-auto pseudo route is judged through
 *  the intent layer's current decided route (the adapter's routing point is
 *  invisible to every DSH projection, so switchman's own routedCurrent is
 *  the only source). No decision yet (fresh auto session) or an unreadable
 *  intent state yields null — "don't know", not incapable. */
async function selectionImageCapableOf(ctx, config, selection, sessionId) {
	if (selection === null) return null;
	if (selection.provider === AUTO_PROVIDER) {
		try {
			const state = await intentStateOf(ctx, config, sessionId);
			const decided = state?.current;
			if (decided === null || typeof decided !== "object") return null;
			return modelImageCapableOf(ctx, decided.provider, decided.model);
		} catch {
			return null;
		}
	}
	return modelImageCapableOf(ctx, selection.provider, selection.model);
}

/** Whether the first root session's selected model accepts image input.
 *  Null when unknowable. Best-effort for probes WITHOUT a session id only
 *  (the client dock always passes one): `selectionFor` lives on the
 *  session-controller's internal controller, not on the cordis ctx.agents
 *  registry, so the first read yields undefined on current DSH and the
 *  dsh ≥0.2.2 `agent.model.current()` shape is tried as the second
 *  attempt. The root's session id rides along so an auto-selection
 *  resolves its decided route through the intent layer (agent ids are
 *  session ids in the agents registry). */
async function rootImageCapableOf(ctx, config) {
	try {
		const root = ctx.agents?.roots?.()?.[0];
		if (root === undefined) return null;
		const current = ctx.agents?.selectionFor?.(root)?.current ?? root?.model?.current?.();
		if (!current?.provider || !current?.model) return null;
		return selectionImageCapableOf(ctx, config, current, typeof root?.id === "string" ? root.id : null);
	} catch {
		return null;
	}
}

/** Whether ONE named session's effective model accepts image input, via the
 *  session-query observeSession channel (shared with host/subagent-model.js;
 *  cold sessions resolve without activating the child). Null when the
 *  session is unknown, unreadable, or carries no selection yet. */
async function sessionImageCapableOf(ctx, config, sessionId) {
	return selectionImageCapableOf(ctx, config, await sessionModelSelectionOf(ctx, sessionId), sessionId);
}

/**
 * Live vision-gate state for the client hint route. `sessionId` (an optional
 * child session id, from the vision-state route's `session` query parameter)
 * judges image capability against THAT session's model — a known-but-
 * unreadable session stays null instead of judging some other conversation's
 * root model. Only probes WITHOUT a session id fall back to the first root
 * session's verdict.
 * @param {import("@deepseek-ai/cordis").Context} ctx - host plugin context.
 * @param {object} config - this plugin's live volatile config.
 * @param {string | null} [sessionId] - session to judge instead of the root.
 * @returns {Promise<{poolConfigured: boolean, imageCapable: boolean | null}>}
 */
export async function visionStateOf(ctx, config, sessionId = null) {
	const hasSession = typeof sessionId === "string" && sessionId !== "";
	let imageCapable = hasSession ? await sessionImageCapableOf(ctx, config, sessionId) : null;
	if (imageCapable === null && !hasSession) imageCapable = await rootImageCapableOf(ctx, config);
	return {
		poolConfigured: readPool(config.poolVision).length > 0,
		imageCapable,
	};
}

/** Localized (zh/en) helper for user-facing command result text. */
const isZh = () => (reportedUiLocale() ?? "").toLowerCase().startsWith("zh");

/**
 * Mount the /vision command (global, plain-context registration).
 * @param {import("@deepseek-ai/cordis").Context} ctx - host plugin context.
 * @param {object} config - this plugin's live volatile config.
 */
export function applyVision(ctx, config) {
	const warn = (message) => ctx.logger?.warn?.(`dsh-switchman: ${message}`);
	ctx.commands?.register?.({
		name: "vision",
		description:
			"Send pasted images with a text-only session model: admits the attachments, hands their host paths to the agent, and instructs vision-pool dispatch.",
		input: { hint: "[message to accompany the images]", attachments: true },
		handler: async (invocation) => {
			const agent = invocation?.agent;
			const attachments = Array.isArray(invocation?.attachments) ? invocation.attachments : [];
			const message = (invocation?.rawInput ?? "").trim();
			// Defensive (the frozen CommandInvocation contract always carries
			// agent): a missing followup must NOT yield a false success below.
			if (typeof agent?.followup !== "function") {
				return {
					kind: "error",
					text: isZh() ? "/vision：当前会话不可用，未发送。" : "/vision: no usable session agent; nothing was sent.",
				};
			}
			const images = attachments.filter((block) => block?.type === "image" && block.attachment);
			if (attachments.some((block) => block?.type === "file")) {
				return {
					kind: "error",
					text: isZh()
						? "/vision：仅接受图片附件。普通文件不受模型读图限制，直接随普通消息发送即可。"
						: "/vision: image attachments only. Generic files are not gated by image support — send them with a normal message.",
				};
			}
			if (images.length === 0) {
				return {
					kind: "error",
					text: isZh()
						? "/vision：没有图片附件。请先粘贴或拖入图片，再发送本命令。"
						: "/vision: no image attachments. Paste or drop images before sending this command.",
				};
			}
			if (readPool(config.poolVision).length === 0) {
				return {
					kind: "error",
					text: isZh()
						? "/vision：视觉池未配置模型——请先在 设置 → dsh-switchman → 派发池与模型排序 的「视觉池 · vision」中添加模型，再重新发送。"
						: "/vision: the vision pool has no models — add vision-pool models under Settings → dsh-switchman → dispatch pools, then resend.",
				};
			}
			const store = ctx.get?.("attachments", false);
			const lines = [];
			for (const block of images) {
				const material = await materializeImage(store, block.attachment, warn);
				if (material === undefined) {
					warn("vision: could not resolve host path for admitted image");
					return {
						kind: "error",
						text: isZh()
							? "/vision：无法解析某张已收图片的宿主路径（附件存储不可达且推导失败），本次未发送。"
							: "/vision: could not resolve the host path of an admitted image (attachment store unreachable and derivation failed); nothing was sent.",
					};
				}
				const ref = block.attachment;
				const name = typeof ref.name === "string" && ref.name !== "" ? `, ${ref.name}` : "";
				const note = material.note === undefined ? "" : ` — ${material.note}`;
				lines.push(`- ${material.path} (${ref.mediaType}${name}, ${ref.width}x${ref.height}${note})`);
			}
			const followup = [
				"[SWITCHMAN:VISION] The user sent image attachment(s) that this session model cannot read directly.",
				`User message: ${message === "" ? "(none)" : message}`,
				"Admitted normalized objects, already materialized as extension-named readable copies (absolute host paths):",
				...lines,
				"Read them by delegating to the vision pool (vision lane): pass a local file path above to an MCP image-analysis tool that accepts paths (e.g. analyze_image with image_source=<path>). Each path already carries a proper file extension (non-PNG/JPEG formats were transcoded to PNG where a converter was available), so image tools accept the paths directly — do not re-copy files yourself unless a per-file note asks you to. Do NOT call read_image on them yourself — a text-only context would only receive a placeholder. Then answer the user in their language.",
			].join("\n");
			try {
				agent?.followup?.({
					// The gateway's stored-session validation (assertMessageEventShape)
					// rejects a user/message whose record lacks a non-empty id/role —
					// an id-less synthetic message bricks the session on reload
					// ("session event at seq N lacks an identified message").
					id: randomUUID(),
					role: "user",
					content: [{ type: "text", text: followup }],
					source: { kind: "user" },
				});
				await ctx.sessions?.flush?.(agent?.session);
			} catch (error) {
				warn(`vision: followup failed: ${error?.message ?? error}`);
				return {
					kind: "error",
					text: isZh()
						? `/vision：消息回注失败（${error?.message ?? error}），图片未送达会话。`
						: `/vision: followup failed (${error?.message ?? error}); the images were not delivered.`,
				};
			}
			return {
				kind: "success",
				text: isZh()
					? `[SWITCHMAN:VISION] 已放行 ${images.length} 张图片，并把带扩展名的可读副本+视觉派发指令注入会话。`
					: `[SWITCHMAN:VISION] ${images.length} image(s) admitted; extension-named readable copies + vision-dispatch instructions injected into the session.`,
			};
		},
	});
}
