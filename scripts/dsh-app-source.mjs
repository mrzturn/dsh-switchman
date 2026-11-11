/**
 * Shared readers for the installed DeepSeek Harness app tree.
 *
 * DSH Desktop ≤0.1.7 shipped a plain `app/node_modules` tree; the renamed
 * DeepSeek Harness app packs the same tree into `app.asar` (with native
 * modules in `app.asar.unpacked`). Every consumer (scripts/validate.mjs,
 * scripts/snapshot-presets.mjs) reads shipped files through this module so
 * both layouts stay supported in exactly one place.
 *
 * Zero runtime dependencies: node builtins only (the yaml parser is resolved
 * lazily by loadYaml with the same candidate ladder as before).
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";

export const APP_ROOT = process.env.DSH_APP_ROOT ?? "/Applications/DeepSeek Harness.app/Contents/Resources/app";

/** Read one file out of an asar archive (plain header walk, no dependency). */
export function readAsarFile(asarPath, innerPath) {
	const fd = openSync(asarPath, "r");
	try {
		const head = Buffer.alloc(8);
		readSync(fd, head, 0, 8, 0);
		const headerSize = head.readUInt32LE(4);
		const headerBuffer = Buffer.alloc(headerSize);
		readSync(fd, headerBuffer, 0, headerSize, 8);
		const text = headerBuffer.toString("utf8");
		const header = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
		let node = header;
		for (const segment of innerPath.split("/")) {
			node = node.files[segment];
			if (node === undefined) return undefined;
		}
		if (node.files !== undefined || node.unpacked) return undefined;
		const buffer = Buffer.alloc(node.size);
		readSync(fd, buffer, 0, node.size, 8 + headerSize + Number(node.offset));
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** One shipped preset's patch text: legacy app tree first, then the asar. */
export function readShippedPatch(pid) {
	const plain = `${APP_ROOT}/node_modules/@deepseek-ai/dsh-web-app/presets/${pid}.patch.yml`;
	if (existsSync(plain)) return readFileSync(plain, "utf8");
	return readAsarFile(`${APP_ROOT}.asar`, `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/${pid}.patch.yml`);
}

/** One shipped module's source text: legacy app tree first, then the asar. */
export function readShippedModuleSource(moduleRelPath) {
	const plain = `${APP_ROOT}/node_modules/${moduleRelPath}`;
	if (existsSync(plain)) return readFileSync(plain, "utf8");
	return readAsarFile(`${APP_ROOT}.asar`, `dsh/node_modules/${moduleRelPath}`);
}

/**
 * The installed app's own version: asar `dsh/package.json` first, then the
 * legacy plain-tree layout. Returns undefined when the app is not readable.
 */
export function readAppVersion() {
	const asar = readAsarFile(`${APP_ROOT}.asar`, "dsh/package.json");
	if (asar !== undefined) {
		try {
			return JSON.parse(asar).version;
		} catch {
			/* fall through */
		}
	}
	const plain = `${APP_ROOT}/package.json`;
	if (existsSync(plain)) {
		try {
			return JSON.parse(readFileSync(plain, "utf8")).version;
		} catch {
			/* fall through */
		}
	}
	return undefined;
}

/**
 * YAML parser with the same candidate ladder as validate.mjs has always used:
 * the installed app tree → the active web-profile workspace → the bare
 * devDependency (CI installs it via npm ci).
 */
export async function loadYaml() {
	const candidates = [
		`${APP_ROOT}/node_modules/yaml/dist/index.js`,
		`${homedir()}/.dsh/profiles/web/node_modules/yaml/dist/index.js`,
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return (await import(candidate)).default;
	}
	return (await import("yaml")).default;
}
