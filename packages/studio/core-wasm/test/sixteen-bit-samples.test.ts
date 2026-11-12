// A sample the engine holds as 16 bit PCM must render bit for bit like the same sample held as the floats a
// 16 bit WAV decodes to. Every reader of sample frames is driven through the real engine, once with float planes
// (`sample_set_ready`) and once with 16 bit planes (`sample_set_ready_i16`), and the two outputs are compared
// value by value.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioData, PcmData} from "@opendaw/lib-dsp"
import {
    ApparatDeviceBox, AudioFileBox, AudioRegionBox, AudioSignalsmithBox, AudioTimeStretchBox, AudioUnitBox, CaptureMidiBox,
    ConvolverDeviceBox, NanoDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, SamplerDeviceBox, SamplerGroupBox,
    SamplerZoneBox, TapeDeviceBox, TrackBox, TransientMarkerBox, ValueEventCollectionBox, WarpMarkerBox, WclapDeviceBox,
    WclapSampleBox, WerkstattSampleBox
} from "@opendaw/studio-boxes"
import {EngineToClient, ProjectSkeleton, ScriptCompiler, TrackType, WclapBundle, WclapStatus} from "@opendaw/studio-adapters"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {drainResourceRequests} from "../src/boot"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {buildEffectProject} from "./helpers/effect-harness"

type Format = "float32" | "int16"
type Engine = Awaited<ReturnType<typeof loadFullEngine>>["engine"]

const FRAMES = 30_000
const RATE = 44_100 // not the engine's 48 kHz, so every reader resamples

// stereo noise as planar 16 bit frames
const noise = (channels: number, frames: number = FRAMES): Int16Array => {
    const planar = new Int16Array(frames * channels)
    let seed = 0x1234_5678
    for (let index = 0; index < planar.length; index++) {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
        planar[index] = (seed >>> 16) - 32_768
    }
    return planar
}

const STEREO = noise(2)
const MONO = noise(1)

// answers every pending sample request with `planar`, in the given format
const serve = (engine: Engine, memory: WebAssembly.Memory, planar: Int16Array, channels: number, rate: number, format: Format): number => {
    const frames = planar.length / channels
    let served = 0
    for (; ;) {
        const handle = engine.sample_take_request(engine.input_reserve(16))
        if (handle < 0) {break}
        if (format === "int16") {
            const pointer = engine.sample_allocate(handle, planar.length * 2)
            new Int16Array(memory.buffer, pointer, planar.length).set(planar)
            engine.sample_set_ready_i16(handle, frames, channels, rate)
        } else {
            const pointer = engine.sample_allocate(handle, planar.length * 4)
            const target = new Float32Array(memory.buffer, pointer, planar.length)
            for (let index = 0; index < planar.length; index++) {target[index] = planar[index] / 32_768}
            engine.sample_set_ready(handle, frames, channels, rate)
        }
        served++
    }
    return served
}

type Run = (engine: Engine, memory: WebAssembly.Memory) => Float32Array

const collect = (engine: Engine, memory: WebAssembly.Memory, quanta: number, target: Array<number>): void => {
    const length = engine.output_len() >>> 0
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        const output = new Float32Array(memory.buffer, engine.output_ptr(), length)
        for (let index = 0; index < length; index++) {target.push(output[index])}
    }
}

const play = (quanta: number): Run => (engine, memory) => {
    const output: Array<number> = []
    engine.stop()
    engine.play()
    collect(engine, memory, quanta, output)
    return Float32Array.from(output)
}

const render = async (source: BoxGraph, planar: Int16Array, channels: number, format: Format, run: Run, rate: number = RATE,
                      offline: boolean = false): Promise<Float32Array> => {
    const {engine, memory} = await loadFullEngine()
    if (offline) {engine.set_sample_float_budget(0xFFFFFFFF)}
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle()
    engine.bind()
    await sync.settle()
    engine.set_metronome_enabled(0)
    expect(serve(engine, memory, planar, channels, rate, format), "the project asks for its sample").toBeGreaterThan(0)
    await sync.settle()
    return run(engine, memory)
}

const expectSame = (asInts: Float32Array, asFloats: Float32Array, name: string): void => {
    expect(asFloats.some(value => Math.abs(value) > 0.001), `${name}: silent, the comparison would prove nothing`).toBe(true)
    expect(asInts.length).toBe(asFloats.length)
    const ints = new Uint32Array(asInts.buffer)
    const floats = new Uint32Array(asFloats.buffer)
    for (let index = 0; index < floats.length; index++) {
        if (ints[index] !== floats[index]) {
            expect.fail(`${name}: differs at ${index} of ${floats.length}: 16 bit ${asInts[index]}, float ${asFloats[index]}`)
        }
    }
}

// one project for both renders: its uuids decide details such as the Signalsmith stagger
const both = async (name: string, build: () => BoxGraph, planar: Int16Array, channels: number, run: Run, rate: number = RATE): Promise<void> => {
    const source = build()
    const asFloats = await render(source, planar, channels, "float32", run, rate)
    const asInts = await render(source, planar, channels, "int16", run, rate)
    expectSame(asInts, asFloats, name)
}

const skeleton = () => ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})

const createFile = (source: BoxGraph, seconds: number): AudioFileBox => AudioFileBox.create(source, UUID.generate(), box => {
    box.startInSeconds.setValue(0.0)
    box.endInSeconds.setValue(seconds)
    box.fileName.setValue("noise")
})

const SECONDS = FRAMES / RATE

// a native region followed by a second one in the given play mode, both on the same file
const regions = (mode: "native" | "grain-once" | "grain-repeat" | "grain-pingpong" | "signalsmith") => (): BoxGraph => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton()
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const file = createFile(source, SECONDS)
    for (let index = 0; index < 6; index++) {
        TransientMarkerBox.create(source, UUID.generate(), box => {
            box.owner.refer(file.transientMarkers)
            box.position.setValue(index * 0.11)
        })
    }
    const first = ValueEventCollectionBox.create(source, UUID.generate())
    AudioRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(900)
        box.loopDuration.setValue(700)
        box.loopOffset.setValue(60)
        box.gain.setValue(-3.0)
        box.regions.refer(track.regions)
        box.file.refer(file)
        box.events.refer(first.owners)
    })
    const second = ValueEventCollectionBox.create(source, UUID.generate())
    const region = AudioRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(960)
        box.duration.setValue(1400)
        box.loopDuration.setValue(1100)
        box.regions.refer(track.regions)
        box.file.refer(file)
        box.events.refer(second.owners)
    })
    if (mode !== "native") {
        const stretch = mode === "signalsmith"
            ? AudioSignalsmithBox.create(source, UUID.generate(), box => box.transpose.setValue(3.0))
            : AudioTimeStretchBox.create(source, UUID.generate(), box => box.transientPlayMode.setValue(
                mode === "grain-once" ? TransientPlayMode.Once : mode === "grain-repeat" ? TransientPlayMode.Repeat : TransientPlayMode.Pingpong))
        WarpMarkerBox.create(source, UUID.generate(), box => {
            box.owner.refer(stretch.warpMarkers)
            box.position.setValue(0)
            box.seconds.setValue(0.0)
        })
        WarpMarkerBox.create(source, UUID.generate(), box => {
            box.owner.refer(stretch.warpMarkers)
            box.position.setValue(1700)
            box.seconds.setValue(SECONDS * 0.9)
        })
        region.playMode.refer(stretch)
    }
    source.endTransaction()
    return source
}

// plays through both regions, then jumps back and forth so the releases and jump tails are part of the output
const playWithJumps: Run = (engine, memory) => {
    const output: Array<number> = []
    engine.stop()
    engine.play()
    collect(engine, memory, 500, output)
    for (const target of [300, 1500, 100, 1200]) {
        engine.set_position(target)
        collect(engine, memory, 60, output)
    }
    engine.stop()
    collect(engine, memory, 40, output)
    return Float32Array.from(output)
}

type Zone = {
    readonly root?: number, readonly transpose?: number, readonly tune?: number, readonly reverse?: boolean,
    readonly loopMode?: number, readonly loopStart?: number, readonly loopEnd?: number, readonly loopFade?: number,
    readonly alternate?: boolean, readonly start?: number, readonly end?: number, readonly oneShot?: boolean
}

const instrumentProject = (create: (source: BoxGraph, unit: AudioUnitBox, file: AudioFileBox) => void) => (): BoxGraph => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton()
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    create(source, unit, createFile(source, SECONDS))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    const notes: ReadonlyArray<readonly [number, number, number]> = [[0, 60, 400], [240, 67, 300], [700, 55, 500], [1300, 72, 200]]
    notes.forEach(([position, pitch, duration]) => NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(position)
        box.duration.setValue(duration)
        box.pitch.setValue(pitch)
        box.velocity.setValue(0.8)
        box.cent.setValue(0)
    }))
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(4000)
        box.loopDuration.setValue(4000)
    })
    source.endTransaction()
    return source
}

const sampler = (zone: Zone) => instrumentProject((source, unit, file) => {
    const device = SamplerDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.volume.setValue(-6.0)
        box.ampEnvelope.attack.setValue(0.002)
        box.ampEnvelope.release.setValue(0.05)
    })
    const group = SamplerGroupBox.create(source, UUID.generate(), box => {
        box.device.refer(device.groups)
        box.index.setValue(0)
    })
    SamplerZoneBox.create(source, UUID.generate(), box => {
        box.device.refer(device.zones)
        box.group.refer(group.zones)
        box.file.refer(file)
        box.rootKey.setValue(zone.root ?? 60)
        box.transpose.setValue(zone.transpose ?? 0)
        box.tune.setValue(zone.tune ?? 0.0)
        box.reverse.setValue(zone.reverse ?? false)
        box.oneShot.setValue(zone.oneShot ?? false)
        box.sampleStart.setValue(zone.start ?? 0)
        box.sampleEnd.setValue(zone.end ?? 0x7FFFFFFF)
        box.loopMode.setValue(zone.loopMode ?? 0)
        box.loopStart.setValue(zone.loopStart ?? 0)
        box.loopEnd.setValue(zone.loopEnd ?? 0x7FFFFFFF)
        box.loopFade.setValue(zone.loopFade ?? 0.0)
        box.loopAlternate.setValue(zone.alternate ?? false)
    })
})

const nano = (shape: (box: NanoDeviceBox) => void) => instrumentProject((source, unit, file) => {
    NanoDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.file.refer(file)
        box.release.setValue(0.05)
        shape(box)
    })
})

const convolver = (normalize: boolean) => (): BoxGraph => buildEffectProject(0.3, (source, unit) => {
    const file = createFile(source, SECONDS)
    return ConvolverDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.wet.setValue(-6.0)
        box.dry.setValue(-12.0)
        box.normalize.setValue(normalize)
        box.file.refer(file)
    })
})

const SCRIPT = `// @sample osc
class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, pos: 0, gain: velocity * 0.2}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        const sample = this.samples.osc
        if (!sample) { return }
        const left = sample.frames[0]
        const right = sample.frames[sample.numberOfChannels > 1 ? 1 : 0]
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                if (voice.pos < sample.numberOfFrames) {
                    l[i] += left[voice.pos] * voice.gain
                    r[i] += right[voice.pos] * voice.gain
                }
                voice.pos++
            }
        }
    }
}`

const apparat = instrumentProject((source, unit, file) => {
    const device = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + SCRIPT)
    })
    WerkstattSampleBox.create(source, UUID.generate(), box => {
        box.owner.refer(device.samples)
        box.label.setValue("osc")
        box.index.setValue(0)
        box.file.refer(file)
    })
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(device.address.uuid), 1, SCRIPT))()
})

describe("16 bit samples render bit-identical: audio regions", () => {
    it("native", async () => both("native", regions("native"), STEREO, 2, playWithJumps), 120_000)
    it("native, mono", async () => both("native mono", regions("native"), MONO, 1, playWithJumps), 120_000)
    it("native, at the engine's own rate", async () => both("native 48k", regions("native"), STEREO, 2, playWithJumps, 48_000), 120_000)
    it("time stretch, once", async () => both("grain once", regions("grain-once"), STEREO, 2, playWithJumps), 120_000)
    it("time stretch, repeat", async () => both("grain repeat", regions("grain-repeat"), STEREO, 2, playWithJumps), 120_000)
    it("time stretch, pingpong", async () => both("grain pingpong", regions("grain-pingpong"), STEREO, 2, playWithJumps), 120_000)
    it("Signalsmith", async () => both("signalsmith", regions("signalsmith"), STEREO, 2, playWithJumps), 180_000)
    it("Signalsmith, mono", async () => both("signalsmith mono", regions("signalsmith"), MONO, 1, playWithJumps), 180_000)
})

describe("16 bit samples render bit-identical: Sampler", () => {
    it("plain", async () => both("plain", sampler({}), STEREO, 2, play(400)), 120_000)
    it("mono", async () => both("mono", sampler({}), MONO, 1, play(400)), 120_000)
    it("tuned off the root", async () => both("tuned", sampler({root: 57, transpose: 2, tune: 31}), STEREO, 2, play(400)), 120_000)
    it("reversed", async () => both("reverse", sampler({reverse: true}), STEREO, 2, play(400)), 120_000)
    it("trimmed one shot", async () => both("one shot", sampler({start: 500, end: 9_000, oneShot: true}), STEREO, 2, play(400)), 120_000)
    it("looped with a crossfade", async () =>
        both("loop fade", sampler({loopMode: 2, loopStart: 2_000, loopEnd: 6_000, loopFade: 0.01}), STEREO, 2, play(400)), 120_000)
    it("looped while held", async () =>
        both("gate loop", sampler({loopMode: 1, loopStart: 1_000, loopEnd: 3_000, root: 62}), STEREO, 2, play(400)), 120_000)
    it("looped alternating", async () =>
        both("alternate", sampler({loopMode: 2, alternate: true, loopStart: 1_500, loopEnd: 4_000}), STEREO, 2, play(400)), 120_000)
})

describe("16 bit samples render bit-identical: Nano", () => {
    it("plain", async () => both("plain", nano(() => {}), STEREO, 2, play(400)), 120_000)
    it("mono", async () => both("mono", nano(() => {}), MONO, 1, play(400)), 120_000)
    it("looped with a crossfade", async () => both("loop", nano(box => {
        box.loop.setValue(true)
        box.loopStart.setValue(0.2)
        box.loopEnd.setValue(0.5)
        box.loopFade.setValue(0.02)
    }), STEREO, 2, play(400)), 120_000)
    it("backwards", async () => both("backwards", nano(box => {
        box.sampleStart.setValue(0.9)
        box.sampleEnd.setValue(0.1)
    }), STEREO, 2, play(400)), 120_000)
})

describe("16 bit samples render bit-identical: Convolver", () => {
    it("stereo impulse response", async () => both("stereo", convolver(false), noise(2, 6_000), 2, play(200)), 120_000)
    it("mono impulse response, normalised", async () => both("mono", convolver(true), noise(1, 6_000), 1, play(200)), 120_000)
    it("impulse response at the engine's own rate", async () => both("48k", convolver(false), noise(2, 6_000), 2, play(200), 48_000), 120_000)
})

describe("16 bit samples reach scripts as floats", () => {
    const offline = async (name: string, planar: Int16Array, channels: number): Promise<void> => {
        const source = apparat()
        expectSame(await render(source, planar, channels, "int16", play(120), RATE, true),
            await render(source, planar, channels, "float32", play(120), RATE, true), name)
    }
    it("an Apparat script plays a 16 bit sample like its float twin", async () => offline("apparat", STEREO, 2), 120_000)
    it("an Apparat script plays a mono 16 bit sample like its float twin", async () => offline("apparat mono", MONO, 1), 120_000)
})

describe("a long 16 bit sample is converted for a script a part per block", () => {
    // 400000 values, more than twelve blocks of conversion
    const LONG = noise(2, 200_000)
    const firstSounding = (output: Float32Array): number => {
        for (let quantum = 0; quantum * 256 < output.length; quantum++) {
            if (output.subarray(quantum * 256, (quantum + 1) * 256).some(value => value !== 0.0)) {return quantum}
        }
        return -1
    }
    it("the script sees no sample until it is whole, then plays it like its float twin", async () => {
        const source = apparat()
        const asFloats = await render(source, LONG, 2, "float32", play(40))
        const asInts = await render(source, LONG, 2, "int16", play(40))
        const [floatStart, intStart] = [firstSounding(asFloats), firstSounding(asInts)]
        expect(floatStart).toBe(0)
        expect(intStart, "the 16 bit sample needs some blocks").toBeGreaterThanOrEqual(3)
        expect(intStart).toBeLessThanOrEqual(16)
        const quanta = 20
        expectSame(asInts.slice(intStart * 256, (intStart + quanta) * 256), asFloats.slice(0, quanta * 256), "delayed start")
    }, 120_000)
})

describe("an offline render does not start without its 16 bit samples", () => {
    it("a script has a long 16 bit sample from the first block, the render equals the float one throughout", async () => {
        const source = apparat()
        const long = noise(2, 200_000)
        const asFloats = await render(source, long, 2, "float32", play(60), RATE, true)
        const asInts = await render(source, long, 2, "int16", play(60), RATE, true)
        expect(asInts.subarray(0, 256).some(value => value !== 0.0), "the first block sounds").toBe(true)
        expectSame(asInts, asFloats, "offline")
    }, 120_000)
})

describe("16 bit samples reach WebCLAP plugins as floats", () => {
    const bundle: WclapBundle = {files: [{path: "module.wasm", bytes: new Uint8Array(readFileSync(path.resolve(__dirname, "assets", "radar.wasm")))}]}
    const project = (): BoxGraph => buildEffectProject(0.0, (source, unit) => {
        const device = WclapDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.url.setValue("radar")
            box.clapId.setValue("com.andremichelle.radar")
        })
        const file = createFile(source, SECONDS)
        WclapSampleBox.create(source, UUID.generate(), box => {
            box.owner.refer(device.samples)
            box.index.setValue(0)
            box.file.refer(file)
        })
        return device
    }, "class Processor { process() {} }")
    // the plugin is loaded and ready before the sample arrives, so both runs start from the same state
    // `whole` hands the sample over in one block, as an offline render does
    const run = async (source: BoxGraph, planar: Int16Array, channels: number, format: Format, whole: boolean = true): Promise<Float32Array> => {
        const statuses: Array<WclapStatus> = []
        const {engine, memory} = await loadFullEngine(48_000, () => {}, () => null, {
            loadBundle: () => Promise.resolve(bundle),
            sendStatus: (_uuid, status) => statuses.push(status)
        })
        if (whole) {engine.set_sample_float_budget(0xFFFFFFFF)}
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle()
        engine.bind()
        await sync.settle()
        engine.set_metronome_enabled(0)
        for (let attempt = 0; attempt < 400 && !statuses.some(({state}) => state === "ready"); attempt++) {
            engine.render()
            await new Promise(resolve => setTimeout(resolve, 5))
        }
        expect(statuses.some(({state}) => state === "ready"), "the plugin loads").toBe(true)
        expect(serve(engine, memory, planar, channels, RATE, format)).toBe(1)
        await sync.settle()
        return play(300)(engine, memory)
    }
    it("Radar plays a 16 bit sample like its float twin", async () => {
        const source = project()
        const asFloats = await run(source, STEREO, 2, "float32")
        const again = await run(source, STEREO, 2, "float32")
        expectSame(again, asFloats, "two float runs, the control")
        expectSame(await run(source, STEREO, 2, "int16"), asFloats, "radar")
    }, 120_000)
    it("Radar gets a long 16 bit sample a part per block and plays it", async () => {
        const output = await run(project(), noise(2, 200_000), 2, "int16", false)
        expect(output.subarray(0, 256).every(value => value === 0.0), "nothing sounds before the sample is whole").toBe(true)
        expect(output.some(value => Math.abs(value) > 0.001)).toBe(true)
        expect(output.every(value => Number.isFinite(value))).toBe(true)
    }, 120_000)
    it("Radar plays a mono 16 bit sample like its float twin", async () => {
        const source = project()
        expectSame(await run(source, MONO, 1, "int16"), await run(source, MONO, 1, "float32"), "radar mono")
    }, 120_000)
})

describe("16 bit samples through the worklet's sample drain", () => {
    const pcmOf = (format: Format): PcmData => {
        const frames = STEREO.length / 2
        if (format === "int16") {
            const planes = PcmData.createInt16(frames, 2)
            planes.forEach((plane, channel) => plane.set(STEREO.subarray(channel * frames, (channel + 1) * frames)))
            return {format: "int16", sampleRate: RATE, numberOfFrames: frames, numberOfChannels: 2, frames: planes}
        }
        const audio = AudioData.create(RATE, frames, 2)
        audio.frames.forEach((plane, channel) => {
            for (let frame = 0; frame < frames; frame++) {plane[frame] = STEREO[channel * frames + frame] / 32_768}
        })
        return {format: "float32", ...audio}
    }
    const project = sampler({tune: 17})()
    const drained = async (client: (pcm: PcmData) => Partial<EngineToClient>, format: Format, announced?: boolean): Promise<Float32Array> => {
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, project)
        await sync.settle()
        engine.bind()
        await sync.settle()
        engine.set_metronome_enabled(0)
        const pending = new Set<Promise<unknown>>()
        const errors: Array<unknown> = []
        drainResourceRequests(engine, memory, {log: () => {}, ...client(pcmOf(format))} as unknown as EngineToClient, pending, 48_000,
            error => errors.push(error), announced)
        expect(pending.size, "the project asks for its sample").toBe(1)
        await Promise.all([...pending])
        expect(errors).toEqual([])
        await sync.settle()
        return play(300)(engine, memory)
    }
    it("fetchSample delivers 16 bit planes that play like floats", async () => {
        const asFloats = await drained(pcm => ({fetchSample: async () => pcm}), "float32")
        const asInts = await drained(pcm => ({fetchSample: async () => pcm}), "int16")
        expectSame(asInts, asFloats, "fetchSample")
    }, 120_000)
    it("a client that only answers fetchAudio still gets its floats played", async () => {
        const viaAudio = await drained(pcm => ({fetchAudio: async () => PcmData.floats(pcm)}), "float32")
        const viaSample = await drained(pcm => ({fetchSample: async () => pcm}), "float32")
        expectSame(viaAudio, viaSample, "fetchAudio fallback")
    }, 120_000)
    it("a host that does not announce fetchSample is asked for its floats, whatever the proxy offers", async () => {
        const asked: Array<string> = []
        const client = (pcm: PcmData): Partial<EngineToClient> => ({
            fetchSample: async () => {
                asked.push("sample")
                return pcm
            },
            fetchAudio: async () => {
                asked.push("audio")
                return PcmData.floats(pcm)
            }
        })
        const viaAudio = await drained(client, "float32", false)
        expect(asked).toEqual(["audio"])
        const viaSample = await drained(client, "float32", true)
        expect(asked).toEqual(["audio", "sample"])
        expectSame(viaAudio, viaSample, "announced or not")
    }, 120_000)
    it("fetchSample wins when both are answered", async () => {
        const silent = AudioData.create(RATE, STEREO.length / 2, 2)
        const both = await drained(pcm => ({fetchSample: async () => pcm, fetchAudio: async () => silent}), "int16")
        expect(both.some(value => Math.abs(value) > 0.001)).toBe(true)
    }, 120_000)
})
