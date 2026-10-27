import {describe, expect, it} from "vitest"
import * as Y from "yjs"
import {asInstanceOf, Option, panic, Terminable, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, WclapDeviceBox, WclapParameterBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, WclapParamInfo} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {Project} from "../project/Project"
import {YSync} from "../ysync/YSync"
import {EffectFactories} from "../EffectFactories"
import {WclapParameters} from "./WclapParameters"
import {WclapStates} from "./WclapStates"

// Two clients in one live room, each running its own engine. Every engine hosts its own plugin instance and
// reports the plugin's parameter list and state blob into its own project, which YSync shares with the room.

type Peer = { doc: Y.Doc, project: Project }

const PARAMS: ReadonlyArray<WclapParamInfo> = [
    {id: 1, name: "Room", module: "", min: 0, max: 1, defaultValue: 0.5, value: 0.5, flags: 1},
    {id: 2, name: "Mix", module: "", min: 0, max: 1, defaultValue: 0.3, value: 0.3, flags: 1}
]

const deliver = (from: Peer, to: Peer): void =>
    Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), from)

const converge = (a: Peer, b: Peer): void => {
    for (let round = 0; round < 20; round++) {
        deliver(a, b)
        deliver(b, a)
        const sva = Y.encodeStateVector(a.doc)
        const svb = Y.encodeStateVector(b.doc)
        if (sva.length === svb.length && sva.every((byte, index) => byte === svb[index])) {return}
    }
    panic("did not converge")
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

// The room owner: a project with one WebCLAP effect that has a plugin selected
const createOwner = async (): Promise<{ peer: Peer, deviceUuid: string }> => {
    const {Project} = await import("../project/Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(createEnv(), skeleton)
    project.boxGraph.beginTransaction()
    const device = EffectFactories.AudioNamed.Wclap.create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0)
    if (!(device instanceof WclapDeviceBox)) {return panic("expected a WclapDeviceBox")}
    device.url.setValue("https://example.com/basics.wclap.tar.gz")
    device.clapId.setValue("uk.co.signalsmith.basics.reverb")
    project.boxGraph.endTransaction()
    const doc = new Y.Doc()
    project.own(await YSync.populateRoom({boxGraph: project.boxGraph, boxes: doc.getMap("boxes")}))
    return {peer: {doc, project}, deviceUuid: UUID.toString(device.address.uuid)}
}

// A second client joining the room, the way YService builds its project
const join = async (owner: Peer): Promise<Peer> => {
    const {Project} = await import("../project/Project")
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(owner.doc), owner)
    const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    const sync = await YSync.joinRoom({boxGraph, boxes: doc.getMap("boxes")})
    const project = Project.fromSkeleton(createEnv(), {boxGraph, mandatoryBoxes: ProjectSkeleton.findMandatoryBoxes(boxGraph)}, false)
    project.own(sync)
    return {doc, project}
}

const parameterIds = (peer: Peer, deviceUuid: string): Array<number> =>
    peer.project.boxGraph.findBox<WclapDeviceBox>(UUID.parse(deviceUuid)).unwrap()
        .parameters.pointerHub.incoming()
        .map(({box}) => asInstanceOf(box, WclapParameterBox).clapId.getValue())
        .sort((a, b) => a - b)

describe("WclapParameters in a live room", () => {
    it("a client joining after the parameters exist reuses them", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        WclapParameters.reconcile(owner.project, deviceUuid, PARAMS)
        const guest = await join(owner)
        WclapParameters.reconcile(guest.project, deviceUuid, PARAMS)
        converge(owner, guest)
        expect(parameterIds(owner, deviceUuid)).toStrictEqual([1, 2])
        expect(parameterIds(guest, deviceUuid)).toStrictEqual([1, 2])
    })

    it("both engines reporting the parameters at the same time create them once", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        const guest = await join(owner)
        WclapParameters.reconcile(owner.project, deviceUuid, PARAMS)
        WclapParameters.reconcile(guest.project, deviceUuid, PARAMS)
        converge(owner, guest)
        expect(parameterIds(owner, deviceUuid)).toStrictEqual([1, 2])
        expect(parameterIds(guest, deviceUuid)).toStrictEqual([1, 2])
        expect(owner.project.boxGraph.checksum()).toStrictEqual(guest.project.boxGraph.checksum())
    })

    // Slide numbers its parameters from 0, and a derivation that leaves id 0 unchanged hands out the device's uuid
    it("creates a parameter with clap id 0 without colliding with the device", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        const params = [0, 1, 0xFFFFFFFF].map(id => ({...PARAMS[0], id, name: `p${id}`}))
        WclapParameters.reconcile(owner.project, deviceUuid, params)
        expect(parameterIds(owner, deviceUuid)).toStrictEqual([-1, 0, 1])
        const uuids = owner.project.boxGraph.findBox<WclapDeviceBox>(UUID.parse(deviceUuid)).unwrap()
            .parameters.pointerHub.incoming().map(({box}) => UUID.toString(box.address.uuid))
        expect(uuids).not.toContain(deviceUuid)
    })

    it("both engines storing a state at the same time converge to one blob", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        const guest = await join(owner)
        WclapStates.store(owner.project, deviceUuid, new Uint8Array([1, 2, 3]).buffer)
        WclapStates.store(guest.project, deviceUuid, new Uint8Array([4, 5, 6]).buffer)
        converge(owner, guest)
        const stateOf = (peer: Peer) =>
            peer.project.boxGraph.findBox<WclapDeviceBox>(UUID.parse(deviceUuid)).unwrap().state.getValue()
        expect(stateOf(owner)).toBe(stateOf(guest))
    })
})

describe("WclapStates in a live room", () => {
    const deviceOf = (peer: Peer, deviceUuid: string): WclapDeviceBox =>
        peer.project.boxGraph.findBox<WclapDeviceBox>(UUID.parse(deviceUuid)).unwrap()
    const bytesOf = (peer: Peer, deviceUuid: string): Array<number> =>
        Array.from(new Uint8Array(deviceOf(peer, deviceUuid).pluginState.getValue().slice().buffer))

    // A client joining an existing room, migrated the way YService does it
    const joinMigrated = async (owner: Peer): Promise<Peer> => {
        const {Project} = await import("../project/Project")
        const {ProjectMigration} = await import("../project/ProjectMigration")
        const doc = new Y.Doc()
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(owner.doc), owner)
        const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        const sync = await YSync.joinRoom({boxGraph, boxes: doc.getMap("boxes")})
        const skeleton = {boxGraph, mandatoryBoxes: ProjectSkeleton.findMandatoryBoxes(boxGraph)}
        await ProjectMigration.migrate(createEnv(), skeleton)
        const project = Project.fromSkeleton(createEnv(), skeleton, false)
        project.own(sync)
        return {doc, project}
    }

    it("a state saved on one peer arrives byte exact on the other", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        const guest = await join(owner)
        const source = [0, 1, 127, 128, 255, 3]
        WclapStates.store(owner.project, deviceUuid, new Uint8Array(source).buffer)
        converge(owner, guest)
        expect(bytesOf(guest, deviceUuid)).toStrictEqual(source)
        expect(deviceOf(guest, deviceUuid).state.getValue()).toBe("")
    })

    it("both peers saving at once converge to one blob", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        const guest = await join(owner)
        WclapStates.store(owner.project, deviceUuid, new Uint8Array([1, 2, 3]).buffer)
        WclapStates.store(guest.project, deviceUuid, new Uint8Array([4, 5, 6, 7]).buffer)
        converge(owner, guest)
        expect(bytesOf(owner, deviceUuid)).toStrictEqual(bytesOf(guest, deviceUuid))
        expect([[1, 2, 3], [4, 5, 6, 7]]).toContainEqual(bytesOf(owner, deviceUuid))
        expect(owner.project.boxGraph.checksum()).toStrictEqual(guest.project.boxGraph.checksum())
    })

    it("a late joiner receives the current state", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        WclapStates.store(owner.project, deviceUuid, new Uint8Array([1]).buffer)
        WclapStates.store(owner.project, deviceUuid, new Uint8Array([2, 2]).buffer)
        const guest = await join(owner)
        expect(bytesOf(guest, deviceUuid)).toStrictEqual([2, 2])
    })

    it("storing the same state again writes nothing to the room", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        WclapStates.store(owner.project, deviceUuid, new Uint8Array([1, 2, 3]).buffer)
        const before = Y.encodeStateVector(owner.doc)
        WclapStates.store(owner.project, deviceUuid, new Uint8Array([1, 2, 3]).buffer)
        expect(Array.from(Y.encodeStateVector(owner.doc))).toStrictEqual(Array.from(before))
    })

    it("a room holding an old base64 state migrates once and nobody writes the string again", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        owner.project.boxGraph.beginTransaction()
        deviceOf(owner, deviceUuid).state.setValue(btoa(String.fromCharCode(9, 8, 7)))
        owner.project.boxGraph.endTransaction()
        const first = await joinMigrated(owner)
        expect(bytesOf(first, deviceUuid)).toStrictEqual([9, 8, 7])
        expect(deviceOf(first, deviceUuid).state.getValue()).toBe("")
        converge(owner, first)
        expect(bytesOf(owner, deviceUuid)).toStrictEqual([9, 8, 7])
        expect(deviceOf(owner, deviceUuid).state.getValue()).toBe("")
        const settled = Array.from(Y.encodeStateVector(owner.doc))
        const second = await joinMigrated(owner)
        converge(owner, second)
        expect(Array.from(Y.encodeStateVector(owner.doc))).toStrictEqual(settled)
        expect(bytesOf(second, deviceUuid)).toStrictEqual([9, 8, 7])
    })

    it("a 1 MB state syncs in one update and the room does not grow with every save", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        const guest = await join(owner)
        const size = 1 << 20
        const blob = (seed: number): ArrayBuffer => Uint8Array.from({length: size}, (_, index) => (index * seed) & 0xFF).buffer
        const vector = Y.encodeStateVector(guest.doc)
        WclapStates.store(owner.project, deviceUuid, blob(3))
        const update = Y.encodeStateAsUpdate(owner.doc, vector)
        expect(update.length).toBeGreaterThan(size)
        expect(update.length).toBeLessThan(size + 4096)
        const start = performance.now()
        Y.applyUpdate(guest.doc, update, owner)
        console.debug(`1 MB state applied on the other peer in ${(performance.now() - start).toFixed(1)} ms`)
        expect(bytesOf(guest, deviceUuid)).toStrictEqual(Array.from(new Uint8Array(blob(3))))
        for (let seed = 5; seed < 15; seed += 2) {
            WclapStates.store(owner.project, deviceUuid, blob(seed))
            converge(owner, guest)
        }
        expect(Y.encodeStateAsUpdate(owner.doc).length).toBeLessThan(2 * size)
        expect(bytesOf(guest, deviceUuid)).toStrictEqual(bytesOf(owner, deviceUuid))
    })
})

describe("WclapStates range sync in a live room", () => {
    const deviceOf = (peer: Peer, deviceUuid: string): WclapDeviceBox =>
        peer.project.boxGraph.findBox<WclapDeviceBox>(UUID.parse(deviceUuid)).unwrap()

    it("a state that differs from the last one in one byte sends about one chunk, not the whole state", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        const guest = await join(owner)
        const state = Uint8Array.from({length: 1 << 20}, (_, index) => (index * 31) & 0xff)
        WclapStates.store(owner.project, deviceUuid, state.slice().buffer)
        converge(owner, guest)
        const next = state.slice()
        next[400_000] ^= 0xff
        const vector = Y.encodeStateVector(guest.doc)
        WclapStates.store(owner.project, deviceUuid, next.buffer)
        const update = Y.encodeStateAsUpdate(owner.doc, vector)
        expect(update.length).toBeLessThan(16 * 1024 + 4096)
        Y.applyUpdate(guest.doc, update, owner)
        const received = new Uint8Array(deviceOf(guest, deviceUuid).pluginState.getValue().slice().buffer)
        expect(received.length).toBe(next.length)
        expect(received.every((byte, index) => byte === next[index])).toBe(true)
    })

    it("a state saved with a pattern inserted grows the state by its new bytes only", async () => {
        const {peer: owner, deviceUuid} = await createOwner()
        const guest = await join(owner)
        const state = Uint8Array.from({length: 200_000}, (_, index) => (index * 7) & 0xff)
        WclapStates.store(owner.project, deviceUuid, state.slice().buffer)
        converge(owner, guest)
        const next = new Uint8Array(state.length + 1024)
        next.set(state.subarray(0, 190_000))
        next.set(state.subarray(190_000), 191_024)
        const vector = Y.encodeStateVector(guest.doc)
        WclapStates.store(owner.project, deviceUuid, next.buffer)
        // an insert moves every chunk behind it, so this is honest about the cost: the tail travels
        const update = Y.encodeStateAsUpdate(owner.doc, vector)
        expect(update.length).toBeLessThan(next.length - 150_000)
        Y.applyUpdate(guest.doc, update, owner)
        expect(deviceOf(guest, deviceUuid).pluginState.getValue().length).toBe(next.length)
    })
})
