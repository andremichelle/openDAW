// Builds the Tubular Classics cartridge: 32 original voices in the classic DX7 styles (tine pianos,
// bells, basses, brass, strings, mallets, organs, leads, drums). Writes the .syx into the studio's bundled
// cartridges and refreshes its index entry.
//   npx tsx packages/studio/adapters/scripts/tubular-classics.mts
import {readFileSync, writeFileSync} from "fs"
import {Dx7Sysex} from "../src/devices/instruments/Tubular/Dx7Sysex"

const OUT_DIR = `${import.meta.dirname}/../../../app/studio/public/tubular`
const FILE = "Tubular_Classics.syx"

type Env = {r: [number, number, number, number], l: [number, number, number, number]}
type Op = {
    env: Env, out: number, coarse: number, fine?: number, detune?: number, fixed?: boolean,
    brk?: number, ld?: number, rd?: number, lc?: number, rc?: number, rs?: number, ams?: number, kvs?: number
}
type Voice = {
    name: string, algo: number, fb: number, oks?: boolean,
    lfo?: {speed?: number, delay?: number, pmd?: number, amd?: number, sync?: boolean, wave?: number},
    pms?: number, transpose?: number, peg?: Env,
    ops: [Op, Op, Op, Op, Op, Op] // OP1..OP6, panel order
}

// Break points: A-1 = 0, C1 = 15, C2 = 27, C3 = 39, C4 = 51. Curves: 0 -LIN, 1 -EXP, 2 +EXP, 3 +LIN.
const C3 = 39
const env = (r: Env["r"], l: Env["l"]): Env => ({r, l})
const sustain = (attack: number, release: number, level = 99): Env => env([attack, 99, 99, release], [99, level, level, 0])
const flatPeg: Env = env([99, 99, 99, 99], [50, 50, 50, 50])
const op = (partial: Partial<Op> & {env: Env, out: number, coarse: number}): Op => partial

const encode = (voice: Voice): Uint8Array => {
    const data = new Uint8Array(Dx7Sysex.PATCH_SIZE)
    voice.ops.forEach((operator, panel) => {
        const o = (5 - panel) * 21
        data.set(operator.env.r, o)
        data.set(operator.env.l, o + 4)
        data[o + 8] = operator.brk ?? C3
        data[o + 9] = operator.ld ?? 0
        data[o + 10] = operator.rd ?? 0
        data[o + 11] = operator.lc ?? 0
        data[o + 12] = operator.rc ?? 0
        data[o + 13] = operator.rs ?? 0
        data[o + 14] = operator.ams ?? 0
        data[o + 15] = operator.kvs ?? 0
        data[o + 16] = operator.out
        data[o + 17] = operator.fixed === true ? 1 : 0
        data[o + 18] = operator.coarse
        data[o + 19] = operator.fine ?? 0
        data[o + 20] = operator.detune ?? 7
    })
    const peg = voice.peg ?? flatPeg
    data.set(peg.r, 126)
    data.set(peg.l, 130)
    data[134] = voice.algo - 1
    data[135] = voice.fb
    data[136] = voice.oks === false ? 0 : 1
    data[137] = voice.lfo?.speed ?? 35
    data[138] = voice.lfo?.delay ?? 0
    data[139] = voice.lfo?.pmd ?? 0
    data[140] = voice.lfo?.amd ?? 0
    data[141] = voice.lfo?.sync === false ? 0 : 1
    data[142] = voice.lfo?.wave ?? 0
    data[143] = voice.pms ?? 3
    data[144] = voice.transpose ?? 24
    return Dx7Sysex.withName(data, voice.name)
}

// Rates measured on the engine (time to -60 dB from full): R30 8.5s, R35 5s, R40 3s, R45 1.9s, R50 0.9s,
// R55 0.55s, R60 0.3s, R65 0.2s, R70 0.12s. Attack to full: R30 1.5s, R40 0.5s, R50 0.17s, R60 50ms.

// ---- Electric pianos (algorithm 5: three 1:1 carrier/modulator pairs, one modulator at 14:1 for the tine,
// feedback on OP6). The modulators keep almost the carriers' envelope, so the harmonics stay with the note
// instead of dying first; the tine settles to a lower level and rings on. Modulators carry the velocity. ----
const carrier = (detune: number, attack = 95): Op =>
    op({env: env([attack, 28, 27, 62], [99, 85, 0, 0]), out: 99, coarse: 1, detune, kvs: 2, rd: 15, rc: 0})
const rhodes: Voice = {
    name: "Rhodes", algo: 5, fb: 6, lfo: {speed: 34, delay: 33}, pms: 3,
    ops: [
        carrier(7),
        op({env: env([98, 50, 35, 70], [99, 72, 0, 0]), out: 58, coarse: 14, kvs: 6, rd: 55, rc: 0, rs: 3}),
        carrier(10),
        op({env: env([96, 30, 22, 55], [99, 94, 0, 0]), out: 88, coarse: 1, kvs: 6, rd: 25, rc: 0, rs: 3}),
        carrier(4),
        op({env: env([96, 30, 22, 55], [99, 94, 0, 0]), out: 78, coarse: 1, detune: 9, kvs: 7, rd: 25, rc: 0, rs: 3})
    ]
}
const softRhodes: Voice = {
    name: "Soft Rhds", algo: 5, fb: 5, lfo: {speed: 34, delay: 33}, pms: 3,
    ops: [
        carrier(7, 90),
        op({env: env([96, 48, 34, 70], [99, 66, 0, 0]), out: 46, coarse: 14, kvs: 7, rd: 65, rc: 0, rs: 3}),
        carrier(10, 90),
        op({env: env([94, 30, 22, 55], [99, 92, 0, 0]), out: 79, coarse: 1, kvs: 6, rd: 30, rc: 0, rs: 3}),
        carrier(4, 90),
        op({env: env([94, 30, 22, 55], [99, 92, 0, 0]), out: 68, coarse: 1, detune: 9, kvs: 7, rd: 30, rc: 0, rs: 3})
    ]
}
const brightRhodes: Voice = {
    name: "Brite Rhds", algo: 5, fb: 7, lfo: {speed: 34, delay: 33}, pms: 3,
    ops: [
        carrier(7, 99),
        op({env: env([99, 52, 36, 72], [99, 76, 0, 0]), out: 66, coarse: 14, kvs: 6, rd: 50, rc: 0, rs: 3}),
        carrier(10, 99),
        op({env: env([98, 32, 24, 58], [99, 95, 0, 0]), out: 92, coarse: 1, kvs: 7, rd: 20, rc: 0, rs: 3}),
        carrier(4, 99),
        op({env: env([98, 32, 24, 58], [99, 95, 0, 0]), out: 84, coarse: 1, detune: 9, kvs: 7, rd: 20, rc: 0, rs: 3})
    ]
}

// ---- Bells and mallets ----
const tubularBells: Voice = {
    name: "Tubular", algo: 5, fb: 5,
    ops: [
        op({env: env([99, 55, 30, 45], [99, 90, 0, 0]), out: 99, coarse: 1, kvs: 2}),
        op({env: env([99, 55, 36, 50], [99, 80, 0, 0]), out: 66, coarse: 3, fine: 50, kvs: 4, rd: 30, rc: 0}),
        op({env: env([99, 55, 31, 45], [99, 90, 0, 0]), out: 92, coarse: 1, fine: 41, detune: 9, kvs: 2}),
        op({env: env([99, 55, 38, 50], [99, 75, 0, 0]), out: 58, coarse: 5, kvs: 4, rd: 30, rc: 0}),
        op({env: env([99, 55, 33, 45], [99, 90, 0, 0]), out: 86, coarse: 2, detune: 5, kvs: 2}),
        op({env: env([99, 58, 42, 52], [99, 65, 0, 0]), out: 64, coarse: 7, kvs: 5, rd: 40, rc: 0})
    ]
}
const glassBell: Voice = {
    name: "Glass Bell", algo: 5, fb: 3,
    ops: [
        op({env: env([99, 55, 34, 48], [99, 88, 0, 0]), out: 99, coarse: 1, kvs: 2}),
        op({env: env([99, 58, 42, 52], [99, 70, 0, 0]), out: 56, coarse: 7, kvs: 5, rd: 35, rc: 0}),
        op({env: env([99, 55, 34, 48], [99, 88, 0, 0]), out: 90, coarse: 2, detune: 9, kvs: 2}),
        op({env: env([99, 58, 44, 52], [99, 65, 0, 0]), out: 50, coarse: 9, kvs: 5, rd: 35, rc: 0}),
        op({env: env([99, 55, 34, 48], [99, 88, 0, 0]), out: 82, coarse: 4, detune: 5, kvs: 2}),
        op({env: env([99, 60, 48, 55], [99, 55, 0, 0]), out: 46, coarse: 11, kvs: 6, rd: 45, rc: 0})
    ]
}
const celesta: Voice = {
    name: "Celesta", algo: 5, fb: 2,
    ops: [
        op({env: env([99, 60, 44, 55], [99, 80, 0, 0]), out: 99, coarse: 1, kvs: 2}),
        op({env: env([99, 62, 56, 60], [99, 55, 0, 0]), out: 54, coarse: 4, kvs: 4, rd: 40, rc: 0}),
        op({env: env([99, 60, 44, 55], [99, 80, 0, 0]), out: 88, coarse: 2, kvs: 2}),
        op({env: env([99, 62, 58, 60], [99, 50, 0, 0]), out: 48, coarse: 8, kvs: 5, rd: 50, rc: 0}),
        op({env: env([99, 60, 46, 55], [99, 75, 0, 0]), out: 70, coarse: 4, detune: 8, kvs: 2}),
        op({env: env([99, 65, 62, 62], [99, 40, 0, 0]), out: 40, coarse: 12, kvs: 6, rd: 50, rc: 0})
    ]
}
const marimba: Voice = {
    name: "Marimba", algo: 5, fb: 4,
    ops: [
        op({env: env([99, 65, 47, 62], [99, 80, 0, 0]), out: 99, coarse: 1, kvs: 3, rd: 30, rc: 0}),
        op({env: env([99, 68, 62, 68], [99, 45, 0, 0]), out: 70, coarse: 4, kvs: 6, rd: 40, rc: 0}),
        op({env: env([99, 65, 48, 62], [99, 78, 0, 0]), out: 84, coarse: 1, detune: 8, kvs: 3, rd: 30, rc: 0}),
        op({env: env([99, 70, 64, 68], [99, 40, 0, 0]), out: 64, coarse: 10, kvs: 6, rd: 50, rc: 0}),
        op({env: env([99, 66, 58, 65], [99, 55, 0, 0]), out: 58, coarse: 4, kvs: 3}),
        op({env: env([99, 75, 74, 75], [99, 30, 0, 0]), out: 56, coarse: 1, kvs: 7})
    ]
}
const vibes: Voice = {
    name: "Vibes", algo: 5, fb: 0, lfo: {speed: 48, amd: 45, wave: 0, sync: false},
    ops: [
        op({env: env([99, 55, 38, 50], [99, 88, 0, 0]), out: 99, coarse: 1, kvs: 2, ams: 2}),
        op({env: env([99, 60, 46, 55], [99, 60, 0, 0]), out: 56, coarse: 4, kvs: 5, rd: 40, rc: 0}),
        op({env: env([99, 55, 38, 50], [99, 88, 0, 0]), out: 90, coarse: 1, detune: 9, kvs: 2, ams: 2}),
        op({env: env([99, 60, 48, 55], [99, 55, 0, 0]), out: 48, coarse: 10, kvs: 5, rd: 40, rc: 0}),
        op({env: env([99, 55, 40, 50], [99, 85, 0, 0]), out: 76, coarse: 4, kvs: 2, ams: 2}),
        op({env: env([99, 62, 56, 58], [99, 45, 0, 0]), out: 42, coarse: 7, kvs: 6})
    ]
}
const steelDrum: Voice = {
    name: "Steel Drum", algo: 5, fb: 5,
    ops: [
        op({env: env([99, 60, 44, 55], [99, 78, 0, 0]), out: 99, coarse: 1, kvs: 3}),
        op({env: env([99, 62, 52, 58], [99, 62, 0, 0]), out: 72, coarse: 2, fine: 2, kvs: 6, rd: 30, rc: 0}),
        op({env: env([99, 60, 44, 55], [99, 78, 0, 0]), out: 88, coarse: 2, fine: 1, kvs: 3}),
        op({env: env([99, 62, 54, 58], [99, 58, 0, 0]), out: 64, coarse: 3, fine: 3, kvs: 6, rd: 30, rc: 0}),
        op({env: env([99, 60, 46, 55], [99, 75, 0, 0]), out: 72, coarse: 4, fine: 1, detune: 9, kvs: 3}),
        op({env: env([99, 64, 58, 60], [99, 45, 0, 0]), out: 58, coarse: 6, fine: 5, kvs: 6, rd: 30, rc: 0})
    ]
}

// ---- Basses ----
const slapBass: Voice = {
    name: "Slap Bass", algo: 16, fb: 6,
    ops: [
        op({env: env([99, 62, 42, 62], [99, 85, 0, 0]), out: 99, coarse: 1, kvs: 3, rd: 10, rc: 0}),
        op({env: env([99, 65, 50, 65], [99, 62, 0, 0]), out: 72, coarse: 1, kvs: 5, rd: 40, rc: 0}),
        op({env: env([99, 70, 66, 70], [99, 45, 0, 0]), out: 68, coarse: 2, kvs: 7, rd: 50, rc: 0}),
        op({env: env([99, 72, 68, 72], [99, 40, 0, 0]), out: 60, coarse: 1, kvs: 7, rd: 50, rc: 0}),
        op({env: env([99, 66, 55, 66], [99, 55, 0, 0]), out: 64, coarse: 0, kvs: 5, rd: 30, rc: 0}),
        op({env: env([99, 74, 72, 74], [99, 35, 0, 0]), out: 70, coarse: 1, kvs: 7, rd: 40, rc: 0})
    ]
}
const solidBass: Voice = {
    name: "Solid Bass", algo: 1, fb: 7,
    ops: [
        op({env: env([99, 62, 42, 62], [99, 86, 40, 0]), out: 99, coarse: 1, kvs: 2, rd: 15, rc: 0}),
        op({env: env([99, 64, 50, 64], [99, 66, 0, 0]), out: 74, coarse: 1, kvs: 5, rd: 40, rc: 0}),
        op({env: env([99, 62, 42, 62], [99, 86, 40, 0]), out: 92, coarse: 0, kvs: 2, rd: 15, rc: 0}),
        op({env: env([99, 66, 55, 66], [99, 58, 0, 0]), out: 68, coarse: 1, kvs: 5, rd: 40, rc: 0}),
        op({env: env([99, 68, 60, 68], [99, 48, 0, 0]), out: 58, coarse: 1, kvs: 6, rd: 45, rc: 0}),
        op({env: env([99, 72, 68, 72], [99, 38, 0, 0]), out: 64, coarse: 1, kvs: 7, rd: 45, rc: 0})
    ]
}
const synthBass: Voice = {
    name: "Synth Bass", algo: 5, fb: 7,
    ops: [
        op({env: env([99, 64, 50, 64], [99, 84, 60, 0]), out: 99, coarse: 0, kvs: 2}),
        op({env: env([99, 66, 58, 66], [99, 66, 0, 0]), out: 78, coarse: 0, kvs: 5, rd: 30, rc: 0}),
        op({env: env([99, 64, 50, 64], [99, 84, 60, 0]), out: 95, coarse: 1, kvs: 2}),
        op({env: env([99, 66, 60, 66], [99, 62, 0, 0]), out: 72, coarse: 1, kvs: 5, rd: 30, rc: 0}),
        op({env: env([99, 64, 50, 64], [99, 82, 58, 0]), out: 85, coarse: 1, detune: 9, kvs: 2}),
        op({env: env([99, 68, 64, 68], [99, 50, 0, 0]), out: 68, coarse: 1, kvs: 6, rd: 30, rc: 0})
    ]
}
const fretless: Voice = {
    name: "Fretless", algo: 1, fb: 5, lfo: {speed: 30, delay: 40, pmd: 12, sync: false, wave: 0}, pms: 3,
    ops: [
        op({env: env([80, 58, 42, 58], [99, 88, 0, 0]), out: 99, coarse: 1, kvs: 2}),
        op({env: env([78, 60, 46, 62], [99, 75, 0, 0]), out: 68, coarse: 1, kvs: 4, rd: 35, rc: 0}),
        op({env: env([80, 58, 42, 58], [99, 88, 0, 0]), out: 88, coarse: 0, kvs: 2}),
        op({env: env([78, 62, 50, 62], [99, 65, 0, 0]), out: 62, coarse: 1, kvs: 4, rd: 35, rc: 0}),
        op({env: env([78, 64, 56, 64], [99, 50, 0, 0]), out: 50, coarse: 2, kvs: 5, rd: 40, rc: 0}),
        op({env: env([99, 68, 64, 68], [99, 40, 0, 0]), out: 48, coarse: 1, kvs: 6, rd: 40, rc: 0})
    ]
}

// ---- Brass, strings, voices, winds ----
const brass: Voice = {
    name: "Brass Sect", algo: 22, fb: 6, lfo: {speed: 35, delay: 50, pmd: 10, sync: false, wave: 0}, pms: 3,
    ops: [
        op({env: env([58, 50, 99, 58], [99, 92, 92, 0]), out: 99, coarse: 1, kvs: 2}),
        op({env: env([52, 52, 99, 58], [99, 82, 82, 0]), out: 80, coarse: 1, kvs: 5, rd: 25, rc: 0}),
        op({env: env([58, 50, 99, 58], [99, 92, 92, 0]), out: 96, coarse: 1, detune: 10, kvs: 2}),
        op({env: env([58, 50, 99, 58], [99, 92, 92, 0]), out: 96, coarse: 1, detune: 4, kvs: 2}),
        op({env: env([58, 50, 99, 58], [99, 92, 92, 0]), out: 90, coarse: 2, kvs: 2}),
        op({env: env([50, 52, 99, 58], [99, 80, 80, 0]), out: 82, coarse: 1, kvs: 5, rd: 30, rc: 0})
    ]
}
const strings: Voice = {
    name: "Strings", algo: 2, fb: 4, lfo: {speed: 30, delay: 45, pmd: 14, sync: false, wave: 0}, pms: 3,
    ops: [
        op({env: env([42, 45, 99, 48], [99, 96, 96, 0]), out: 99, coarse: 1, kvs: 1}),
        op({env: env([40, 48, 99, 48], [99, 86, 86, 0]), out: 64, coarse: 1, kvs: 3, rd: 30, rc: 0}),
        op({env: env([40, 45, 99, 48], [99, 96, 96, 0]), out: 96, coarse: 1, detune: 10, kvs: 1}),
        op({env: env([40, 45, 99, 48], [99, 96, 96, 0]), out: 90, coarse: 2, detune: 4, kvs: 1}),
        op({env: env([38, 48, 99, 48], [99, 80, 80, 0]), out: 60, coarse: 2, kvs: 3, rd: 30, rc: 0}),
        op({env: env([38, 48, 99, 48], [99, 70, 70, 0]), out: 56, coarse: 1, detune: 9, kvs: 3, rd: 30, rc: 0})
    ]
}
const analogPad: Voice = {
    name: "Analog Pad", algo: 2, fb: 6, lfo: {speed: 25, delay: 60, pmd: 8, sync: false, wave: 0}, pms: 2,
    ops: [
        op({env: env([34, 45, 99, 44], [99, 96, 96, 0]), out: 99, coarse: 1, kvs: 0}),
        op({env: env([34, 45, 99, 44], [99, 90, 90, 0]), out: 58, coarse: 1, kvs: 2, rd: 25, rc: 0}),
        op({env: env([32, 45, 99, 44], [99, 96, 96, 0]), out: 96, coarse: 1, detune: 11, kvs: 0}),
        op({env: env([32, 45, 99, 44], [99, 96, 96, 0]), out: 90, coarse: 0, detune: 5, kvs: 0}),
        op({env: env([30, 48, 99, 44], [99, 72, 72, 0]), out: 56, coarse: 1, kvs: 2, rd: 25, rc: 0}),
        op({env: env([30, 48, 99, 44], [99, 72, 72, 0]), out: 60, coarse: 1, detune: 3, kvs: 2, rd: 25, rc: 0})
    ]
}
const choir: Voice = {
    name: "Choir", algo: 2, fb: 0, lfo: {speed: 28, delay: 60, pmd: 10, sync: false, wave: 0}, pms: 3,
    ops: [
        op({env: env([42, 45, 99, 46], [99, 96, 96, 0]), out: 99, coarse: 1, kvs: 1}),
        op({env: env([40, 48, 99, 46], [99, 86, 86, 0]), out: 56, coarse: 2, kvs: 2, rd: 40, rc: 0}),
        op({env: env([40, 45, 99, 46], [99, 96, 96, 0]), out: 94, coarse: 1, detune: 10, kvs: 1}),
        op({env: env([40, 45, 99, 46], [99, 96, 96, 0]), out: 84, coarse: 2, detune: 5, kvs: 1}),
        op({env: env([38, 48, 99, 46], [99, 76, 76, 0]), out: 50, coarse: 3, kvs: 2, rd: 45, rc: 0}),
        op({env: env([38, 48, 99, 46], [99, 62, 62, 0]), out: 44, coarse: 5, kvs: 2, rd: 50, rc: 0})
    ]
}
const flute: Voice = {
    name: "Flute", algo: 1, fb: 0, lfo: {speed: 36, delay: 55, pmd: 12, sync: false, wave: 0}, pms: 3,
    ops: [
        op({env: env([56, 55, 99, 58], [99, 94, 94, 0]), out: 99, coarse: 1, kvs: 2}),
        op({env: env([60, 58, 99, 58], [99, 72, 72, 0]), out: 48, coarse: 1, kvs: 4, rd: 40, rc: 0}),
        op({env: env([99, 62, 60, 65], [99, 50, 0, 0]), out: 50, coarse: 4, kvs: 5}),
        op({env: env([99, 64, 64, 65], [99, 45, 0, 0]), out: 38, coarse: 7, kvs: 5}),
        op({env: env([99, 66, 66, 65], [99, 40, 0, 0]), out: 32, coarse: 11, kvs: 5}),
        op({env: env([99, 68, 68, 65], [99, 35, 0, 0]), out: 28, coarse: 16, kvs: 5})
    ]
}
const harmonica: Voice = {
    name: "Harmonica", algo: 1, fb: 5, lfo: {speed: 34, delay: 50, pmd: 10, sync: false, wave: 0}, pms: 3,
    ops: [
        op({env: env([62, 55, 99, 58], [99, 94, 94, 0]), out: 99, coarse: 1, kvs: 2}),
        op({env: env([58, 58, 99, 58], [99, 84, 84, 0]), out: 70, coarse: 2, kvs: 4, rd: 30, rc: 0}),
        op({env: env([62, 55, 99, 58], [99, 92, 92, 0]), out: 90, coarse: 1, detune: 9, kvs: 2}),
        op({env: env([56, 58, 99, 58], [99, 82, 82, 0]), out: 64, coarse: 1, kvs: 4, rd: 30, rc: 0}),
        op({env: env([56, 58, 99, 58], [99, 72, 72, 0]), out: 56, coarse: 3, kvs: 4}),
        op({env: env([56, 58, 99, 58], [99, 66, 66, 0]), out: 58, coarse: 1, kvs: 5})
    ]
}

// ---- Keys, organs, plucks ----
const clav: Voice = {
    name: "Clav", algo: 3, fb: 6,
    ops: [
        op({env: env([99, 62, 45, 64], [99, 84, 0, 0]), out: 99, coarse: 1, kvs: 3, rd: 20, rc: 0}),
        op({env: env([99, 66, 58, 66], [99, 60, 0, 0]), out: 76, coarse: 1, kvs: 6, rd: 45, rc: 0}),
        op({env: env([99, 62, 45, 64], [99, 84, 0, 0]), out: 90, coarse: 2, kvs: 3, rd: 20, rc: 0}),
        op({env: env([99, 68, 60, 66], [99, 55, 0, 0]), out: 68, coarse: 3, kvs: 6, rd: 50, rc: 0}),
        op({env: env([99, 70, 64, 68], [99, 45, 0, 0]), out: 60, coarse: 5, kvs: 6, rd: 50, rc: 0}),
        op({env: env([99, 74, 72, 72], [99, 35, 0, 0]), out: 64, coarse: 1, kvs: 7, rd: 50, rc: 0})
    ]
}
const harpsichord: Voice = {
    name: "Harpsichrd", algo: 5, fb: 7,
    ops: [
        op({env: env([99, 62, 46, 62], [99, 78, 0, 0]), out: 99, coarse: 1, kvs: 1}),
        op({env: env([99, 64, 50, 64], [99, 70, 0, 0]), out: 78, coarse: 3, kvs: 3, rd: 30, rc: 0}),
        op({env: env([99, 62, 46, 62], [99, 78, 0, 0]), out: 92, coarse: 2, kvs: 1}),
        op({env: env([99, 64, 52, 64], [99, 66, 0, 0]), out: 72, coarse: 5, kvs: 3, rd: 35, rc: 0}),
        op({env: env([99, 62, 48, 62], [99, 72, 0, 0]), out: 80, coarse: 4, kvs: 1}),
        op({env: env([99, 66, 56, 66], [99, 58, 0, 0]), out: 70, coarse: 1, kvs: 4, rd: 40, rc: 0})
    ]
}
const drawbars: Voice = {
    name: "Drawbars", algo: 32, fb: 0, lfo: {speed: 55, amd: 12, wave: 0, sync: false},
    ops: [
        op({env: sustain(99, 75), out: 99, coarse: 1, ams: 1}),
        op({env: sustain(99, 75), out: 92, coarse: 2, ams: 1}),
        op({env: sustain(99, 75), out: 86, coarse: 0, ams: 1}),
        op({env: sustain(99, 75), out: 82, coarse: 3, ams: 1}),
        op({env: sustain(99, 75), out: 74, coarse: 4, ams: 1}),
        op({env: env([99, 62, 99, 75], [99, 0, 0, 0]), out: 84, coarse: 4, kvs: 2})
    ]
}
const pipeOrgan: Voice = {
    name: "Pipe Organ", algo: 32, fb: 0,
    ops: [
        op({env: sustain(70, 60), out: 99, coarse: 1}),
        op({env: sustain(68, 60), out: 90, coarse: 2}),
        op({env: sustain(66, 60), out: 84, coarse: 0}),
        op({env: sustain(64, 60), out: 78, coarse: 4}),
        op({env: sustain(62, 60), out: 70, coarse: 3}),
        op({env: sustain(60, 60), out: 62, coarse: 8})
    ]
}
const harp: Voice = {
    name: "Harp", algo: 5, fb: 4,
    ops: [
        op({env: env([99, 58, 42, 55], [99, 86, 0, 0]), out: 99, coarse: 1, kvs: 3}),
        op({env: env([99, 62, 55, 60], [99, 55, 0, 0]), out: 60, coarse: 3, kvs: 6, rd: 40, rc: 0}),
        op({env: env([99, 58, 42, 55], [99, 86, 0, 0]), out: 88, coarse: 2, kvs: 3}),
        op({env: env([99, 64, 58, 60], [99, 48, 0, 0]), out: 52, coarse: 5, kvs: 6, rd: 45, rc: 0}),
        op({env: env([99, 58, 44, 55], [99, 82, 0, 0]), out: 72, coarse: 1, detune: 9, kvs: 3}),
        op({env: env([99, 66, 62, 62], [99, 40, 0, 0]), out: 56, coarse: 8, kvs: 6, rd: 50, rc: 0})
    ]
}
const nylonGuitar: Voice = {
    name: "Nylon Gtr", algo: 1, fb: 5,
    ops: [
        op({env: env([99, 60, 45, 58], [99, 84, 0, 0]), out: 99, coarse: 1, kvs: 3}),
        op({env: env([99, 62, 56, 62], [99, 62, 0, 0]), out: 70, coarse: 1, kvs: 6, rd: 40, rc: 0}),
        op({env: env([99, 60, 46, 58], [99, 80, 0, 0]), out: 84, coarse: 2, kvs: 3}),
        op({env: env([99, 64, 58, 62], [99, 58, 0, 0]), out: 64, coarse: 3, kvs: 6, rd: 45, rc: 0}),
        op({env: env([99, 66, 62, 64], [99, 48, 0, 0]), out: 56, coarse: 1, kvs: 6}),
        op({env: env([99, 70, 68, 68], [99, 35, 0, 0]), out: 60, coarse: 4, kvs: 7})
    ]
}

// ---- Leads and synths ----
const squareLead: Voice = {
    name: "Square Ld", algo: 1, fb: 7, lfo: {speed: 38, delay: 50, pmd: 14, sync: false, wave: 0}, pms: 3,
    ops: [
        op({env: env([99, 60, 99, 60], [99, 92, 92, 0]), out: 99, coarse: 1, kvs: 2}),
        op({env: env([99, 62, 99, 60], [99, 85, 85, 0]), out: 78, coarse: 2, kvs: 3}),
        op({env: env([99, 60, 99, 60], [99, 92, 92, 0]), out: 90, coarse: 1, detune: 10, kvs: 2}),
        op({env: env([99, 62, 99, 60], [99, 85, 85, 0]), out: 70, coarse: 2, kvs: 3}),
        op({env: env([99, 62, 99, 60], [99, 70, 70, 0]), out: 60, coarse: 1, kvs: 3}),
        op({env: env([99, 62, 99, 60], [99, 60, 60, 0]), out: 72, coarse: 1, kvs: 3})
    ]
}
const brightLead: Voice = {
    name: "Bright Ld", algo: 16, fb: 7, lfo: {speed: 40, delay: 45, pmd: 16, sync: false, wave: 0}, pms: 4,
    ops: [
        op({env: env([99, 58, 99, 58], [99, 92, 92, 0]), out: 99, coarse: 1, kvs: 2}),
        op({env: env([99, 60, 99, 58], [99, 80, 80, 0]), out: 76, coarse: 1, kvs: 3}),
        op({env: env([99, 60, 99, 58], [99, 75, 75, 0]), out: 70, coarse: 2, kvs: 3}),
        op({env: env([99, 62, 99, 58], [99, 60, 60, 0]), out: 58, coarse: 3, kvs: 4}),
        op({env: env([99, 60, 99, 58], [99, 70, 70, 0]), out: 66, coarse: 1, detune: 10, kvs: 3}),
        op({env: env([99, 64, 99, 58], [99, 55, 55, 0]), out: 72, coarse: 1, kvs: 4})
    ]
}
const syncLead: Voice = {
    name: "FM Lead", algo: 7, fb: 7, lfo: {speed: 36, delay: 45, pmd: 12, sync: false, wave: 0}, pms: 3,
    ops: [
        op({env: env([99, 60, 99, 60], [99, 90, 90, 0]), out: 99, coarse: 1, kvs: 2}),
        op({env: env([99, 62, 99, 60], [99, 75, 75, 0]), out: 74, coarse: 1, kvs: 4}),
        op({env: env([99, 60, 99, 60], [99, 90, 90, 0]), out: 92, coarse: 1, detune: 9, kvs: 2}),
        op({env: env([99, 62, 99, 60], [99, 75, 75, 0]), out: 68, coarse: 2, kvs: 4}),
        op({env: env([99, 62, 99, 60], [99, 70, 70, 0]), out: 62, coarse: 3, kvs: 4}),
        op({env: env([99, 64, 99, 60], [99, 60, 60, 0]), out: 70, coarse: 1, kvs: 5})
    ]
}
const bellPad: Voice = {
    name: "Bell Pad", algo: 5, fb: 2, lfo: {speed: 26, delay: 50, pmd: 6, sync: false, wave: 0}, pms: 2,
    ops: [
        op({env: env([42, 50, 99, 45], [99, 92, 92, 0]), out: 99, coarse: 1, kvs: 1}),
        op({env: env([99, 55, 40, 48], [99, 65, 0, 0]), out: 54, coarse: 7, kvs: 4, rd: 40, rc: 0}),
        op({env: env([40, 50, 99, 45], [99, 92, 92, 0]), out: 94, coarse: 1, detune: 10, kvs: 1}),
        op({env: env([40, 52, 99, 45], [99, 68, 68, 0]), out: 50, coarse: 2, kvs: 3, rd: 30, rc: 0}),
        op({env: env([40, 50, 99, 45], [99, 92, 92, 0]), out: 88, coarse: 2, detune: 4, kvs: 1}),
        op({env: env([99, 58, 42, 48], [99, 55, 0, 0]), out: 46, coarse: 11, kvs: 4, rd: 45, rc: 0})
    ]
}

// ---- Drums ----
const bassDrum: Voice = {
    name: "Bass Drum", algo: 5, fb: 0, peg: env([99, 60, 99, 99], [66, 50, 50, 50]),
    ops: [
        op({env: env([99, 62, 56, 70], [99, 78, 0, 0]), out: 99, coarse: 0, kvs: 2}),
        op({env: env([99, 70, 70, 75], [99, 45, 0, 0]), out: 76, coarse: 0, kvs: 4}),
        op({env: env([99, 64, 58, 70], [99, 70, 0, 0]), out: 80, coarse: 0, fine: 50, kvs: 2}),
        op({env: env([99, 74, 74, 78], [99, 35, 0, 0]), out: 88, coarse: 1, fixed: true, kvs: 3}),
        op({env: env([99, 72, 72, 76], [99, 35, 0, 0]), out: 58, coarse: 2, kvs: 3}),
        op({env: env([99, 78, 78, 80], [99, 25, 0, 0]), out: 74, coarse: 3, kvs: 5})
    ]
}
const snare: Voice = {
    name: "Snare", algo: 32, fb: 7,
    ops: [
        op({env: env([99, 66, 62, 70], [99, 60, 0, 0]), out: 99, coarse: 1, fixed: true, fine: 80, kvs: 2}),
        op({env: env([99, 68, 64, 72], [99, 55, 0, 0]), out: 90, coarse: 1, fixed: true, fine: 20, kvs: 2}),
        op({env: env([99, 70, 66, 72], [99, 50, 0, 0]), out: 80, coarse: 2, fixed: true, fine: 50, kvs: 2}),
        op({env: env([99, 72, 68, 74], [99, 40, 0, 0]), out: 70, coarse: 2, fixed: true, fine: 90, kvs: 3}),
        op({env: env([99, 70, 66, 74], [99, 45, 0, 0]), out: 74, coarse: 3, fixed: true, fine: 30, kvs: 3}),
        op({env: env([99, 66, 63, 70], [99, 55, 0, 0]), out: 96, coarse: 3, fixed: true, fine: 95, kvs: 3})
    ]
}
const timpani: Voice = {
    name: "Timpani", algo: 5, fb: 3, peg: env([99, 70, 99, 99], [56, 50, 50, 50]),
    ops: [
        op({env: env([99, 60, 46, 62], [99, 84, 0, 0]), out: 99, coarse: 0, kvs: 2}),
        op({env: env([99, 66, 56, 66], [99, 55, 0, 0]), out: 68, coarse: 1, fine: 50, kvs: 5}),
        op({env: env([99, 60, 48, 62], [99, 80, 0, 0]), out: 88, coarse: 1, kvs: 2}),
        op({env: env([99, 68, 60, 68], [99, 45, 0, 0]), out: 60, coarse: 2, fine: 30, kvs: 5}),
        op({env: env([99, 62, 54, 64], [99, 68, 0, 0]), out: 70, coarse: 1, fine: 40, kvs: 2}),
        op({env: env([99, 74, 72, 74], [99, 35, 0, 0]), out: 64, coarse: 5, kvs: 6})
    ]
}

const bank: ReadonlyArray<Voice> = [
    rhodes, softRhodes, brightRhodes,
    tubularBells, glassBell, celesta, marimba, vibes, steelDrum,
    slapBass, solidBass, synthBass, fretless,
    brass, strings, analogPad, choir, flute, harmonica,
    clav, harpsichord, drawbars, pipeOrgan, harp, nylonGuitar,
    squareLead, brightLead, syncLead, bellPad,
    bassDrum, snare, timpani
]
if (bank.length !== 32) {
    throw new Error(`a cartridge holds 32 voices, got ${bank.length}`)
}
const bytes = Dx7Sysex.encodeBank(bank.map(encode))
writeFileSync(`${OUT_DIR}/cartridges/${FILE}`, bytes)
const index = JSON.parse(readFileSync(`${OUT_DIR}/index.json`, "utf8"))
const entry = {
    name: "Tubular Classics", file: FILE, author: "openDAW", credit: "openDAW",
    license: "CC0", source: "https://github.com/andremichelle/openDAW/blob/main/packages/studio/adapters/scripts/tubular-classics.mts",
    voices: bank.map(voice => voice.name)
}
index.cartridges = [entry, ...index.cartridges.filter((cartridge: {file: string}) => cartridge.file !== FILE)]
writeFileSync(`${OUT_DIR}/index.json`, JSON.stringify(index, null, 2) + "\n")
console.log(`wrote ${FILE} with ${bank.length} voices`)
