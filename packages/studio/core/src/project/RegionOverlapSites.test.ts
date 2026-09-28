import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN, TimeBase} from "@opendaw/lib-dsp"
import {Xml} from "@opendaw/lib-xml"
import {FileReferenceSchema} from "@opendaw/lib-dawproject"
import {AudioFileBox, AudioRegionBox, AudioUnitBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, ProjectSkeleton, TrackBoxAdapter, Validator} from "@opendaw/studio-adapters"
import {ProjectValidation} from "./ProjectValidation"
import {RegionPushExistingResolver} from "../ui/timeline/RegionPushExistingResolver"
import {RegionKeepExistingResolver} from "../ui/timeline/RegionKeepExistingResolver"
import {DawProjectExporter} from "../dawproject/DawProjectExporter"
import type {ProjectEnv} from "./ProjectEnv"
import type {Project} from "./Project"

// Follow-up to live 1140. A seconds region stores its duration in SECONDS, its end in ppqn moves with the tempo
// and it ends where the next region starts, never an error. Every site below used to read that duration as if
// it were ppqn, each with its own idea of what an overlap is.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const SECONDS = 7.5 // 14400 ppqn at the default 120 bpm
const SECONDS_PPQN = PPQN.secondsToPulses(SECONDS, 120.0)

const sampleManager = {
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get meta() {return Option.None},
        get uuid() {return uuid}, get state() {return {type: "idle"} as const},
        invalidate() {}, subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
}

const fakeEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined, sampleManager,
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

type RegionSpec = { position: number, duration: number, timeBase: TimeBase }

const musical = (position: number, duration: number): RegionSpec => ({position, duration, timeBase: TimeBase.Musical})
const seconds = (position: number, duration: number): RegionSpec => ({position, duration, timeBase: TimeBase.Seconds})

const createRegion = (project: Project, trackBox: TrackBox, file: AudioFileBox, spec: RegionSpec): AudioRegionBox => {
    const events = ValueEventCollectionBox.create(project.boxGraph, UUID.generate())
    return AudioRegionBox.create(project.boxGraph, UUID.generate(), box => {
        box.position.setValue(spec.position)
        box.duration.setValue(spec.duration)
        box.loopDuration.setValue(spec.duration)
        box.timeBase.setValue(spec.timeBase)
        box.regions.refer(trackBox.regions)
        box.file.refer(file)
        box.events.refer(events.owners)
    })
}

// A Tape unit with one audio track per entry of `layout`, top to bottom.
const setup = async (layout: ReadonlyArray<ReadonlyArray<RegionSpec>>) => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(fakeEnv(), skeleton)
    const result = project.editing.modify(() => {
        const {audioUnitBox, trackBox: first} = project.api.createInstrument(InstrumentFactories.Tape)
        const file = AudioFileBox.create(project.boxGraph, UUID.generate(), box => {
            box.fileName.setValue("audio.wav")
            box.endInSeconds.setValue(SECONDS)
        })
        const trackBoxes = layout.map((_, index) => index === 0 ? first : project.api.createAudioTrack(audioUnitBox))
        const regions = layout.map((specs, index) => specs.map(spec => createRegion(project, trackBoxes[index], file, spec)))
        return {audioUnitBox, trackBoxes, regions}
    }, false).unwrap()
    return {project, skeleton, ...result}
}

const audioTracks = (audioUnitBox: AudioUnitBox): ReadonlyArray<TrackBox> => audioUnitBox.tracks.pointerHub.incoming()
    .map(({box}) => box as TrackBox)
    .sort((left, right) => left.index.getValue() - right.index.getValue())

const trackOf = (region: AudioRegionBox): TrackBox => region.regions.targetVertex.unwrap("no track").box as TrackBox

describe("loading a project", () => {
    it("keeps a seconds region that reaches over the next region", async () => {
        const {project, skeleton, regions: [[stacked, next]]} = await setup([[seconds(0, 30.0), musical(20, PPQN.Bar)]])
        ProjectValidation.validate(skeleton)
        expect(stacked.isAttached(), "30 seconds is not 30 ppqn").toBe(true)
        expect(next.isAttached()).toBe(true)
        project.terminate()
    })

    it("trims a musical overlap to the gap instead of deleting both regions", async () => {
        const {project, skeleton, regions: [[prev, next]]} =
            await setup([[musical(0, PPQN.Bar), musical(PPQN.Bar / 2, PPQN.Bar)]])
        ProjectValidation.validate(skeleton)
        expect(prev.isAttached()).toBe(true)
        expect(next.isAttached()).toBe(true)
        expect(prev.duration.getValue()).toBe(PPQN.Bar / 2)
        expect(Validator.hasOverlappingRegions(project.boxGraph)).toBe(false)
        project.terminate()
    })

    it("still deletes two regions stacked on the same position", async () => {
        const {project, skeleton, regions: [[prev, next]]} = await setup([[musical(0, PPQN.Bar), musical(0, PPQN.Bar)]])
        ProjectValidation.validate(skeleton)
        expect(prev.isAttached()).toBe(false)
        expect(next.isAttached()).toBe(false)
        project.terminate()
    })
})

describe("detecting overlaps", () => {
    const stackedAfterSeconds = [[seconds(0, 1.0), musical(PPQN.Bar, PPQN.Bar), musical(PPQN.Bar * 1.5, PPQN.Bar)]]

    it("a seconds region does not switch the check off for the rest of the track", async () => {
        const {project} = await setup(stackedAfterSeconds)
        expect(Validator.hasOverlappingRegions(project.boxGraph)).toBe(true)
        expect(project.invalid()).toBe(true)
        project.terminate()
    })

    it("a seconds region reaching over its successor is not an overlap", async () => {
        const {project} = await setup([[seconds(0, SECONDS), musical(PPQN.Bar, PPQN.Bar)]])
        expect(Validator.hasOverlappingRegions(project.boxGraph)).toBe(false)
        expect(project.invalid()).toBe(false)
        project.terminate()
    })
})

describe("finding room on another track", () => {
    // Top track holds one musical region, the track below is covered by a seconds region.
    const layout = [[musical(PPQN.Bar / 2, PPQN.Bar / 2)], [seconds(0, SECONDS)]]

    it("compactTracks does not stack a seconds region onto a region it covers", async () => {
        const {project, audioUnitBox, trackBoxes, regions: [, [covering]]} = await setup(layout)
        expect(SECONDS_PPQN).toBeGreaterThan(PPQN.Bar)
        project.editing.modify(() => project.api.compactTracks(audioUnitBox))
        expect(trackOf(covering)).toBe(trackBoxes[1])
        project.terminate()
    })

    it("push-existing does not push a region under a seconds region", async () => {
        const {project, audioUnitBox, trackBoxes, regions: [[pushed]]} = await setup(layout)
        const track = project.boxAdapters.adapterFor(trackBoxes[0], TrackBoxAdapter)
        project.editing.modify(() => RegionPushExistingResolver
            .fromRange(track, PPQN.Bar / 2, PPQN.Bar, project.api, project.boxAdapters)())
        expect(trackOf(pushed)).not.toBe(trackBoxes[1])
        expect(audioTracks(audioUnitBox).length).toBe(3)
        project.terminate()
    })

    it("keep-existing does not pick a track covered by a seconds region", async () => {
        const {project, audioUnitBox, trackBoxes} = await setup(layout)
        const track = project.boxAdapters.adapterFor(trackBoxes[0], TrackBoxAdapter)
        const target = project.editing.modify(() => RegionKeepExistingResolver
            .resolveTargetTrack(track, PPQN.Bar / 2, PPQN.Bar, project.api, project.boxAdapters), false).unwrap()
        expect(target.box).not.toBe(trackBoxes[1])
        expect(audioTracks(audioUnitBox).length).toBe(3)
        project.terminate()
    })
})

describe("dawproject export", () => {
    it("writes a seconds region's length in beats", async () => {
        const {project, skeleton} = await setup([[seconds(0, SECONDS)]])
        const schema = DawProjectExporter.write(skeleton, sampleManager as never, {
            write: (path: string): FileReferenceSchema => Xml.element({path, external: false}, FileReferenceSchema)
        })
        const xml = Xml.pretty(Xml.toElement("Project", schema))
        const beats = SECONDS_PPQN / PPQN.Quarter
        expect(xml).toContain(`duration="${beats}"`)
        expect(xml).toContain(`loopEnd="${beats}"`)
        project.terminate()
    })
})
