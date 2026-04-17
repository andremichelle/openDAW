import {Option, UUID} from "@moises-ai/lib-std"
import {AudioUnitType, IconSymbol} from "@moises-ai/studio-enums"
import {AudioUnitFactory, InstrumentFactories, ProjectSkeleton, TrackType} from "@moises-ai/studio-adapters"
import {
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    CompressorDeviceBox,
    CrusherDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    FoldDeviceBox,
    GateDeviceBox,
    MaximizerDeviceBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    StereoToolDeviceBox,
    TidalDeviceBox,
    TrackBox,
    ValueEventCollectionBox,
    VocoderDeviceBox,
    WaveshaperDeviceBox,
    CaptureAudioBox,
    CaptureMidiBox
} from "@moises-ai/studio-boxes"
import {AudioData, PPQN, TimeBase} from "@moises-ai/lib-dsp"
import {BoxGraph} from "@moises-ai/lib-box"
import {Project, OfflineEngineRenderer, DefaultSampleLoader} from "@moises-ai/studio-core"
import type {Peaks} from "@moises-ai/lib-fusion"
import {StudioService} from "@/service/StudioService"
import {BenchmarkCategory, BenchmarkResult} from "./measure"

export const RENDER_SECONDS = 60
export const SAMPLE_RATE = 48_000

type DeviceSpec = {
    readonly name: string
    readonly addToUnit: (boxGraph: BoxGraph, audioUnitBox: AudioUnitBox) => void
}

const audioEffects: ReadonlyArray<DeviceSpec> = [
    {
        name: "Compressor",
        addToUnit: (boxGraph, unit) => CompressorDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Crusher",
        addToUnit: (boxGraph, unit) => CrusherDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Dattorro Reverb",
        addToUnit: (boxGraph, unit) => DattorroReverbDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Delay",
        addToUnit: (boxGraph, unit) => DelayDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Fold",
        addToUnit: (boxGraph, unit) => FoldDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Gate",
        addToUnit: (boxGraph, unit) => GateDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Maximizer",
        addToUnit: (boxGraph, unit) => MaximizerDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Reverb (FreeVerb)",
        addToUnit: (boxGraph, unit) => ReverbDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Revamp (EQ)",
        addToUnit: (boxGraph, unit) => RevampDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Stereo Tool",
        addToUnit: (boxGraph, unit) => StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Tidal",
        addToUnit: (boxGraph, unit) => TidalDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Vocoder",
        addToUnit: (boxGraph, unit) => VocoderDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    },
    {
        name: "Waveshaper",
        addToUnit: (boxGraph, unit) => WaveshaperDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
    }
]

const sampleUuid = UUID.generate()

const createSampleData = (): AudioData => {
    const durationFrames = SAMPLE_RATE * 10
    const data = AudioData.create(SAMPLE_RATE, durationFrames, 2)
    const [left, right] = data.frames
    for (let i = 0; i < durationFrames; i++) {
        const sample = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5
        left[i] = sample
        right[i] = sample
    }
    return data
}

const createTapeSkeleton = (effect: DeviceSpec | null): ProjectSkeleton => {
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph} = skeleton
    boxGraph.beginTransaction()
    const audioUnitBox = AudioUnitFactory.create(skeleton,
        AudioUnitType.Instrument, Option.wrap(CaptureAudioBox.create(boxGraph, UUID.generate())))
    InstrumentFactories.Tape.create(boxGraph, audioUnitBox.input, "Tape", IconSymbol.Tape)
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.target.refer(audioUnitBox)
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(audioUnitBox.tracks)
    })
    AudioFileBox.create(boxGraph, sampleUuid, box => {
        box.endInSeconds.setValue(10)
    })
    const valueEventCollectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.timeBase.setValue(TimeBase.Musical)
        box.position.setValue(0)
        box.duration.setValue(PPQN.Bar * 16)
        box.loopDuration.setValue(PPQN.Bar * 16)
        box.file.refer(boxGraph.findBox(sampleUuid).unwrap())
        box.events.refer(valueEventCollectionBox.owners)
        box.regions.refer(trackBox.regions)
    })
    if (effect !== null) {
        effect.addToUnit(boxGraph, audioUnitBox)
    }
    boxGraph.endTransaction()
    return skeleton
}

const defaultPitches = [60, 64, 67, 72, 60, 65, 69, 72, 60, 62, 65, 69]

const addNoteRegion = (boxGraph: BoxGraph, trackBox: TrackBox,
                       pitches: ReadonlyArray<number> = defaultPitches): void => {
    const noteEventCollectionBox = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    pitches.forEach((pitch, index) => {
        NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(index * PPQN.Quarter)
            box.duration.setValue(PPQN.Quarter * 0.9)
            box.pitch.setValue(pitch)
            box.velocity.setValue(0.8)
            box.events.refer(noteEventCollectionBox.events)
        })
    })
    NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(PPQN.Bar * 4)
        box.loopDuration.setValue(PPQN.Bar * 4)
        box.regions.refer(trackBox.regions)
        box.events.refer(noteEventCollectionBox.owners)
    })
}

type InstrumentSpec = {
    readonly name: string
    readonly needsSample: boolean
    readonly create: (skeleton: ProjectSkeleton) => void
}

const instruments: ReadonlyArray<InstrumentSpec> = [
    {
        name: "Vaporisateur",
        needsSample: false,
        create: (skeleton) => {
            const {boxGraph} = skeleton
            const audioUnitBox = AudioUnitFactory.create(skeleton,
                AudioUnitType.Instrument, Option.wrap(CaptureMidiBox.create(boxGraph, UUID.generate())))
            InstrumentFactories.Vaporisateur.create(boxGraph, audioUnitBox.input, "Vaporisateur", IconSymbol.Waveform)
            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.target.refer(audioUnitBox)
                box.type.setValue(TrackType.Notes)
                box.tracks.refer(audioUnitBox.tracks)
            })
            addNoteRegion(boxGraph, trackBox)
        }
    },
    {
        name: "Nano",
        needsSample: true,
        create: (skeleton) => {
            const {boxGraph} = skeleton
            const audioUnitBox = AudioUnitFactory.create(skeleton,
                AudioUnitType.Instrument, Option.wrap(CaptureMidiBox.create(boxGraph, UUID.generate())))
            AudioFileBox.create(boxGraph, sampleUuid, box => {
                box.endInSeconds.setValue(10)
            })
            InstrumentFactories.Nano.create(boxGraph, audioUnitBox.input, "Nano", IconSymbol.NanoWave,
                boxGraph.findBox<AudioFileBox>(sampleUuid).unwrap())
            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.target.refer(audioUnitBox)
                box.type.setValue(TrackType.Notes)
                box.tracks.refer(audioUnitBox.tracks)
            })
            addNoteRegion(boxGraph, trackBox)
        }
    },
    {
        name: "Playfield",
        needsSample: true,
        create: (skeleton) => {
            const {boxGraph} = skeleton
            const audioUnitBox = AudioUnitFactory.create(skeleton,
                AudioUnitType.Instrument, Option.wrap(CaptureMidiBox.create(boxGraph, UUID.generate())))
            AudioFileBox.create(boxGraph, sampleUuid, box => {
                box.endInSeconds.setValue(10)
            })
            const pads = [36, 38, 42, 46].map(note => ({
                note, uuid: sampleUuid, name: "perf-sine", durationInSeconds: 10, exclude: false
            }))
            InstrumentFactories.Playfield.create(boxGraph, audioUnitBox.input, "Playfield",
                IconSymbol.Playfield, pads)
            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.target.refer(audioUnitBox)
                box.type.setValue(TrackType.Notes)
                box.tracks.refer(audioUnitBox.tracks)
            })
            addNoteRegion(boxGraph, trackBox, [36, 38, 42, 46, 36, 38, 42, 46, 36, 38, 42, 46])
        }
    },
    {
        name: "Soundfont",
        needsSample: false,
        create: (skeleton) => {
            const {boxGraph} = skeleton
            const audioUnitBox = AudioUnitFactory.create(skeleton,
                AudioUnitType.Instrument, Option.wrap(CaptureMidiBox.create(boxGraph, UUID.generate())))
            InstrumentFactories.Soundfont.create(boxGraph, audioUnitBox.input, "Soundfont", IconSymbol.SoundFont)
            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.target.refer(audioUnitBox)
                box.type.setValue(TrackType.Notes)
                box.tracks.refer(audioUnitBox.tracks)
            })
            addNoteRegion(boxGraph, trackBox)
        }
    },
]

const createInstrumentSkeleton = (instrument: InstrumentSpec): ProjectSkeleton => {
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph} = skeleton
    boxGraph.beginTransaction()
    instrument.create(skeleton)
    boxGraph.endTransaction()
    return skeleton
}

const injectSample = (service: StudioService, sampleData: AudioData): void => {
    service.sampleManager.remove(sampleUuid)
    const loader = new DefaultSampleLoader(sampleUuid)
    const emptyPeaks: Peaks = {stages: [], data: [], numFrames: 0, numChannels: 0, nearest: () => null}
    loader.setLoaded(sampleData, emptyPeaks, {
        name: "perf-sine", duration: 10, sample_rate: SAMPLE_RATE, bpm: 120, origin: "openDAW"
    })
    service.sampleManager.record(loader)
}

type RenderResult = { elapsed: number, audio: Float32Array[] }

const renderAndMeasure = async (service: StudioService, skeleton: ProjectSkeleton,
                                sampleData: AudioData | null): Promise<RenderResult> => {
    if (sampleData !== null) {
        injectSample(service, sampleData)
    }
    const project = Project.fromSkeleton(service, skeleton, false)
    const renderer = await OfflineEngineRenderer.create(project, Option.None, SAMPLE_RATE)
    await renderer.waitForLoading()
    renderer.play()
    const start = performance.now()
    const audio = await renderer.step(RENDER_SECONDS * SAMPLE_RATE)
    const elapsed = performance.now() - start
    renderer.stop()
    renderer.terminate()
    project.terminate()
    return {elapsed, audio}
}

export type BenchmarkProgress = {
    readonly current: string
    readonly index: number
    readonly total: number
}

const tryRender = async (service: StudioService, skeleton: ProjectSkeleton,
                         sampleData: AudioData | null): Promise<RenderResult | string> => {
    try {
        return await renderAndMeasure(service, skeleton, sampleData)
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error)
    }
}

export const runAllBenchmarks = async (
    service: StudioService,
    onProgress: (progress: BenchmarkProgress) => void,
    onResult: (result: BenchmarkResult) => void
): Promise<void> => {
    await service.audioContext.suspend()
    const sampleData = createSampleData()
    const totalDevices = audioEffects.length + instruments.length + 3
    const totalQuanta = RENDER_SECONDS * SAMPLE_RATE / 128
    let step = 0
    const emitResult = (result: RenderResult | string, category: BenchmarkCategory,
                        name: string, baselineMs: number) => {
        if (typeof result === "string") {
            onResult({category, name, renderMs: 0, marginalMs: 0, perQuantumUs: 0,
                durationSeconds: RENDER_SECONDS, error: result})
        } else {
            const marginalMs = result.elapsed - baselineMs
            onResult({category, name, renderMs: result.elapsed, marginalMs,
                perQuantumUs: (marginalMs / totalQuanta) * 1000, durationSeconds: RENDER_SECONDS,
                audio: result.audio})
        }
    }
    onProgress({current: "Warmup", index: step, total: totalDevices})
    const warmupSkeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    await tryRender(service, warmupSkeleton, null)
    step++
    onProgress({current: "Empty engine", index: step, total: totalDevices})
    const emptySkeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const emptyResult = await tryRender(service, emptySkeleton, null)
    const emptyMs = typeof emptyResult === "string" ? 0 : emptyResult.elapsed
    emitResult(emptyResult, "Baseline", "Empty engine", emptyMs)
    step++
    onProgress({current: "Tape only", index: step, total: totalDevices})
    const baselineResult = await tryRender(service, createTapeSkeleton(null), sampleData)
    const baselineMs = typeof baselineResult === "string" ? 0 : baselineResult.elapsed
    emitResult(baselineResult, "Baseline", "Tape only", emptyMs)
    step++
    for (const effect of audioEffects) {
        onProgress({current: effect.name, index: step, total: totalDevices})
        emitResult(await tryRender(service, createTapeSkeleton(effect), sampleData),
            "Audio Effect", effect.name, baselineMs)
        step++
    }
    for (const instrument of instruments) {
        onProgress({current: instrument.name, index: step, total: totalDevices})
        emitResult(await tryRender(service, createInstrumentSkeleton(instrument),
            instrument.needsSample ? sampleData : null), "Instrument", instrument.name, baselineMs)
        step++
    }
    await service.audioContext.resume()
}
