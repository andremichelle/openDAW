import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, tryCatch, UUID} from "@opendaw/lib-std"
import {PPQN, ppqn, TimeBase} from "@opendaw/lib-dsp"
import {AudioRegionBoxAdapter, ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"

// Live error 1307-1309 (and 1035, 998, 927-930): "duration(0) must be positive" from a loop-duration drag.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

type RegionSpec = Readonly<{ position: ppqn, length: number, timeBase: TimeBase }>

const setup = async (tempo: ReadonlyArray<[ppqn, number]>, specs: ReadonlyArray<RegionSpec>) => {
    const {Project, TimelineRange, RegionClipResolver} = await import("@opendaw/studio-core")
    const {Snapping} = await import("@/ui/timeline/Snapping.ts")
    const {RegionLoopDurationModifier} = await import("./RegionLoopDurationModifier.ts")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(600))
    const boxes = specs.map(({position, length, timeBase}) => {
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.timeBase.setValue(timeBase)
            box.position.setValue(position)
            box.duration.setValue(length)
            box.loopDuration.setValue(length)
            box.loopOffset.setValue(0)
            box.regions.refer(trackBox.regions)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as Parameters<typeof Project.fromSkeleton>[0], skeleton)
    if (tempo.length > 0) {
        const collection = project.timelineBoxAdapter.tempoTrackEvents.unwrap("tempo track").box
        project.editing.modify(() => tempo.forEach(([position, value]) =>
            ValueEventBox.create(project.boxGraph, UUID.generate(), box => {
                box.events.refer(collection.events)
                box.position.setValue(position)
                box.value.setValue(value)
            })))
    }
    const track = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    const regions = boxes.map(box => project.boxAdapters.adapterFor(box, AudioRegionBoxAdapter))
    const range = new TimelineRange({padding: 0})
    range.maxUnits = PPQN.fromSignature(256, 4)
    range.width = 8192
    range.showAll()
    const snapping = new Snapping(range)
    snapping.index = 3
    const element = {getBoundingClientRect: () => ({left: 0})} as unknown as Element
    const dragLoop = (selected: ReadonlyArray<AudioRegionBoxAdapter>, reference: AudioRegionBoxAdapter, toPulse: ppqn) => {
        const pointerPulse = reference.position + reference.loopDuration
        const modifier = RegionLoopDurationModifier.create(selected, {
            project, element, snapping, pointerPulse, reference
        }).unwrap("modifier")
        modifier.update({clientX: range.unitToX(toPulse), clientY: 0, altKey: false, shiftKey: false, ctrlKey: false})
        return modifier
    }
    return {project, track, regions, dragLoop, validate: () => RegionClipResolver.validateTrack(track)}
}

const Tempos: ReadonlyArray<ReadonlyArray<[ppqn, number]>> = [
    [],
    [[0, 120], [3840, 60], [7680, 180]],
    [[0, 90], [1920, 140], [11520, 70]]
]

describe("loop-duration drag keeps every region positive (#1307)", () => {
    it("sweep: seconds and musical audio regions, tempo automation, every delta", async () => {
        const failures: Array<string> = []
        for (const tempo of Tempos) {
            for (const firstBase of [TimeBase.Seconds, TimeBase.Musical]) {
                for (const position of [0, 1920, 3840, 5000]) {
                    const firstLength = firstBase === TimeBase.Seconds ? 2.5 : 4800
                    const probe = await setup(tempo, [{position, length: firstLength, timeBase: firstBase}])
                    const firstComplete = Math.ceil(probe.regions[0].complete)
                    probe.project.terminate()
                    for (const deltaPulse of [-7680, -3840, -960, -1, 0, 1, 960, 3840, 8960]) {
                        for (const selectBoth of [false, true]) {
                            const {project, regions, dragLoop, validate} = await setup(tempo, [
                                {position, length: firstLength, timeBase: firstBase},
                                {position: firstComplete, length: 1.75, timeBase: TimeBase.Seconds}
                            ])
                            const [first] = regions
                            const selected = selectBoth ? regions : [first]
                            selected.forEach(region => region.onSelected())
                            const modifier = dragLoop(selected, first, first.position + first.loopDuration + deltaPulse)
                            const pre = tryCatch(validate)
                            const approved = pre.status === "success" ? tryCatch(() => modifier.approve()) : pre
                            const result = pre.status === "failure" ? `pre ${String(pre.error)}`
                                : approved.status === "failure" ? `approve ${String(approved.error)}` : null
                            if (result !== null) {
                                failures.push(`tempo ${JSON.stringify(tempo)} ${firstBase} @${position} delta ${deltaPulse} both ${selectBoth}: ${result} → ${regions.map(region => `[${region.position}, d ${region.duration}, ld ${region.loopDuration}]`).join(" ")}`)
                            }
                            project.terminate()
                        }
                    }
                }
            }
        }
        expect(failures).toEqual([])
    })
})
