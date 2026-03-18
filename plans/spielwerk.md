# Spielwerk — User-Scripted MIDI Effect Processor

## Concept

A scripted MIDI effect device — the MIDI counterpart to Werkstatt (audio DSP). Users write TypeScript classes that transform or generate note events. Reuses the same infrastructure: code editor, compile-via-`addModule()`, version gating, error recovery.

---

## The `iterateActiveNotesAt` Problem — Solved

Every `MidiEffectProcessor` must implement both `processNotes()` (block-by-block note lifecycle) and `iterateActiveNotesAt()` (point-in-time snapshot). These two methods are tightly coupled — every built-in device mirrors its transformation in both methods. This duplication is error-prone and too complex for users.

### How It Actually Works

`iterateActiveNotesAt` does not look into the past. It returns what is **currently active** — notes that have been started but haven't ended yet. The Arpeggio already proves this pattern: it stores generated notes in an `EventSpanRetainer`, and `iterateActiveNotesAt` simply calls `retainer.overlapping(position)`.

### Solution: The Host Owns the Retainer

The user only writes `processNotes`. The host intercepts every yielded note, stores it in a retainer, and answers `iterateActiveNotesAt` from the retainer. The user never knows this method exists.

This works universally — for transformers (1:1), generators (1:N), and filters (1:0).

---

## Class Contract

```typescript
class Processor {
    paramChanged?(name: string, value: number): void
    reset?(): void  // called on transport jump (seek, loop restart)

    // Called per block. Receives upstream note starts, yields output notes.
    // Each yielded note must have: { position, duration, pitch, velocity, cent }
    * processNotes(block, notes) {
        for (const note of notes) {
            yield note
        }
    }
}
```

- `block` — the engine `Block` object passed directly (provides `from`, `to`, `bpm`, `s0`, `s1`, `flags`, etc.). Sample indices are irrelevant for MIDI but passing the Block keeps the API simple.
- `notes` — an iterator of upstream note starts in `[block.from, block.to)`. Each note is `{ position, duration, pitch, velocity, cent }`. Stop events are hidden from the user.
- The user yields zero or more notes per input note. Each must have `position`, `duration`, `pitch`, `velocity`, `cent`. Position must be `>= block.from`. Notes with position in `[from, to)` are emitted immediately. Notes with position `>= to` are held in an internal scheduler and emitted in the appropriate future block.
- `paramChanged` — optional, same as audio Werkstatt. Receives mapped parameter values from `// @param` declarations.
- `reset` — optional. Called when the transport jumps (discontinuous flag: seek, loop restart). Use to clear accumulated state like held note arrays.

---

## Host Processor — `SpielwerkDeviceProcessor`

```typescript
const MAX_NOTES_PER_BLOCK: int = 100
const MAX_SCHEDULED_NOTES: int = 128

const validateNote = (note: any, from: ppqn): Nullable<string> => {
    if (!isDefined(note)) return "processNotes yielded undefined"
    if (typeof note.pitch !== "number" || note.pitch !== note.pitch) return `Invalid pitch: ${note.pitch}`
    if (note.pitch < 0 || note.pitch > 127) return `Pitch out of range: ${note.pitch} (must be 0–127)`
    if (typeof note.velocity !== "number" || note.velocity !== note.velocity) return `Invalid velocity: ${note.velocity}`
    if (note.velocity < 0 || note.velocity > 1) return `Velocity out of range: ${note.velocity} (must be 0–1)`
    if (typeof note.duration !== "number" || note.duration !== note.duration) return `Invalid duration: ${note.duration}`
    if (note.duration <= 0) return `Duration must be positive: ${note.duration}`
    if (typeof note.position !== "number" || note.position !== note.position) return `Invalid position: ${note.position}`
    if (note.position < from) return `Position ${note.position} is in the past (block starts at ${from})`
    return null
}

export class SpielwerkDeviceProcessor extends EventProcessor implements MidiEffectProcessor {
    readonly #adapter: SpielwerkDeviceBoxAdapter
    readonly #engineToClient: EngineToClient
    readonly #retainer: EventSpanRetainer<Id<NoteEvent>>
    readonly #scheduled: Array<{position: ppqn, duration: ppqn, pitch: byte, velocity: float, cent: number}>
    readonly #sourceToOutput: Map<int, Array<int>>  // source note id → output note ids
    readonly #uuid: string

    #source: Option<NoteEventSource> = Option.None
    #userProcessor: Option<any> = Option.None
    #currentUpdate: int = -1
    #silenced: boolean = false

    constructor(context: EngineContext, adapter: SpielwerkDeviceBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#engineToClient = context.engineToClient
        this.#retainer = new EventSpanRetainer<Id<NoteEvent>>()
        this.#scheduled = []
        this.#sourceToOutput = new Map()
        this.#uuid = UUID.toString(adapter.uuid)
        this.ownAll(
            adapter.box.code.catchupAndSubscribe(owner => {
                const newUpdate = parseUpdate(owner.getValue())
                if (newUpdate > 0 && newUpdate !== this.#currentUpdate) {
                    this.#silenced = true
                    this.#userProcessor = Option.None
                    this.#tryLoad(newUpdate)
                }
            }),
            // ... parameter binding (same pattern as audio Werkstatt)
            context.registerProcessor(this)
        )
    }

    #reportError(message: string): void {
        this.#engineToClient.deviceMessage(this.#uuid, message)
    }

    #silence(message: string): void {
        this.#silenced = true
        this.#sourceToOutput.clear()
        Arrays.clear(this.#scheduled)
        this.#reportError(message)
        // retainer is NOT cleared here — processNotes will yield stop events for all retained notes
    }

    #tryLoad(update: int): void {
        const registry = (globalThis as any).openDAW?.spielwerkProcessors?.[this.#uuid]
        if (isDefined(registry) && registry.update === update) {
            this.#swapProcessor(registry.create, update)
        }
    }

    #swapProcessor(ProcessorClass: any, update: int): void {
        try {
            this.#userProcessor = Option.wrap(new ProcessorClass())
            this.#currentUpdate = update
            this.#silenced = false
            this.#pushAllParameters()
        } catch (error) {
            this.#silence(`Failed to instantiate Processor: ${error}`)
        }
    }

    * #emitNote(note: {position: ppqn, duration: ppqn, pitch: byte, velocity: float, cent: number}): IterableIterator<NoteLifecycleEvent> {
        const lifecycle = NoteLifecycleEvent.start(note.position, note.duration, note.pitch, note.velocity, note.cent ?? 0)
        this.#retainer.addAndRetain({...lifecycle})
        yield lifecycle
    }

    setNoteEventSource(source: NoteEventSource): Terminable {
        assert(this.#source.isEmpty(), "NoteEventSource already set")
        this.#source = Option.wrap(source)
        return Terminable.create(() => this.#source = Option.None)
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    * processNotes(from: ppqn, to: ppqn, flags: int): IterableIterator<NoteLifecycleEvent> {
        // Phase 1: Release expired notes from retainer
        if (this.#retainer.nonEmpty()) {
            if (Bits.every(flags, BlockFlag.discontinuous)) {
                for (const event of this.#retainer.releaseAll()) {
                    yield NoteLifecycleEvent.stop(event, from)
                }
                this.#sourceToOutput.clear()
                Arrays.clear(this.#scheduled)
            } else {
                for (const event of this.#retainer.releaseLinearCompleted(to)) {
                    yield NoteLifecycleEvent.stop(event, event.position + event.duration)
                }
            }
        }
        if (this.#source.isEmpty() || this.#userProcessor.isEmpty() || this.#silenced) {
            // Release all remaining notes when silenced or disconnected
            for (const event of this.#retainer.releaseAll()) {
                yield NoteLifecycleEvent.stop(event, from)
            }
            return
        }
        const source = this.#source.unwrap()
        const proc = this.#userProcessor.unwrap()
        // Phase 2: Consume upstream, separate starts from stops
        const upstreamStarts: Array<Id<NoteEvent>> = []
        const upstreamStops: Array<NoteCompleteEvent> = []
        for (const event of source.processNotes(from, to, flags)) {
            if (NoteLifecycleEvent.isStart(event)) {
                upstreamStarts.push(event)
            } else {
                upstreamStops.push(event)
            }
        }
        // Phase 3: Handle upstream stops — release associated output notes
        for (const stop of upstreamStops) {
            const outputIds = this.#sourceToOutput.get(stop.id)
            if (isDefined(outputIds)) {
                for (const event of this.#retainer.release(note => outputIds.includes(note.id))) {
                    yield NoteLifecycleEvent.stop(event, stop.position)
                }
                this.#sourceToOutput.delete(stop.id)
            }
        }
        // Phase 4: Emit scheduled notes that fall into this block
        for (let i = this.#scheduled.length - 1; i >= 0; i--) {
            const note = this.#scheduled[i]
            if (note.position >= from && note.position < to) {
                this.#scheduled.splice(i, 1)
                yield* this.#emitNote(note)
            }
        }
        // Phase 5: Feed starts to user, retain and yield output
        const userNotes = upstreamStarts.map(event => ({
            position: event.position,
            duration: event.duration,
            pitch: event.pitch,
            velocity: event.velocity,
            cent: event.cent
        }))
        const block: Block = {from, to, /* ... */}
        try {
            let noteCount: int = 0
            for (const yielded of proc.processNotes(block, userNotes[Symbol.iterator]())) {
                if (++noteCount > MAX_NOTES_PER_BLOCK) {
                    this.#silence(`Note flood: exceeded ${MAX_NOTES_PER_BLOCK} notes per block`)
                    return
                }
                const error = validateNote(yielded, from)
                if (error !== null) {
                    this.#silence(error)
                    return
                }
                if (yielded.position >= to) {
                    // Future note — add to scheduler
                    if (this.#scheduled.length >= MAX_SCHEDULED_NOTES) {
                        this.#silence(`Scheduler full: exceeded ${MAX_SCHEDULED_NOTES} scheduled notes`)
                        return
                    }
                    this.#scheduled.push({
                        position: yielded.position,
                        duration: yielded.duration,
                        pitch: yielded.pitch,
                        velocity: yielded.velocity,
                        cent: yielded.cent ?? 0
                    })
                } else {
                    // Current block — emit immediately
                    yield* this.#emitNote(yielded)
                }
            }
        } catch (err) {
            this.#silence(`Runtime error: ${err}`)
            return
        }
        // Phase 5: Release any output notes that completed within this block
        for (const event of this.#retainer.releaseLinearCompleted(to)) {
            yield NoteLifecycleEvent.stop(event, event.position + event.duration)
        }
    }

    * iterateActiveNotesAt(position: ppqn, _onlyExternal: boolean): IterableIterator<NoteEvent> {
        yield* this.#retainer.overlapping(position, NoteEvent.Comparator)
    }

    reset(): void {
        this.#retainer.clear()
        this.#sourceToOutput.clear()
        Arrays.clear(this.#scheduled)
        this.eventInput.clear()
    }

    processEvents(_block: Block, _from: ppqn, _to: ppqn): void {}
    parameterChanged(_parameter: AutomatableParameter): void {}
    handleEvent(_block: Block, _event: Event): void {}

    index(): number {return this.#adapter.indexField.getValue()}
    adapter(): SpielwerkDeviceBoxAdapter {return this.#adapter}
}
```

### Key Design Decisions

**`iterateActiveNotesAt` is always the retainer.** No user code involved. The retainer holds exactly the notes the user has yielded that haven't expired or been stopped. `overlapping(position)` filters to notes where `note.position <= position < note.position + note.duration`. Always returns from retainer regardless of `onlyExternal` — unlike Arpeggio (which generates time-stepped patterns unrelated to input), Spielwerk effects produce notes that are derived from or are the input notes, so they should always be visible.

**Stop propagation from upstream.** When an upstream note stops (e.g., key release during live play), the host releases all output notes derived from it via the `sourceToOutput` map. For sequenced content with known durations, notes also expire naturally via `releaseLinearCompleted`. Both paths are needed — duration handles the normal case, stop propagation handles external/audition notes.

**The user never sees stop events.** The `notes` iterator only contains start events. The host handles the entire lifecycle: starts enter the retainer, stops are emitted when duration expires or upstream stops.

**Internal scheduler for future notes.** Notes with `position >= to` are not emitted immediately — they are held in a sorted scheduler array (`MAX_SCHEDULED_NOTES = 128`). At the start of each block (phase 4), the host drains all scheduled notes whose position falls in `[from, to)` and emits them. Notes with `position < from` are rejected as errors (notes in the past). This enables effects like echo/delay and humanizers that shift notes across block boundaries. The scheduler is cleared on discontinuous (transport jump), silence, and reset.

**Note flood protection.** `MAX_NOTES_PER_BLOCK = 100` for notes yielded per block. `MAX_SCHEDULED_NOTES = 128` for the scheduler queue. Exceeding either limit silences with an error message.

**Error reporting and validation.** Same mechanism as audio Werkstatt: `engineToClient.deviceMessage(uuid, message)` sends errors to the editor, which subscribes via `engine.subscribeDeviceMessage(uuid, observer)` and displays them inline. The host validates every yielded note for: missing fields, NaN, pitch out of 0–127, velocity out of 0–1, non-positive duration, position in the past. On validation failure, runtime exception, note flood, or scheduler overflow: report the error, silence, wait for recompile.

---

## Examples — Built-in Devices Recreated

All built-in MIDI effects (except Zeitgeist) can be recreated in Spielwerk. Zeitgeist requires access to the Groove warp/unwarp interface, which is outside the user script's scope.

### Velocity

The built-in Velocity device uses position-dependent automation (`valueAt(position)`) for each parameter. Spielwerk parameters are scalar (one value per block), so this is a simplified but functionally equivalent version.

```typescript
// @param target 0 1 0.5 linear
// @param strength 0 1 0 linear
// @param randomAmount 0 1 0 linear
// @param offset -1 1 0 linear
// @param mix 0 1 1 linear

class Processor {
    target = 0.5
    strength = 0
    randomAmount = 0
    offset = 0
    mix = 1
    paramChanged(name, value) {
        if (name === "target") this.target = value
        if (name === "strength") this.strength = value
        if (name === "randomAmount") this.randomAmount = value
        if (name === "offset") this.offset = value
        if (name === "mix") this.mix = value
    }
    * processNotes(block, notes) {
        for (const note of notes) {
            const magnet = note.velocity + (this.target - note.velocity) * this.strength
            const random = (Math.random() * 2 - 1) * this.randomAmount
            const wet = Math.max(0, Math.min(1, magnet + random + this.offset))
            const velocity = note.velocity * (1 - this.mix) + wet * this.mix
            yield { ...note, velocity }
        }
    }
}
```

### Pitch

```typescript
// @param octaves -4 4 0 int
// @param semiTones -12 12 0 int
// @param cent -100 100 0 linear

class Processor {
    octaves = 0
    semiTones = 0
    cent = 0
    paramChanged(name, value) {
        if (name === "octaves") this.octaves = value
        if (name === "semiTones") this.semiTones = value
        if (name === "cent") this.cent = value
    }
    * processNotes(block, notes) {
        for (const note of notes) {
            yield {
                ...note,
                pitch: note.pitch + this.octaves * 12 + this.semiTones,
                cent: note.cent + this.cent
            }
        }
    }
}
```

### Arpeggio

The user tracks active notes across blocks via instance state. At each step, the active set is computed for that specific position — notes that have started (`position <= step`) and haven't ended (`position + duration > step`).

```typescript
// @param mode 0 2 0 int
// @param rate 24 960 120 int
// @param gate 0.1 1.0 0.8 linear
// @param repeat 1 8 1 int
// @param octaves 1 4 1 int

class Processor {
    mode = 0
    rate = 120
    gate = 0.8
    repeat = 1
    octaves = 1
    held = []
    paramChanged(name, value) {
        if (name === "mode") this.mode = value
        if (name === "rate") this.rate = value
        if (name === "gate") this.gate = value
        if (name === "repeat") this.repeat = value
        if (name === "octaves") this.octaves = value
    }
    reset() {
        this.held = []
    }
    activeAt(position) {
        return this.held
            .filter(note => note.position <= position && position < note.position + note.duration)
            .sort((noteA, noteB) => noteA.pitch - noteB.pitch)
    }
    * processNotes(block, notes) {
        for (const note of notes) {
            this.held.push(note)
        }
        this.held = this.held.filter(note => note.position + note.duration > block.from)
        const duration = Math.max(1, Math.floor(this.rate * this.gate))
        let index = Math.ceil(block.from / this.rate)
        let position = index * this.rate
        while (position < block.to) {
            const stack = this.activeAt(position)
            if (stack.length > 0) {
                const count = stack.length
                const amount = count * this.octaves
                const stepIndex = Math.floor(index / this.repeat)
                let localIndex, octave
                if (this.mode === 0) {
                    localIndex = stepIndex % count
                    octave = Math.floor((stepIndex % amount) / count)
                } else if (this.mode === 1) {
                    localIndex = (count - 1) - stepIndex % count
                    octave = (this.octaves - 1) - Math.floor((stepIndex % amount) / count)
                } else {
                    const seqLen = Math.max(1, amount * 2 - 2)
                    const seqIdx = stepIndex % seqLen
                    const procIdx = seqIdx < amount ? seqIdx : seqLen - seqIdx
                    localIndex = procIdx % count
                    octave = Math.floor(procIdx / count)
                }
                const source = stack[localIndex]
                yield {
                    position,
                    duration,
                    pitch: source.pitch + octave * 12,
                    velocity: source.velocity,
                    cent: source.cent
                }
            }
            position = ++index * this.rate
        }
    }
}
```

---

## Examples — Creative Effects

### Chord Generator

```typescript
// @param mode 0 3 0 int

class Processor {
    intervals = [[0, 4, 7], [0, 3, 7], [0, 4, 7, 11], [0, 3, 7, 10]]
    mode = 0
    paramChanged(name, value) {
        if (name === "mode") this.mode = value
    }
    * processNotes(block, notes) {
        for (const note of notes) {
            for (const interval of this.intervals[this.mode]) {
                yield { ...note, pitch: note.pitch + interval }
            }
        }
    }
}
```

### Random Humanizer

```typescript
// @param timing 0 50 10 linear
// @param velRange 0 0.3 0.1 linear

class Processor {
    timing = 10
    velRange = 0.1
    paramChanged(name, value) {
        if (name === "timing") this.timing = value
        if (name === "velRange") this.velRange = value
    }
    * processNotes(block, notes) {
        for (const note of notes) {
            yield {
                ...note,
                position: note.position + Math.random() * this.timing,
                velocity: Math.max(0, Math.min(1, note.velocity + (Math.random() - 0.5) * this.velRange))
            }
        }
    }
}
```

### Probability Gate

```typescript
// @param chance 0 1 0.5 linear

class Processor {
    chance = 0.5
    paramChanged(name, value) {
        if (name === "chance") this.chance = value
    }
    * processNotes(block, notes) {
        for (const note of notes) {
            if (Math.random() < this.chance) {
                yield note
            }
        }
    }
}
```

### Echo / Note Delay

```typescript
// @param repeats 1 8 3 int
// @param delay 24 480 120 int
// @param decay 0.1 1.0 0.7 linear

class Processor {
    repeats = 3
    delay = 120
    decay = 0.7
    paramChanged(name, value) {
        if (name === "repeats") this.repeats = value
        if (name === "delay") this.delay = value
        if (name === "decay") this.decay = value
    }
    * processNotes(block, notes) {
        for (const note of notes) {
            for (let i = 0; i < this.repeats; i++) {
                yield {
                    ...note,
                    position: note.position + i * this.delay,
                    velocity: note.velocity * Math.pow(this.decay, i)
                }
            }
        }
    }
}
```

Notes with `position >= block.to` are automatically held in the internal scheduler and emitted in the correct future block.

### Note Filter — Pitch Range

```typescript
// @param low 0 127 36 int
// @param high 0 127 84 int

class Processor {
    low = 36
    high = 84
    paramChanged(name, value) {
        if (name === "low") this.low = value
        if (name === "high") this.high = value
    }
    * processNotes(block, notes) {
        for (const note of notes) {
            if (note.pitch >= this.low && note.pitch <= this.high) {
                yield note
            }
        }
    }
}
```

---

## Architecture

### Forge Schema

Separate box schema, shared custom fields with audio Werkstatt:

```typescript
const WerkstattFields = {
    10: {type: "string", name: "code", value: ""},
    11: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}}
} as const satisfies FieldRecord<Pointers>

// Existing (audio effect)
export const WerkstattDeviceBox = DeviceFactory.createAudioEffect("WerkstattDeviceBox", WerkstattFields)

// New (midi effect)
export const SpielwerkDeviceBox = DeviceFactory.createMidiEffect("SpielwerkDeviceBox", WerkstattFields)
```

Three separate schemas are necessary because the device type system is deeply structural: different host pointer types, different common fields (effects have `index`, instruments have `icon`), different tags, different adapter interfaces, different processor factories, and different chain wiring. A unified box would require rewriting the entire device dispatch architecture. Werkstatt appears as "Werkstatt" and Spielwerk as "Spielwerk" in the UI via `box.label.setValue()`.

Reuses `WerkstattParameterBox` from audio Werkstatt — same `// @param` format, same reconciliation.

### Compiler

Reuses `WerkstattCompiler` infrastructure. Different registry namespace:

```javascript
globalThis.openDAW.spielwerkProcessors["<uuid>"] = {
    version: 42,
    create: (function spielwerk() {
        class Processor { /* user code */ }
        return Processor
    })()
}
```

### Editor

Reuses `CodeEditor` component and `DeviceEditor` shell. Error display via `engine.subscribeDeviceMessage(uuid, observer)` — same as audio Werkstatt. No peak meter (MIDI has no audio output). Could show note activity indicator via `NoteBroadcaster`.

---

## Open Questions

### 1. Source-to-Output Tracking for 1:N Generators

For 1:1 transforms, the `sourceToOutput` mapping is straightforward — same iteration order pairs input to output. For generators that yield multiple notes per input (chord generator), we need to track which yields came from which input note.

Approach: wrap the user's input iterator so the host knows when the user consumes each input note. All output notes yielded between consuming input N and input N+1 are associated with input N's id. This lets the host release all chord notes when the original note stops.

### 2. Shared Compiler Infrastructure

Extract `// @param` parsing and box reconciliation from audio Werkstatt into a shared module so both audio and MIDI Werkstatt reuse it.

---

## Implementation Order

1. **Extract shared compiler/param infrastructure** from audio Werkstatt
2. **Extract shared `WerkstattFields`** into a common constant
3. **Forge schema**: `SpielwerkDeviceBox` + box visitor + adapter
4. **Host processor**: `SpielwerkDeviceProcessor` with retainer + sourceToOutput tracking
5. **Factory registration**: create, adapter, editor
6. **Editor**: reuse CodeEditor, error display, default passthrough code
7. **Test**: verify `iterateActiveNotesAt` correctness with Zeitgeist in chain, test note flood protection, test upstream stop propagation
