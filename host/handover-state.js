/**
 * Shared in-flight handover registry (process-lifetime, never persisted).
 *
 * context-watch.js records phase transitions from the first synchronous
 * line of runHandover (t=0, before the fork even starts); routes.js
 * exposes the read-only snapshot behind GET /api/dsh-switchman/
 * handover-state so the client badge can show a live "handover in
 * progress" cue during the otherwise-silent fork+compact window.
 */

/** sessionId -> { sessionId, phase, source?, attempt?, at }. */
const inflight = new Map();

/**
 * Record (or overwrite) the live phase of one session's handover.
 * @param {string} sessionId - the root session being handed over.
 * @param {object} info - { phase: "backup"|"compacting"|"continuation",
 *   source?: "manual"|"tool"|"auto", attempt?: number, at: number }.
 */
export function recordHandover(sessionId, info) {
	if (sessionId === null || sessionId === undefined) return;
	inflight.set(sessionId, { ...info, sessionId });
}

/** Drop the record once the handover settles (success or failure). */
export function clearHandover(sessionId) {
	inflight.delete(sessionId);
}

/** Live record for one session, or undefined. */
export function handoverOf(sessionId) {
	return inflight.get(sessionId);
}

/** Read-only array snapshot of every in-flight handover. */
export function handoverSnapshot() {
	return [...inflight.values()];
}
