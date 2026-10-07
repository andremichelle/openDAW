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
