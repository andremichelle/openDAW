import {describe, expect, it} from "vitest"
import {isDefined, UUID} from "@opendaw/lib-std"
import {AudioBusBox, AudioUnitBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {AudioUnitGroups} from "./AudioUnitGroups"
import {AudioUnitLayout} from "./AudioUnitLayout"

describe("AudioUnitLayout", () => {
    it("knows which group buses have member tracks, collapsed ones included", () => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {rootBox, primaryAudioBusBox} = skeleton.mandatoryBoxes
        const graph = skeleton.boxGraph
        const create = (group: boolean, parent?: AudioUnitBox): AudioUnitBox => {
            const unit = AudioUnitBox.create(graph, UUID.generate(), box => {
                box.collection.refer(rootBox.audioUnits)
                box.output.refer((isDefined(parent) ? AudioUnitGroups.bus(parent).unwrap() : primaryAudioBusBox).input)
                box.type.setValue(group ? AudioUnitType.Bus : AudioUnitType.Instrument)
            })
            if (group) {
                AudioBusBox.create(graph, UUID.generate(), box => {
                    box.collection.refer(rootBox.audioBusses)
                    box.output.refer(unit.input)
                })
            }
            return unit
        }
        graph.beginTransaction()
        const outer = create(true), inner = create(true, outer), child = create(false, inner), empty = create(true)
        graph.endTransaction()
        const layout = () => new AudioUnitLayout(rootBox, unit => unit === inner)
        expect([outer, inner, child, empty].map(unit => layout().hasMembers(unit))).toEqual([true, true, false, false])
        graph.beginTransaction()
        child.delete()
        graph.endTransaction()
        expect(layout().hasMembers(inner)).toBe(false)
    })
})
