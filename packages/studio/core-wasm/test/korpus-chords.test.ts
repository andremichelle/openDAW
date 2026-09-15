// Chord transitions through the REAL polyphonic pool: the pool starts each note at the newest
// decaying voice's pitch and glides to the target — a no-op start_glide made every chord replay
// its predecessor's pitches (the stale-chord bug). The windows below pin the fix.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, KorpusDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLE_RATE = 48_000

const goertzel = (samples: Float32Array, from: number, to: number, frequency: number): number => {
    const omega = 2.0 * Math.PI * frequency / SAMPLE_RATE
    const coefficient = 2.0 * Math.cos(omega)
    let s1 = 0.0
    let s2 = 0.0
    for (let index = from; index < to; index++) {
        const s0 = samples[index] + coefficient * s1 - s2
        s2 = s1
        s1 = s0
    }
    return s1 * s1 + s2 * s2 - coefficient * s1 * s2
}

const hz = (pitch: number) => 440.0 * Math.pow(2.0, (pitch - 69) / 12.0)

describe("korpus wind chord transitions", () => {
    it("second chord speaks promptly and the first does not linger", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        KorpusDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.exciter.setValue(4)
            box.intensity.setValue(0.6)
            box.position.setValue(0.35)
            box.objectA.setValue(1)
            box.dampingA.setValue(0.65)
            box.vibrato.setValue(0.25)
        })
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.enabled.setValue(true)
            box.index.setValue(0)
            box.target.refer(unit)
            box.tracks.refer(unit.tracks)
        })
        const events = NoteEventCollectionBox.create(source, UUID.generate())
        // Two chords, back to back: 0..1920 PPQN then 1920..3840 (1s each at 120bpm).
        const chordOne = [57, 61, 64]
        const chordTwo = [59, 62, 66]
        chordOne.forEach(pitch => NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(0)
            box.duration.setValue(1920)
            box.pitch.setValue(pitch)
            box.velocity.setValue(0.8)
            box.cent.setValue(0)
        }))
        chordTwo.forEach(pitch => NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(1920)
            box.duration.setValue(1920)
            box.pitch.setValue(pitch)
            box.velocity.setValue(0.8)
            box.cent.setValue(0)
        }))
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(7680)
            box.loopDuration.setValue(7680)
        })
        source.endTransaction()

        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const half = len / 2
        const quanta = Math.ceil(3.0 * SAMPLE_RATE / half)
        const all = new Float32Array(quanta * half)
        engine.stop(); engine.play()
        for (let quantum = 0; quantum < quanta; quantum++) {
            engine.render()
            const left = new Float32Array(memory.buffer, engine.output_ptr(), half)
            all.set(left, quantum * half)
        }
        const second = (seconds: number) => Math.floor(seconds * SAMPLE_RATE)
        // Windows: chord 1 sustain, transition, chord 2 sustain.
        const report = (label: string, from: number, to: number) => {
            const one = chordOne.map(pitch => goertzel(all, from, to, hz(pitch)).toFixed(0)).join("/")
            const two = chordTwo.map(pitch => goertzel(all, from, to, hz(pitch)).toFixed(0)).join("/")
            console.log(`${label}: chord1 ${one} | chord2 ${two}`)
        }
        report("0.3-0.9s (chord1)", second(0.3), second(0.9))
        report("1.05-1.35s (early chord2)", second(1.05), second(1.35))
        report("1.5-1.9s (chord2)", second(1.5), second(1.9))
        report("2.2-2.9s (after)", second(2.2), second(2.9))
        // Chord 2 onset: first sample after 1.0s where short-window energy of chord2 root rises.
        let onset = -1
        for (let t = 1.0; t < 2.0; t += 0.02) {
            const power = goertzel(all, second(t), second(t + 0.05), hz(59))
            if (power > 500) {onset = t; break}
        }
        console.log(`chord2 root audible from ~${onset.toFixed(2)}s (note-on at 1.00s)`)
        expect(all.every(Number.isFinite)).toBe(true)
        expect(onset, "second chord must speak promptly").toBeGreaterThan(0)
        expect(onset, "second chord must speak promptly").toBeLessThanOrEqual(1.08)
        const sustain = [second(1.5), second(1.9)] as const
        for (const pitch of chordTwo) {
            expect(goertzel(all, sustain[0], sustain[1], hz(pitch)),
                `chord2 pitch ${pitch} must sound in its own window`).toBeGreaterThan(50_000)
        }
        for (const pitch of chordOne) {
            expect(goertzel(all, sustain[0], sustain[1], hz(pitch)),
                `chord1 pitch ${pitch} must have decayed to a tail`).toBeLessThan(25_000)
        }
    }, 30_000)
})
