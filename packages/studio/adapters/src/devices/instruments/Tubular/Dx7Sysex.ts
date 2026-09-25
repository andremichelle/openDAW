import {int} from "@opendaw/lib-std"

// The DX7 voice formats: a 155-byte unpacked voice (VCED order, OP6 first), the 128-byte packed cartridge
// slot, the 4104-byte 32-voice bulk dump (F0 43 0n 09 20 00 + 4096 + checksum + F7, or the bare body) and
// the 163-byte single-voice dump (F0 43 0n 00 01 1B + 155 + checksum + F7). Mirrors Dexed's Cartridge.

export type Dx7Voice = {
    readonly name: string
    readonly data: Uint8Array
}

export namespace Dx7Sysex {
    export const PATCH_SIZE = 155
    export const PACKED_SIZE = 128
    export const BANK_SIZE = 4104
    export const BANK_BODY = 4096
    export const VOICE_SIZE = 163
    export const NAME_OFFSET = 145
    export const NAME_LENGTH = 10

    export const checksum = (bytes: Uint8Array): int => {
        let sum = 0
        for (const byte of bytes) {sum -= byte}
        return sum & 0x7F
    }

    export const unpack = (bulk: Uint8Array): Uint8Array => {
        const patch = new Uint8Array(PATCH_SIZE)
        for (let op = 0; op < 6; op++) {
            const src = op * 17
            const dst = op * 21
            for (let index = 0; index < 11; index++) {patch[dst + index] = bulk[src + index] & 0x7F}
            const leftRightCurves = bulk[src + 11] & 0xF
            patch[dst + 11] = leftRightCurves & 3
            patch[dst + 12] = (leftRightCurves >> 2) & 3
            const detuneRateScaling = bulk[src + 12] & 0x7F
            patch[dst + 13] = detuneRateScaling & 7
            const velocityAmpMod = bulk[src + 13] & 0x1F
            patch[dst + 14] = velocityAmpMod & 3
            patch[dst + 15] = (velocityAmpMod >> 2) & 7
            patch[dst + 16] = bulk[src + 14] & 0x7F
            const coarseMode = bulk[src + 15] & 0x3F
            patch[dst + 17] = coarseMode & 1
            patch[dst + 18] = (coarseMode >> 1) & 0x1F
            patch[dst + 19] = bulk[src + 16] & 0x7F
            patch[dst + 20] = (detuneRateScaling >> 3) & 0x7F
        }
        for (let index = 0; index < 8; index++) {patch[126 + index] = bulk[102 + index] & 0x7F}
        patch[134] = bulk[110] & 0x1F
        const syncFeedback = bulk[111] & 0xF
        patch[135] = syncFeedback & 7
        patch[136] = syncFeedback >> 3
        patch[137] = bulk[112] & 0x7F
        patch[138] = bulk[113] & 0x7F
        patch[139] = bulk[114] & 0x7F
        patch[140] = bulk[115] & 0x7F
        const sensWaveSync = bulk[116] & 0x7F
        patch[141] = sensWaveSync & 1
        patch[142] = (sensWaveSync >> 1) & 7
        patch[143] = sensWaveSync >> 4
        patch[144] = bulk[117] & 0x7F
        for (let index = 0; index < NAME_LENGTH; index++) {patch[NAME_OFFSET + index] = bulk[118 + index] & 0x7F}
        return patch
    }

    export const pack = (patch: Uint8Array): Uint8Array => {
        const bulk = new Uint8Array(PACKED_SIZE)
        for (let op = 0; op < 6; op++) {
            const src = op * 21
            const dst = op * 17
            bulk.set(patch.subarray(src, src + 11), dst)
            bulk[dst + 11] = ((patch[src + 12] & 3) << 2) | (patch[src + 11] & 3)
            bulk[dst + 12] = ((patch[src + 20] & 0x0F) << 3) | (patch[src + 13] & 7)
            bulk[dst + 13] = ((patch[src + 15] & 7) << 2) | (patch[src + 14] & 3)
            bulk[dst + 14] = patch[src + 16]
            bulk[dst + 15] = ((patch[src + 18] & 0x1F) << 1) | (patch[src + 17] & 1)
            bulk[dst + 16] = patch[src + 19]
        }
        bulk.set(patch.subarray(126, 134), 102)
        bulk[110] = patch[134] & 0x1F
        bulk[111] = ((patch[136] & 1) << 3) | (patch[135] & 7)
        bulk.set(patch.subarray(137, 141), 112)
        bulk[116] = ((patch[143] & 7) << 4) | ((patch[142] & 7) << 1) | (patch[141] & 1)
        bulk[117] = patch[144]
        bulk.set(patch.subarray(NAME_OFFSET, NAME_OFFSET + NAME_LENGTH), 118)
        return bulk
    }

    export const voiceName = (patch: Uint8Array): string =>
        Array.from(patch.subarray(NAME_OFFSET, NAME_OFFSET + NAME_LENGTH))
            .map(code => code >= 32 && code < 127 ? String.fromCharCode(code) : " ")
            .join("").trim()

    export const withName = (patch: Uint8Array, name: string): Uint8Array => {
        const copy = new Uint8Array(patch)
        for (let index = 0; index < NAME_LENGTH; index++) {
            const code = name.charCodeAt(index)
            copy[NAME_OFFSET + index] = Number.isNaN(code) ? 32 : code >= 32 && code < 127 ? code : 32
        }
        return copy
    }

    const isBankHeader = (bytes: Uint8Array): boolean =>
        bytes[0] === 0xF0 && bytes[1] === 0x43 && (bytes[2] & 0xF0) === 0 && bytes[3] === 0x09 && bytes[4] === 0x20 && bytes[5] === 0x00

    const isVoiceHeader = (bytes: Uint8Array): boolean =>
        bytes[0] === 0xF0 && bytes[1] === 0x43 && (bytes[2] & 0xF0) === 0 && bytes[3] === 0x00 && bytes[4] === 0x01 && bytes[5] === 0x1B

    const toVoice = (data: Uint8Array): Dx7Voice => ({name: voiceName(data), data})

    const decodeBankBody = (body: Uint8Array): ReadonlyArray<Dx7Voice> =>
        Array.from({length: 32}, (_, index) => toVoice(unpack(body.subarray(index * PACKED_SIZE, (index + 1) * PACKED_SIZE))))

    // One sysex message (F0..F7): a bank dump or a single voice dump. Throws on anything else.
    const decodeMessage = (message: Uint8Array): ReadonlyArray<Dx7Voice> => {
        if (message.length === BANK_SIZE && isBankHeader(message)) {
            const body = message.subarray(6, 6 + BANK_BODY)
            if (checksum(body) !== message[6 + BANK_BODY]) {throw new Error("bank checksum mismatch")}
            return decodeBankBody(body)
        }
        if (message.length === VOICE_SIZE && isVoiceHeader(message)) {
            const data = message.slice(6, 6 + PATCH_SIZE)
            if (checksum(data) !== message[6 + PATCH_SIZE]) {throw new Error("voice checksum mismatch")}
            return [toVoice(data)]
        }
        throw new Error(`not a DX7 dump (${message.length} bytes)`)
    }

    // Every voice in a .syx file: a headerless 4096-byte cartridge, or one or more sysex messages.
    export const decode = (bytes: Uint8Array): ReadonlyArray<Dx7Voice> => {
        if (bytes.length === BANK_BODY && bytes[0] !== 0xF0) {return decodeBankBody(bytes)}
        const voices: Array<Dx7Voice> = []
        let cursor = 0
        while (cursor < bytes.length) {
            const start = bytes.indexOf(0xF0, cursor)
            if (start < 0) {break}
            const end = bytes.indexOf(0xF7, start)
            if (end < 0) {throw new Error("unterminated sysex message")}
            voices.push(...decodeMessage(bytes.subarray(start, end + 1)))
            cursor = end + 1
        }
        if (voices.length === 0) {throw new Error("no DX7 voices found")}
        return voices
    }

    export const encodeBank = (voices: ReadonlyArray<Uint8Array>): Uint8Array => {
        if (voices.length !== 32) {throw new Error("a cartridge holds 32 voices")}
        const bank = new Uint8Array(BANK_SIZE)
        bank.set([0xF0, 0x43, 0x00, 0x09, 0x20, 0x00], 0)
        voices.forEach((voice, index) => bank.set(pack(voice), 6 + index * PACKED_SIZE))
        bank[6 + BANK_BODY] = checksum(bank.subarray(6, 6 + BANK_BODY))
        bank[BANK_SIZE - 1] = 0xF7
        return bank
    }

    export const encodeVoice = (patch: Uint8Array): Uint8Array => {
        const message = new Uint8Array(VOICE_SIZE)
        message.set([0xF0, 0x43, 0x00, 0x00, 0x01, 0x1B], 0)
        message.set(patch.subarray(0, PATCH_SIZE), 6)
        message[6 + PATCH_SIZE] = checksum(patch.subarray(0, PATCH_SIZE))
        message[VOICE_SIZE - 1] = 0xF7
        return message
    }
}
