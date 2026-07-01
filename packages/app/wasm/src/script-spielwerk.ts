// Spielwerk's stateful note-transform orchestration (mirrors the TS `SpielwerkDeviceProcessor.processNotes`),
// run JS-side by the script bridge. It reads the upstream input `EventRecord`s the device pulled (note-on /
// note-off), builds the `UserEvent` stream, runs the user generator `*process(block, events)`, validates each
// yielded note, schedules future-block notes, and correlates note-on -> note-off via a retainer so it can emit
// the stops. The persistent state (retainer + scheduler) lives in `SpielwerkRuntime` across blocks.
//
// EventRecord (abi, 40 bytes, little-endian): position f64@0, offset u32@8, kind u32@12, id u32@16,
// pitch u32@20, velocity f32@24, cent f32@28, duration f64@32. kind: 0 = note-on, 1 = note-off. `duration` is
// the note's pulse length, carried on the note-on so the user script's `event.duration` is exact.

const RECORD_SIZE = 40
const KIND_NOTE_ON = 0
const KIND_NOTE_OFF = 1
const MAX_NOTES_PER_BLOCK = 128
const MAX_SCHEDULED_NOTES = 128

type ScheduledNote = {position: number, duration: number, pitch: number, velocity: number, cent: number}
type RetainedNote = {id: number, position: number, duration: number, pitch: number, velocity: number, cent: number}

let nextOutputId = 1

// One Spielwerk instance's cross-block state.
export class SpielwerkRuntime {
    readonly retained: RetainedNote[] = []   // emitted notes awaiting their note-off (position + duration reached)
    readonly scheduled: ScheduledNote[] = [] // notes the script placed in a future block
    readonly sourceToOutput = new Map<number, Set<number>>() // upstream note-on id -> emitted output ids it spawned

    reset(): void {
        this.retained.length = 0
        this.scheduled.length = 0
        this.sourceToOutput.clear()
    }
}

const writeRecord = (view: DataView, slot: number, kind: number, position: number, id: number, pitch: number, velocity: number, cent: number, duration: number): void => {
    const base = slot * RECORD_SIZE
    view.setFloat64(base + 0, position, true)
    view.setUint32(base + 8, 0, true) // offset: a midi-fx leaves it for the consumer to resolve from `position`
    view.setUint32(base + 12, kind, true)
    view.setUint32(base + 16, id, true)
    view.setUint32(base + 20, pitch, true)
    view.setFloat32(base + 24, velocity, true)
    view.setFloat32(base + 28, cent, true)
    view.setFloat64(base + 32, duration, true)
}

const validateNote = (note: any, from: number): string | null => {
    if (note === undefined || note === null) {return "process yielded undefined"}
    if (typeof note.pitch !== "number" || note.pitch !== note.pitch) {return `Invalid pitch: ${note.pitch}`}
    if (note.pitch < 0 || note.pitch > 127) {return `Pitch out of range: ${note.pitch} (must be 0-127)`}
    if (typeof note.velocity !== "number" || note.velocity !== note.velocity) {return `Invalid velocity: ${note.velocity}`}
    if (note.velocity < 0 || note.velocity > 1) {return `Velocity out of range: ${note.velocity} (must be 0-1)`}
    if (typeof note.duration !== "number" || note.duration !== note.duration) {return `Invalid duration: ${note.duration}`}
    if (note.duration <= 0) {return `Duration must be positive: ${note.duration}`}
    if (typeof note.position !== "number" || note.position !== note.position) {return `Invalid position: ${note.position}`}
    if (note.position < from) {return `Position ${note.position} is in the past (block starts at ${from})`}
    return null
}

// Run one pulled range through the user generator + tracking, writing output records, returning the count.
// Throws on a script error / validation failure / flood (the bridge catches it and silences).
export const runSpielwerk = (runtime: SpielwerkRuntime, proc: any, memory: ArrayBufferLike,
                             inPtr: number, inCount: number, outPtr: number, outMax: number,
                             from: number, to: number, bpm: number, flags: number, s0: number, s1: number): number => {
    const input = new DataView(memory, inPtr, inCount * RECORD_SIZE)
    const out = new DataView(memory, outPtr, outMax * RECORD_SIZE)
    let outCount = 0
    const emit = (kind: number, position: number, id: number, pitch: number, velocity: number, cent: number, duration: number): void => {
        if (outCount >= outMax) {throw new Error(`Note flood: exceeded ${outMax} output notes per range`)}
        writeRecord(out, outCount++, kind, position, id, pitch, velocity, cent, duration)
    }

    // Release retained notes whose span completed within this range, emitting their note-off.
    for (let i = runtime.retained.length - 1; i >= 0; i--) {
        const note = runtime.retained[i]
        const end = note.position + note.duration
        if (end < to) {
            runtime.retained.splice(i, 1)
            emit(KIND_NOTE_OFF, end, note.id, note.pitch, 0, 0, 0)
        }
    }

    // Build the upstream UserEvent stream; a note-off cancels the outputs its source note-on spawned.
    const events: any[] = []
    for (let i = 0; i < inCount; i++) {
        const base = i * RECORD_SIZE
        const kind = input.getUint32(base + 12, true)
        const id = input.getUint32(base + 16, true)
        const position = input.getFloat64(base + 0, true)
        const pitch = input.getUint32(base + 20, true)
        if (kind === KIND_NOTE_ON) {
            events.push({gate: true, id, position, duration: input.getFloat64(base + 32, true), pitch, velocity: input.getFloat32(base + 24, true), cent: input.getFloat32(base + 28, true)})
        } else if (kind === KIND_NOTE_OFF) {
            const outputs = runtime.sourceToOutput.get(id)
            if (outputs !== undefined) {
                for (const outputId of outputs) {
                    const index = runtime.retained.findIndex(note => note.id === outputId)
                    if (index >= 0) {
                        const note = runtime.retained.splice(index, 1)[0]
                        emit(KIND_NOTE_OFF, position, note.id, note.pitch, 0, 0, 0)
                    }
                }
                runtime.sourceToOutput.delete(id)
            }
            events.push({gate: false, id, position, pitch})
        }
    }

    // Replay any scheduled notes that fall in this range.
    for (let i = runtime.scheduled.length - 1; i >= 0; i--) {
        const note = runtime.scheduled[i]
        if (note.position >= from && note.position < to) {
            runtime.scheduled.splice(i, 1)
            emit(KIND_NOTE_ON, note.position, retain(runtime, note), note.pitch, note.velocity, note.cent, note.duration)
        }
    }

    // Run the user generator, tracking the current source note-on id (so emitted notes correlate for note-off).
    let currentSourceId = -1
    const tracked: Iterable<any> = {
        [Symbol.iterator](): Iterator<any> {
            let index = 0
            return {
                next(): IteratorResult<any> {
                    if (index >= events.length) {currentSourceId = -1; return {done: true, value: undefined}}
                    const value = events[index++]
                    if (value.gate) {currentSourceId = value.id}
                    return {done: false, value}
                }
            }
        }
    }
    const block = {from, to, bpm, s0, s1, flags}
    let noteCount = 0
    for (const yielded of proc.process(block, tracked)) {
        if (++noteCount > MAX_NOTES_PER_BLOCK) {throw new Error(`Note flood: exceeded ${MAX_NOTES_PER_BLOCK} notes per block`)}
        const error = validateNote(yielded, from)
        if (error !== null) {throw new Error(error)}
        const note: ScheduledNote = {position: yielded.position, duration: yielded.duration, pitch: yielded.pitch, velocity: yielded.velocity, cent: yielded.cent ?? 0}
        if (note.position >= to) {
            if (runtime.scheduled.length >= MAX_SCHEDULED_NOTES) {throw new Error(`Scheduler full: exceeded ${MAX_SCHEDULED_NOTES} scheduled notes`)}
            runtime.scheduled.push(note)
        } else {
            const id = retain(runtime, note)
            if (currentSourceId >= 0) {
                let set = runtime.sourceToOutput.get(currentSourceId)
                if (set === undefined) {set = new Set(); runtime.sourceToOutput.set(currentSourceId, set)}
                set.add(id)
            }
            emit(KIND_NOTE_ON, note.position, id, note.pitch, note.velocity, note.cent, note.duration)
        }
    }
    return outCount
}

const retain = (runtime: SpielwerkRuntime, note: ScheduledNote): number => {
    const id = nextOutputId++
    runtime.retained.push({id, position: note.position, duration: note.duration, pitch: note.pitch, velocity: note.velocity, cent: note.cent})
    return id
}
