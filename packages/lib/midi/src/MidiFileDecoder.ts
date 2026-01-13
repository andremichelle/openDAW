import {byte, ByteArrayInput, int} from "@moises-ai/lib-std"
import {MidiFileFormat} from "./MidiFileFormat"
import {Chunk} from "./Chunk"
import {MidiTrack} from "./MidiTrack"

export class MidiFileDecoder {
    readonly input: ByteArrayInput

    #suppressWarnings: boolean = false
    #sysMode: boolean = false

    constructor(input: ByteArrayInput) {this.input = input}

    decode(): MidiFileFormat {
        this.input.littleEndian = false
        const header = this.input.readInt()
        if (header === Chunk.MTHD) {
            if (this.input.readInt() !== 6) {
                throw new Error("2nd int in header must be 6")
            }
        } else {
            console.warn(`Unsupported midi format ${header} !== ${Chunk.MTHD}`)
            throw new Error("Unsupported midi format")
        }
        const formatType = this.input.readShort()
        const numTracks = this.input.readShort()
        const timeDivision = this.input.readShort()
        const tracks: MidiTrack[] = []
        for (let index = 0; index < numTracks; index++) {
            const trackChunk = this.input.readInt()
            const trackLength = this.input.readInt()
            const trackPosition = this.input.position
            if (trackChunk === Chunk.MTRK) {
                tracks[index] = MidiTrack.decode(this)
            }
            this.input.position = trackPosition + trackLength
        }
        if (0 < this.input.remaining()) {
            console.warn(`${this.input.remaining()} bytes remaining.`)
        }
        return new MidiFileFormat(tracks, formatType, timeDivision)
    }

    readVarLen(): int {
        let value: int = this.input.readByte() & 0xff
        let c: int
        if (0 < (value & 0x80)) {
            value &= 0x7f
            do {
                c = this.input.readByte() & 0xff
                value = (value << 7) + (c & 0x7f)
            } while (0 < (c & 0x80))
        }
        return value
    }

    readSignature(): [int, int] {
        const b0 = this.input.readByte() & 0xff
        const b1 = this.input.readByte() & 0xff
        const b2 = this.input.readByte() & 0xff
        const b3 = this.input.readByte() & 0xff
        if (!this.#suppressWarnings) {
            if (24 !== b2) {
                // Unsupported Metronome Pulse.
            }
            if (8 !== b3) {
                // Unsupported Number of 32nd notes each quarter note.
            }
        }
        return [b0, 1 << b1]
    }

    readTempo(): number {
        const b0 = this.input.readByte() & 0xff
        const b1 = this.input.readByte() & 0xff
        const b2 = this.input.readByte() & 0xff
        const MICROSECONDS_PER_MINUTE = 60_000_000.0 as const
        return MICROSECONDS_PER_MINUTE / ((b0 << 16) | (b1 << 8) | b2)
    }

    skipSysEx(value: int): void {
        if (0xf0 === value) {
            if (this.#sysMode) {throw new Error("System message already in progress")}
            this.input.skip(this.readVarLen() - 1)
            this.#sysMode = true
        } else if (0xf7 === value) {
            if (!this.#sysMode) {
                this.input.skip(this.readVarLen() - 1)
                this.#sysMode = true
            } else {
                this.#sysMode = false
            }
        }
    }
    skip(count: int): void {this.input.skip(count)}
    readByte(): byte {return this.input.readByte()}
}