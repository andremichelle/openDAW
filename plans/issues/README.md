# Open Issue Plans

One plan file per open GitHub issue (55 issues, snapshot 2026-07-08). Each file follows
`_TEMPLATE.md`: what is asked, current behaviour with real `path:line` references, a concrete
plan, and risks. Doability is rated 1 to 5 (5 = small and clear, 1 = major project needing
architecture work or maintainer decisions).

## Doability at a glance

| # | Issue | Type | Do | Verdict |
|---|-------|------|----|---------|
| ~~[289](289-select-midi-clip-track.md)~~ | ~~selecting a midi clip selects its track~~ | ux | 5 | ✅ done (a8f5840db) |
| [91](091-stereo-tool-dc-remove.md) | Stereo Tool DC remove button | feature | 5 | reuses existing highpass biquad |
| [234](234-evaluate-webclap.md) | Evaluate WebCLAP | research | 5 | pure evaluation, verdict already clear |
| [263](263-windows-build-instructions.md) | Windows build instructions | docs | 5 | docs only, root cause is bash-only npm scripts |
| ~~[208](208-automation-node-undo-bug.md)~~ | ~~automation node undo bug~~ | bug | 4 | ✅ done (settle-move stays in #pending + tests) |
| [274](274-automation-node-snapping-bug.md) | automation node snapping bug | bug | 4 | node creation never consults the grid |
| [271](271-automation-clip-default-node.md) | automation clip default node | feature | 4 | self-contained factory fix |
| [212](212-automation-track-naming.md) | automation track naming | feature | 4 | accessors exist, two ProjectApi factories |
| [185](185-clip-view-issues.md) | clip view issues | ux | 4 | both root causes pinned |
| [285](285-add-bus-buttons.md) | more buttons to create busses | ux | 4 | bus factory exists, add buttons |
| [273](273-ctrl-d-duplicate-effects.md) | Ctrl+D duplicate effects | feature | 4 | shortcut exists, does the wrong thing |
| [73](073-mousewheel-zoom-bug.md) | mousewheel zoom-in bug | bug | 4 | wheel deltaMode line-vs-pixel, mechanical |
| [149](149-vaporisateur-separate-envelopes.md) | separate vol/filter envelopes | feature | 4 | root cause pinpointed, contained |
| [85](085-nano-sampler-playfield.md) | Nano sampler playfield features | feature | 4 | mostly plumbing, code to port exists |
| [241](241-soundfont-envelope.md) | envelope on soundfont player | feature | 4 | add user ADSR atop patch envelope |
| [133](133-allpass-filter.md) | allpass filter | feature | 4 | allpass biquad already exists unused |
| [79](079-compressor-lookahead-click.md) | compressor lookahead click | bug | 4 | discontinuity root-caused, fix pattern exists |
| [84](084-autosave-indexeddb.md) | autosave to IndexedDB | feature | 4 | wire existing OPFS backup to unload + prompt |
| [261](261-wasm-audio-engine.md) | WASM audio engine | feature | 4 | tracking issue, core already shipped as default |
| [92](092-light-theme-support.md) | light theme support | feature | 4 | color-indirection layer exists, add palette |
| [243](243-manual-outside-desktop.md) | manual outside desktop | docs | 4 | plan already exists, execute it |
| [114](114-editable-transients.md) | editable transients | feature | 4 | design doc + template already in repo |
| [275](275-automation-node-placement-behaviour.md) | automation node placement behaviour | bug | 3 | builds on #274, needs UX key decisions |
| [269](269-playfield-automating-mute.md) | playfield automating mute | bug | 3 | TS root-caused, WASM parity + UI wrapper |
| [29](029-region-resize-tool-behaviour.md) | region resize tool behaviour | bug | 3 | two mechanisms, one bug needs a repro |
| [88](088-shift-click-deselect-mouseup.md) | shift+click deselect on mouseup | feature | 3 | exact root cause, shared-component risk |
| [57](057-drag-device-between-tracks.md) | drag device between tracks | feature | 3 | pieces exist, cross-track drop missing |
| [58](058-note-drawing-tool-upgrade.md) | note drawing tool upgrade | feature | 3 | one sub-ask partly implemented |
| [102](102-volume-envelope-device.md) | volume envelope device | feature | 3 | Tidal-oneshot path viable, freeform harder |
| [90](090-mid-side-eq.md) | Mid-Side EQ | feature | 3 | mirrors Revamp twice, new M/S codec |
| [195](195-chorus-effect.md) | chorus effect | feature | 3 | delay + LFO exist, algorithm is new |
| [203](203-analyser-device.md) | Analyser device | feature | 3 | FFT/broadcast exist, 4 new visualizations |
| [211](211-werkstatt-sidechain-input.md) | Werkstatt sidechain input | feature | 3 | proven pattern, ABI bridge widening |
| [201](201-classic-time-stretch.md) | classic time stretch | feature | 3 | extends voice arch, new timing model |
| [23](023-native-version.md) | native version | feature | 3 | needs PWA vs Tauri decision |
| [255](255-dough-samples-default.md) | dough-samples default set | content | 3 | no code change, licensing is the blocker |
| [277](277-werkstatt-midi-input.md) | Werkstatt midi input | feature | 3 | clear template, needs routing decision |
| [291](291-automation-curve-render-bug.md) | automation curve render bug | bug | 2 | plausible cause, needs live repro first |
| [292](292-automation-clip-deletion-bug.md) | automation clip deletion bug | bug | 2 | code looks correct, needs live repro |
| [270](270-automate-effect-enable.md) | automate effect enable/disable | feature | 2 | needs chain-wiring rework |
| [38](038-automation-region-unit-resolution.md) | automation region unit/resolution | feature | 2 | large design surface, new schema |
| [207](207-custom-device-inputs.md) | custom device inputs (XY, pulse) | feature | 2 | pulse has no backing box-graph concept |
| [249](249-file-evaluation-choosing.md) | file evaluation and choosing | ux | 2 | no conflict system exists today |
| [138](138-fm-synthesizer.md) | FM/PM synthesizer | feature | 2 | large new instrument, algorithm decision first |
| [288](288-generic-playfield-grid.md) | generic one-shot playfield grid | feature | 2 | real refactor, sample-only end to end today |
| [174](174-tape-device-playfield-controls.md) | tape device playfield controls | feature | 2 | architecture mismatch, scope decision |
| [188](188-realtime-pitch-shifter.md) | real-time pitch shifter | feature | 2 | no precedent, cross-engine, LGPL risk |
| [209](209-paulstretch-effect.md) | Paulstretch effect | feature | 2 | FFT reusable, offline-vs-realtime unresolved |
| [170](170-dynamic-device-loading.md) | dynamic device loading | feature | 2 | large refactor, full plan already exists |
| [262](262-audio-video-chat.md) | audio/video chat extension | ux | 2 | signaling exists, media calling is new |
| [89](089-multitarget-midi-automation.md) | multitarget midi/automation | feature | 2 | large data-model change, needs scoping |
| [245](245-podcast-recording.md) | podcast recording | feature | 2 | split into 8 sub-issues, fix RAM first |
| [154](154-automation-generation.md) | automation generation | feature | 1 | new generator engine + live-preview UI |
| [139](139-parameter-modulation-controllers.md) | parameter modulation controllers | feature | 1 | no modulation-routing infra exists |
| [141](141-instrument-fx-layer-device.md) | instrument/FX layer device | feature | 1 | needs new nested-device-graph container |

## Reading the tiers

**5 (4 issues)** ship in a sitting: #289, #91, #263 are near-mechanical, #234 is an evaluation.

**4 (17 issues)** are well-scoped fixes and features with the root cause or an exact template
already pinned. The bug cluster (#208, #274, #73, #79) and the contained device work (#149, #241,
#133, #85) live here.

**3 (14 issues)** are moderate: real new code or a UX decision, but a clear path. Several new
effects (#90, #195, #203, #211) and the interaction reworks (#88, #57, #58) sit here.

**2 (17 issues)** need an architecture or product decision before coding: new schema (#38), new
routing (#270), new device-graph containers (#288, #174), or a live repro (#291, #292). Note #170
and #245 already have their own dedicated plans in `plans/`.

**1 (3 issues)** are foundational projects. #139 and #141 both require a modulation/nested-device
system that does not exist yet, and #154 needs a full generator engine. These unlock many other
requests once built (a modulation layer would also serve #102, #149, #89).

## Cross-issue themes

- **Automation node interaction** (#274, #275, #208, #291, #292, #271, #38) is one subsystem. Fix
  #274 (grid snapping on create) first, then #275 builds on it.
- **Playfield generalization** (#85, #174, #288) is one arc: #85 is the tractable slice, #288 is
  the full refactor.
- **Time/pitch DSP** (#188, #201, #209) shares FFT and voice infrastructure and relates to the
  existing time-stretch v2 plan.
- **Modulation** (#139, #102, #149, #89, #270) all want a parameter-modulation layer. Building #139
  properly would subsume much of the rest.
