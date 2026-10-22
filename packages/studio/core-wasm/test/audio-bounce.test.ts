// AUDIO BOUNCE (#301) on the real engine: the copy AudioBounce.prepareCopy leaves behind is rendered as the same
// one-stem export the offline worker builds, through AudioBounce.renderFrames, and the resulting audio is judged.
import {describe, expect, it} from "vitest"
import {asInstanceOf, int, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData, dbToGain, PPQN, ppqn} from "@opendaw/lib-dsp"
import {InstrumentFactories, ProjectSkeleton, ScriptCompiler, UnionAdapterTypes} from "@opendaw/studio-adapters"
import {
    ApparatDeviceBox,
    AudioUnitBox,
    DelayDeviceBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox
} from "@opendaw/studio-boxes"
import type {AudioBounce as Bounce, Project as ProjectType, ProjectEnv} from "@opendaw/studio-core"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const {AudioBounce, EffectFactories, Project} = await import("@opendaw/studio-core")

const SampleRate = 48_000
const Quantum = 128
const Bar = PPQN.Bar
const BarFrames = SampleRate * 2 // 120 bpm

// A sine per held note that stops dead on note-off, so any sound after a region's end is an effect tail.
const Synth = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: velocity * 0.4, freq: 440 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.gain
                l[i] += s; r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

const createEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: SampleRate,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

type Scene = { project: ProjectType, unit: AudioUnitBox, track: TrackBox, delay: DelayDeviceBox }

const createScene = (): Scene => {
    const project = Project.fromSkeleton(createEnv(),
        ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
    const {unit, track, delay} = project.editing.modify(() => {
        const {audioUnitBox, instrumentBox, trackBox} = project.api.createInstrument(InstrumentFactories.Apparat)
        const apparat = asInstanceOf(instrumentBox, ApparatDeviceBox)
        apparat.code.setValue("// @apparat js 1 1\n" + Synth)
        new Function(ScriptCompiler.wrap(
            {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
            UUID.toString(apparat.address.uuid), 1, Synth))()
        const delayBox = asInstanceOf(project.api.insertEffect(audioUnitBox.audioEffects,
            EffectFactories.AudioNamed.Delay), DelayDeviceBox)
        return {unit: audioUnitBox, track: trackBox, delay: delayBox}
    }).unwrap("scene")
    return {project, unit, track, delay}
}

type Note = { position: ppqn, duration: ppqn }

const addRegion = ({project}: Scene, track: TrackBox, position: ppqn, duration: ppqn,
                   notes: ReadonlyArray<Note> = [{position: 0, duration}],
                   loop: { loopDuration: ppqn, loopOffset: ppqn } = {loopDuration: duration, loopOffset: 0}): NoteRegionBox =>
    project.editing.modify(() => {
        const {boxGraph} = project
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        notes.forEach(note => NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(note.position)
            box.duration.setValue(note.duration)
            box.pitch.setValue(69)
            box.velocity.setValue(1.0)
        }))
        return project.api.createNoteRegion({trackBox: track, position, duration, eventCollection: events, ...loop})
    }).unwrap("region")

const flagsOf = (tap: Bounce.Tap): int => {
    const stem = AudioBounce.stemConfiguration(tap, "test")
    return (stem.includeAudioEffects ? 1 : 0) | (stem.includeSends ? 2 : 0)
        | (stem.useInstrumentOutput ? 4 : 0) | ((stem.skipChannelStrip ?? false) ? 8 : 0)
}

type Render = { tap: Bounce.Tap, tail: boolean, prepare?: boolean }

// The offline worker's stem render, in node: stem record before bind, then play from the job start.
const bounce = async (project: ProjectType, job: Bounce.Job, {tap, tail, prepare = true}: Render): Promise<AudioData> => {
    const copy = project.copy()
    if (prepare) {AudioBounce.prepareCopy(copy, job)}
    const {engine, memory, drainSamples} = await loadFullEngine(SampleRate)
    const sync = connectSyncToEngine(engine, memory, copy.boxGraph)
    await sync.settle()
    const pointer = engine.input_reserve(20)
    new Uint8Array(memory.buffer, pointer, 16).set(job.audioUnitBox.address.uuid)
    new DataView(memory.buffer, pointer, 20).setUint32(16, flagsOf(tap), true)
    engine.set_stem_export(1, 0)
    engine.bind()
    await sync.settle()
    drainSamples()
    await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop()
    engine.set_position(job.start)
    engine.play()
    const step: Bounce.Step = async count => {
        const channels = [new Float32Array(count), new Float32Array(count)]
        for (let offset = 0; offset < count; offset += Quantum) {
            engine.render()
            const planar = new Float32Array(memory.buffer, engine.stem_output_ptr(), 2 * Quantum)
            channels[0].set(planar.subarray(0, Quantum), offset)
            channels[1].set(planar.subarray(Quantum, 2 * Quantum), offset)
        }
        return channels
    }
    return AudioBounce.renderFrames(step, AudioBounce.renderSpan(project, job, tail, SampleRate), SampleRate)
}

const peak = (audio: AudioData, from: int = 0, to: int = audio.numberOfFrames): number => {
    let max = 0
    audio.frames.forEach(channel => {
        for (let index = from; index < to; index++) {max = Math.max(max, Math.abs(channel[index]))}
    })
    return max
}

const rms = (audio: AudioData, from: int = 0, to: int = audio.numberOfFrames): number => {
    let sum = 0
    audio.frames.forEach(channel => {
        for (let index = from; index < to; index++) {sum += channel[index] * channel[index]}
    })
    return Math.sqrt(sum / ((to - from) * audio.numberOfChannels))
}

const allFinite = (audio: AudioData): boolean =>
    audio.frames.every(channel => channel.every(value => Number.isFinite(value)))

const jobOf = (scene: Scene, regions: ReadonlyArray<NoteRegionBox>, merge: boolean = false,
               loop: boolean = false): Bounce.Job => {
    const adapters = regions.map(region => scene.project.boxAdapters.adapterFor(region, UnionAdapterTypes.isRegion))
    const jobs = AudioBounce.collectJobs(adapters, merge, loop)
    expect(jobs).toHaveLength(1)
    return jobs[0]
}

describe("AudioBounce render", () => {
    it("renders exactly the region span without tail", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar)
        const audio = await bounce(scene.project, jobOf(scene, [region]), {tap: "pre-fader", tail: false})
        expect(audio.numberOfFrames).toBe(BarFrames)
        expect(audio.numberOfChannels).toBe(2)
        expect(allFinite(audio)).toBe(true)
        expect(peak(audio)).toBeGreaterThan(0.1)
    }, 60_000)

    it("starts at the region position, not at the song start", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, Bar * 4, Bar, [{position: 0, duration: Bar / 4}])
        const audio = await bounce(scene.project, jobOf(scene, [region]), {tap: "pre-fx", tail: false})
        expect(audio.numberOfFrames).toBe(BarFrames)
        expect(peak(audio, 0, BarFrames / 8)).toBeGreaterThan(0.1)
        expect(peak(audio, BarFrames / 4 + Quantum, BarFrames)).toBe(0)
    }, 60_000)

    it("pre-fx carries only the instrument: nothing after the note ends", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar, [{position: 0, duration: Bar / 2}])
        const audio = await bounce(scene.project, jobOf(scene, [region]), {tap: "pre-fx", tail: false})
        expect(peak(audio, 0, BarFrames / 2)).toBeGreaterThan(0.1)
        expect(peak(audio, BarFrames / 2 + Quantum, BarFrames)).toBe(0)
    }, 60_000)

    it("pre-fader carries the delay echoes after the note ends", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar, [{position: 0, duration: Bar / 2}])
        const audio = await bounce(scene.project, jobOf(scene, [region]), {tap: "pre-fader", tail: false})
        expect(peak(audio, BarFrames / 2 + Quantum, BarFrames)).toBeGreaterThan(0.01)
    }, 60_000)

    it("post-fader follows the unit volume, pre-fader ignores it", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar)
        const job = jobOf(scene, [region])
        scene.project.editing.modify(() => scene.unit.volume.setValue(-12))
        const preFader = await bounce(scene.project, job, {tap: "pre-fader", tail: false})
        const postFader = await bounce(scene.project, job, {tap: "post-fader", tail: false})
        const ratio = rms(postFader) / rms(preFader)
        expect(ratio).toBeGreaterThan(dbToGain(-12) * 0.8)
        expect(ratio).toBeLessThan(dbToGain(-12) * 1.25)
    }, 60_000)

    it("without tail the delay is cut at the region end", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar)
        const audio = await bounce(scene.project, jobOf(scene, [region]), {tap: "pre-fader", tail: false})
        expect(audio.numberOfFrames).toBe(BarFrames)
    }, 60_000)

    it("with tail the bounce runs on until the delay has faded out", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar)
        const audio = await bounce(scene.project, jobOf(scene, [region]), {tap: "pre-fader", tail: true})
        expect(audio.numberOfFrames).toBeGreaterThan(BarFrames + SampleRate / 10)
        expect(audio.numberOfFrames).toBeLessThanOrEqual(BarFrames + AudioBounce.MaxTailSeconds * SampleRate)
        expect(peak(audio, audio.numberOfFrames - Quantum, audio.numberOfFrames))
            .toBeGreaterThan(AudioBounce.SilenceThreshold)
        expect(allFinite(audio)).toBe(true)
    }, 60_000)

    it("with tail but nothing ringing, the bounce keeps the exact span", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar)
        const audio = await bounce(scene.project, jobOf(scene, [region]), {tap: "pre-fx", tail: true})
        expect(audio.numberOfFrames).toBe(BarFrames)
    }, 60_000)

    it("an endless feedback is capped at the maximum tail", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar)
        scene.project.editing.modify(() => scene.delay.feedback.setValue(1.0))
        const audio = await bounce(scene.project, jobOf(scene, [region]), {tap: "pre-fader", tail: true})
        expect(audio.numberOfFrames).toBe(BarFrames + AudioBounce.MaxTailSeconds * SampleRate)
    }, 120_000)

    it("the next region of the same unit is not in the bounce", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar)
        addRegion(scene, scene.track, Bar, Bar * 4)
        const job = jobOf(scene, [region])
        const solo = await bounce(scene.project, job, {tap: "pre-fx", tail: true})
        expect(solo.numberOfFrames).toBe(BarFrames)
        const unprepared = await bounce(scene.project, job, {tap: "pre-fx", tail: true, prepare: false})
        expect(unprepared.numberOfFrames).toBeGreaterThan(BarFrames * 2)
    }, 60_000)

    it("a muted region on a muted unit still bounces", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar)
        scene.project.editing.modify(() => {
            region.mute.setValue(true)
            scene.unit.mute.setValue(true)
        })
        const job = jobOf(scene, [region])
        const audio = await bounce(scene.project, job, {tap: "post-fader", tail: false})
        expect(peak(audio)).toBeGreaterThan(0.05)
        const unprepared = await bounce(scene.project, job, {tap: "post-fader", tail: false, prepare: false})
        expect(peak(unprepared)).toBe(0)
    }, 60_000)

    it("another soloed unit does not silence the bounce", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar)
        scene.project.editing.modify(() => {
            const other = scene.project.api.createInstrument(InstrumentFactories.Vaporisateur)
            other.audioUnitBox.solo.setValue(true)
        })
        const audio = await bounce(scene.project, jobOf(scene, [region]), {tap: "post-fader", tail: false})
        expect(peak(audio)).toBeGreaterThan(0.05)
    }, 60_000)

    it("a merged bounce spans both regions with silence in the gap", async () => {
        const scene = createScene()
        const first = addRegion(scene, scene.track, 0, Bar)
        const second = addRegion(scene, scene.track, Bar * 2, Bar)
        const audio = await bounce(scene.project, jobOf(scene, [first, second], true), {tap: "pre-fx", tail: false})
        expect(audio.numberOfFrames).toBe(BarFrames * 3)
        expect(peak(audio, 0, BarFrames)).toBeGreaterThan(0.1)
        expect(peak(audio, BarFrames + Quantum, BarFrames * 2)).toBe(0)
        expect(peak(audio, BarFrames * 2 + Quantum, BarFrames * 3)).toBeGreaterThan(0.1)
    }, 60_000)

    it("a loop bounce is exactly one pass long", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, Bar, Bar * 4, [{position: 0, duration: Bar / 4}],
            {loopDuration: Bar, loopOffset: 0})
        const audio = await bounce(scene.project, jobOf(scene, [region], false, true), {tap: "pre-fader", tail: true})
        expect(audio.numberOfFrames).toBe(BarFrames)
        expect(allFinite(audio)).toBe(true)
    }, 60_000)

    it("a loop bounce carries the echoes of the previous pass into its start", async () => {
        const scene = createScene()
        const lateNote = [{position: Bar / 2, duration: Bar / 2}]
        const looped = addRegion(scene, scene.track, 0, Bar * 4, lateNote, {loopDuration: Bar, loopOffset: 0})
        const loop = await bounce(scene.project, jobOf(scene, [looped], false, true), {tap: "pre-fader", tail: false})
        expect(peak(loop, 0, BarFrames / 2)).toBeGreaterThan(0.01)
        expect(peak(loop, BarFrames / 2, BarFrames)).toBeGreaterThan(0.1)
        const plain = await bounce(scene.project, jobOf(scene, [looped]), {tap: "pre-fader", tail: false})
        expect(peak(plain, 0, BarFrames / 2)).toBe(0)
    }, 60_000)

    it("a loop bounce without effects is the bare pass", async () => {
        const scene = createScene()
        const lateNote = [{position: Bar / 2, duration: Bar / 2}]
        const looped = addRegion(scene, scene.track, 0, Bar * 4, lateNote, {loopDuration: Bar, loopOffset: 0})
        const loop = await bounce(scene.project, jobOf(scene, [looped], false, true), {tap: "pre-fx", tail: false})
        expect(peak(loop, 0, BarFrames / 2)).toBe(0)
        expect(peak(loop, BarFrames / 2 + Quantum, BarFrames)).toBeGreaterThan(0.1)
    }, 60_000)

    it("a loop bounce starts at the loop start, not at the region's loop offset", async () => {
        const scene = createScene()
        const region = addRegion(scene, scene.track, 0, Bar * 2, [{position: 0, duration: Bar / 4}],
            {loopDuration: Bar, loopOffset: Bar / 2})
        const audio = await bounce(scene.project, jobOf(scene, [region], false, true), {tap: "pre-fx", tail: false})
        expect(audio.numberOfFrames).toBe(BarFrames)
        expect(peak(audio, 0, BarFrames / 8)).toBeGreaterThan(0.1)
        expect(peak(audio, BarFrames / 4 + Quantum, BarFrames)).toBe(0)
    }, 60_000)

    it("an aborted render rejects", async () => {
        const controller = new AbortController()
        controller.abort()
        const step: Bounce.Step = async count => [new Float32Array(count), new Float32Array(count)]
        const span = {skipFrames: 0, numFrames: BarFrames, tail: false}
        await expect(AudioBounce.renderFrames(step, span, SampleRate, () => {}, controller.signal)).rejects.toThrow()
    })
})
