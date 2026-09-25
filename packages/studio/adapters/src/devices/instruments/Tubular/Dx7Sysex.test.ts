import {describe, expect, it} from "vitest"
import {readdirSync, readFileSync} from "node:fs"
import {join} from "node:path"
import {Dx7Sysex} from "./Dx7Sysex"

const cartridges = join(__dirname, "../../../../../../app/studio/public/tubular/cartridges")

// Voice 0 of Dexed_01.syx ("Say Again.") as Dexed's Cartridge::unpackProgram produces it.
const sayAgain = [
    7, 64, 45, 99, 45, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 0, 0, 0, 7,
    10, 64, 49, 99, 46, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 0, 2, 0, 7,
    13, 64, 49, 99, 46, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 0, 0, 0, 7,
    15, 64, 49, 99, 44, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 0, 2, 0, 7,
    25, 64, 49, 99, 50, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 0, 0, 0, 7,
    70, 40, 49, 99, 99, 92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 0, 1, 0, 7,
    99, 99, 99, 99, 50, 50, 50, 50, 31, 7, 1, 35, 0, 0, 0, 1, 0, 3, 24,
    83, 97, 121, 32, 65, 103, 97, 105, 110, 46
]

describe("Dx7Sysex", () => {
    it("unpacks the first Dexed voice exactly like Dexed", () => {
        const bytes = new Uint8Array(readFileSync(join(cartridges, "Dexed_01.syx")))
        const voices = Dx7Sysex.decode(bytes)
        expect(voices.length).toBe(32)
        expect(Array.from(voices[0].data)).toStrictEqual(sayAgain)
        expect(voices[0].name).toBe("Say Again.")
    })

    it("decodes every bundled cartridge with valid checksums and 32 named voices", () => {
        const files = readdirSync(cartridges).filter(file => file.endsWith(".syx"))
        expect(files.length).toBe(37)
        for (const file of files) {
            const voices = Dx7Sysex.decode(new Uint8Array(readFileSync(join(cartridges, file))))
            expect(voices.length, file).toBe(32)
            voices.forEach(voice => expect(voice.data.length).toBe(Dx7Sysex.PATCH_SIZE))
        }
    })

    it("packs what it unpacked (a round trip through the cartridge slot)", () => {
        const bytes = new Uint8Array(readFileSync(join(cartridges, "SynprezFM_07.syx")))
        const body = bytes.subarray(6, 6 + Dx7Sysex.BANK_BODY)
        for (let index = 0; index < 32; index++) {
            const slot = body.subarray(index * 128, (index + 1) * 128)
            const masked = Array.from(slot).map(byte => byte & 0x7F)
            expect(Array.from(Dx7Sysex.pack(Dx7Sysex.unpack(slot))), `voice ${index}`).toStrictEqual(masked)
        }
    })

    it("re-encodes a bank byte for byte", () => {
        const bytes = new Uint8Array(readFileSync(join(cartridges, "YM2612_ROM1_BASS_BRASS.syx")))
        const voices = Dx7Sysex.decode(bytes)
        expect(Array.from(Dx7Sysex.encodeBank(voices.map(voice => voice.data)))).toStrictEqual(Array.from(bytes))
    })

    it("accepts a headerless 4096-byte body, a single-voice dump and a stream of messages", () => {
        const bytes = new Uint8Array(readFileSync(join(cartridges, "Dexed_01.syx")))
        const body = bytes.slice(6, 6 + Dx7Sysex.BANK_BODY)
        expect(Dx7Sysex.decode(body).map(voice => voice.name)).toStrictEqual(Dx7Sysex.decode(bytes).map(voice => voice.name))
        const single = Dx7Sysex.encodeVoice(Dx7Sysex.decode(bytes)[3].data)
        expect(single.length).toBe(Dx7Sysex.VOICE_SIZE)
        expect(Dx7Sysex.decode(single)[0].name).toBe(Dx7Sysex.decode(bytes)[3].name)
        const stream = new Uint8Array(single.length + bytes.length)
        stream.set(single, 0)
        stream.set(bytes, single.length)
        expect(Dx7Sysex.decode(stream).length).toBe(33)
    })

    it("rejects a corrupted checksum and non-DX7 data", () => {
        const bytes = new Uint8Array(readFileSync(join(cartridges, "Dexed_01.syx")))
        bytes[100] ^= 0x01
        expect(() => Dx7Sysex.decode(bytes)).toThrow("checksum")
        expect(() => Dx7Sysex.decode(new Uint8Array([0xF0, 0x43, 0x00, 0x7E, 0xF7]))).toThrow("not a DX7 dump")
        expect(() => Dx7Sysex.decode(new Uint8Array(12))).toThrow("no DX7 voices")
    })

    it("renames within the 10 printable characters", () => {
        const renamed = Dx7Sysex.withName(new Uint8Array(Dx7Sysex.PATCH_SIZE), "Glocke Ünd Mehr")
        expect(Dx7Sysex.voiceName(renamed)).toBe("Glocke  nd")
        expect(Dx7Sysex.voiceName(Dx7Sysex.withName(renamed, "EP"))).toBe("EP")
    })
})
