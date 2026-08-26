// Generates the Neon calibration PROBE pack (probe/*.syx): synthetic CZ tones that isolate
// ONE mapping each, to be rendered through VirtualCZ (see the README it writes). The fits derived from
// these renders replace the preset-derived approximations in `crates/stock-devices/device-neon`.
// Run: npx tsx scripts/generate-cz-probes.ts   (from packages/studio/adapters)

import {mkdirSync, writeFileSync} from "node:fs"
import {resolve} from "node:path"
import {CzEnvelope, CzSysex, CzTone} from "../src/devices/instruments/Neon/CzSysex"

const outDir = resolve(__dirname, "../../../../test-files/probe")
mkdirSync(outDir, {recursive: true})

const flat: CzEnvelope = {rates: [50, 50, 50, 50, 50, 50, 50, 50], levels: [0, 0, 0, 0, 0, 0, 0, 0], sustain: 1, end: 2}
const full = (rate: number = 99): CzEnvelope =>
    ({rates: [rate, 50, 50, 50, 50, 50, 50, 50], levels: [99, 0, 0, 0, 0, 0, 0, 0], sustain: 1, end: 2})
const zeroSustain: CzEnvelope = {rates: [99, 50, 50, 50, 50, 50, 50, 50], levels: [0, 0, 0, 0, 0, 0, 0, 0], sustain: 1, end: 2}
const staircase = (rates: ReadonlyArray<number>, levels: ReadonlyArray<number>, sustain: number, end: number): CzEnvelope =>
    ({rates: [...rates], levels: [...levels], sustain, end})

const base = (partial: Partial<CzTone> & {line1?: Partial<CzTone["lines"][0]>, line2?: Partial<CzTone["lines"][0]>}): CzTone => {
    const line = (overrides?: Partial<CzTone["lines"][0]>) => ({
        wave1: 0, wave2: 0, dcwKeyFollow: 0, dcaKeyFollow: 0,
        pitchEnv: flat, dcwEnv: full(), dcaEnv: full(),
        ...overrides
    })
    const {line1, line2, ...tone} = partial
    return {
        lineSelect: 0, modulation: 0, octave: 0, detuneNote: 0, detuneFine: 0,
        vibratoWave: 0, vibratoDelay: 0, vibratoRate: 0, vibratoDepth: 0,
        lines: [line(line1), line(line2)],
        ...tone
    }
}

const probes: Array<{name: string, hold: string, why: string, tone: CzTone}> = []
const add = (name: string, hold: string, why: string, tone: CzTone) => probes.push({name, hold, why, tone})

add("dca-rate-fast", "C4, hold 6s", "DCA rate curve 60-95: segment times between alternating levels",
    base({line1: {dcaEnv: staircase([95, 90, 85, 80, 75, 70, 65, 60], [99, 20, 99, 20, 99, 20, 99, 20], 0, 8)}}))
add("dca-rate-mid", "C4, hold 20s", "DCA rate curve 30-55",
    base({line1: {dcaEnv: staircase([55, 50, 45, 40, 35, 30, 99, 99], [99, 20, 99, 20, 99, 20, 99, 99], 0, 6)}}))
add("dca-rate-slow", "C4, hold 90s (long!)", "DCA rate curve 15-25",
    base({line1: {dcaEnv: staircase([25, 20, 15, 99, 99, 99, 99, 99], [99, 20, 99, 99, 99, 99, 99, 99], 0, 3)}}))
add("dca-level", "C4, hold 8s", "DCA level→amplitude curve: plateaus at 90..20",
    base({line1: {dcaEnv: staircase([99, 60, 99, 60, 99, 60, 99, 60], [90, 80, 70, 60, 50, 40, 30, 20], 0, 8)}}))
add("dcw-level", "C4, hold 8s", "DCW level→brightness curve: plateaus at 90..20 (saw)",
    base({line1: {dcwEnv: staircase([99, 60, 99, 60, 99, 60, 99, 60], [90, 80, 70, 60, 50, 40, 30, 20], 0, 8)}}))
const waveNames = ["saw", "square", "pulse", "double-sine", "saw-pulse", "res-saw", "res-triangle", "res-trapezoid"]
waveNames.forEach((waveName, wave) => {
    add(`dcw-sweep-${waveName}`, "C4, hold 12s", `wave ${wave + 1} morphology over a slow DCW ramp 0→99`,
        base({line1: {wave1: wave, dcwEnv: staircase([40, 99, 99, 99, 99, 99, 99, 99], [99, 99, 99, 99, 99, 99, 99, 99], 1, 2)}}))
})
for (const rate of [5, 25, 50, 75, 99]) {
    add(`vib-rate-${rate}`, "C4, hold 8s", "vibrato LFO frequency at this rate value",
        base({vibratoRate: rate, vibratoDepth: 30, line1: {dcwEnv: full(), dcaEnv: full()}}))
}
for (const depth of [10, 30, 60, 99]) {
    add(`vib-depth-${depth}`, "C4, hold 8s", "vibrato depth in cents at this depth value (rate fixed 30)",
        base({vibratoRate: 30, vibratoDepth: depth}))
}
add("vib-delay-60", "C4, hold 10s", "vibrato delay/ramp time at delay 60 (rate 40, depth 60)",
    base({vibratoRate: 40, vibratoDepth: 60, vibratoDelay: 60}))
add("ring-sine", "C4, hold 6s", "RING formula: pure cosines (DCW 0) at f and f/2 — sideband levels read the mix",
    base({lineSelect: 3, modulation: 1, detuneNote: -12,
        line1: {dcwEnv: zeroSustain}, line2: {dcwEnv: zeroSustain}}))
add("ring-bright", "C4, hold 6s", "RING with full-DCW saws (rich case cross-check)",
    base({lineSelect: 3, modulation: 1, detuneNote: -12}))
add("noise-mod", "C4, hold 6s", "NOISE modulation on pure cosines",
    base({lineSelect: 3, modulation: 2, line1: {dcwEnv: zeroSustain}, line2: {dcwEnv: zeroSustain}}))
add("alternation", "C4, hold 6s", "wave1+wave2 on ONE line (square+saw): per-cycle alternation vs other semantics",
    base({line1: {wave1: 1, wave2: 1}}))
add("kf-dca-9", "C2 2s, C4 2s, C6 2s", "DCA key follow 9: envelope speed vs note",
    base({line1: {dcaKeyFollow: 9, dcaEnv: staircase([50, 99, 99, 99, 99, 99, 99, 99], [99, 99, 99, 99, 99, 99, 99, 99], 1, 2)}}))
add("kf-dcw-9", "C2 2s, C4 2s, C6 2s", "DCW key follow 9: brightness vs note (saw, DCW 99)",
    base({line1: {dcwKeyFollow: 9}}))
add("pitch-level", "C4, hold 10s", "DCO pitch-env level→pitch curve: plateaus at 10..99",
    base({line1: {pitchEnv: staircase([99, 55, 99, 55, 99, 55, 99, 55], [10, 25, 40, 55, 63, 70, 85, 99], 8, 8)}}))

const lines: Array<string> = [
    "# Neon calibration probes",
    "",
    "Each `.syx` isolates ONE mapping. For each file: load it into VirtualCZ (Bitwig), play the note(s)",
    "listed below, render, and save the result as `<name>.wav` next to the `.syx`. Default: a single held C4",
    "for the listed duration, then release and let it ring one more second. 44.1k or 48k both fine.",
    ""
]
for (const {name, hold, why, tone} of probes) {
    writeFileSync(resolve(outDir, `${name}.syx`), CzSysex.encode(tone))
    lines.push(`- \`${name}.syx\` — ${hold} — ${why}`)
}
writeFileSync(resolve(outDir, "README.md"), lines.join("\n") + "\n")
console.log(`wrote ${probes.length} probes + README to ${outDir}`)
