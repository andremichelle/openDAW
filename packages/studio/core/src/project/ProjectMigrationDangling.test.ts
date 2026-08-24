import {describe, expect, it} from "vitest"
import {BoxGraph} from "@opendaw/lib-box"
import {JSONValue, Option, UUID} from "@opendaw/lib-std"
import {AudioBusBox, AudioUnitBox, BoxIO, TapeDeviceBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {ProjectMigration} from "./ProjectMigration"
import {ProjectEnv} from "./ProjectEnv"

// Rebuild a project from JSON with some box simply absent, which is what a merged document (or a peer that
// deleted it) delivers. Loads with validation off, exactly as ProjectSkeleton.decode does, so the pointers
// naming the missing box survive into migrate().
const loadWithout = (build: (skeleton: ProjectSkeleton) => UUID.Bytes): ProjectSkeleton => {
    const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
    const removed = build(source)
    const json = source.boxGraph.toJSON() as Record<string, JSONValue>
    delete json[source.boxGraph.findBox(removed).unwrap("removed").address.toString()]
    const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    boxGraph.fromJSON(json, false)
    return {boxGraph, mandatoryBoxes: ProjectSkeleton.findMandatoryBoxes(boxGraph)}
}

const env = {sampleManager: {getOrCreate: () => {throw new Error("unused")}}} as unknown as ProjectEnv

describe("ProjectMigration with a missing pointer target", () => {
    // A target something knows how to rebuild: the existing groove branch reads "not set", which is what the
    // missing target now looks like, and it recreates the box. No rule anywhere mentions dangling.
    it("rebuilds a missing target the existing migration already handles", async () => {
        const skeleton = loadWithout(({mandatoryBoxes: {rootBox}}) =>
            rootBox.groove.targetVertex.unwrap("groove").box.address.uuid)
        const {mandatoryBoxes: {rootBox}} = skeleton
        await ProjectMigration.migrate(env, skeleton)
        expect(rootBox.isAttached(), "the RootBox that owned the broken pointer survives").toBe(true)
        expect(rootBox.groove.targetVertex.nonEmpty(), "and its groove is rebuilt").toBe(true)
    })

    // A target nothing knows how to rebuild: the device cannot exist without a host, so the final generic
    // pass removes it. This is the behaviour migrateSelectionBox used to hand-code for one box type.
    it("removes a box whose required target nothing can rebuild", async () => {
        const deviceId = UUID.generate()
        const skeleton = loadWithout(({boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}}) => {
            const unitId = UUID.generate()
            boxGraph.beginTransaction()
            const unit = AudioUnitBox.create(boxGraph, unitId, box => {
                box.type.setValue(AudioUnitType.Instrument)
                box.collection.refer(rootBox.audioUnits)
                box.output.refer(primaryAudioBusBox.input)
                box.index.setValue(1)
            })
            TapeDeviceBox.create(boxGraph, deviceId, box => box.host.refer(unit.input))
            boxGraph.endTransaction()
            return unitId
        })
        const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
        await ProjectMigration.migrate(env, skeleton)
        expect(boxGraph.findBox(deviceId).isEmpty(), "the hostless device is gone").toBe(true)
        expect(rootBox.isAttached(), "the rest of the project is not").toBe(true)
    })


    // Still reachable from the RootBox, so findOrphans does not see it. Only the mandatory rule does: a bus
    // routed into a bus that is gone has nowhere to send audio. Also the case that used to abort the whole
    // migration, because a later pass dereferences a pointer that is now unset.
    it("removes a still-reachable box whose required target is gone", async () => {
        const downstreamId = UUID.generate()
        const skeleton = loadWithout(({boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}}) => {
            const upstreamId = UUID.generate()
            boxGraph.beginTransaction()
            const upstream = AudioBusBox.create(boxGraph, upstreamId, box => {
                box.collection.refer(rootBox.audioBusses)
                box.output.refer(primaryAudioBusBox.input)
            })
            AudioBusBox.create(boxGraph, downstreamId, box => {
                box.collection.refer(rootBox.audioBusses)
                box.output.refer(upstream.input)
            })
            boxGraph.endTransaction()
            return upstreamId
        })
        const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
        await ProjectMigration.migrate(env, skeleton)
        expect(boxGraph.findBox(downstreamId).isEmpty(), "the bus with nowhere to route is gone").toBe(true)
        expect(rootBox.isAttached(), "the project is not").toBe(true)
    })

})
