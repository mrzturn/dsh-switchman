/** Shared <DSH_HOME> derivation. Explicit env override wins (with ~
 * expansion), else the per-user default. Mirrors the host's own
 * resolution order (dsh-home-paths' resolveDshHome), so plugin-side file
 * lookups (attachments store, session projcache records) land on the same
 * directories the host reads and writes. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Best-effort <DSH_HOME> derivation: explicit env override wins, else
 * the per-user default. */
export function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === "string" && env.trim() !== "") {
		const expanded = env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
		return resolve(expanded);
	}
	return join(homedir(), ".dsh");
}
