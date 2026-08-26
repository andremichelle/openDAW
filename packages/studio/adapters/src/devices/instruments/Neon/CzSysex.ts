import {int} from "@opendaw/lib-std"

// The Casio CZ-101/1000 single-tone dump (264 bytes): F0 44 00 00 7n cmd prog, 128 tone bytes as 256
// nibbles (LOW nibble first), F7. Layout per the published MIDI specification (youngmonkey), see
// plans/neon.md. Decoded values stay in the raw hardware domains (0-99 etc.) — the box stores them raw.

export type CzEnvelope = {
    rates: ReadonlyArray<int> // 8 × 0-99
    levels: ReadonlyArray<int> // 8 × 0-99
    sustain: int // 1-based step, 0 = none
    end: int // 1-based step
}

export type CzLine = {
    wave1: int // panel wave 0-7
    wave2: int // 0 = off, else panel wave + 1
    dcwKeyFollow: int
    dcaKeyFollow: int
    pitchEnv: CzEnvelope
    dcwEnv: CzEnvelope
    dcaEnv: CzEnvelope
}

export type CzTone = {
    lineSelect: int // 0-3: 1, 2, 1+1', 1+2'
    modulation: int // 0 none, 1 ring, 2 noise
    octave: int // -1..+1
    detuneNote: int // signed semitones (-48..48)
    detuneFine: int // signed steps (-60..60, 60 steps per semitone)
    vibratoWave: int // 0-3
    vibratoDelay: int // 0-99
    vibratoRate: int
    vibratoDepth: int
    lines: [CzLine, CzLine]
}

const TONE_BYTES = 128
const WAVE_BITS: ReadonlyArray<int> = [0b000, 0b001, 0b010, 0b100, 0b101, 0b110, 0b110, 0b110]
const WINDOW_OF_WAVE: ReadonlyArray<int> = [0, 0, 0, 0, 0, 1, 2, 3]
const VIBRATO_WAVE_BYTES: ReadonlyArray<int> = [0x08, 0x04, 0x20, 0x02]

const panelWave = (bits: int, window: int): int => {
    if (bits === 0b110) {return 4 + Math.min(Math.max(window, 1), 3)}
    const index = WAVE_BITS.indexOf(bits)
    return index >= 0 ? index : 0
}

const decodeRateLinear = (byte: int, divisor: int): int => {
    const masked = byte & 0x7F
    if (masked === 0) {return 0}
    if (masked >= divisor) {return 99}
    return Math.min(99, Math.floor(99 * masked / divisor) + 1)
}

const decodeDcwRate = (byte: int): int => {
    const masked = byte & 0x7F
    if (masked <= 8) {return 0}
    if (masked >= 0x77) {return 99}
    return Math.min(99, Math.floor(99 * (masked - 8) / 119) + 1)
}

const decodeLevel = (byte: int): int => {
    const masked = byte & 0x7F
    if (masked === 0) {return 0}
    if (masked >= 0x7F) {return 99}
    return Math.min(99, Math.floor(99 * masked / 127) + 1)
}

const decodePitchLevel = (byte: int): int => {
    const masked = byte & 0x7F
    return masked <= 0x3F ? masked : Math.min(99, masked - 4)
}

const encodeRateLinear = (rate: int, divisor: int): int =>
    rate <= 0 ? 0 : rate >= 99 ? divisor : Math.floor(divisor * rate / 99)

const encodeDcwRate = (rate: int): int =>
    rate <= 0 ? 8 : rate >= 99 ? 0x77 : Math.floor(119 * rate / 99) + 8

const encodeLevel = (level: int): int =>
    level <= 0 ? 0 : level >= 99 ? 0x7F : Math.floor(127 * level / 99)

const encodePitchLevel = (level: int): int => level <= 0x3F ? level : level + 4

const decodeEnvelope = (data: Uint8Array, endOffset: int, stepsOffset: int,
                        rate: (byte: int) => int, level: (byte: int) => int): CzEnvelope => {
    const rates: int[] = []
    const levels: int[] = []
    const end = (data[endOffset] & 0x07) + 1
    const sustainSteps: int[] = []
    for (let step = 0; step < 8; step++) {
        const rateByte = data[stepsOffset + step * 2]
        const levelByte = data[stepsOffset + step * 2 + 1]
        rates.push(rate(rateByte))
        levels.push(level(levelByte))
        if ((levelByte & 0x80) !== 0) {sustainSteps.push(step + 1)}
    }
    return {rates, levels, sustain: sustainSteps.at(0) ?? 0, end}
}

const encodeEnvelope = (out: Uint8Array, endOffset: int, stepsOffset: int, envelope: CzEnvelope,
                        rate: (value: int) => int, level: (value: int) => int): void => {
    out[endOffset] = Math.min(Math.max(envelope.end, 1), 8) - 1
    let previous = 0
    for (let step = 0; step < 8; step++) {
        const target = envelope.levels[step] ?? 0
        let rateByte = rate(envelope.rates[step] ?? 0)
        if (target < previous) {rateByte |= 0x80}
        let levelByte = level(target)
        if (envelope.sustain === step + 1) {levelByte |= 0x80}
        out[stepsOffset + step * 2] = rateByte
        out[stepsOffset + step * 2 + 1] = levelByte
        previous = target
    }
}

const decodeLine = (data: Uint8Array, waveOffset: int, blockOffset: int, withModulation: boolean):
    {line: CzLine, modulation: int} => {
    const first = data[waveOffset]
    const second = data[waveOffset + 1]
    const wave1Bits = (first >> 5) & 0x07
    const wave2Bits = (first >> 2) & 0x07
    const wave2On = ((first >> 1) & 0x01) !== 0
    const window = second & 0x07
    const modulationBits = (second >> 3) & 0x07
    const modulation = !withModulation ? 0 : modulationBits === 0b100 ? 1 : modulationBits === 0b011 ? 2 : 0
    const dcaKeyFollow = Math.min(data[blockOffset] & 0x0F, 9)
    const dcwKeyFollow = Math.min(data[blockOffset + 2] & 0x0F, 9)
    const dcaEnv = decodeEnvelope(data, blockOffset + 4, blockOffset + 5, byte => decodeRateLinear(byte, 119), decodeLevel)
    const dcwEnv = decodeEnvelope(data, blockOffset + 21, blockOffset + 22, decodeDcwRate, decodeLevel)
    const pitchEnv = decodeEnvelope(data, blockOffset + 38, blockOffset + 39, byte => decodeRateLinear(byte, 127), decodePitchLevel)
    return {
        line: {
            wave1: panelWave(wave1Bits, window),
            wave2: wave2On ? panelWave(wave2Bits, window) + 1 : 0,
            dcwKeyFollow, dcaKeyFollow, pitchEnv, dcwEnv, dcaEnv
        },
        modulation
    }
}

const encodeLine = (out: Uint8Array, waveOffset: int, blockOffset: int, line: CzLine, modulation: int): void => {
    const wave2 = line.wave2 > 0 ? line.wave2 - 1 : 0
    const window1 = WINDOW_OF_WAVE[line.wave1]
    const window = window1 !== 0 ? window1 : line.wave2 > 0 ? WINDOW_OF_WAVE[wave2] : 0
    const modulationBits = modulation === 1 ? 0b100 : modulation === 2 ? 0b011 : 0
    out[waveOffset] = (WAVE_BITS[line.wave1] << 5) | (WAVE_BITS[wave2] << 2) | (line.wave2 > 0 ? 0b10 : 0)
    out[waveOffset + 1] = (modulationBits << 3) | window
    out[blockOffset] = line.dcaKeyFollow
    out[blockOffset + 1] = DCA_KEY_FOLLOW_SECOND[line.dcaKeyFollow] ?? 0
    out[blockOffset + 2] = line.dcwKeyFollow
    out[blockOffset + 3] = DCW_KEY_FOLLOW_SECOND[line.dcwKeyFollow] ?? 0
    encodeEnvelope(out, blockOffset + 4, blockOffset + 5, line.dcaEnv, value => encodeRateLinear(value, 119), encodeLevel)
    encodeEnvelope(out, blockOffset + 21, blockOffset + 22, line.dcwEnv, encodeDcwRate, encodeLevel)
    encodeEnvelope(out, blockOffset + 38, blockOffset + 39, line.pitchEnv, value => encodeRateLinear(value, 127), encodePitchLevel)
}

const DCA_KEY_FOLLOW_SECOND: ReadonlyArray<int> = [0x00, 0x08, 0x11, 0x1A, 0x24, 0x2F, 0x3A, 0x45, 0x52, 0x5F]
const DCW_KEY_FOLLOW_SECOND: ReadonlyArray<int> = [0x00, 0x1F, 0x2C, 0x39, 0x46, 0x53, 0x60, 0x6E, 0x92, 0xFF]

// The vibrato triples' 2nd+3rd bytes for the table ranges (the 1st byte is always the panel value).
// Below the table range: delay v<32 -> (0, v); rate v<25 -> 16-bit (v+1)*0x20; depth v<32 -> (0, v+1).
const VIBRATO_DELAY_TAIL: ReadonlyArray<int> = [ // 32..99, 16-bit (2nd byte << 8 | 3rd byte)
    0x0021, 0x0023, 0x0025, 0x0027, 0x0029, 0x002B, 0x002D, 0x002F, 0x0031, 0x0033, 0x0035, 0x0037,
    0x0039, 0x003B, 0x003D, 0x003F, 0x0043, 0x0047, 0x004B, 0x004F, 0x0053, 0x0057, 0x005B, 0x005F,
    0x0063, 0x0067, 0x006B, 0x006F, 0x0073, 0x0077, 0x007B, 0x007F, 0x0087, 0x008F, 0x0097, 0x009F,
    0x00A7, 0x00AF, 0x00B7, 0x00BF, 0x00C7, 0x00CF, 0x00D7, 0x00DF, 0x00E7, 0x00EF, 0x00F7, 0x00FF,
    0x010F, 0x011F, 0x012F, 0x013F, 0x014F, 0x015F, 0x016F, 0x017F, 0x018F, 0x019F, 0x01AF, 0x01BF,
    0x01CF, 0x01DF, 0x01EF, 0x01FF, 0x021F, 0x023F, 0x025F, 0x027F
]
const VIBRATO_RATE_TAIL: ReadonlyArray<int> = [ // 25..99
    0x0340, 0x0360, 0x0380, 0x03A0, 0x03C0, 0x03E0, 0x0400, 0x0460, 0x04A0, 0x04E0, 0x0520, 0x0560,
    0x05A0, 0x05E0, 0x0620, 0x0660, 0x06A0, 0x06E0, 0x0720, 0x0760, 0x07A0, 0x07E0, 0x0820, 0x08E0,
    0x0960, 0x09E0, 0x0A60, 0x0AE0, 0x0B60, 0x0BE0, 0x0C60, 0x0CE0, 0x0D60, 0x0DE0, 0x0E60, 0x0EE0,
    0x0F60, 0x0FE0, 0x1060, 0x11E0, 0x12E0, 0x13E0, 0x14E0, 0x15E0, 0x16E0, 0x17E0, 0x18E0, 0x19E0,
    0x1AE0, 0x1BE0, 0x1CE0, 0x1DE0, 0x1EE0, 0x1FE0, 0x20E0, 0x23E0, 0x25E0, 0x27E0, 0x29E0, 0x2BE0,
    0x2DE0, 0x2FE0, 0x31E0, 0x33E0, 0x35E0, 0x37E0, 0x39E0, 0x3BE0, 0x3DE0, 0x3FE0, 0x41E0, 0x47E0,
    0x4BE0, 0x4FE0, 0x53E0
]
const VIBRATO_DEPTH_TAIL: ReadonlyArray<int> = [ // 32..99
    0x0023, 0x0025, 0x0027, 0x0029, 0x002B, 0x002D, 0x002F, 0x0031, 0x0033, 0x0035, 0x0037, 0x0039,
    0x003B, 0x003D, 0x003F, 0x0041, 0x0047, 0x004B, 0x004F, 0x0053, 0x0057, 0x005B, 0x005F, 0x0063,
    0x0067, 0x006B, 0x006F, 0x0073, 0x0077, 0x007B, 0x007F, 0x0083, 0x008F, 0x0097, 0x009F, 0x00A7,
    0x00AF, 0x00B7, 0x00BF, 0x00C7, 0x00CF, 0x00D7, 0x00DF, 0x00E7, 0x00EF, 0x00F7, 0x00FF, 0x0107,
    0x011F, 0x012F, 0x013F, 0x014F, 0x015F, 0x016F, 0x017F, 0x018F, 0x019F, 0x01AF, 0x01BF, 0x01CF,
    0x01DF, 0x01EF, 0x01FF, 0x020F, 0x023F, 0x025F, 0x027F, 0x0300
]

const vibratoTriple = (value: int, kind: "delay" | "rate" | "depth"): [int, int, int] => {
    if (kind === "rate") {
        const wide = value < 25 ? (value + 1) * 0x20 : VIBRATO_RATE_TAIL[value - 25]
        return [value, (wide >> 8) & 0xFF, wide & 0xFF]
    }
    if (value < 32) {
        return [value, 0, kind === "delay" ? value : value + 1]
    }
    const wide = (kind === "delay" ? VIBRATO_DELAY_TAIL : VIBRATO_DEPTH_TAIL)[value - 32]
    return [value, (wide >> 8) & 0xFF, wide & 0xFF]
}

export namespace CzSysex {
    export const isToneDump = (bytes: Uint8Array): boolean => {
        if (bytes.length < TONE_BYTES * 2 + 2) {return false}
        return bytes[0] === 0xF0 && bytes[1] === 0x44 && bytes[bytes.length - 1] === 0xF7
    }

    export const decode = (bytes: Uint8Array): CzTone => {
        if (!isToneDump(bytes)) {throw new Error("Not a Casio CZ tone dump")}
        const nibbleStart = bytes.length - 1 - TONE_BYTES * 2
        const data = new Uint8Array(TONE_BYTES)
        for (let index = 0; index < TONE_BYTES; index++) {
            const low = bytes[nibbleStart + index * 2] & 0x0F
            const high = bytes[nibbleStart + index * 2 + 1] & 0x0F
            data[index] = (high << 4) | low
        }
        const lineSelect = data[0] & 0x03
        const octaveBits = (data[0] >> 2) & 0x03
        const octave = octaveBits === 1 ? 1 : octaveBits === 2 ? -1 : 0
        const sign = (data[1] & 0x01) !== 0 ? -1 : 1
        const fine = ((data[2] >> 4) & 0x0F) * 15 + (data[2] & 0x0F)
        const octaveNote = data[3] & 0x3F
        const detuneNote = sign * Math.min(octaveNote, 47)
        const detuneFine = sign * Math.min(fine, 60)
        const vibratoWave = Math.max(VIBRATO_WAVE_BYTES.indexOf(data[4]), 0)
        const vibratoDelay = Math.min(data[5], 99)
        const vibratoRate = Math.min(data[8], 99)
        const vibratoDepth = Math.min(data[11], 99)
        const first = decodeLine(data, 14, 16, true)
        const second = decodeLine(data, 71, 73, false)
        return {
            lineSelect, modulation: first.modulation, octave, detuneNote, detuneFine,
            vibratoWave, vibratoDelay, vibratoRate, vibratoDepth,
            lines: [first.line, second.line]
        }
    }

    export const encode = (tone: CzTone, channel: int = 0, program: int = 0x60): Uint8Array => {
        const data = new Uint8Array(TONE_BYTES)
        const octaveBits = tone.octave > 0 ? 1 : tone.octave < 0 ? 2 : 0
        data[0] = (octaveBits << 2) | (tone.lineSelect & 0x03)
        data[1] = tone.detuneNote < 0 || tone.detuneFine < 0 ? 0x01 : 0x00
        // FINE ranges: 0..15 -> 00..0F (16 entries), then 15-wide ranges 11..1F, 21..2F, 31..3F.
        const fine = Math.min(Math.abs(tone.detuneFine), 60)
        data[2] = fine <= 15 ? fine : ((Math.floor((fine - 16) / 15) + 1) << 4) | ((fine - 16) % 15 + 1)
        data[3] = Math.min(Math.abs(tone.detuneNote), 47)
        data[4] = VIBRATO_WAVE_BYTES[tone.vibratoWave] ?? 0x08
        const [delay1, delay2, delay3] = vibratoTriple(tone.vibratoDelay, "delay")
        data.set([delay1, delay2, delay3], 5)
        const [rate1, rate2, rate3] = vibratoTriple(tone.vibratoRate, "rate")
        data.set([rate1, rate2, rate3], 8)
        const [depth1, depth2, depth3] = vibratoTriple(tone.vibratoDepth, "depth")
        data.set([depth1, depth2, depth3], 11)
        encodeLine(data, 14, 16, tone.lines[0], tone.modulation)
        encodeLine(data, 71, 73, tone.lines[1], 0)
        const bytes = new Uint8Array(7 + TONE_BYTES * 2 + 1)
        bytes.set([0xF0, 0x44, 0x00, 0x00, 0x70 | (channel & 0x0F), 0x20, program], 0)
        for (let index = 0; index < TONE_BYTES; index++) {
            bytes[7 + index * 2] = data[index] & 0x0F
            bytes[7 + index * 2 + 1] = (data[index] >> 4) & 0x0F
        }
        bytes[bytes.length - 1] = 0xF7
        return bytes
    }
}
