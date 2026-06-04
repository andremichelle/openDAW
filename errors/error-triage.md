# openDAW Error Triage — index

Snapshot of https://logs.opendaw.studio. **57 unresolved** reports across **33 signatures**, grouped into **23 error-groups** (one file each). Scanned 914 rows, ids 1..1001.

Each error-group has its own file in this folder. Priority: **P1** highest-value real bugs · **P2** real bugs · **P3** lower/needs-context · **ENV** environmental/transient · **RESOLVED** message already gone from source.

> Per-error workflow (proven on #995–#1001): pull full logs+stack -> root-cause -> reproduce (unit test where feasible) -> fix the root cause (no band-aids) -> regression test -> branch->main -> mark `fixed=1`.


## P1

- [Mixer Unknown-key channel-strip](P1-mixer-unknown-key-channel-strip.md) — OPEN · 5× · ids [924, 925, 926, 984, 985]
- [Timeline duration family](P1-timeline-duration-family.md) — OPEN · 3× · ids [933, 982, 998]

## P2

- [UI Checkbox catch-not-a-function](P2-ui-checkbox-catch-not-a-function.md) — OPEN · 2× · ids [815, 816]
- [Box-graph requires-an-edge](P2-box-graph-requires-an-edge.md) — OPEN · 2× · ids [820, 983]
- [Box-graph already-staged](P2-box-graph-already-staged.md) — OPEN · 2× · ids [662, 903]
- [Automation Already-assigned](P2-automation-already-assigned.md) — OPEN · 1× · ids [915]

## P3

- [Mixdown offline-render OOM](P3-mixdown-offline-render-oom.md) — OPEN · 4× · ids [70, 71, 291, 302]
- [Option unwrap-failed](P3-option-unwrap-failed.md) — OPEN · 2× · ids [811, 950]
- [Monaco object-Event worker](P3-monaco-object-event-worker.md) — OPEN · 2× · ids [642, 703]
- [Monaco factory null-deref](P3-monaco-factory-null-deref.md) — OPEN · 1× · ids [975]

## ENV

- [Storage quota-exceeded](ENV-storage-quota-exceeded.md) — ENV · 5× · ids [839, 951, 952, 953, 954]
- [Storage file-not-found](ENV-storage-file-not-found.md) — ENV · 4× · ids [631, 766, 971, 974]
- [Network failed-to-fetch](ENV-network-failed-to-fetch.md) — ENV · 4× · ids [604, 624, 761, 813]
- [Generic unhandledrejection](ENV-generic-unhandledrejection.md) — ENV · 2× · ids [807, 809]
- [Storage io-read-failed](ENV-storage-io-read-failed.md) — ENV · 2× · ids [697, 698]
- [Deploy html-served-for-js](ENV-deploy-html-served-for-js.md) — ENV · 2× · ids [160, 237]
- [Storage transient-cached-state](ENV-storage-transient-cached-state.md) — ENV · 2× · ids [870, 981]
- [Network chunk-load](ENV-network-chunk-load.md) — ENV · 2× · ids [623, 810]
- [Audio device-init](ENV-audio-device-init.md) — ENV · 2× · ids [704, 765]
- [External btn-comment-mode-click](ENV-external-btn-comment-mode-click.md) — ENV · 1× · ids [957]
- [File-picker not-allowed](ENV-file-picker-not-allowed.md) — ENV · 1× · ids [814]

## RESOLVED

- [Timeline overlap-after-clipping](RESOLVED-timeline-overlap-after-clipping.md) — RESOLVED · 5× · ids [738, 740, 745, 748, 758]
- [Timeline duration zero-or-negative](RESOLVED-timeline-duration-zero-or-negative.md) — RESOLVED · 1× · ids [667]

## Strategy — address one by one

- **Phase 0 — Reconcile (no code):** verify the RESOLVED group on a current build, flip `fixed=1` (#667, #738/#740/#745/#748/#758).
- **Phase 1 — Timeline duration family (#933/#982/#998):** find & fix the 0-duration creation site (recording suspect). No band-aids.
- **Phase 2 — Mixer 'Unknown key' (5x):** registerChannelStrip -> SortedSet.get miss; getOrNull + guard.
- **Phase 3 — Box-graph integrity:** requires-an-edge / already-staged / Already-assigned; reproduce per op.
- **Phase 4 — UI & editor:** Checkbox .catch, Monaco factory null, Monaco [object Event], unwrap failed.
- **Phase 5 — Resource limits:** mixdown/offline-render OOM; catch + friendly message.
- **Phase 6 — Environmental noise:** graceful handling + ErrorHandler ignore-list/reload-prompt (cf. #997).

One phase per session; mark `fixed=1` as each ships.
