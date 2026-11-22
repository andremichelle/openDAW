# Plan: Comprehensive MIDI Feature Specification & Phased Rollout for openDAW

- **Status:** `Draft` _(Options: Draft | In Review | Approved | Superseded)_
- **Target Path:** `plans/midi-feature-roadmap.md`
- **Author(s):** `@contributor`
- **Reviewers / Maintainers:** `@andremichelle`
- **Created:** 2026-11-22
- **Repository:** `andremichelle/openDAW`
- **Related Issues:** `#58`, `#352`, `#355`, `#356`, `#369`, `#489`, `#493`, `#498`, `#512`

---

## 1. Summary & Motivation

This document establishes a comprehensive functional baseline and phased rollout plan for the MIDI subsystem in **openDAW**. Following openDAW's contribution guidelines (`README.md` and `CLAUDE.md`):

1. **Scope Clarity:** Defines all de-facto industry MIDI must-haves (`MIDI-CORE-*`) alongside high-value browser-native extensions (`MIDI-VAL-*`), mapped directly to existing openDAW packages (`@opendaw/lib-midi`, stock MIDI devices, Note Editor, WebCLAP) and open GitHub issues.
2. **Small, Incremental PRs:** Breaks the overall roadmap into self-contained, reviewable milestones so every pull request remains small, focused, and keeps the studio operational.
3. **Granular Issue & Audit Tracking:** Links existing GitHub issues directly at the Acceptance Criteria checkbox level so each item can be audited and closed cleanly via incremental PRs (`Closes #<issue>`).

---

## 2. Non-Goals (Out of Scope)

To align with openDAW's philosophy of radical simplicity and keep PRs small and focused:

- **Traditional Sheet Music / Score Notation Editor:** Engraving, clefs, and orchestral score layout are out of scope; editing remains centered on openDAW's Note Editor, Clip/Timeline views, and Automation/CC lanes.
- **Native OS MIDI Drivers / Bridging Daemons:** All hardware communication relies strictly on standard Web MIDI APIs without requiring external helper apps or OS-level virtual drivers.
- **Proprietary Closed-Source Vendor Protocols:** Reverse-engineering undocumented hardware sysex protocols is excluded unless contributed via open scripting APIs (`Spielwerk` / controller scripts).

---

## 3. De-Facto Core Features (Must-Have Standard)

These 8 functional pillars represent the baseline standard across established DAWs (Ableton Live, Bitwig Studio, Logic Pro, Cubase, REAPER, FL Studio), tailored to openDAW's web architecture.

### `MIDI-CORE-01`: Browser Device I/O, Hot-Plugging & Port Roles

- **Priority:** `Must-Have` (Phase 1)
- **openDAW Context:** Builds upon existing Web MIDI multi-device recording, channel filtering, and `@opendaw/lib-midi` SMF decoding.
- **Acceptance Criteria (Definition of Done):**
  - [x] Requests Web MIDI permissions cleanly and handles unsupported browsers gracefully with clear UI feedback.
  - [x] Detects newly connected or disconnected USB/Bluetooth MIDI devices at runtime without requiring a page reload.
  - [x] Control messages never leak into recorded MIDI clips (recording captures notes only), each track selects its input device and channel, and each MIDI output port has its own **Sync** (clock/transport output) toggle.
  - [ ] Exposes per-port toggles for **Track** (note/performance input) and **Remote** (parameter mapping/control), so MIDI learn and mapped controls only listen to ports enabled for **Remote**.
  - [x] Provides a built-in QWERTY computer keyboard mode with octave shift and velocity controls for hardware-free testing and composition.
  - [x] Imports Standard MIDI Files (`.mid`, SMF Type 0 & Type 1) as note tracks split per track and channel, and exports a single note clip as an SMF file _(clip export: [#352](https://github.com/andremichelle/openDAW/issues/352))_.
  - [ ] Supports full SMF roundtrip preserving track structure (multi-track Type 1 export), channels, CC data, and tempo maps on import and export.

### `MIDI-CORE-02`: Visual MIDI/Key Mapping Mode & Central Mapping Browser

- **Priority:** `Must-Have` (Phase 2)
- **openDAW Context:** Extends openDAW's parameter automation and hardware integration with a unified 1-click controller/key mapping workflow.
- **Acceptance Criteria (Definition of Done):**
  - [ ] Dedicated **MIDI Map Mode** and **Key Map Mode** toggles visually highlight all assignable UI controls in distinct colors.
  - [ ] Clicking an on-screen parameter and moving a hardware control (or pressing a computer key) binds them immediately.
  - [ ] A central **Mapping Browser / Manager** lists all active bindings (`Port/Channel`, `CC/Note/Key`, `Target Track/Device`, `Parameter Name`, `Min`, `Max`) with search/sort, click-to-locate navigation, and bulk deletion.
  - [ ] Supports custom `Min` and `Max` value scaling per binding, including **control inversion** when `Min > Max`.
  - [ ] Supports configurable **Takeover Modes** (_Jump_, _Pickup/Catch_, _Value Scaling_) and relative endless encoders.
  - [ ] Persists mappings inside the openDAW project bundle and allows exporting/importing reusable controller presets as JSON (respecting openDAW's no-signup/local-first privacy model).

### `MIDI-CORE-03`: Piano-Roll (Note Editor), CC Lanes & Event Manipulation

- **Priority:** `Must-Have` (Phase 1 & Phase 2)
- **openDAW Context:** Builds on openDAW's Note Editor (_Fine-Tune_, _Chance_, _Play-Count_, scale helpers).
- **Acceptance Criteria (Definition of Done):**
  - [ ] Supports drawing, moving, resizing, splitting, duplicating, muting, and auditioning notes across configurable grid divisions (including triplets and snap-off mode), remembering last-used note length/velocity ([#58](https://github.com/andremichelle/openDAW/issues/58)), fixing multi-select numeric input jumps ([#369](https://github.com/andremichelle/openDAW/issues/369)), and preserving pickup notes played during count-in ([#493](https://github.com/andremichelle/openDAW/issues/493)).
  - [ ] Provides grid **Quantization** (start time & duration) with adjustable _Strength (%)_, _Swing/Groove_ (integrating with _Zeitgeist_), and _Humanize_ randomization.
  - [ ] Includes synchronized **CC & Expression Lanes** in the Note Editor for Velocity, Pitch Bend, Channel Aftertouch, **Sustain (`CC64`)** ([#498](https://github.com/andremichelle/openDAW/issues/498)), and arbitrary CCs with step/line/curve tools.
  - [ ] Implements **Retroactive MIDI Capture** (continuous background input ring buffer) allowing users to recover recently played MIDI notes into a clip with one click even when Record was not armed.

### `MIDI-CORE-04`: Flexible MIDI Routing, Channel Filtering & Layering

- **Priority:** `Must-Have` (Phase 1)
- **openDAW Context:** Leverages openDAW's existing channel filtering and _Composite_ device (multi-instrument layering with independent effect chains).
- **Acceptance Criteria (Definition of Done):**
  - [x] Allows per-track MIDI input/output port selection and channel filtering (`Channels 1–16` or `All/Omni`).
  - [ ] Supports routing MIDI output from one track into multiple instrument tracks simultaneously alongside _Composite_ multi-instrument layering.
  - [ ] Supports configurable **Key Zones** (note range splits) and **Velocity Zones** per instrument or _Composite_ chain.

### `MIDI-CORE-05`: Real-Time MIDI Effects & Macro Controls

- **Priority:** `Must-Have` (Phase 2 & Phase 3)
- **openDAW Context:** Builds on existing stock MIDI devices (_Arpeggio_, _Pitch_, _Velocity_, _Zeitgeist_, and _Spielwerk_).
- **Acceptance Criteria (Definition of Done):**
  - [ ] Covers core non-destructive real-time MIDI FX before instruments: **Arpeggio**, **Chord Generator**, **Scale Lock/Constrain**, **Pitch/Transpose**, **Note Length**, and **Velocity Curve**.
  - [ ] Provides **Macro Controls** (8–16 macro knobs per rack/Composite) allowing users to bind multiple device parameters with independent `Min/Max` ranges to a single unified knob.

### `MIDI-CORE-06`: External Hardware Integration & Clock Sync

- **Priority:** `Must-Have` (Phase 3)
- **openDAW Context:** Extends the existing _MIDIOutput_ device for tight hardware synthesizer and sequencer workflows.
- **Acceptance Criteria (Definition of Done):**
  - [ ] Extends _MIDIOutput_ / introduces an **External Instrument** workflow combining outbound MIDI routing with inbound audio return on a single channel, supporting live monitoring and direct audio recording from hardware ([#512](https://github.com/andremichelle/openDAW/issues/512)).
  - [ ] Provides accurate roundtrip hardware latency compensation ([#355](https://github.com/andremichelle/openDAW/issues/355)) and jitter-free outbound MIDI event scheduling without desync under rapid note playback ([#356](https://github.com/andremichelle/openDAW/issues/356)).
  - [ ] Functions as a reliable **MIDI Clock Master** (`Start`, `Stop`, `Continue`, `Song Position Pointer`) with configurable millisecond clock offset.
  - [ ] Supports sending MSB/LSB **Bank Select** and **Program Change** messages per track or clip.

### `MIDI-CORE-07`: Bidirectional Control Surface Feedback

- **Priority:** `Must-Have` (Phase 3)
- **openDAW Context:** Enables tactile hardware control over openDAW's mixer, transport, and device parameters.
- **Acceptance Criteria (Definition of Done):**
  - [ ] Supports **Mackie Control Universal (MCU)** and **HUI** protocols for motorized faders, transport controls, mute/solo/arm buttons, and track name displays.
  - [ ] Sends live parameter value updates, pad LED states, and encoder ring feedback back to connected controllers upon track selection or automation playback.
  - [ ] Requests the optional Web MIDI **SysEx** permission (only when a control surface needs it) for controller handshakes, display text, and RGB pad colors.

### `MIDI-CORE-08`: Device Chain MIDI Passthrough & WebCLAP Automation

- **Priority:** `Must-Have` (Phase 1)
- **openDAW Context:** Ensures seamless MIDI flow across stock MIDI devices (_Spielwerk_, _Arpeggio_, _Cubed_) and hosted **WebCLAP (`.wclap`)** instruments/effects.
- **Acceptance Criteria (Definition of Done):**
  - [ ] Any MIDI-generating or MIDI-transforming device (_Arpeggio_, _Spielwerk_, _Cubed_ pattern export [#352](https://github.com/andremichelle/openDAW/issues/352), WebCLAP MIDI FX) passes processed MIDI events downstream to subsequent devices and allows recording or exporting that output as a MIDI clip.
  - [ ] Forwards MIDI CCs (including Sustain `CC64` [#498](https://github.com/andremichelle/openDAW/issues/498)), pitch bend, and aftertouch to all hosted stock and WebCLAP instruments with sample-accurate timing.

---

## 4. High-Value Extensions (Differentiators & Value-Add)

These capabilities build directly on openDAW's unique strengths (JavaScript programmability via _Spielwerk_/_Apparat_/_Werkstatt_, WebCLAP, Live Rooms, and local-first architecture).

### `MIDI-VAL-01`: Universal Modulation System & Scriptable Modulators

- **Priority:** `High Value` (Phase 4)
- **openDAW Context:** Directly aligns with openDAW's modulation tab and _Spielwerk_ scripting paradigm.
- **Acceptance Criteria (Definition of Done):**
  - [ ] Supports attachable modulation sources (_LFO, Envelope Follower, ADSR, Step Sequencer, MIDI Expression Mapper_) routable unipolarly or bipolarly to any DAW or WebCLAP parameter.
  - [ ] Supports user-programmable **Scriptable Modulators** inside the modulation tab ([#489](https://github.com/andremichelle/openDAW/issues/489)).

### `MIDI-VAL-02`: MPE (MIDI Polyphonic Expression) & Microtuning

- **Priority:** `High Value` (Phase 4)
- **openDAW Context:** Complements the Note Editor's existing _Fine-Tune_ per-note capability.
- **Acceptance Criteria (Definition of Done):**
  - [ ] Records, plays back, and displays per-note Pitch Bend, Slide (`CC74`), and Polyphonic Pressure directly on individual note bars in the Note Editor.
  - [ ] Supports importing `.scl` and `.kbm` tuning files for custom scale highlighting and microtonal playback.

### `MIDI-VAL-03`: JavaScript Controller Scripting API & Shareable JSON Surface Layouts

- **Priority:** `High Value` (Phase 4)
- **openDAW Context:** Extends the _Spielwerk_ / _Apparat_ / _Werkstatt_ programmable JS ecosystem to external hardware controllers.
- **Acceptance Criteria (Definition of Done):**
  - [ ] Exposes a documented, sandboxed JS API for mixer, transport, active device focus ("Blue Hand"), and SysEx/LED feedback.
  - [ ] Includes a visual controller layout builder where users can map hardware controls via drag-and-drop and share templates as self-contained JSON files (no account/cloud dependency).

### `MIDI-VAL-04`: Generative Tools & Rule-Based Transformers

- **Priority:** `High Value` (Phase 4)
- **openDAW Context:** Expands the Note Editor's existing _Chance_ and _Play-Count_ features while honoring openDAW's philosophy (_"openDAW will never generate your music"_—providing deterministic/algorithmic tools rather than black-box AI).
- **Acceptance Criteria (Definition of Done):**
  - [x] Adds randomized velocity ranges alongside existing per-note _Chance_ probability.
  - [ ] Provides deterministic algorithmic helpers (Euclidean rhythms, chord voicings) and a rule-based MIDI Transformer (e.g., select by beat position/velocity and transpose or humanize).

### `MIDI-VAL-05`: Live Rooms Collaborative MIDI & MIDI 2.0 Readiness

- **Priority:** `Future-Proof` (Phase 4)
- **openDAW Context:** Integrates with openDAW's existing **Live Rooms** collaborative workflow.
- **Acceptance Criteria (Definition of Done):**
  - [ ] Allows routing live MIDI performance streams between participants inside openDAW Live Rooms or across local browser tabs (`BroadcastChannel`).
  - [ ] Supports 14-bit CC/NRPN and prepares internal parameter resolution for Web MIDI 2.0 Universal MIDI Packets (UMP).

---

## 5. Phased Rollout Plan (Small, Incremental PR Strategy)

Per `README.md` (_"Keep pull requests small and focused. Large PRs will not be reviewed"_), each phase is designed to be shipped as a series of small, self-contained PRs:

| Phase       | Theme                            | Included Requirement IDs                                                                | Suggested PR Breakdown & Milestone Goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| :---------- | :------------------------------- | :-------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 1** | **Core Foundation & Bugfixes**   | `MIDI-CORE-01`, `MIDI-CORE-03` (Notes/Sustain/Count-in), `MIDI-CORE-04`, `MIDI-CORE-08` | **PR 1.1:** Fix count-in note drop ([#493](https://github.com/andremichelle/openDAW/issues/493)), multi-select edit bugs ([#369](https://github.com/andremichelle/openDAW/issues/369)), & drawing tool defaults ([#58](https://github.com/andremichelle/openDAW/issues/58)).<br>**PR 1.2:** Add Sustain `CC64` lane & forwarding ([#498](https://github.com/andremichelle/openDAW/issues/498)).<br>**PR 1.3:** Port role toggles (_Track/Remote/Sync_) & QWERTY keyboard.<br>**PR 1.4:** SMF `.mid` export ([#352](https://github.com/andremichelle/openDAW/issues/352)) & multi-track MIDI routing/zones. |
| **Phase 2** | **Mapping & Expressive Control** | `MIDI-CORE-02`, `MIDI-CORE-03` (CC Lanes/Capture), `MIDI-CORE-05` (Macros)              | **PR 2.1:** Visual MIDI/Key Map Mode + basic binding.<br>**PR 2.2:** Central Mapping Browser (`Min/Max`, inversion, Takeover modes, JSON presets).<br>**PR 2.3:** Retroactive MIDI Capture & Macro knobs.                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Phase 3** | **Hardware Studio & Stage**      | `MIDI-CORE-05` (MIDI FX), `MIDI-CORE-06`, `MIDI-CORE-07`                                | **PR 3.1:** Fix hardware MIDI output desync ([#356](https://github.com/andremichelle/openDAW/issues/356)) & latency compensation ([#355](https://github.com/andremichelle/openDAW/issues/355)).<br>**PR 3.2:** _MIDIOutput_ audio return recording ([#512](https://github.com/andremichelle/openDAW/issues/512)), MIDI Clock Master & Program Change.<br>**PR 3.3:** Missing MIDI FX (_Chord_, _Scale_, _Note Length_) & MCU/HUI support.                                                                                                                                                                  |
| **Phase 4** | **Ecosystem & Differentiators**  | `MIDI-VAL-01` through `MIDI-VAL-05`                                                     | **PR 4.1:** Scriptable modulator ([#489](https://github.com/andremichelle/openDAW/issues/489)) & universal modulation routing.<br>**PR 4.2:** MPE per-note editing & `.scl`/`.kbm` microtuning.<br>**PR 4.3:** JS Controller Scripting API & Live Rooms MIDI routing.                                                                                                                                                                                                                                                                                                                                      |

---

## 6. Open Questions for Maintainer Sign-Off

Before opening implementation PRs, please align on these questions (via GitHub Discussion / Discord / Maintainer Call):

1. **Mapping Browser UI Placement (`MIDI-CORE-02`):** Should the Mapping Browser live as a collapsible side panel (Ableton-style) or as a dedicated tab/floating window consistent with openDAW's workspace layout?
2. **External Hardware Workflow (`MIDI-CORE-06` / [#512](https://github.com/andremichelle/openDAW/issues/512)):** Should audio return recording be built directly into the existing _MIDIOutput_ device or implemented as a dedicated _External Instrument_ device?
3. **Control Surface Priorities (`MIDI-CORE-07`):** Beyond Mackie Control (MCU) and HUI, are there specific controllers used by the community (e.g., Launchpad, APC, KeyLab) we should target first?
4. **Scripted Modulators (`MIDI-VAL-01` / [#489](https://github.com/andremichelle/openDAW/issues/489)):** Should scriptable modulators share the exact same sandbox and API conventions as _Spielwerk_ / _Werkstatt_?

---

## 7. Gap Analysis Log _(Pre-Populated Baseline for Claude Code Audit)_

> **Instructions for Claude Code (`CLAUDE.md` compliant):**
> Inspect the repository (`packages/`, `introduction.md`, and open issues) against each Requirement ID below. Update the `Status`, `Existing Files / Modules`, and `Notes & Missing Acceptance Criteria` columns without modifying any source code yet. Follow all conventions in `CLAUDE.md` (no `any`, `Option<T>`/`Nullable<T>`, no `try/catch`).

| Requirement ID | Initial Status | Known Existing Modules / Issues                                                                                                                                                                                                                                                                                  | Audit Notes & Missing Acceptance Criteria _(To be verified by Claude Code)_                                                                                                                                                                                                                                                               |
| :------------- | :------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIDI-CORE-01` | `Partial`      | `@opendaw/lib-midi`, Web MIDI multi-device input, SMF decoder, [#352](https://github.com/andremichelle/openDAW/issues/352)                                                                                                                                                                                       | _Verify:_ Port role separation (`Track`/`Remote`/`Sync`), runtime hot-plug edge cases, QWERTY keyboard, and SMF `.mid` **export**.                                                                                                                                                                                                        |
| `MIDI-CORE-02` | `Missing`      | Automation system                                                                                                                                                                                                                                                                                                | _Verify:_ Whether any MIDI-learn or key-binding registry already exists; design Mapping Browser & JSON preset schema.                                                                                                                                                                                                                     |
| `MIDI-CORE-03` | `Partial`      | Note Editor (_Fine-Tune_, _Chance_, _Play-Count_), _Zeitgeist_, [#58](https://github.com/andremichelle/openDAW/issues/58), [#369](https://github.com/andremichelle/openDAW/issues/369), [#493](https://github.com/andremichelle/openDAW/issues/493), [#498](https://github.com/andremichelle/openDAW/issues/498) | _Verify:_ Existing CC lane capabilities, `CC64` Sustain ([#498](https://github.com/andremichelle/openDAW/issues/498)), count-in note snapping/dropping ([#493](https://github.com/andremichelle/openDAW/issues/493)), multi-select edit bugs ([#369](https://github.com/andremichelle/openDAW/issues/369)), and Retroactive MIDI Capture. |
| `MIDI-CORE-04` | `Partial`      | Channel filtering, _Composite_ device                                                                                                                                                                                                                                                                            | _Verify:_ Inter-track MIDI routing (sending MIDI from Track A to Track B) and Key/Velocity zone splits in _Composite_.                                                                                                                                                                                                                    |
| `MIDI-CORE-05` | `Partial`      | _Arpeggio_, _Pitch_, _Velocity_, _Zeitgeist_, _Spielwerk_                                                                                                                                                                                                                                                        | _Verify:_ Gaps for dedicated _Chord_, _Scale Constrain_, _Note Length_ devices, and unified Macro knobs.                                                                                                                                                                                                                                  |
| `MIDI-CORE-06` | `Partial`      | _MIDIOutput_ device, [#355](https://github.com/andremichelle/openDAW/issues/355), [#356](https://github.com/andremichelle/openDAW/issues/356), [#512](https://github.com/andremichelle/openDAW/issues/512)                                                                                                       | _Verify:_ Hardware output desync ([#356](https://github.com/andremichelle/openDAW/issues/356)), delay compensation ([#355](https://github.com/andremichelle/openDAW/issues/355)), audio return capture ([#512](https://github.com/andremichelle/openDAW/issues/512)), MIDI Clock Master, and Bank/Program Change.                         |
| `MIDI-CORE-07` | `Missing`      | —                                                                                                                                                                                                                                                                                                                | _Verify:_ Whether any MCU/HUI or outbound controller LED/fader feedback exists in `@opendaw/lib-midi` or studio core.                                                                                                                                                                                                                     |
| `MIDI-CORE-08` | `Partial`      | _Spielwerk_, _Arpeggio_, _Cubed_, WebCLAP (`.wclap`) host, [#352](https://github.com/andremichelle/openDAW/issues/352), [#498](https://github.com/andremichelle/openDAW/issues/498)                                                                                                                              | _Verify:_ Recording/exporting MIDI output generated by _Arpeggio_/_Spielwerk_/_Cubed_ ([#352](https://github.com/andremichelle/openDAW/issues/352)) and WebCLAP MIDI CC/Sustain forwarding ([#498](https://github.com/andremichelle/openDAW/issues/498)).                                                                                 |
| `MIDI-VAL-01`  | `Partial`      | Modulation tab, [#489](https://github.com/andremichelle/openDAW/issues/489)                                                                                                                                                                                                                                      | _Verify:_ Current modulation architecture and requirements for scriptable modulators ([#489](https://github.com/andremichelle/openDAW/issues/489)).                                                                                                                                                                                       |
| `MIDI-VAL-02`  | `Partial`      | Note Editor _Fine-Tune_                                                                                                                                                                                                                                                                                          | _Verify:_ Per-note pitch/slide/pressure data structures in `@opendaw/lib-midi` and `.scl`/`.kbm` tuning support.                                                                                                                                                                                                                          |
| `MIDI-VAL-03`  | `Partial`      | _Spielwerk_, _Apparat_, _Werkstatt_ (JS scripting)                                                                                                                                                                                                                                                               | _Verify:_ How existing JS scriptable devices are sandboxed and whether that pattern can extend to controller scripts.                                                                                                                                                                                                                     |
| `MIDI-VAL-04`  | `Partial`      | Note Editor _Chance_ & _Play-Count_                                                                                                                                                                                                                                                                              | _Verify:_ Existing generative/randomization utilities and batch note transformations.                                                                                                                                                                                                                                                     |
| `MIDI-VAL-05`  | `Partial`      | Live Rooms                                                                                                                                                                                                                                                                                                       | _Verify:_ Whether Live Rooms currently syncs project state only or also supports real-time MIDI event streaming.                                                                                                                                                                                                                          |
