import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {MarkerBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {MixdownSection} from "./MixdownSection"
import type {ProjectEnv} from "./project/ProjectEnv"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined,
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

type Setup = {
    songEnd?: ppqn
    loop?: { from: ppqn, to: ppqn }
    markers?: ReadonlyArray<{ position: ppqn, label: string }>
}

const build = async ({songEnd, loop, markers}: Setup) => {
    const {Project} = await import("./project/Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox, timelineBox}} = skeleton
    boxGraph.beginTransaction()
    if (isDefined(songEnd)) {
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(songEnd)
            box.loopDuration.setValue(songEnd)
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
        })
    }
    if (isDefined(loop)) {
        timelineBox.loopArea.from.setValue(loop.from)
        timelineBox.loopArea.to.setValue(loop.to)
    }
    markers?.forEach(({position, label}) => MarkerBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(position)
        box.label.setValue(label)
        box.track.refer(timelineBox.markerTrack.markers)
    }))
    boxGraph.endTransaction()
    return Project.fromSkeleton(createEnv(), skeleton)
}

const summary = (sections: ReadonlyArray<MixdownSection>) =>
    sections.map(({type, label, start, end, passes, tail}) => ({type, label, start, end, passes, tail}))

const Bar = PPQN.Bar

describe("MixdownSection.collect", () => {
    it("lists entire song, both loop entries and every marker section in order", async () => {
        const project = await build({
            songEnd: Bar * 16,
            loop: {from: Bar * 2, to: Bar * 4},
            markers: [
                {position: Bar * 8, label: "Chorus"},
                {position: 0, label: "Intro"},
                {position: Bar * 4, label: "Verse"}
            ]
        })
        expect(summary(MixdownSection.collect(project))).toEqual([
            {type: "song", label: "Entire song", start: 0, end: Bar * 16, passes: 1, tail: true},
            {type: "loop", label: "Loop Area", start: Bar * 2, end: Bar * 4, passes: 1, tail: false},
            {type: "loop", label: "Loop Area (two passes)", start: Bar * 2, end: Bar * 4, passes: 2, tail: false},
            {type: "marker", label: "Intro", start: 0, end: Bar * 4, passes: 1, tail: false},
            {type: "marker", label: "Verse", start: Bar * 4, end: Bar * 8, passes: 1, tail: false},
            {type: "marker", label: "Chorus", start: Bar * 8, end: Bar * 16, passes: 1, tail: true}
        ])
        project.terminate()
    })
    it("offers the loop entries while the loop area is disabled", async () => {
        const project = await build({songEnd: Bar, loop: {from: 0, to: Bar}})
        expect(project.timelineBox.loopArea.enabled.getValue()).toBe(false)
        expect(MixdownSection.collect(project).filter(section => section.type === "loop")).toHaveLength(2)
        project.terminate()
    })
    it("skips the loop entries for an empty loop area", async () => {
        const project = await build({songEnd: Bar, loop: {from: Bar, to: Bar}})
        expect(MixdownSection.collect(project).map(section => section.key)).toEqual(["song"])
        project.terminate()
    })
    it("skips a zero length section between markers sharing a position", async () => {
        const project = await build({
            songEnd: Bar * 4,
            loop: {from: 0, to: 0},
            markers: [{position: Bar, label: "A"}, {position: Bar, label: "B"}, {position: Bar * 2, label: "C"}]
        })
        const markers = MixdownSection.collect(project).filter(section => section.type === "marker")
        expect(markers).toHaveLength(2)
        expect(markers.map(({start, end}) => [start, end])).toEqual([[Bar, Bar * 2], [Bar * 2, Bar * 4]])
        project.terminate()
    })
    it("skips the last marker when it sits at or past the song end", async () => {
        const project = await build({
            songEnd: Bar * 2,
            loop: {from: 0, to: 0},
            markers: [{position: 0, label: "A"}, {position: Bar * 3, label: "B"}]
        })
        expect(summary(MixdownSection.collect(project).filter(section => section.type === "marker"))).toEqual([
            {type: "marker", label: "A", start: 0, end: Bar * 3, passes: 1, tail: false}
        ])
        project.terminate()
    })
    it("names unlabelled markers by their index", async () => {
        const project = await build({songEnd: Bar * 2, loop: {from: 0, to: 0}, markers: [{position: 0, label: "  "}]})
        expect(MixdownSection.collect(project).at(-1)?.label).toBe("Marker 1")
        project.terminate()
    })
    it("keys markers by uuid and falls back to the entire song for an unknown key", async () => {
        const project = await build({songEnd: Bar, loop: {from: 0, to: 0}, markers: [{position: 0, label: "A"}]})
        const sections = MixdownSection.collect(project)
        const marker = sections.at(-1)
        expect(MixdownSection.find(sections, marker?.key ?? "")).toBe(marker)
        expect(MixdownSection.find(sections, "gone").type).toBe("song")
        project.terminate()
    })
})
