import {describe, expect, it} from "vitest"
import {asDefined, asInstanceOf, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN, TimeBase} from "@opendaw/lib-dsp"
import {AudioRegionBoxAdapter, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {
    AudioFileBox, AudioRegionBox, AudioSignalsmithBox, BoxIO, TrackBox, ValueEventCollectionBox, WarpMarkerBox
} from "@opendaw/studio-boxes"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioContentHelpers} from "./AudioContentHelpers"
import {migrateWarpMarkers} from "../migration/MigrateWarpMarkers"
import type {ProjectEnv} from "../ProjectEnv"

// live error 1221: two warp markers at position 0 only crashed on a later sort, far from the edit that made them

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, soundfontManager: undefined,
    sampleService: undefined, soundfontService: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get meta() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    }
}) as unknown as ProjectEnv

const setup = async () => {
    const {Project} = await import("../Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const audioFileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => {
        box.fileName.setValue("loop.wav")
        box.endInSeconds.setValue(4.0)
    })
    const playMode = AudioSignalsmithBox.create(boxGraph, UUID.generate())
    AudioContentHelpers.addWarpMarkers(boxGraph, playMode, [
        {position: 0, seconds: 0.0}, {position: PPQN.Bar, seconds: 2.0}, {position: PPQN.Bar * 2, seconds: 4.0}
    ])
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(PPQN.Bar * 4)
        box.duration.setValue(PPQN.Bar * 2)
        box.loopDuration.setValue(PPQN.Bar * 2)
        box.timeBase.setValue(TimeBase.Musical)
        box.regions.refer(trackBox.regions)
        box.file.refer(audioFileBox)
        box.events.refer(events.owners)
        box.playMode.refer(playMode)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const adapter = project.boxAdapters.adapterFor(regionBox, AudioRegionBoxAdapter)
    return {project, adapter, playMode}
}

const positions = (playMode: AudioSignalsmithBox): Array<number> => playMode.warpMarkers.pointerHub.incoming()
    .map(({box}) => asInstanceOf(box, WarpMarkerBox).position.getValue()).sort((a, b) => a - b)

describe("WarpMarkerGuard", () => {
    it("fails the edit that puts a second warp marker onto an occupied position", async () => {
        const {project, playMode} = await setup()
        expect(() => project.boxGraph.beginTransaction()).not.toThrow()
        WarpMarkerBox.create(project.boxGraph, UUID.generate(), box => {
            box.owner.refer(playMode.warpMarkers)
            box.position.setValue(0)
            box.seconds.setValue(0.5)
        })
        expect(() => project.boxGraph.endTransaction()).toThrow(/Warp markers at the same position 0/)
        project.terminate()
    })

    it("fails the edit that moves a warp marker onto another", async () => {
        const {project, playMode} = await setup()
        const marker = asDefined(playMode.warpMarkers.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, WarpMarkerBox)).find(box => box.position.getValue() === PPQN.Bar))
        project.boxGraph.beginTransaction()
        marker.position.setValue(0)
        expect(() => project.boxGraph.endTransaction()).toThrow(/Warp markers at the same position 0/)
        project.terminate()
    })

    it("lets edits through that keep the positions apart", async () => {
        const {project, playMode} = await setup()
        project.editing.modify(() => WarpMarkerBox.create(project.boxGraph, UUID.generate(), box => {
            box.owner.refer(playMode.warpMarkers)
            box.position.setValue(PPQN.Bar / 2)
            box.seconds.setValue(1.0)
        }))
        expect(positions(playMode)).toEqual([0, PPQN.Bar / 2, PPQN.Bar, PPQN.Bar * 2])
        project.terminate()
    })
})

describe("moving the content start of a stretched region", () => {
    const moveAndWatch = async (delta: number) => {
        const {project, adapter, playMode} = await setup()
        const collisions: Array<number> = []
        const subscriptions = playMode.warpMarkers.pointerHub.incoming().map(({box}) =>
            asInstanceOf(box, WarpMarkerBox).position.subscribe(() => {
                const current = positions(playMode)
                if (new Set(current).size !== current.length) {collisions.push(...current)}
            }))
        project.editing.modify(() => adapter.moveContentStart(delta))
        subscriptions.forEach(subscription => subscription.terminate())
        const result = positions(playMode)
        project.terminate()
        return {collisions, result}
    }

    it("never lets a marker land on its unmoved neighbour when shifting right", async () => {
        const {collisions, result} = await moveAndWatch(-PPQN.Bar)
        expect(collisions).toEqual([])
        expect(result).toEqual([PPQN.Bar, PPQN.Bar * 2, PPQN.Bar * 3])
    })

    it("never lets a marker land on its unmoved neighbour when shifting left", async () => {
        const {collisions, result} = await moveAndWatch(PPQN.Bar)
        expect(collisions).toEqual([])
        expect(result).toEqual([-PPQN.Bar, 0, PPQN.Bar])
    })
})

describe("migrateWarpMarkers", () => {
    it("drops duplicate warp markers on a Signalsmith play-mode too", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        boxGraph.beginTransaction()
        const playMode = AudioSignalsmithBox.create(boxGraph, UUID.generate())
        ;[0, 0, PPQN.Bar].forEach(position => WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
            box.owner.refer(playMode.warpMarkers)
            box.position.setValue(position)
        }))
        boxGraph.endTransaction()
        migrateWarpMarkers(boxGraph, playMode)
        expect(positions(playMode)).toEqual([0, PPQN.Bar])
    })
})
