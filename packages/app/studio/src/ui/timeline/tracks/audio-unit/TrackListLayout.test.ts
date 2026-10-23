import {describe, expect, it} from "vitest"
import {AudioUnitLayout, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {asDefined, isDefined, UUID} from "@opendaw/lib-std"
import {TrackListLayout} from "./TrackListLayout"

const fixture = () => {
    const skeleton = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
    const {rootBox, primaryAudioBusBox, primaryAudioUnitBox: output} = skeleton.mandatoryBoxes
    const graph = skeleton.boxGraph
    graph.beginTransaction()
    let index = 0
    const create = (group: boolean, parent?: AudioUnitBox): AudioUnitBox => AudioUnitBox.create(graph, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(index++)
        box.type.setValue(group ? AudioUnitType.Bus : AudioUnitType.Instrument)
        box.isGroup.setValue(group)
        if (isDefined(parent)) {box.groupParent.refer(parent.groupChildren)}
    })
    const outer = create(true), inner = create(true, outer), child = create(false, inner)
    const sibling = create(false, outer), outside = create(false)
    output.index.setValue(index)
    graph.endTransaction()
    const contents = new Map<AudioUnitBox, TrackListLayout.Channel<string>>([
        [outer, {unit: outer, automationCollapsed: false, lanes: [
            {content: "outer", automation: false}, {content: "outer-volume", automation: true}]}],
        [inner, {unit: inner, automationCollapsed: false, lanes: [{content: "inner", automation: false}]}],
        [child, {unit: child, automationCollapsed: false, lanes: [
            {content: "notes", automation: false}, {content: "audio", automation: false}, {content: "cutoff", automation: true}]}],
        [sibling, {unit: sibling, automationCollapsed: false, lanes: [{content: "sibling", automation: false}]}],
        [outside, {unit: outside, automationCollapsed: false, lanes: [{content: "outside", automation: false}]}]
    ])
    const layout = () => new TrackListLayout(new AudioUnitLayout(rootBox), contents, ["modulator-head", "modulator-value"])
    const edit = (operation: () => void) => {graph.beginTransaction(); operation(); graph.endTransaction()}
    return {outer, inner, child, output, rootBox, contents, layout, edit}
}

describe("flat track list projection", () => {
    it("projects group boundaries onto actual lanes and leaves a bare Output without a phantom row", () => {
        const {layout, output} = fixture()
        const snapshot = layout()
        expect(snapshot.rows.map(row => row.content)).toEqual([
            "outer", "outer-volume", "inner", "notes", "audio", "cutoff", "sibling", "outside", "modulator-head", "modulator-value"])
        expect(snapshot.rows.map(row => row.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        expect(snapshot.rows.map(row => row.indent)).toEqual([0, 0, 5, 10, 10, 10, 5, 0, 0, 0])
        expect(snapshot.boundaries.map(span => [span.start, span.end])).toEqual([[0, 7], [2, 6]])
        expect(snapshot.units.some(unit => unit.unit === output)).toBe(false)
        expect(snapshot.rows.slice(-2).every(row => row.unit === undefined)).toBe(true)
    })
    it("hides nested rows and recalculates boundaries without losing nested collapse state", () => {
        const {outer, inner, layout, edit} = fixture()
        edit(() => inner.groupCollapsed.setValue(true))
        expect(layout().rows.map(row => row.content)).toEqual([
            "outer", "outer-volume", "inner", "sibling", "outside", "modulator-head", "modulator-value"])
        expect(layout().boundaries.map(span => [span.start, span.end])).toEqual([[0, 4], [2, 3]])
        edit(() => outer.groupCollapsed.setValue(true))
        expect(layout().rows.map(row => row.content)).toEqual(["outer", "outside", "modulator-head", "modulator-value"])
        edit(() => outer.groupCollapsed.setValue(false))
        expect(inner.groupCollapsed.getValue()).toBe(true)
        expect(layout().rows.some(row => row.content === "notes")).toBe(false)
    })
    it("removes collapsed automation from both visible rows and group boundaries", () => {
        const {child, contents, layout} = fixture()
        const channel = asDefined(contents.get(child))
        contents.set(child, {...channel, automationCollapsed: true})
        const snapshot = layout()
        expect(snapshot.rows.map(row => row.content)).not.toContain("cutoff")
        expect(snapshot.boundaries.map(span => [span.start, span.end])).toEqual([[0, 6], [2, 5]])
    })
    it("drops empty channel spans rather than relying on DOM child counts", () => {
        const {child, contents, layout} = fixture()
        contents.delete(child)
        const snapshot = layout()
        expect(snapshot.units.some(unit => unit.unit === child)).toBe(false)
        expect(snapshot.boundaries.map(span => [span.start, span.end])).toEqual([[0, 4], [2, 3]])
    })
})
