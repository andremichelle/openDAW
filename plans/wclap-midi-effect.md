# WebCLAP MIDI effects

openDAW hosts WebCLAP instruments and audio effects, not MIDI effects. Blossom by Althemi (a real time MIDI
harmonizer, melody in, counterpoint and harmony voices out, eight preset banks, animated skins) shall run as a
WebCLAP MIDI effect in the device panel. Its developer ports it herself, we never see the source. So we build a
test plugin and the host side first, prove notes in, process, notes out, then hand her a template, a test page
and instructions in open-webclap. She sends back the bundle.

## Facts

1. **The type exists.** CLAP has the feature `"note-effect"` (`CLAP_PLUGIN_FEATURE_NOTE_EFFECT`): a plugin with an
   input note port, an output note port and no audio ports. Hosts route its out events onward.
2. **openDAW MIDI effects are pulled.** `process_events(from, to, flags, ...)` (`crates/abi/src/lib.rs:1688`)
   pulls the upstream notes for a pulse range and transforms them into `EventRecord`s. Offsets are absolute
   within the quantum, so a range maps to a sample span.
3. **The bridge only reads PARAM_VALUE out events** (`wclap-bridge.ts:789`). Notes go in at offset 0 of the next
   chunk (`#note`, `wclap-bridge.ts:967`), not sample exact.
4. **The JUCE kit has no MIDI out.** `juce_webclap_clap.cpp` pushes only parameter events, the note port is input
   only.
5. **The site uses the published SDK** (`site/package.json`, studio-core 0.2.9, core-wasm 0.0.20). Host work in
   openDAW reaches the test page only with an SDK release.
6. **Device panel is done.** Feature `opendaw:device-panel`, extension `opendaw.device-panel/1`, 176px surface,
   `?panel` URI, `request_show` opens the big window (`plans/wclap-device-panel.md`, WetChorus as demo).
7. **The site can already import** an external bundle (Import, 2f62081), and `?local` loads `build/<port>/`.

## Phases

### 1. Test plugin `ports/note-lab` (open-webclap)

1. Plain CLAP in C++, no JUCE, built like WetChorus (emcc, `wasi_shim.cpp`, `pack-wclap.py`), MIT.
2. Features `note-effect`, `opendaw:device-panel`. One input and one output note port (CLAP and MIDI dialects),
   no audio ports.
3. Modes as a stepped parameter, each one tests a path Blossom needs:
    1. Thru: every event passes unchanged at its offset.
    2. Harmony: each note plus a third and a fifth, same offsets (more out than in).
    3. Echo: three repeats at a set delay, crossing block boundaries (notes born later than their input).
    4. Hold: note offs dropped until the next note (out notes whose lifetime the input does not show).
4. Eight presets A to H in its state, picked by a parameter, so automation and MIDI learn can recall them.
5. Panel page (`?panel`, 176px): an animation of the incoming and outgoing keys, preset buttons, Big View
   (`request_show`). Window page: the same plus a larger view and a note log.
6. Every note off the plugin owes is sent on `reset`, `stop_processing`, mode change and deactivate.
7. Data exchange optimised as in the other ports: page updates at most every 33 ms of processed audio, only what
   changed (delta frames for the key animation), a page that says hello gets one snapshot.
8. History steps as tiny as possible: the state is laid out so an edit changes few bytes (ranged edits of the
   state bytes field), a preset pick or knob turn never rewrites the whole blob, the animation never touches the
   state.
9. Node check script: load, feed a chord, compare the out events with the expected offsets per mode, measure
   bytes per page message and bytes per history step.

### 2. Test host: note effects (open-webclap `test-host/`)

1. Read `note-effect`, hand out events of type NOTE_ON, NOTE_OFF, NOTE_CHOKE and MIDI to the page.
2. Out notes play a small polyphonic sine in the worklet, or go to a Web MIDI output picked in a select.
3. Inputs as today: on screen keyboard, computer keys, Web MIDI in.
4. A note monitor: in and out events with offsets. This gives a first proof without any openDAW release.

### 3. openDAW host (built 2026-10-29, node tests green, not seen in the browser)

1. `WclapMidiEffectBox` (forge-boxes `midi-effects`) with the field keys of `WclapDeviceBox`, so `WclapLink`,
   `WclapParameters` and `WclapStates` serve it unchanged. `WclapBoxes.is` in studio-core names all three boxes.
2. `EffectFactories.MidiNamed.WclapMidi` (key `WclapMidi`, `Wclap` would collide in `MergedNamed`),
   `WclapMidiEffectBoxAdapter`, the device dialog, Spotlight and the catalogue list note effects.
3. Engine: `host_block_at(pulse, out)` returns the block holding a pulse and a quantum serial.
4. Crate `device-wclap-midi`: per update sub range it pulls upstream, hands the notes to
   `abi::wclap_process_notes` at their sample offsets and returns the plugin's notes at the pulse of their sample
   (round trip exact), with its own note ids. A plugin change or no plugin ends the notes it holds.
5. Bridge `#processNotes`: params and notes as events, process with the span's frames and transport, the
   plugin's notes collected only during this call (other plugins unchanged), a larger event area for note
   effects only.
6. Composite cells hold their own replica of a unit-level MIDI effect, all with the same box uuid, so one
   plugin: the bridge counts references and answers a repeated span (same serial and position) from the last
   one without processing again.
7. Fixed on the way: a load replaced while it awaited consumed the pending state, so the load that won started
   without it (also for audio effects and instruments).
8. Node tests `core-wasm/test/wclap-midi-effect.test.ts`: Thru, Harmony, Echo across quanta, two composite layers,
   all within a sample. `duration` is only read by scripts, plugin notes carry 0 like live notes.

### 4. SDK release

1. Publish the studio packages with the new box and factory, additive only (SDK consumers).
2. Bump the site's dependencies.

### 5. Site page for MIDI effects (open-webclap `site/`)

1. Plugin kind `midi-effect` in `plugins.ts`, the session builds a track: notes, the WebCLAP MIDI effect, then an
   instrument.
2. Input: the Keyboard component, Web MIDI in, and a looping note region with a small step grid as piano roll.
3. Output select: a stock sine (Vaporisateur preset) or an external MIDI device through MIDI Output.
4. The device panel view shown as in the studio, plus the big window and the message log.
5. Note-lab listed on the site and in the catalogue as the reference.

### 6. Porting kit for her (open-webclap)

1. `docs/porting-a-midi-effect.md`: clone, emsdk, build note-lab, `npm run dev`, `?local`, Import of her own
   bundle, where logs show, the node check.
2. The contract: features, note ports, panel extension, `?panel` URI, 176px height and `get_width`, Big View via
   `request_show`, state save and load, `clap.param-hovered` for host menus, no threads,
   no filesystem, no allocation in `process`, all owed note offs sent.
3. Data exchange and history rules with numbers from note-lab: deltas only, 33 ms cap, no full state per
   message, a stable state layout so every edit is a tiny ranged history step. The node check reports both, her
   bundle must meet them before it ships.
4. Suggestion for presets: program change and CC do not reach a plugin in openDAW, so a stepped preset parameter
   would let MIDI learn and automation recall them. Her call.
5. Her source stays in her own repository, never in open-webclap. She sends `<id>.wclap.tar.gz`, the clap id and
   a version.
6. If Blossom is JUCE: the kit gains MIDI out (`producesMidi`, `isMidiEffect` as `note-effect`, output note port,
   MidiBuffer to out events) and a JUCE variant of note-lab proves it before she starts.

### 7. Deploy

1. openDAW PROD with the host side, then her bundle in the catalogue through the admin app.

## Decided

1. Her bundle reaches the catalogue through the admin app.
2. The guide suggests a preset parameter (MIDI learn, automation), program change and CC do not exist in
   openDAW's note stream.
3. Blossom takes notes in and generates notes from them by its settings, which is what note-lab's modes test.
4. Tests start with phase 1 and 2.

## Open

1. A MIDI effect bypassed or removed while a note sounds leaves that note hanging downstream, for every MIDI
   effect (checked with Pitch), because nothing pulls it any more. Engine wide, needs a decision.
2. Blossom's framework and UI technology (JUCE, own C++, web)? JUCE works once phase 6.6 is done, ask her before
   she starts.
