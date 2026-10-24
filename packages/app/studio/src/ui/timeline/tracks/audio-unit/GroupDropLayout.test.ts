import {describe, expect, it} from "vitest"
import {AudioUnitLayout, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {asDefined, isDefined, UUID} from "@opendaw/lib-std"
import {GroupDropLayout} from "./GroupDropLayout"

const fixture = ({firstHeight = 48, groupHeight = 48, automationHeight = 0, horizontal = false} = {}) => {
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
    const first = create(false), group = create(true), child = create(false, group)
    const inner = create(true, group), leaf = create(false, inner), lastChild = create(false, group)
    const after = create(false), last = create(false)
    output.index.setValue(index)
    graph.endTransaction()
    const build = () => {
        const layout = new AudioUnitLayout(rootBox)
        let position = 100
        const rows: GroupDropLayout.Row[] = layout.visibleRows.filter(row => row.unit !== output).map(({unit}) => {
            const height = unit === first ? firstHeight : unit === group ? groupHeight : 48
            const bounds = horizontal ? {x: position, y: 100, width: 74, height: 500}
                : {x: 300, y: position, width: 1000, height: height + (unit === group ? automationHeight : 0)}
            const header = horizontal ? {...bounds, height: 64} : {...bounds, width: 288, height}
            position += horizontal ? 82 : bounds.height + 1
            return {unit, bounds, header}
        })
        const row = (unit: AudioUnitBox) => asDefined(rows.find(row => row.unit === unit))
        const resolve = (coordinate: number, cross = 360) => GroupDropLayout.resolve(layout, rows,
            horizontal ? {clientX: coordinate, clientY: cross} : {clientX: cross, clientY: coordinate}, horizontal).unwrap()
        return {layout, rows, row, resolve}
    }
    return {first, group, child, inner, leaf, lastChild, after, last, output, graph, build}
}

const line = (target: GroupDropLayout.Target): number => target.row.bounds.y
    + (target.after ? target.row.bounds.height : 0) - 1

describe("track drop layout", () => {
    it("anchors both sides of an ordinary gap to one insertion line", () => {
        const {first, group, build} = fixture()
        const {row, resolve} = build()
        const above = resolve(row(first).bounds.y + row(first).bounds.height - 1)
        const below = resolve(row(group).bounds.y + 1)
        expect(above.before).toBe(group)
        expect(below.before).toBe(group)
        expect(above.row).toBe(below.row)
        expect(above.after).toBe(false)
        expect(line(above)).toBe(line(below))
    })
    it("anchors nested sibling gaps once without changing their destination", () => {
        const {group, child, inner, build} = fixture()
        const {row, resolve} = build()
        const above = resolve(row(child).bounds.y + row(child).bounds.height - 1)
        const below = resolve(row(inner).bounds.y + 1)
        expect([above.parent, below.parent]).toEqual([group, group])
        expect([above.before, below.before]).toEqual([inner, inner])
        expect(above.row).toBe(below.row)
        expect(line(above)).toBe(line(below))
    })
    it("draws after an expanded group below its whole subtree rather than below its header", () => {
        const {group, lastChild, after, build} = fixture()
        const {row, resolve} = build()
        const headerBottom = resolve(row(group).header.y + row(group).header.height - 1)
        const childBottom = resolve(row(lastChild).bounds.y + row(lastChild).bounds.height - 1, 304)
        const nextTop = resolve(row(after).bounds.y + 1)
        expect([headerBottom.before, childBottom.before, nextTop.before]).toEqual([after, after, after])
        expect(headerBottom.row).toBe(row(after))
        expect(line(headerBottom)).toBe(line(childBottom))
        expect(line(childBottom)).toBe(line(nextTop))
    })
    it("uses one physical boundary for end-of-folder and following root positions", () => {
        const {group, lastChild, after, build} = fixture()
        const {row, resolve} = build()
        const inside = resolve(row(lastChild).bounds.y + row(lastChild).bounds.height - 1)
        const outside = resolve(row(after).bounds.y + 1)
        expect(inside.parent).toBe(group)
        expect(inside.before).toBeUndefined()
        expect(outside.parent).toBeUndefined()
        expect(inside.row).toBe(outside.row)
        expect(line(inside)).toBe(line(outside))
        expect(inside.indent).toBe(5)
        expect(outside.indent).toBe(0)
    })
    it("uses the real height of resized tracks and group headers", () => {
        const {first, group, after, build} = fixture({firstHeight: 160, groupHeight: 132, automationHeight: 48})
        const {row, resolve} = build()
        expect(resolve(row(first).bounds.y + 50).before).toBe(first)
        expect(resolve(row(first).bounds.y + 120).before).toBe(group)
        const inside = resolve(row(group).header.y + 66)
        expect(inside.inside).toBe(true)
        expect(inside.parent).toBe(group)
        expect(inside.row.header.width).toBe(288)
        expect(inside.row.header.height).toBe(132)
        const automation = resolve(row(group).header.y + 150)
        expect(automation.inside).toBe(false)
        expect(automation.before).toBe(after)
    })
    it("does not treat the clip launcher as the group header", () => {
        const {group, build} = fixture()
        const {row, resolve} = build()
        const header = row(group).header
        expect(resolve(header.y + header.height / 2, header.x + header.width / 2).inside).toBe(true)
        expect(resolve(header.y + header.height / 2, header.x + header.width + 10).inside).toBe(false)
    })
    it("handles folded groups and a hidden Output without losing the final insertion slot", () => {
        const {group, last, output, graph, build} = fixture()
        graph.beginTransaction()
        group.groupCollapsed.setValue(true)
        graph.endTransaction()
        const {rows, row, resolve} = build()
        expect(rows).toHaveLength(4)
        const target = resolve(row(last).bounds.y + row(last).bounds.height - 1)
        expect(target.before).toBe(output)
        expect(target.row).toBe(row(last))
        expect(target.after).toBe(true)
        expect(target.inside).toBe(false)
    })
    it("anchors both sides of mixer column gaps to the same boundary", () => {
        const {first, group, build} = fixture({horizontal: true})
        const {row, resolve} = build()
        const above = resolve(row(first).bounds.x + row(first).bounds.width - 1, 150)
        const below = resolve(row(group).bounds.x + 1, 150)
        expect([above.before, below.before]).toEqual([group, group])
        expect(above.row).toBe(below.row)
        expect(above.after).toBe(false)
    })
    it("returns no target for an empty visible list", () => {
        const {build} = fixture()
        expect(GroupDropLayout.resolve(build().layout, [], {clientX: 0, clientY: 0}, false).isEmpty()).toBe(true)
    })
})
