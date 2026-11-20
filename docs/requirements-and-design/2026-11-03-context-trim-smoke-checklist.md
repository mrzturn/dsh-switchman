# Live smoke checklist — dsh-switchman context-trim v1.8.1 (post-restart)

Precondition already done (2026-11-03): repo synced into
~/.dsh/profiles/desktop/node_modules/dsh-switchman/ (backup at
.dsh-switchman.bak-pretrim-<epoch> alongside). cordis.patch.yml with
auto:false arbitration pins ships inside the package and re-applies at
host start.

## Steps (run in a NEW DSH session after app restart)

1. Confirm the new plugin is live: host log should contain
   [context-trim] banner lines OR check ~/.dsh/.../state/trim/ dir gets
   created on first session activity. If nothing: check host startup
   errors mention dsh-switchman.
2. Grow a session past the growth gate (read a few big files, >50k
   tokens of tool output). Watch for:
   - [SWITCHMAN:TRIM] banner in runtime context: "view ~Nk tokens"
     (VIEW reading, not stored).
   - First fold at idle boundary: warn-once log line
     "[context-trim] <session>: committed fold ..." + a
     <sessionId>.json ledger under <dshHome>/.dsh-switchman/state/trim/.
   - Watermark banner should DROP after fold (view shrinks), unlike the
     old stored-token reading that only climbed.
3. Compaction arbitration: /compact command still works manually (handover
   borrow intact); no automatic compaction from dsh-compaction-basic
   (auto:false). Overflow handling: emergency tier fold at idle boundary.
4. Fork inheritance: spawn a subagent_fork child from a folded parent;
   child's first llm/stream should log
   "[context-trim] <child>: inherited fold state from <parent> (N blocks,
   frontier preserved)" when history matches; else clean start.
5. Metrics sanity: after a fold, upstream request input tokens should drop
   on the next turn (cache repays only the new tail).

## Rollback

rm -rf ~/.dsh/profiles/desktop/node_modules/dsh-switchman && mv
.dsh-switchman.bak-pretrim-<epoch> dsh-switchman ; restart app.
