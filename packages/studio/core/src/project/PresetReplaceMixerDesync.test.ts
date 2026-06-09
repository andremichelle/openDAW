import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, tryCatch, UUID} from "@opendaw/lib-std"
import {
    AudioUnitBoxAdapter,
    AudioUnitFactory,
    Devices,
    InstrumentFactories,
    PresetEncoder,
    ProjectSkeleton,
    TrackType
} from "@opendaw/studio-adapters"
import {PresetDecoder} from "@opendaw/studio-adapters"
import {
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    CaptureMidiBox,
    RootBox,
    TrackBox,
    ValueEventCollectionBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import type {ProjectEnv} from "./ProjectEnv"

// Drives the real "Replace with preset" path (PresetApplication.createNewAudioUnitFromInstrument:
// api.createAnyInstrument + PresetDecoder.replaceAudioUnit) and then checks the exact invariant the
// Mixer/DevicePanel rely on: every audio unit in the graph must be enrolled in rootBox.audioUnits, with
// exactly one RootBox and one Output unit. A red here names the producing operation for #1005-1007.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

// A MIDI sampler-style preset (timeline + audio file), mirroring the Playfield preset in the report.
const buildPresetBytes = (): ArrayBuffer => {
    const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = source
    boxGraph.beginTransaction()
    const capture = CaptureMidiBox.create(boxGraph, UUID.generate())
    const unit = AudioUnitFactory.create(source, AudioUnitType.Instrument, Option.wrap(capture))
    VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
    const track = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(unit.tracks)
        box.target.refer(unit)
        box.index.setValue(0)
    })
    const file = AudioFileBox.create(boxGraph, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0); box.endInSeconds.setValue(2.0); box.fileName.setValue("s.wav")
    })
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.regions.refer(track.regions); box.file.refer(file); box.events.refer(events.owners)
        box.position.setValue(0); box.duration.setValue(1000)
    })
    boxGraph.endTransaction()
    return PresetEncoder.encode(unit, {includeTimeline: true}) as ArrayBuffer
}

describe("Replace-with-preset vs Mixer enrollment", () => {
    const assertEnrolled = (project: { boxGraph: any, rootBox: RootBox, boxAdapters: any, mixer: any }, round: number) => {
        const {boxGraph, rootBox, boxAdapters, mixer} = project
        const allUnits = boxGraph.boxes().filter((box: unknown) => box instanceof AudioUnitBox) as AudioUnitBox[]
        const enrolled = new Set(rootBox.audioUnits.pointerHub.incoming().map((pointer: any) => pointer.box))
        const rootCount = boxGraph.boxes().filter((box: unknown) => box instanceof RootBox).length
        const outputs = allUnits.filter(unit => unit.type.getValue() === AudioUnitType.Output)
        const orphans = allUnits.filter(unit => !enrolled.has(unit))
        const failures: string[] = []
        for (const unit of allUnits) {
            const adapter = boxAdapters.adapterFor(unit, AudioUnitBoxAdapter) as AudioUnitBoxAdapter
            const attempt = tryCatch(() => mixer.registerChannelStrip(adapter, {silent: () => {}}))
            if (attempt.status === "failure") {failures.push(`${unit.type.getValue()} ${UUID.toString(unit.address.uuid).slice(0, 8)}`)}
            else {attempt.value.terminate()}
        }
        if (rootCount !== 1 || outputs.length !== 1 || orphans.length > 0 || failures.length > 0) {
            console.warn(`[round ${round}] roots=${rootCount} outputs=${outputs.length} units=${allUnits.length} ` +
                `orphans=${orphans.length} registerFailures=[${failures.join(", ")}]`)
        }
        expect(rootCount, "RootBox count").toBe(1)
        expect(outputs.length, "Output unit count").toBe(1)
        expect(orphans.length, "units not in rootBox.audioUnits").toBe(0)
        expect(failures.length, "registerChannelStrip failures").toBe(0)
    }

    it("keeps every unit enrolled after createInstrument + replaceAudioUnit (twice, like #1005)", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const presetBytes = buildPresetBytes()

        for (let round = 1; round <= 2; round++) {
            project.editing.modify(() => {
                const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
                const attempt = PresetDecoder.replaceAudioUnit(presetBytes, product.audioUnitBox,
                    {keepMIDIEffects: true, keepAudioEffects: true})
                expect(attempt.isSuccess(), attempt.isFailure() ? String(attempt.failureReason()) : "ok").toBe(true)
            })
            assertEnrolled(project as any, round)
        }
        project.terminate()
    })
})
