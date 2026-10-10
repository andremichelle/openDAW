# Standalone chromatic tuner

## Current implementation

User request: a standalone chromatic tuner with live feedback and saved settings, integrated with openDAW's existing device architecture and visual conventions. The final meter is an original straight scale with a downward triangle, not the early arc/ball or semicircular dial prototypes. Meter offers Target/Strobe; Histogram offers Auto/Manual pitch history with a labeled note-key axis. The footer uses Gate-style buttons and Revamp's reference-value interaction. Readings hold for 120ms and fade over 1000ms. Octaves match openDAW (MIDI 60 = C3).

Feature reference: https://www.ableton.com/en/manual/live-audio-effect-reference/#tuner — target/strobe, history with auto/pan/zoom, Hz/cents, and reference 410–480 Hz. This informed functionality; the final artwork uses openDAW styling. There is no simulated-pitch slider in the real device. The user manual is `packages/app/manual/public/devices/audio/tuner.md`.

Implementation: standalone audio-effect schema/adapters/factory/editor, fixed-storage Rust YIN detector in a transparent WASM side module, and three-float live telemetry at address.append(0). Audio is copied unchanged. Analysis runs at <=12 kHz and 30 frames/sec; automatic channel choice avoids stereo cancellation. Persistent view settings use box fields and Editing transactions. Subscriptions and animation belong to the editor lifecycle.

Verification: four native detector tests pass (bass/treble, common sample rates, stereo phase/right-only input, gating, silence, and noise/nonfinite input). Three full-engine/project tests pass (bit-identical transparent audio including bypass changes, three-float live telemetry, and persisted settings). Existing device live-data tests (2) and Studio tests (59) pass. Full workspace build/typecheck passes. Chrome inspection confirmed factory discoverability, editor rendering, and switching to History. Automated reloads intermittently fail with ERR_BLOCKED_BY_CLIENT; live instrument and final post-reload styling checks need a manual browser trial. Initial visual inspection found clipping; controls were compacted into two-column selectors/toggles and smaller standard knobs.

AI-assisted implementation: Codex researched the manual, inspected existing device registration and Autotune telemetry patterns, and implemented the schema, engine module, editor, manual, and tests. Detector range/accuracy claims are bounded by the synthetic tests; real instrument trials remain useful for ambiguous harmonic signals.

## Contribution scope and remaining review

This contribution is one audio-effect device, not a new plugin framework, instrument, pitch-correction effect, or change to the existing Autotune device. Cross-package edits register its schema, adapter, processor and editor in the existing architecture; tests and documentation accompany the feature. Most implementation was committed together, followed by style/documentation fixes. That history is not an incremental implementation series and the overall size remains a concern under the README's small-PR guidance. Before proposing it upstream, agree on a smaller submission or reorganization with the maintainer; do not treat this explanation as a waiver of that requirement.

The human contributor has supplied design direction, screenshots and interactive feedback. This does not establish that they have reviewed or understand every submitted line. That review remains required by README.md before upstream submission. Automated checks do not replace it. Remaining manual coverage includes sustained real-instrument signals, harmonic-rich inputs, all view/interaction combinations, bypass/silence release, and save/reopen behavior in the browser. Earlier browser inspections were partial, not a complete sign-off.

## Reproducible verification

After completing the development setup/build prerequisites in README.md, run from the repository root with the supported Node and Rust tools on PATH:

```sh
npm run build --workspace=@opendaw/app-studio
npm test --workspace=@opendaw/app-studio
cargo test --manifest-path crates/Cargo.toml -p device-tuner
npm run test:vitest --workspace=@opendaw/studio-core-wasm -- test/tuner-device.test.ts
```

The engine integration tests require built WASM modules; the Studio build uses built workspace dependencies. These are focused checks, not a claim that every repository-wide test suite has passed.

Manual test procedure:

1. Insert Tuner after an instrument, or on an audio track with input monitoring enabled. Play sustained single notes; compare the readout with the piano roll and known frequencies.
2. Switch Meter between Target and Strobe; check flat/sharp direction, zero, and green feedback within ±5 cents.
3. Toggle ct/Hz and adjust Reference by dragging and double-click text entry. Confirm recalibration without changing the audio.
4. Switch to Histogram; check note-axis highlight, Auto following, Manual freeze, drag/arrow-key pan/zoom, and double-click return to Auto. Confirm the footer does not jump.
5. Stop the signal and check hold/fade and history gaps; bypass and confirm immediate clearing and unchanged audio.
6. Save/reopen a project and confirm view, reference and manual range persist while history starts empty.

## Historical implementation and design log

The entries below record intermediate states and checks at the time of each revision; they do not describe the final UI or prove that later changes still pass.

Design revision verification: Studio build and two visual-state tests pass. Chrome inspection verified Target/Strobe/History bottom tabs, keyboard switching, selected-state feedback and synchronized footer ct/Hz toggle. The visual release uses a smoothstep envelope (120ms hold + 800ms fade); invalid data leaves gaps in history, and bypass resets immediately. The isolated visual-state model permits deterministic testing without DOM/audio mocks.

Minimal UI revision: removed the Notes/Auto/Hz sidebar controls, Threshold/Input/Smooth knobs and signal hint. The compact panel retains the meter, bottom view tabs, ct/Hz and directly editable Reference. History double-click resumes automatic following after manual pan/zoom. Legacy box fields remain for saved-project compatibility. Canvas artwork now uses uniform aspect-preserving scaling instead of independent horizontal/vertical stretching; a layout test covers compact and high-DPI sizes.

Minimal UI verification: Studio build and all 62 Studio tests pass. Chrome inspection of an unsaved test project confirmed the sidebar is gone, the panel fits its allocated height, bottom tabs switch views, and inline Reference edits commit correctly. The idle target screenshot confirms a circular target and no clipped footer.

Octave naming correction: match openDAW's piano roll convention (MIDI 60 = C3, MIDI 69 = A3) in the readout, history labels and reference accessibility text. This changes labels only, not detection, calibration or cents. Regression tests compare all 128 MIDI labels against MidiKeys.toFullString and cover rounding/alternate spelling; all 64 Studio tests pass.

Footer correction: use only two icon tabs (curved meter and History). The Target/Strobe label is the actual mode toggle, with cyan selected feedback for Strobe; no extra Strobe icon. Keyboard tab navigation now follows the two visible tabs. Persistent view values remain unchanged.

Native openDAW styling revision: retain the minimal layout and interaction while replacing Ableton-specific hardcoded colors with shared Colors/DisplayPaint and CSS color tokens. Canvas typography uses the app's Rubik font; panel borders are subtle and controls use rounded outlined frames with low-opacity fills, matching native EQ controls. In-tune feedback is green and detuned feedback is orange. Strobe/Hz selected states use the shared blue accent. No detection or persistence behavior changes.

Native style verification: Studio build and all 64 tests pass. Chrome visual inspection confirmed the new panel/typography/outlined controls alongside Cubed, and the Target/Strobe toggle's selected state.

Revamp component parity: replaced custom footer controls with the actual shared Button/Checkbox components used by Revamp, and Reference with ParameterLabel/RelativeUnitValueDragging (drag or double-click text entry). Removed display perimeter and footer divider; canvas clears to transparent, with Revamp-style low-opacity axis labels and thin neutral guides. View tab arrow/Home/End navigation and Enter/Space activation are retained.

History note-axis revision: right-hand note-centered key bands distinguish black/white keys subtly and highlight the detected key in shared green. Highlight selection uses the same smoothed note and release envelope as the readout; no valid pitch means no highlight. Pure layout tests verify note ordering, center alignment, and continuous clipped bands while panning/zooming.

Original meter shape: after previewing alternatives, the user chose a line and triangle. Replace the arc/circular target with a straight −50..+50 scale, semitone-deviation ticks, fixed zero mark and a downward triangle pitch marker. Strobe segments now move above the same straight scale; the meter tab icon reflects the new shape. Extend visual release from 800ms to 1000ms while keeping the 120ms hold, immediate reacquisition and bypass reset. Update release timing assertions, including a check that the reading remains visible past the old endpoint.

Meter contrast adjustment: make the center zero mark fully opaque green, 3 artwork pixels thick and taller; brighten the zero label and scale guides, including their idle state. Signal-loss fading still applies only to the live marker/readout, not the fixed zero reference.

Gate-style footer revision: replace framed Button/Checkbox wrappers with native accessible buttons adopting Gate's exact ParameterToggleButton stylesheet. Controls are 15px high with compact 12px icons, dark flat backgrounds and blue active states. Footer left inset is derived from the canvas transform and active plot's left edge, aligning the buttons with the meter/history instead of the device perimeter. Preserve keyboard tab navigation and pressed/selected semantics.

Stationary text footer: rename the view tabs Meter/History and remove icons. Use one view-independent inset instead of changing the footer's padding per view; reserve the Target/Strobe slot while invisible/disabled in History, and fix mode/unit widths. This prevents the footer jumping when changing views, mode labels or ct/Hz.

Footer naming/order follow-up: at the user's request, label pitch history Histogram and move the meter-only Target/Strobe button after ct/Hz. Preserve its reserved slot so view/unit controls remain stationary when it disappears.

Reference caption typography: use the standard device-caption treatment (9px, regular weight, 0.5px tracking, shadow color) rather than inheriting the larger footer font. Keep the shared ParameterLabel value styling unchanged.

Histogram Auto/Manual: reuse the fixed mode-button slot after ct/Hz instead of adding another control. It shows Target/Strobe in Meter and Auto/Manual in Histogram. Manual captures the currently visible center before disabling autoFollow, avoiding a jump to an old stored range. Both view and autoFollow subscriptions update the button, including drag/keyboard changes and double-click return to Auto. Existing project fields/undo transactions persist the mode.

Wider meter: expand the horizontal scale from 360 to 444 artwork pixels, aligned to the shared 18px plot inset. Remap ticks, triangle and strobe to the same wider scale, keeping zero centered and endpoint labels inward-aligned. Layout tests cover endpoint/center mappings and out-of-range clamping.

Final pre-publication verification: Studio build and all 67 Studio tests pass for the final UI. Fresh checks pass for all 4 native detector tests and all 3 full-engine/project tuner tests. The tuner is an audio-effect measurement device, not a sound-generating instrument or pitch-correction effect. Real-instrument harmonic ambiguity remains a documented limitation.
