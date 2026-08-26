# Spielwerk: pass incoming notes through by default

## Context

Spielwerk is a scriptable MIDI effect. Today it emits ONLY what the user generator yields, so a device with no
compiled script, a script that has not loaded yet, or a script that a runtime error silenced eats the whole
note stream and the track goes quiet. A fresh Spielwerk dropped into a chain is a mute button until the user
compiles something.

New contract: Spielwerk forwards every incoming note verbatim, and whatever the generator yields is emitted on
top. A script that wants to replace the incoming stream (transform, filter, generate) declares `// @no-pass`
and gets today's behaviour.

Decisions taken with the user:

Additive, not replace-if-empty. The input is forwarded and the yields are added.

Clean break, no version gating. Saved user scripts that re-yield their input will double until the author adds
`// @no-pass`. Every bundled example gets the directive in this change.

No script or silenced script passes through, unless the last compiled code declared `// @no-pass`, in which
case a runtime error keeps it silent, matching the author's intent.

All logic is JS side in the script bridge. No Rust change, no wasm rebuild.

## Implementation

### 1. Directive parsing, `packages/studio/adapters/src/ScriptDeclaration.ts`

Add a standalone directive next to the existing `LABEL_LINE` / `PARAM_LINE` regexes. It is not part of
`DIRECTIVE_LINE` / `DECLARATION_LINE` and does not belong to a `@group`.

```ts
const NO_PASS_LINE = /^\/\/ @no-pass\b(.*)$/m
```

```ts
export const parsePassThrough = (code: string): boolean => {
    const match = NO_PASS_LINE.exec(code)
    if (match === null) {return true}
    if (match[1].trim().length > 0) {throw new Error("Malformed @no-pass: expected: // @no-pass")}
    return false
}
```

### 2. Registry payload, `packages/studio/adapters/src/ScriptCompiler.ts`

`wrapScript` already parses `@param` / `@sample` for the worklet, which has no box graph to read them from.
Add one field to the emitted registry entry:

```
        params: ${JSON.stringify(params)},
        samples: ${JSON.stringify(samples)},
        pass: ${ScriptDeclaration.parsePassThrough(userCode)}
```

No signature change, so every call site inherits it: `load`, `compile`, `OfflineEngineRenderer.ts`,
`engine-host.tsx`, and the wasm tests that call `ScriptCompiler.wrap`.

### 3. Pass-through, `packages/studio/core-wasm/src/script-spielwerk.ts`

`runSpielwerk` takes a `pass: boolean`. When set, the first thing it does is copy the input records verbatim
into the output, one bulk byte copy while the output is still empty, then advance `outCount`. Verbatim means
the record keeps its id, position, duration, pitch, velocity and cent, so the upstream note-off correlates
downstream on its own and Spielwerk never retains those notes. The retainer, scheduler and `sourceToOutput`
correlation stay exactly as they are and apply only to yielded notes.

```ts
export const copyEvents = (memory: ArrayBufferLike, inPtr: number, inCount: number,
                           outPtr: number, outMax: number): number => {
    const count = Math.min(inCount, outMax)
    new Uint8Array(memory, outPtr, count * RECORD_SIZE)
        .set(new Uint8Array(memory, inPtr, count * RECORD_SIZE))
    return count
}
```

Output order does not matter. The consumer sorts by offset with note-off before note-on at a tie
(`render_instrument`, `crates/abi/src/lib.rs:1230`).

Separate the id spaces. Pass-through puts upstream ids (a small per sequencer counter starting at 0, see
`crates/engine-env/src/note_sequencer.rs`) into the same stream as Spielwerk's generated ids (`nextOutputId`,
starting at 1), and the downstream instrument matches note-off to voice BY ID, so a collision steals or strands
a voice. `retain` moves into a reserved high range:

```ts
const GENERATED_ID_BASE = 0x4000_0000
```

```ts
const id = GENERATED_ID_BASE + (nextOutputId++ & 0x3fff_ffff)
```

The counter stays module global so two Spielwerks in one chain cannot collide with each other either.

Capacity stays as it is. The output cap is 256 records (`DEVICE_MAX_EVENTS`, `crates/engine/src/lib.rs:319`).
Pass-through records are written first, so the input is never dropped in favour of generated notes, and the
existing `Note flood` throw still guards a runaway script.

### 4. Bridge, `packages/studio/core-wasm/src/script-bridge.ts`

`RegistryEntry` gains `pass: boolean`, `Bridge` gains `pass = true`. The `true` default is what makes an
unknown or never compiled device transparent.

`#ensureProc` sets `bridge.pass = registry.pass !== false` on hot-swap, next to the `paramMappings` /
`sampleLabels` rebuild but OUTSIDE the `try` that instantiates the Processor, so a script that throws in its
constructor still honours its own declaration.

`#notes` returns `bridge.pass ? copyEvents(this.#memory.buffer, inPtr, inCount, outPtr, outMax) : 0` where it
currently returns a bare `0`, in both places: the `proc === null` guard (no registry entry yet, or silenced)
and the catch block, so the block in which a script throws still forwards its input. `bridge.pass` is passed
into `runSpielwerk`.

`crates/stock-devices/device-spielwerk/src/lib.rs` needs no code change. Its module doc gets one line stating
the bridge forwards the pulled input unless the script declares `// @no-pass`.

### 5. Bundled scripts, `packages/app/studio/src/ui/devices/midi-effects/`

`spielwerk-default.js` becomes a transparent template, an empty `* process(block, events)` loop with a
commented out `yield` showing how to add notes, since pass-through now does what today's `yield event` did.

All 8 files in `examples/` (chord-generator, velocity, pitch, random-humanizer, probability-gate,
echo-note-delay, pitch-range-filter, tb-303-sequencer) get `// @no-pass` under their `// @label` line, which
keeps every example sounding exactly as it does today. Optional follow up, not part of this change:
echo-note-delay could instead drop its `i === 0` repeat and let the dry note pass through.

`spielwerk-starter-prompt.txt` documents the pass-through default, the directive, and that a script which
replaces the input must declare it.

### 6. Manual, `packages/app/studio/public/manuals/devices/midi/spielwerk.md`

New section between "3. Parameters" and "4. Keyboard Shortcuts" describing the note flow: input forwarded
verbatim, yields added on top, `// @no-pass` to suppress the input. The `Processor` skeleton in "6. API
Reference" is updated to the new default template. The "5. Safety" paragraph changes: a silenced processor no
longer mutes the chain, it falls back to pass-through unless the code declares `// @no-pass`.

### 7. Tests

`packages/studio/adapters/src/ScriptDeclaration.test.ts`: `parsePassThrough` is true by default, false with the
directive, throws on a malformed line, matches anywhere in the file, does not match mid-line.

`packages/app/wasm/test/spielwerk-parity.test.ts`: `PASSTHROUGH` and `TRANSPOSE` get `// @no-pass` so the
existing assertions keep their meaning (without it the re-yielded note doubles against the reference), plus two
new cases. One script whose `process` yields nothing must render bit identical to the reference, proving
verbatim pass-through. One `// @no-pass` script that transposes must render only the transposed note, proving
suppression.

`packages/app/wasm/test/spielwerk-automation-parity.test.ts`: its `SPIELWERK` script gets `// @no-pass` so the
assertions stay about the transform.

The .od loading tests (`freeze-pipeline`, `freeze-80s-full`, `live-meter-teardown-fuzz`, `load-303-project`)
carry stored scripts that will now double. `load-303-project` only asserts peak greater than 0.01 and the
freeze tests compare two renders through the same path, so they are expected to stay green. Run them and check
rather than assume.

## Dry run

The trace below is what the four scenarios do after the change, with the code paths named.

Fresh device, nothing compiled. `#ensureProc` finds no registry entry, returns null, `bridge.pass` is still its
`true` default, `#notes` returns `copyEvents(...)`. Every pulled record reaches the instrument unchanged. The
`MISSING_GRACE_CALLS` warning still fires once, since a scriptless device is still worth surfacing.

Default template compiled. `parsePassThrough` returns true, the registry entry carries `pass: true`,
`runSpielwerk` copies the input, the generator yields nothing, `outCount` equals `inCount`. Identical audio to
the fresh device.

Chord Generator with `// @no-pass`. Registry carries `pass: false`, no copy, the three yielded notes get ids in
the `0x4000_0000` range, the retainer emits their note-offs and the incoming note-off cancels them through
`sourceToOutput`. Byte for byte what happens today.

Chord Generator without the directive. Input C3 passes through with its upstream id, and the yielded root,
third and fifth are added, so the root sounds twice. That is the new default and the reason every example ships
with the directive.

Script throws inside `process`. `#notes` catches, `#silence` marks the bridge, the catch returns
`copyEvents(...)` when `bridge.pass`, so the chain keeps playing the raw input. With `// @no-pass` the same
path returns 0 and the device stays silent, which is what the author asked for.

Files touched, none of them Rust: `ScriptDeclaration.ts`, `ScriptCompiler.ts` (+ their tests),
`script-spielwerk.ts`, `script-bridge.ts`, `spielwerk-default.js`, 8 example scripts,
`spielwerk-starter-prompt.txt`, `spielwerk.md`, 2 wasm parity tests, one doc line in
`device-spielwerk/src/lib.rs`.

Known regression, accepted: a saved project whose Spielwerk script re-yields its input doubles those notes on
next load until the author adds `// @no-pass`.

## Verification

1. `cd packages/studio/adapters && npx vitest run src/ScriptDeclaration.test.ts`
2. `npm run build -w @opendaw/studio-adapters`, then
   `npm run build:bundles -w @opendaw/studio-core-wasm && npm run build:api -w @opendaw/studio-core-wasm`.
   The worklet runs the prebuilt bundle, so without this step the studio app keeps the old bridge.
3. `npm run test:parity -w @opendaw/app-wasm`
4. `npm run dev:studio`, then in the browser: put a Spielwerk in front of an instrument on a track with notes
   and compile nothing, the notes must play. Compile the default template, the notes still play. Load the Chord
   Generator example, the chord sounds as before with no doubled root. Delete its `// @no-pass` line and
   recompile, the root now doubles. Put a `throw` in `process`, the notes keep playing. Add `// @no-pass` back
   and break it again, silence.
5. `npx tsc --noEmit` in `packages/studio/adapters` and `packages/studio/core-wasm`.
