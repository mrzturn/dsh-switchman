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
 * to the vision pool (MCP image-analysis tools accept local file
 * paths; calling read_image in a text-only context would only yield a
 * placeholder, so the followup forbids that). With an empty vision
 * pool the command refuses with setup guidance instead, and the client
 * composer-dock hint (fed by GET /api/dsh-switchman/vision-state)
 * points at the same setting.
 */

import { join } from "node:path";
import { dshHome } from "./lib/dsh-home.js";
import { reportedUiLocale } from "./ui-locale.js";

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

/** Whether the first root session's selected model accepts image input.
 * Mirrors the prompt-admission gate's exact semantics: undefined
 * inputModalities pass (no restriction declared); anything else must
 * include "image". Returns null when unknowable (no root, no llm
 * service, resolution failure) — callers treat null as "don't know",
 * never as capable/incapable. */
async function rootImageCapableOf(ctx) {
	try {
		const root = ctx.agents?.roots?.()?.[0];
		if (root === undefined) return null;
		const current = ctx.agents?.selectionFor?.(root)?.current;
		if (!current?.provider || !current?.model) return null;
		const resolveModelInfo = ctx.get?.("llm", false)?.resolveModelInfo;
		if (typeof resolveModelInfo !== "function") return null;
		const info = await resolveModelInfo(current.provider, current.model);
		if (info?.inputModalities === undefined) return true;
		return Array.isArray(info.inputModalities) && info.inputModalities.includes("image");
	} catch {
		return null;
	}
}

/**
 * Live vision-gate state for the client hint route.
 * @param {import("@deepseek-ai/cordis").Context} ctx - host plugin context.
 * @param {object} config - this plugin's live volatile config.
 * @returns {Promise<{poolConfigured: boolean, imageCapable: boolean | null}>}
 */
export async function visionStateOf(ctx, config) {
	return {
		poolConfigured: readPool(config.poolVision).length > 0,
		imageCapable: await rootImageCapableOf(ctx),
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
						? "/vision：视觉池未配置模型。当前会话模型不支持读图——请先在 设置 → dsh-switchman → 派发池与模型排序 的「视觉池 · vision」中添加模型，再重新发送。"
						: "/vision: the vision pool has no models. This session model cannot read images — add vision-pool models under Settings → dsh-switchman → dispatch pools, then resend.",
				};
			}
			const store = ctx.get?.("attachments", false);
			const lines = [];
			for (const block of images) {
				const path = imageHostPathOf(store, block.attachment);
				if (path === undefined) {
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
				lines.push(`- ${path} (${ref.mediaType}${name}, ${ref.width}x${ref.height})`);
			}
			const followup = [
				"[SWITCHMAN:VISION] The user sent image attachment(s) that this session model cannot read directly.",
				`User message: ${message === "" ? "(none)" : message}`,
				"Admitted normalized objects (absolute host paths):",
				...lines,
				"Read them by delegating to the vision pool (vision lane): pass a local file path above to an MCP image-analysis tool that accepts paths (e.g. analyze_image with image_source=<path>). Do NOT call read_image on them yourself — a text-only context would only receive a placeholder. Then answer the user in their language.",
			].join("\n");
			try {
				agent?.followup?.({
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
					? `[SWITCHMAN:VISION] 已放行 ${images.length} 张图片并把宿主路径+视觉派发指令注入会话。`
					: `[SWITCHMAN:VISION] ${images.length} image(s) admitted; host paths + vision-dispatch instructions injected into the session.`,
			};
		},
	});
}
