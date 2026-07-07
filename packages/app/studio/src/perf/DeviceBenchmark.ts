import {Option, UUID} from "@opendaw/lib-std"
import {AudioUnitType, IconSymbol} from "@opendaw/studio-enums"
import {AudioUnitFactory, InstrumentFactories, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
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
} from "@opendaw/studio-boxes"
import {AudioData, PPQN, TimeBase} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"
import {Project, OfflineEngineRenderer, DefaultSampleLoader} from "@opendaw/studio-core"
import type {Peaks} from "@opendaw/lib-fusion"
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
        box.file.refer(boxGraph.findBox(sampleUuid).unwrap("findBox.sample"))
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
                boxGraph.findBox<AudioFileBox>(sampleUuid).unwrap("findBox.file"))
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
    // Soundfont is intentionally omitted: the A/B page renders both engines from real .sf2 bytes, and there is
    // no soundfont to self-provision from a synthetic skeleton (no bundle carries one here). It renders silent,
    // which understates its true cost since the voice/interpolation path never runs. Measure it via the
    // BundlePlayer page, which carries an actual .sf2.
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

type RenderResult = { elapsed: number, audio: Float32Array[], peak: number }

const SILENCE_THRESHOLD = 1e-6

const computePeak = (audio: ReadonlyArray<Float32Array>): number => {
    let peak = 0
    for (const channel of audio) {
        for (let i = 0; i < channel.length; i++) {
            const value = Math.abs(channel[i])
            if (value > peak) {peak = value}
        }
    }
    return peak
}

const renderAndMeasure = async (service: StudioService, skeleton: ProjectSkeleton,
                                sampleData: AudioData | null, variant: boolean): Promise<RenderResult> => {
    if (sampleData !== null) {
        injectSample(service, sampleData)
    }
    const project = Project.fromSkeleton(service, skeleton, false)
    const renderer = await OfflineEngineRenderer.create(project, Option.None, SAMPLE_RATE, variant)
    await renderer.waitForLoading()
    await renderer.play()
    const start = performance.now()
    const audio = await renderer.step(RENDER_SECONDS * SAMPLE_RATE)
    const elapsed = performance.now() - start
    renderer.stop()
    renderer.terminate()
    project.terminate()
    return {elapsed, audio, peak: computePeak(audio)}
}

export type BenchmarkProgress = {
    readonly current: string
    readonly index: number
    readonly total: number
}

const tryRender = async (service: StudioService, skeleton: ProjectSkeleton,
                         sampleData: AudioData | null, variant: boolean): Promise<RenderResult | string> => {
    try {
        return await renderAndMeasure(service, skeleton, sampleData, variant)
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error)
    }
}

// Render the SAME spec through both engines (fresh skeletons — a skeleton is consumed by its project).
const tryRenderBoth = async (service: StudioService, makeSkeleton: () => ProjectSkeleton,
                             sampleData: AudioData | null): Promise<[RenderResult | string, RenderResult | string]> => {
    const ts = await tryRender(service, makeSkeleton(), sampleData, false)
    const wasm = await tryRender(service, makeSkeleton(), sampleData, true)
    return [ts, wasm]
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
    const failure = (result: RenderResult | string, expectAudio: boolean): string | undefined => {
        if (typeof result === "string") {return result}
        if (expectAudio && result.peak < SILENCE_THRESHOLD) {
            return `silent — no audio produced (peak ${result.peak.toExponential(2)})`
        }
        return undefined
    }
    const emitResult = (ts: RenderResult | string, wasm: RenderResult | string, category: BenchmarkCategory,
                        name: string, baselines: {ts: number, wasm: number}, expectAudio: boolean) => {
        const tsError = failure(ts, expectAudio)
        const wasmError = failure(wasm, expectAudio)
        const tsResult = typeof ts === "string" ? undefined : ts
        const wasmResult = typeof wasm === "string" ? undefined : wasm
        const marginalMs = (tsResult?.elapsed ?? 0) - baselines.ts
        const wasmMarginalMs = (wasmResult?.elapsed ?? 0) - baselines.wasm
        onResult({
            category, name,
            renderMs: tsResult?.elapsed ?? 0,
            marginalMs,
            perQuantumUs: (marginalMs / totalQuanta) * 1000,
            wasmRenderMs: wasmResult?.elapsed,
            wasmMarginalMs: wasmResult === undefined ? undefined : wasmMarginalMs,
            wasmPerQuantumUs: wasmResult === undefined ? undefined : (wasmMarginalMs / totalQuanta) * 1000,
            durationSeconds: RENDER_SECONDS,
            audio: tsError === undefined ? tsResult?.audio : undefined,
            wasmAudio: wasmError === undefined ? wasmResult?.audio : undefined,
            error: tsError,
            wasmError
        })
    }
    const elapsedOf = (result: RenderResult | string): number => typeof result === "string" ? 0 : result.elapsed
    onProgress({current: "Warmup", index: step, total: totalDevices})
    await tryRenderBoth(service, () => ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}), null)
    step++
    onProgress({current: "Empty engine", index: step, total: totalDevices})
    const [emptyTs, emptyWasm] = await tryRenderBoth(service,
        () => ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}), null)
    const emptyBaselines = {ts: elapsedOf(emptyTs), wasm: elapsedOf(emptyWasm)}
    emitResult(emptyTs, emptyWasm, "Baseline", "Empty engine", emptyBaselines, false)
    step++
    onProgress({current: "Tape only", index: step, total: totalDevices})
    const [tapeTs, tapeWasm] = await tryRenderBoth(service, () => createTapeSkeleton(null), sampleData)
    const baselines = {ts: elapsedOf(tapeTs), wasm: elapsedOf(tapeWasm)}
    emitResult(tapeTs, tapeWasm, "Baseline", "Tape only", emptyBaselines, true)
    step++
    for (const effect of audioEffects) {
        onProgress({current: effect.name, index: step, total: totalDevices})
        const [ts, wasm] = await tryRenderBoth(service, () => createTapeSkeleton(effect), sampleData)
        emitResult(ts, wasm, "Audio Effect", effect.name, baselines, true)
        step++
    }
    for (const instrument of instruments) {
        onProgress({current: instrument.name, index: step, total: totalDevices})
        const [ts, wasm] = await tryRenderBoth(service, () => createInstrumentSkeleton(instrument),
            instrument.needsSample ? sampleData : null)
        emitResult(ts, wasm, "Instrument", instrument.name, baselines, true)
        step++
    }
    await service.audioContext.resume()
}
