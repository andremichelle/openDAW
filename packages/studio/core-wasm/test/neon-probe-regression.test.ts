// Regression: the Neon device rendered through the REAL wasm engine against the VirtualCZ reference
// renders in test-files/probe (mono 16-bit, peak-normalized, silence-trimmed). Each probe isolates one
// mapping (wave morphology, DCA/DCW curves, key follow, vibrato, ring/noise, alternation). Metrics are
// gain-aligned so absolute level differences cancel: an RMS contour delta (envelope timing/shape), a
// time-averaged harmonic-energy delta (spectrum), and the tail level after the reference ends (catches
// too-long envelopes). Tolerances pin the calibration state of 2026-07-30 — a change that worsens any
// probe beyond its recorded headroom fails here.
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, NeonDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {CzSysex, NeonPreset, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const PROBE_DIR = path.resolve(__dirname, "../../../../test-files/probe")
const SR = 48000
const PULSES_PER_SECOND = 1920 // bpm 120, PPQN.Quarter 960
const C4 = 261.63

type NotePlan = ReadonlyArray<{pitch: number, start: number, hold: number}>
type Probe = {
    name: string
    hold: number
    notes?: NotePlan
    f0?: number // 0 = skip the harmonic metric (staircase pitch / noise probes)
    contourTol: number
    harmTol: number
    tailTol: number
}

const KF_NOTES: NotePlan = [
    {pitch: 36, start: 0.02, hold: 2.0}, {pitch: 60, start: 2.52, hold: 2.0}, {pitch: 84, start: 5.02, hold: 2.0}
]

const PROBES: ReadonlyArray<Probe> = [
    {name: "alternation", hold: 6, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    // coarse: a 0.4s self-idling burst of 2-20ms stages, ~1 hop of timing drift dominates; harm 4.0
    // absorbs the DELIBERATE 5ms DCW-sweep floor (anti-click) on this floor-sensitive content.
    {name: "dca-level", hold: 8, contourTol: 8.0, harmTol: 4.0, tailTol: -40},
    {name: "dca-rate-fast", hold: 6, contourTol: 3.5, harmTol: 3.0, tailTol: -40},
    {name: "dca-rate-mid", hold: 20, contourTol: 3.0, harmTol: 3.0, tailTol: -40},
    // audible region ≤1.5dB (measured rate table + ascending-end-stage drain); the mean is dominated by
    // end-of-render windows where the REFERENCE sits at its own recording floor (~-66dB, right at the
    // peak-65 activity gate) while our drain still carries -56dB of real tail.
    {name: "dca-rate-slow", hold: 90, contourTol: 7.0, harmTol: 3.0, tailTol: -25},
    {name: "dcw-level", hold: 8, contourTol: 1.5, harmTol: 3.0, tailTol: -50},
    {name: "dcw-sweep-saw", hold: 12, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    // square/pulse/double-sine: period-2 rework 2026-07-31 — band-level matches (preset battery ≤5.8dB),
    // per-harmonic parity awaits the exact hardware alternation structure (plans/neon.md); skipped, not red.
    {name: "dcw-sweep-square", hold: 12, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "dcw-sweep-pulse", hold: 12, contourTol: 1.8, harmTol: 3.0, tailTol: -50},
    {name: "dcw-sweep-double-sine", hold: 12, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "dcw-sweep-saw-pulse", hold: 12, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "dcw-sweep-res-saw", hold: 12, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "dcw-sweep-res-triangle", hold: 12, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "dcw-sweep-res-trapezoid", hold: 12, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "kf-dca-9", hold: 8, notes: KF_NOTES, f0: 0, contourTol: 2.0, harmTol: 0, tailTol: -40},
    {name: "kf-dcw-9", hold: 8, notes: KF_NOTES, f0: 0, contourTol: 2.0, harmTol: 0, tailTol: -40},
    {name: "ring-sine", hold: 6, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "ring-bright", hold: 6, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "noise-mod", hold: 6, f0: 0, contourTol: 1.5, harmTol: 0, tailTol: -50},
    {name: "pitch-level", hold: 10, f0: 0, contourTol: 2.0, harmTol: 0, tailTol: -40},
    {name: "vib-rate-5", hold: 8, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "vib-rate-25", hold: 8, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "vib-rate-50", hold: 8, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "vib-rate-75", hold: 8, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "vib-rate-99", hold: 8, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "vib-depth-10", hold: 8, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "vib-depth-30", hold: 8, contourTol: 1.0, harmTol: 3.0, tailTol: -50},
    {name: "vib-depth-60", hold: 8, contourTol: 1.0, harmTol: 4.0, tailTol: -50},
    {name: "vib-depth-99", hold: 8, contourTol: 1.5, harmTol: 7.0, tailTol: -50}, // ±611 cent FM smears the C4 harmonic grid
    {name: "vib-delay-60", hold: 10, contourTol: 1.0, harmTol: 4.0, tailTol: -50}
]

const readMonoWav = (file: string): Float32Array => {
    const bytes = readFileSync(file)
    const channels = bytes.readUInt16LE(22)
    const dataOffset = 44
    const frames = (bytes.length - dataOffset) / 2 / channels
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let ch = 0; ch < channels; ch++) {
            sum += bytes.readInt16LE(dataOffset + (i * channels + ch) * 2)
        }
        out[i] = sum / channels / 32768
    }
    return out
}

const HOP = Math.floor(0.025 * SR)
const WINDOW = Math.floor(0.05 * SR)

const contourDb = (mono: Float32Array): Float32Array => {
    const count = Math.max(1, Math.floor((mono.length - WINDOW) / HOP))
    const out = new Float32Array(count)
    for (let index = 0; index < count; index++) {
        let sum = 0
        const start = index * HOP
        for (let i = start; i < start + WINDOW; i++) {sum += mono[i] * mono[i]}
        out[index] = 10 * Math.log10(Math.max(sum / WINDOW, 1e-12))
    }
    return out
}

// Mean |Δ| of the two RMS contours after removing the median gain offset, over windows active in the ref.
const contourDelta = (ours: Float32Array, ref: Float32Array): number => {
    const ourC = contourDb(ours)
    const refC = contourDb(ref)
    const count = Math.min(ourC.length, refC.length)
    const refPeak = Math.max(...refC)
    const deltas: Array<number> = []
    for (let i = 0; i < count; i++) {
        if (refC[i] > refPeak - 65) {deltas.push(ourC[i] - refC[i])}
    }
    if (deltas.length === 0) {return 0}
    const sorted = [...deltas].sort((left, right) => left - right)
    const median = sorted[sorted.length >> 1]
    return deltas.reduce((sum, delta) => sum + Math.abs(delta - median), 0) / deltas.length
}

// Sliding-window Hann Goertzel POWER at `freq`, averaged over the whole signal (beat/phase robust).
const harmonicEnergy = (mono: Float32Array, freq: number, until: number): number => {
    let total = 0
    let windows = 0
    const step = (2 * Math.PI * freq) / SR
    for (let start = 0; start + WINDOW < until; start += HOP * 2) {
        let re = 0
        let im = 0
        for (let i = 0; i < WINDOW; i++) {
            const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW)
            const sample = mono[start + i] * hann
            const angle = step * (start + i)
            re += sample * Math.cos(angle)
            im -= sample * Math.sin(angle)
        }
        total += re * re + im * im
        windows++
    }
    return windows === 0 ? 0 : Math.sqrt(total / windows)
}

// Max |Δ dB| across harmonics 1..8 (each normalized to its side's loudest harmonic), where the ref
// harmonic is within 40dB of the loudest — the audible spectrum.
const harmonicDelta = (ours: Float32Array, ref: Float32Array, f0: number): number => {
    const until = Math.min(ours.length, ref.length)
    const ourH = [1, 2, 3, 4, 5, 6, 7, 8].map(h => harmonicEnergy(ours, f0 * h, until))
    const refH = [1, 2, 3, 4, 5, 6, 7, 8].map(h => harmonicEnergy(ref, f0 * h, until))
    const ourMax = Math.max(...ourH, 1e-12)
    const refMax = Math.max(...refH, 1e-12)
    let worst = 0
    for (let i = 0; i < 8; i++) {
        const refDb = 20 * Math.log10(Math.max(refH[i] / refMax, 1e-9))
        if (refDb <= -40) {continue}
        const ourDb = 20 * Math.log10(Math.max(ourH[i] / ourMax, 1e-9))
        worst = Math.max(worst, Math.abs(ourDb - refDb))
    }
    return worst
}

// Our level (dB rel our peak) in the 0.5s AFTER the reference has gone silent.
const tailDb = (ours: Float32Array, refLength: number): number => {
    const start = refLength
    const end = Math.min(ours.length, refLength + Math.floor(0.5 * SR))
    if (end - start < WINDOW) {return -120}
    let sum = 0
    for (let i = start; i < end; i++) {sum += ours[i] * ours[i]}
    const tail = 10 * Math.log10(Math.max(sum / (end - start), 1e-12))
    let peak = 0
    for (let i = 0; i < ours.length; i++) {peak = Math.max(peak, Math.abs(ours[i]))}
    return tail - 20 * Math.log10(Math.max(peak, 1e-6))
}

// Fresh project + engine per probe: mutating one shared project across probes left stale note
// bindings behind (missed note-offs); an engine load is ~300ms, isolation is cheap.
const renderProbe = async (probe: Probe, seconds: number): Promise<Float32Array> => {
    const tone = CzSysex.decode(new Uint8Array(readFileSync(path.join(PROBE_DIR, `${probe.name}.syx`))))
    const notes = probe.notes ?? [{pitch: 60, start: 0.02, hold: probe.hold}]
    const {boxGraph: source, mandatoryBoxes: {rootBox, timelineBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    // The skeleton's 4-bar loop area would wrap the transport at 8s and replay every note.
    timelineBox.loopArea.enabled.setValue(false)
    const unit = AudioUnitBox.create(source, UUID.generate(), (box: AudioUnitBox) => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const neon = NeonDeviceBox.create(source, UUID.generate(), (box: NeonDeviceBox) => {
        box.host.refer(unit.input)
    })
    NeonPreset.apply(neon, tone)
    const track = TrackBox.create(source, UUID.generate(), (box: TrackBox) => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    const regionEnd = Math.ceil((notes.at(-1)!.start + notes.at(-1)!.hold + 120) * PULSES_PER_SECOND)
    for (const note of notes) {
        NoteEventBox.create(source, UUID.generate(), (box: NoteEventBox) => {
            box.events.refer(events.events)
            box.position.setValue(Math.round(note.start * PULSES_PER_SECOND))
            box.duration.setValue(Math.round(note.hold * PULSES_PER_SECOND))
            box.pitch.setValue(note.pitch)
            box.velocity.setValue(100 / 127)
            box.cent.setValue(0)
        })
    }
    NoteRegionBox.create(source, UUID.generate(), (box: NoteRegionBox) => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(regionEnd)
        box.loopDuration.setValue(regionEnd)
    })
    source.endTransaction()
    const {engine, memory} = await loadFullEngine(SR)
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle()
    engine.bind()
    await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop()
    engine.play()
    const len = engine.output_len() >>> 0
    const frames = len / 2
    const quanta = Math.ceil((seconds * SR) / frames)
    const mono = new Float32Array(quanta * frames)
    for (let q = 0; q < quanta; q++) {
        engine.render()
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        const base = q * frames
        for (let i = 0; i < frames; i++) {
            mono[base + i] = (out[i] + out[frames + i]) * 0.5
        }
    }
    return mono
}

describe("neon probe regression", () => {
    for (const probe of PROBES) {
        if ((probe as {skip?: boolean}).skip) {
            it.skip(`matches VirtualCZ on ${probe.name}`, () => {})
            continue
        }
        it(`matches VirtualCZ on ${probe.name}`, async () => {
            const ref = readMonoWav(path.join(PROBE_DIR, `${probe.name}.wav`))
            const ours = await renderProbe(probe, ref.length / SR + 0.75)
            expect(ours.some(sample => Math.abs(sample) > 1e-4), "renders audio").toBe(true)
            const contour = contourDelta(ours, ref)
            expect(contour, `contour delta ${contour.toFixed(2)}dB`).toBeLessThan(probe.contourTol)
            if ((probe.f0 ?? C4) !== 0) {
                const harm = harmonicDelta(ours, ref, probe.f0 ?? C4)
                expect(harm, `harmonic delta ${harm.toFixed(2)}dB`).toBeLessThan(probe.harmTol)
            }
            const tail = tailDb(ours, ref.length)
            expect(tail, `tail ${tail.toFixed(1)}dB after the reference ends`).toBeLessThan(probe.tailTol)
        }, 120000)
    }
})
