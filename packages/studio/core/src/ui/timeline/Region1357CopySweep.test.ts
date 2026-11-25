import {describe, expect, it, vi} from "vitest"
import {isDefined, Option, Terminable, tryCatch, UUID} from "@opendaw/lib-std"
import {PPQN, ppqn, TimeBase} from "@opendaw/lib-dsp"
import {
    AnyLoopableRegionBoxAdapter,
    AnyRegionBoxAdapter,
    ProjectSkeleton,
    TrackBoxAdapter,
    TrackType
} from "@opendaw/studio-adapters"
import {
    AudioFileBox,
    AudioRegionBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    ValueEventCollectionBox
} from "@opendaw/studio-boxes"
import {RegionModifyStrategies, RegionModifyStrategy} from "./RegionModifyStrategies"
import type {ProjectEnv} from "../../project/ProjectEnv"

// Live errors 1357 to 1359: "duration(0) must be positive" / "duration(-57600) must be positive" after a
// Ctrl-drag copy of selected regions (RegionMoveModifier copy: true) in clip mode. This sweeps layouts of several
// regions, selections and copy deltas, mirroring RegionMoveModifier.approve with copy = true.

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

const makeCopyStrategy = (deltaPosition: ppqn): RegionModifyStrategies => ({
    showOrigin: () => true,
    selectedModifyStrategy: (): RegionModifyStrategy => ({
        translateTrackIndex: (index) => index,
        readPosition: (region) => region.position + deltaPosition,
        readComplete: (region) => region.resolveComplete(region.position + deltaPosition),
        readMirror: () => false,
        readLoopOffset: (region) => (region as AnyLoopableRegionBoxAdapter).loopOffset,
        readLoopDuration: (region) => (region as AnyLoopableRegionBoxAdapter).resolveLoopDuration(region.position + deltaPosition),
        iterateRange: (regions, from, to) => regions.iterateRange(from - deltaPosition, to - deltaPosition)
    }),
    unselectedModifyStrategy: () => RegionModifyStrategy.Identity
})

type Kind = "note" | "musical" | "seconds"
type Span = { kind: Kind, position: number, duration: number, loopDuration: number, loopOffset: number }

const buildProject = async (layout: ReadonlyArray<Span>) => {
    const {Project} = await import("../../project/Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const audio = layout.some(({kind}) => kind !== "note")
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(audio ? TrackType.Audio : TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const fileBox = audio ? AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(600)) : null
    layout.forEach(({kind, position, duration, loopDuration, loopOffset}) => {
        if (kind === "note") {
            const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
            NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.duration.setValue(duration)
                box.loopDuration.setValue(loopDuration)
                box.loopOffset.setValue(loopOffset)
                box.regions.refer(trackBox.regions)
                box.events.refer(events.owners)
            })
        } else {
            const toBase = (pulses: number) => kind === "seconds" ? PPQN.pulsesToSeconds(pulses, 120) : pulses
            const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
            AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                box.timeBase.setValue(kind === "seconds" ? TimeBase.Seconds : TimeBase.Musical)
                box.position.setValue(position)
                box.duration.setValue(toBase(duration))
                box.loopDuration.setValue(toBase(loopDuration))
                box.loopOffset.setValue(toBase(loopOffset))
                box.regions.refer(trackBox.regions)
                if (isDefined(fileBox)) {box.file.refer(fileBox)}
                box.events.refer(events.owners)
            })
        }
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    return {project, trackAdapter}
}

const describeTrack = (track: TrackBoxAdapter): string => track.regions.collection.asArray()
    .map(region => `[${region.position}..${region.complete}]`).join(" ")

const runCopy = async (layout: ReadonlyArray<Span>, selected: ReadonlyArray<number>, delta: ppqn): Promise<Option<string>> => {
    const {project, trackAdapter} = await buildProject(layout)
    const regions: ReadonlyArray<AnyRegionBoxAdapter> = trackAdapter.regions.collection.asArray()
    const originals = selected.map(index => regions[index]).filter(isDefined)
    originals.forEach(region => region.onSelected())
    const attempt = tryCatch(() =>
        project.overlapResolver.apply([trackAdapter], originals, makeCopyStrategy(delta), 0, () => {
            originals.forEach(original => original.copyTo({
                position: original.position + delta,
                target: trackAdapter.box.regions,
                consolidate: true
            }))
        }))
    const after = describeTrack(trackAdapter)
    project.terminate()
    return attempt.status === "failure"
        ? Option.wrap(`${String((attempt.error as Error)?.message ?? attempt.error)} -> ${after}`)
        : Option.None
}

// deterministic pseudo random numbers, so a failure names a reproducible layout
const createRandom = (seed: number) => {
    let state = seed >>> 0
    return (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 0x100000000
    }
}

const generateLayout = (random: () => number): ReadonlyArray<Span> => {
    const audio = random() < 0.6
    const count = 2 + Math.floor(random() * 5)
    const spans: Array<Span> = []
    let position = Math.floor(random() * 4) * 960
    for (let i = 0; i < count; i++) {
        const kind: Kind = !audio ? "note" : random() < 0.5 ? "seconds" : "musical"
        const duration = kind === "seconds"
            ? 100 + Math.floor(random() * 7680)
            : (1 + Math.floor(random() * 16)) * 960
        const looped = kind !== "seconds" && random() < 0.4
        const loopDuration = looped ? (1 + Math.floor(random() * 4)) * 960 : duration
        const loopOffset = looped && random() < 0.5 ? Math.floor(random() * (loopDuration / 480)) * 480 : 0
        spans.push({kind, position, duration, loopDuration, loopOffset})
        position += Math.ceil(duration / 960) * 960 + (random() < 0.5 ? 0 : Math.floor(random() * 8) * 960)
    }
    return spans
}

describe("clip resolver keeps every region valid when selected regions are copied (1357 sweep)", () => {
    it("sweeps layouts, selections and copy deltas", async () => {
        const random = createRandom(1357)
        const deltas: ReadonlyArray<ppqn> = [-30720, -15360, -3840, -1920, 960, 1920, 2880, 3840, 7680, 15360, 30720]
        const failures: Array<string> = []
        for (let trial = 0; trial < 1500 && failures.length < 10; trial++) {
            const layout = generateLayout(random)
            const selected = layout.map((_, index) => index).filter(() => random() < 0.6)
            if (selected.length === 0) {continue}
            for (const delta of deltas) {
                if (layout[selected[0]].position + delta < 0) {continue}
                const result = await runCopy(layout, selected, delta)
                result.ifSome(message => failures.push(
                    `layout ${JSON.stringify(layout)} selected ${JSON.stringify(selected)} delta ${delta}: ${message}`))
            }
        }
        expect(failures, failures.join("\n")).toEqual([])
    }, 120_000)
})

describe("an invalid track after a clip edit logs the layout before and after (1357 diagnostics)", () => {
    it("logs regions-duration and regions-before, then rethrows", async () => {
        const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
        const layout: ReadonlyArray<Span> = [
            {kind: "note", position: 0, duration: 1920, loopDuration: 1920, loopOffset: 0},
            {kind: "note", position: 3840, duration: 1920, loopDuration: 1920, loopOffset: 0}
        ]
        const {project, trackAdapter} = await buildProject(layout)
        const [first, second] = trackAdapter.regions.collection.asArray()
        first.onSelected()
        const attempt = tryCatch(() => project.overlapResolver.apply([trackAdapter], [first], makeCopyStrategy(960), 0,
            () => {second.box.duration.setValue(0)}))
        expect(attempt.status).toBe("failure")
        const labels = debug.mock.calls.map(([label]) => label)
        expect(labels).toContain("regions-duration")
        expect(labels).toContain("regions-before")
        project.terminate()
        debug.mockRestore()
    })
})
