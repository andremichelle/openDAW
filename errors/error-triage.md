# openDAW Error Triage — index

Snapshot of https://logs.opendaw.studio. **57 unresolved** reports across **33 signatures**, grouped into **23 error-groups** (one file each). Scanned 914 rows, ids 1..1001.

Each error-group has its own file in this folder. Priority: **P1** highest-value real bugs · **P2** real bugs · **P3** lower/needs-context · **ENV** environmental/transient. (Nothing is marked RESOLVED — see note below; a silenced/reworded panic is not a fix.)

> Per-error workflow (proven on #995–#1001): pull full logs+stack -> root-cause -> reproduce (unit test where feasible) -> fix the root cause (no band-aids) -> regression test -> branch->main -> mark `fixed=1`.

> **Cross-cutting fix (ErrorHandler):** `processError` no longer treats an unhandled **promise rejection** as fatal — previously ANY non-ignored rejection ran `AnimationFrame.terminate()` + the recovery dialog, killing the whole app over a single async failure (even a reason-less one). Rejections are now reported once and the session stays alive; only synchronous `error` events remain fatal. This is the root cause behind much of the rejection-based "crash" class below; the per-error `#tryIgnore` handlers (storage, monaco, file-picker, …) remain as defence-in-depth and for friendly messages.


## P1

- [Mixer Unknown-key channel-strip](P1-mixer-unknown-key-channel-strip.md) — OPEN · 5× · ids [924, 925, 926, 984, 985]
- [Timeline duration family](P1-timeline-duration-family.md) — #1003 FIXED · recording guarded · 4× · ids [933, 982, 998, 1003]

## P2

- [UI Checkbox catch-not-a-function](P2-ui-checkbox-catch-not-a-function.md) — ALREADY FIXED (7cac185c6) · 2× · ids [815, 816]
- [Box-graph requires-an-edge](P2-box-graph-requires-an-edge.md) — OPEN · 2× · ids [820, 983]
- [Box-graph already-staged](P2-box-graph-already-staged.md) — OPEN · 2× · ids [662, 903]
- [Automation Already-assigned](P2-automation-already-assigned.md) — FIXED (menu path) · 1× · ids [915]
- [Timeline overlap-after-clipping](P2-timeline-overlap-after-clipping.md) — OPEN (band-aided, not fixed) · 5× · ids [738, 740, 745, 748, 758]
- [Timeline region-split zero-duration](P2-timeline-region-split-zero-duration.md) — OPEN (reworded panic, not fixed) · 1× · ids [667]

## P3

- [Mixdown offline-render OOM](P3-mixdown-offline-render-oom.md) — OPEN · 4× · ids [70, 71, 291, 302]
- [Option unwrap-failed](P3-option-unwrap-failed.md) — OPEN · 2× · ids [811, 950]
- [Monaco object-Event worker](P3-monaco-object-event-worker.md) — FIXED · 2× · ids [642, 703]
- [Monaco factory null-deref](P3-monaco-factory-null-deref.md) — OPEN · 1× · ids [975]

## ENV

- [Storage quota-exceeded](ENV-storage-quota-exceeded.md) — FIXED (graceful) · 5× · ids [839, 951, 952, 953, 954]
- [Storage file-not-found](ENV-storage-file-not-found.md) — FIXED (non-fatal) · 4× · ids [631, 766, 971, 974]
- [Network failed-to-fetch](ENV-network-failed-to-fetch.md) — FIXED (non-fatal) · 4× · ids [604, 624, 761, 813]
- [Generic unhandledrejection](ENV-generic-unhandledrejection.md) — FIXED (synthetic/old) · 2× · ids [807, 809]
- [Storage io-read-failed](ENV-storage-io-read-failed.md) — FIXED (graceful) · 2× · ids [697, 698]
- [Deploy html-served-for-js](ENV-deploy-html-served-for-js.md) — FIXED (infra-mitigated) · 2× · ids [160, 237]
- [Storage transient-cached-state](ENV-storage-transient-cached-state.md) — FIXED (non-fatal) · 2× · ids [870, 981]
- [Network chunk-load](ENV-network-chunk-load.md) — FIXED (infra-mitigated) · 2× · ids [623, 810]
- [Audio device-init](ENV-audio-device-init.md) — FIXED (handled/old) · 2× · ids [704, 765]
- [External btn-comment-mode-click](ENV-external-btn-comment-mode-click.md) — FIXED (generic external) · 1× · ids [957]
- [File-picker not-allowed](ENV-file-picker-not-allowed.md) — FIXED (graceful) · 1× · ids [814]

> **No truly-resolved groups.** The two previously labeled RESOLVED were band-aids, not fixes: overlap-after-clipping (panic→`console.error`) and region-split zero-duration (panic reworded). Both are now OPEN under P2. Nothing has been marked `fixed=1`.

## Strategy — address one by one

- **Phase 0 — none.** There are no genuinely-resolved reports to reconcile; do not mark anything `fixed=1` until its root cause is actually fixed (verified by repro/test).
- **Phase 1 — Timeline duration family (#933/#982/#998):** find & fix the 0-duration creation site (recording suspect). No band-aids.
- **Phase 2 — Mixer 'Unknown key' (5x):** registerChannelStrip -> SortedSet.get miss; getOrNull + guard.
- **Phase 3 — Box-graph integrity:** requires-an-edge / already-staged / Already-assigned; reproduce per op.
- **Phase 4 — UI & editor:** Checkbox .catch, Monaco factory null, Monaco [object Event], unwrap failed.
- **Phase 5 — Resource limits:** mixdown/offline-render OOM; catch + friendly message.
- **Phase 6 — Environmental noise:** graceful handling + ErrorHandler ignore-list/reload-prompt (cf. #997).

One phase per session; mark `fixed=1` as each ships.
