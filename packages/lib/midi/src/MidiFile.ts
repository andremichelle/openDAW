import {byte, ByteArrayInput, ByteArrayOutput} from "@moises-ai/lib-std"
import {MidiTrack} from "./MidiTrack"
import {Chunk} from "./Chunk"
import {MidiFileDecoder} from "./MidiFileDecoder"

export namespace MidiFile {
    export const decoder = (buffer: ArrayBuffer): MidiFileDecoder => new MidiFileDecoder(new ByteArrayInput(buffer))
    export const encoder = (): MidiFileEncoder => new MidiFileEncoder()

    class MidiFileEncoder {
        static writeVarLen(output: ByteArrayOutput, value: number): void {
            let bytes: Array<byte> = []
            while (value > 0x7F) {
                bytes.push((value & 0x7F) | 0x80)
                value >>= 7
            }
            bytes.push(value & 0x7F)
            for (let i = bytes.length - 1; i >= 0; i--) {
                output.writeByte(bytes[i])
            }
        }

        readonly #tracks: Array<MidiTrack> = []

        addTrack(track: MidiTrack): this {
            this.#tracks.push(track)
            return this
        }

        encode(): ByteArrayOutput {
            const output = ByteArrayOutput.create()
            output.littleEndian = false
            output.writeInt(Chunk.MTHD)
            output.writeInt(6)
            output.writeShort(0) // formatType
            output.writeShort(this.#tracks.length)
            output.writeShort(96) // timeDivision
            this.#tracks.forEach(track => {
                output.writeInt(Chunk.MTRK)
                const buffer = track.encode()
                output.writeInt(buffer.byteLength)
                output.writeBytes(new Int8Array(buffer))
            })
            return output
        }
    }

}