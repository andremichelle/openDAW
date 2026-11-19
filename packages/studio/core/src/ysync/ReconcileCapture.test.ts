import {describe, expect, it} from "vitest"
import * as Y from "yjs"
import {BoxGraph} from "@opendaw/lib-box"
import {Option, UUID} from "@opendaw/lib-std"
import {AudioUnitFactory, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {
    AudioUnitBox,
    BoxIO,
    CaptureAudioBox,
    CaptureMidiBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TapeDeviceBox,
    TrackBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitCapture} from "../project/AudioUnitCapture"
import {migrateAudioUnitBox} from "../project/migration"
import {deterministicReconcile} from "./Reconcile"
import {YSync} from "./YSync"

// Riffle (SDK 0.0.184): an instrument whose capture is empty was deleted by deterministicReconcile, with its
// tracks and regions, before ProjectMigration could restore the capture. It must get its capture back instead.

type Device = "midi" | "tape" | "none"

const createProject = (device: Device) => {
    const skeleton = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
    const {boxGraph} = skeleton
    boxGraph.beginTransaction()
    const unit = AudioUnitFactory.create(skeleton, AudioUnitType.Instrument, Option.None)
    if (device === "midi") {VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))}
    if (device === "tape") {TapeDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))}
    const track = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(device === "tape" ? TrackType.Audio : TrackType.Notes)
        box.tracks.refer(unit.tracks)
        box.target.refer(unit)
    })
    const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    const region = NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.duration.setValue(960)
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
    })
    boxGraph.endTransaction()
    return {boxGraph, unit, track, region}
}

const reconcile = (boxGraph: BoxGraph): boolean => {
    boxGraph.beginTransaction()
    const repaired = deterministicReconcile(boxGraph)
    boxGraph.endTransaction()
    return repaired
}

const captureOf = (unit: AudioUnitBox) => unit.capture.targetVertex.map(vertex => vertex.box).unwrapOrNull()

describe("deterministicReconcile: instrument without capture", () => {
    it("gives a note instrument a CaptureMidiBox derived from its uuid and keeps track and region", () => {
        const {boxGraph, unit, track, region} = createProject("midi")
        expect(reconcile(boxGraph)).toBe(true)
        const capture = captureOf(unit)
        expect(capture).toBeInstanceOf(CaptureMidiBox)
        expect(UUID.equals(capture!.address.uuid, AudioUnitCapture.deriveUUID(unit.address.uuid))).toBe(true)
        expect(unit.isAttached() && track.isAttached() && region.isAttached()).toBe(true)
        expect(reconcile(boxGraph)).toBe(false)
    })

    it("gives Tape a CaptureAudioBox", () => {
        const {boxGraph, unit} = createProject("tape")
        reconcile(boxGraph)
        expect(captureOf(unit)).toBeInstanceOf(CaptureAudioBox)
    })

    it("still deletes a unit that has no instrument to capture for", () => {
        const {boxGraph, unit, region} = createProject("none")
        expect(reconcile(boxGraph)).toBe(true)
        expect(unit.isAttached()).toBe(false)
        expect(region.isAttached()).toBe(false)
    })

    it("derives a valid uuid that differs from the unit's", () => {
        const unitUUID = UUID.generate()
        const derived = AudioUnitCapture.deriveUUID(unitUUID)
        expect(UUID.equals(derived, unitUUID)).toBe(false)
        expect(UUID.validateString(UUID.toString(derived))).toBe(true)
        expect(UUID.equals(derived, AudioUnitCapture.deriveUUID(unitUUID))).toBe(true)
    })
})

describe("migrateAudioUnitBox", () => {
    it("restores the capture of any note instrument", () => {
        const {boxGraph, unit} = createProject("midi")
        migrateAudioUnitBox(boxGraph, unit)
        expect(captureOf(unit)).toBeInstanceOf(CaptureMidiBox)
    })

    it("panics on a unit with neither capture nor instrument", () => {
        const {boxGraph, unit} = createProject("none")
        expect(() => migrateAudioUnitBox(boxGraph, unit)).toThrow()
        boxGraph.abortTransaction()
    })
})

describe("YSync: instrument without capture in a room", () => {
    const joinTwice = async (boxes: Y.Map<unknown>) => {
        const peers: Array<{doc: Y.Doc, boxGraph: BoxGraph<BoxIO.TypeMap>}> = []
        for (let index = 0; index < 2; index++) {
            const doc = new Y.Doc()
            Y.applyUpdate(doc, Y.encodeStateAsUpdate(boxes.doc!))
            const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
            await YSync.joinRoom<BoxIO.TypeMap>({boxGraph, boxes: doc.getMap("boxes")})
            peers.push({doc, boxGraph})
        }
        return peers
    }

    it("joining peers restore the same capture and write it to the room", async () => {
        const {boxGraph, unit, region} = createProject("midi")
        const doc = new Y.Doc()
        const sync = await YSync.populateRoom<BoxIO.TypeMap>({boxGraph, boxes: doc.getMap("boxes")})
        const peers = await joinTwice(doc.getMap("boxes"))
        const captureKey = UUID.toString(AudioUnitCapture.deriveUUID(unit.address.uuid))
        for (const peer of peers) {
            const joinedUnit = peer.boxGraph.findBox<AudioUnitBox>(unit.address.uuid).unwrap()
            expect(captureOf(joinedUnit)).toBeInstanceOf(CaptureMidiBox)
            expect(peer.boxGraph.findBox(region.address.uuid).nonEmpty()).toBe(true)
            expect(peer.doc.getMap("boxes").has(captureKey)).toBe(true)
        }
        Y.applyUpdate(peers[1].doc, Y.encodeStateAsUpdate(peers[0].doc))
        Y.applyUpdate(peers[0].doc, Y.encodeStateAsUpdate(peers[1].doc))
        const [first, second] = peers.map(peer => peer.boxGraph.findBox<AudioUnitBox>(unit.address.uuid).unwrap())
        expect(captureOf(first)!.address.uuid).toEqual(captureOf(second)!.address.uuid)
        sync.terminate()
    })

    it("a merge that removes the capture restores it instead of deleting the unit", async () => {
        const {boxGraph, unit, region} = createProject("midi")
        boxGraph.beginTransaction()
        unit.capture.refer(CaptureMidiBox.create(boxGraph, UUID.generate()))
        boxGraph.endTransaction()
        const captureKey = UUID.toString(captureOf(unit)!.address.uuid)
        const doc = new Y.Doc()
        const sync = await YSync.populateRoom<BoxIO.TypeMap>({boxGraph, boxes: doc.getMap("boxes")})
        const remote = new Y.Doc()
        Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
        remote.getMap("boxes").delete(captureKey)
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)), "remote")
        expect(unit.isAttached() && region.isAttached()).toBe(true)
        const capture = captureOf(unit)
        expect(capture).toBeInstanceOf(CaptureMidiBox)
        expect(UUID.equals(capture!.address.uuid, AudioUnitCapture.deriveUUID(unit.address.uuid))).toBe(true)
        expect(doc.getMap("boxes").has(UUID.toString(capture!.address.uuid))).toBe(true)
        sync.terminate()
    })
})
