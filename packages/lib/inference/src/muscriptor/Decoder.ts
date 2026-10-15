import {MuScriptorNote} from "./types"
import {MUSCRIPTOR_VOCAB, MUSCRIPTOR_GROUPS} from "./Model"

interface OpenNote {start: number, pitch: number, program: number}

/** Tracks (instrument, pitch), so different instruments can share a pitch. */
export class MuScriptorDecoder {
    readonly #open = new Map<string, OpenNote>()
    readonly #notes: Array<MuScriptorNote> = []
    #offset = 0
    #limit = 0
    #time = 0
    #program = -1
    #velocity = -1
    #prologue = true

    beginChunk(offset: number, end: number): number[] {
        this.#offset = offset
        this.#limit = end
        this.#time = offset
        this.#program = -1
        this.#velocity = -1
        this.#prologue = true
        // Upstream generates the first prologue itself. Only later chunks have
        // a preceding note state from which to teacher-force a continuation.
        const prefix = [1395]
        if (offset === 0) {return prefix}
        let program = -1
        for (const note of [...this.#open.values()].sort((a, b) => a.program - b.program || a.pitch - b.pitch)) {
            if (note.program !== program) {prefix.push(1135 + note.program); program = note.program}
            prefix.push(1004 + note.pitch)
        }
        prefix.push(1134)
        return prefix
    }

    feed(id: number): void {
        const token = MUSCRIPTOR_VOCAB[id]
        if (token === undefined) {throw new Error(`Invalid MuScriptor token ${id}`)}
        const {type, value} = token
        if (type === "tie") {this.#prologue = false; this.#velocity = -1; return}
        if (type === "program") {this.#program = value; return}
        if (this.#prologue) {return}
        if (type === "shift") {
            if (value > 0) {this.#time = this.#offset + value / 100}
        } else if (type === "velocity") {
            this.#velocity = value
        } else if (type === "drum") {
            if (this.#time < this.#limit) {this.#push({start: this.#time, pitch: value, program: 128}, this.#time + 0.01)}
        } else if (type === "pitch" && this.#program >= 0 && this.#program < 128 && this.#velocity >= 0) {
            if (this.#time >= this.#limit) {return}
            const key = `${this.#program}:${value}`
            const old = this.#open.get(key)
            if (old !== undefined) {this.#push(old, this.#time); this.#open.delete(key)}
            if (this.#velocity > 0) {this.#open.set(key, {start: this.#time, pitch: value, program: this.#program})}
        }
    }

    finish(duration: number): ReadonlyArray<MuScriptorNote> {
        // Unclosed notes are not extended through unknown audio to the selection's end.
        for (const note of this.#open.values()) {this.#push(note, Math.min(duration, Math.max(this.#time, note.start + 0.01)))}
        this.#open.clear()
        return this.#notes.map(note => ({...note, end: Math.min(duration, note.end)}))
            .filter(note => note.end > note.start)
            .sort((a, b) => a.start - b.start || a.program - b.program || a.pitch - b.pitch)
    }

    #push(note: OpenNote, end: number): void {
        if (end <= note.start) {return}
        const group = MUSCRIPTOR_GROUPS[note.program]
        this.#notes.push({...note, end, velocity: 100 / 127, isDrum: note.program === 128,
            instrument: note.program === 128 ? "Drums" : group ?? `MIDI Program ${note.program + 1}`})
    }
}
