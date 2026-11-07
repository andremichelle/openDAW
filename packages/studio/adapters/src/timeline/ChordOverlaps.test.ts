import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ChordEventBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {ChordOverlaps} from "./ChordOverlaps"

const bar = 3840

const setup = () => {
    const {boxGraph, mandatoryBoxes: {timelineBox}} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const add = (position: number, duration: number, degree: number) => ChordEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(position)
        box.duration.setValue(duration)
        box.degree.setValue(degree)
        box.track.refer(timelineBox.chordTrack.events)
    })
    const chords = () => timelineBox.chordTrack.events.pointerHub.incoming()
        .map(({box}) => box as ChordEventBox)
        .map(box => [box.position.getValue(), box.duration.getValue(), box.degree.getValue()])
        .sort((left, right) => left[0] - right[0])
    const resolve = (inserted: ReadonlyArray<ChordEventBox>) => {
        const all = timelineBox.chordTrack.events.pointerHub.incoming().map(({box}) => box as ChordEventBox)
        ChordOverlaps.resolve(boxGraph, all, inserted)
    }
    return {boxGraph, add, chords, resolve}
}

describe("ChordOverlaps", () => {
    it("splits a longer chord around the inserted one", () => {
        const {boxGraph, add, chords, resolve} = setup()
        boxGraph.beginTransaction()
        add(0, bar * 4, 1)
        const inserted = add(bar, bar, 5)
        resolve([inserted])
        boxGraph.endTransaction()
        expect(chords()).toEqual([[0, bar, 1], [bar, bar, 5], [bar * 2, bar * 2, 1]])
    })
    it("shortens, moves and removes covered chords", () => {
        const {boxGraph, add, chords, resolve} = setup()
        boxGraph.beginTransaction()
        add(0, bar, 1)
        add(bar, bar, 2)
        add(bar * 2, bar, 3)
        const inserted = add(bar / 2, bar * 2, 6)
        resolve([inserted])
        boxGraph.endTransaction()
        expect(chords()).toEqual([[0, bar / 2, 1], [bar / 2, bar * 2, 6], [bar * 5 / 2, bar / 2, 3]])
    })
    it("keeps the inserted chords untouched by each other", () => {
        const {boxGraph, add, chords, resolve} = setup()
        boxGraph.beginTransaction()
        add(0, bar * 3, 1)
        const first = add(0, bar, 4)
        const second = add(bar, bar, 5)
        resolve([first, second])
        boxGraph.endTransaction()
        expect(chords()).toEqual([[0, bar, 4], [bar, bar, 5], [bar * 2, bar, 1]])
    })
})
