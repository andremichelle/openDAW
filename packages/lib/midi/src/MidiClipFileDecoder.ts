import {ByteArrayInput} from "@opendaw/lib-std"
import {ControlEvent} from "./ControlEvent"
import {ControlType} from "./ControlType"
import {MidiFileFormat} from "./MidiFileFormat"
import {MidiTrack} from "./MidiTrack"

const umpWordCounts = [1, 1, 1, 2, 2, 4, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4]

export class MidiClipFileDecoder {
    // The caller has consumed the eight-byte SMF2CLIP signature.
    constructor(readonly input: ByteArrayInput) {}

    decode(): MidiFileFormat {
        const tracks = new Map<number, MidiTrack>()
        let ticksPerQuarter = 0
        let ticks = 0
        let started = false

        while (this.input.remaining() > 0) {
            if (!this.input.available(4)) {throw new Error("Truncated MIDI Clip File UMP")}
            const word = this.input.readInt()
            const type = word >>> 28
            const remainingBytes = (umpWordCounts[type] - 1) * 4
            if (!this.input.available(remainingBytes)) {throw new Error("Truncated MIDI Clip File UMP")}

            if (type === 0x0) {
                const status = (word >>> 20) & 0x0f
                if (status === 0x3) { // Delta Clockstamp Ticks Per Quarter Note
                    if (started || ticksPerQuarter !== 0 || (word & 0xffff) === 0) {
                        throw new Error("Invalid MIDI Clip File ticks per quarter note")
                    }
                    ticksPerQuarter = word & 0xffff
                } else if (status === 0x4 && started) { // Delta Clockstamp
                    ticks += word & 0xfffff
                }
            } else if (type === 0x0f) {
                const status = (word >>> 16) & 0x03ff
                if (status === 0x20) { // Start of Clip
                    if (started || ticksPerQuarter === 0) {throw new Error("Invalid MIDI Clip File Start of Clip")}
                    started = true
                } else if (status === 0x21) { // End of Clip
                    if (!started || this.input.remaining() !== remainingBytes) {
                        throw new Error("Invalid MIDI Clip File End of Clip")
                    }
                    return new MidiFileFormat(Array.from(tracks.values()), 0, ticksPerQuarter)
                }
            } else if (started && (type === 0x2 || type === 0x4)) {
                const status = (word >>> 16) & 0xf0
                if (status === ControlType.NOTE_ON || status === ControlType.NOTE_OFF) {
                    const group = (word >>> 24) & 0x0f
                    const channel = (word >>> 16) & 0x0f
                    const note = (word >>> 8) & 0x7f
                    const velocity = type === 0x4 ? this.input.readInt() >>> 16 : word & 0x7f
                    let track = tracks.get(group)
                    if (track === undefined) {
                        track = MidiTrack.createEmpty(group)
                        tracks.set(group, track)
                    }
                    const event = type === 0x4
                        ? new ControlEvent(ticks, status, note, Math.round(velocity * 127 / 65535), velocity / 65535)
                        : new ControlEvent(ticks, status, note, velocity)
                    track.controlEvents.add(channel, event)
                    continue
                }
            }

            this.input.skip(remainingBytes)
        }
        throw new Error("Missing MIDI Clip File End of Clip")
    }
}
