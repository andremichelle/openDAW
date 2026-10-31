import {DefaultObservableValue, isDefined, MutableObservableOption, Notifier, Observer, Option, panic, Terminable, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {BoxIO, UserInterfaceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TransportAnchor} from "@opendaw/studio-adapters"
import * as Y from "yjs"
import type {EngineWorklet} from "../../EngineWorklet"
import type {RecordingStart} from "../../Engine"
import type {Project} from "../../project/Project"
import type {ProjectEnv} from "../../project/ProjectEnv"
import {YSync} from "../YSync"

// A live room in one process: real projects, real YSync, real Y.Docs, and a network the test controls.
// Messages wait in each peer's inbox until delivered, so any interleaving, partition or late join can be replayed.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const Network = Symbol("network")
const MessageLimit = 20_000

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: {currentTime: 0, sampleRate: 48_000, outputLatency: 0}, audioWorklets: undefined, sampleManager: sampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
} as unknown as ProjectEnv)

export const createFakeWorklet = () => ({
    playbackTimestamp: new DefaultObservableValue(0),
    countInBeatsRemaining: new DefaultObservableValue(0),
    compensationLatency: new DefaultObservableValue(0),
    position: new DefaultObservableValue<ppqn>(0),
    bpm: new DefaultObservableValue(120),
    isPlaying: new DefaultObservableValue(false),
    isRecording: new DefaultObservableValue(false),
    isCountingIn: new DefaultObservableValue(false),
    markerState: new DefaultObservableValue(null),
    cpuLoad: new DefaultObservableValue(0),
    recordingStart: new MutableObservableOption<RecordingStart>(),
    recordingStop: new MutableObservableOption<RecordingStart>(),
    anchors: new Notifier<ReadonlyArray<TransportAnchor>>(),
    subscribeTransportAnchors(observer: Observer<ReadonlyArray<TransportAnchor>>) {return this.anchors.subscribe(observer)},
    ignoreNoteRegion: () => {},
    prepareRecordingState: () => {},
    preferences: {update: () => {}, subscribeAll: () => Terminable.Empty}
})

export interface RoomPeer {
    readonly name: string
    readonly doc: Y.Doc
    readonly boxes: Y.Map<unknown>
    readonly sync: YSync<BoxIO.TypeMap>
    readonly project: Project
    readonly graph: BoxGraph<BoxIO.TypeMap>
    readonly worklet: ReturnType<typeof createFakeWorklet>
    readonly inbox: Array<Uint8Array>
    readonly outbox: Array<Uint8Array>
    online: boolean
    sent: number
}

const hex = (graph: BoxGraph): string =>
    Array.from(graph.checksum(), byte => (byte & 0xff).toString(16).padStart(2, "0")).join("")

export class LiveRoom {
    static async create(names: ReadonlyArray<string>): Promise<LiveRoom> {
        const room = new LiveRoom()
        for (const name of names) {await room.join(name)}
        return room
    }

    readonly peers: Array<RoomPeer> = []

    peer(name: string): RoomPeer {return this.peers.find(peer => peer.name === name) ?? panic(`No peer ${name}`)}

    async join(name: string): Promise<RoomPeer> {
        const {Project} = await import("../../project/Project")
        const doc = new Y.Doc()
        doc.clientID = this.peers.length + 1
        const boxes = doc.getMap("boxes")
        const source = this.peers.find(({online}) => online)
        const peer = isDefined(source)
            ? await (async () => {
                Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc), Network)
                const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
                const sync = await YSync.joinRoom<BoxIO.TypeMap>({boxGraph, boxes})
                const mandatoryBoxes = ProjectSkeleton.findMandatoryBoxes(boxGraph)
                const project = Project.fromSkeleton(createEnv(), {boxGraph, mandatoryBoxes}, false)
                boxGraph.beginTransaction()
                const userInterfaceBox = UserInterfaceBox.create(boxGraph, UUID.generate(),
                    box => box.root.refer(mandatoryBoxes.rootBox.users))
                boxGraph.endTransaction()
                project.follow(userInterfaceBox)
                return {project, sync, graph: boxGraph}
            })()
            : await (async () => {
                const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
                const project = Project.fromSkeleton(createEnv(), skeleton)
                const sync = await YSync.populateRoom<BoxIO.TypeMap>({boxGraph: project.boxGraph, boxes})
                return {project, sync, graph: project.boxGraph}
            })()
        peer.project.own(peer.sync)
        peer.project.attachLiveSync(peer.sync)
        const worklet = createFakeWorklet()
        peer.project.engine.setWorklet(worklet as unknown as EngineWorklet)
        const inbox = this.peers.map(other => Y.encodeStateAsUpdate(other.doc))
        const roomPeer: RoomPeer = {name, doc, boxes, worklet, inbox, outbox: [], online: true, sent: 0, ...peer}
        this.peers.forEach(other => other.inbox.push(Y.encodeStateAsUpdate(doc)))
        doc.on("update", (update: Uint8Array, origin: unknown) => {
            if (origin === Network) {return}
            roomPeer.sent++
            if (roomPeer.online) {
                this.peers.forEach(other => {if (other !== roomPeer) {other.inbox.push(update)}})
            } else {
                roomPeer.outbox.push(update)
            }
        })
        this.peers.push(roomPeer)
        return roomPeer
    }

    deliverOne(peer: RoomPeer): boolean {
        if (!peer.online) {return false}
        const update = peer.inbox.shift()
        if (!isDefined(update)) {return false}
        Y.applyUpdate(peer.doc, update, Network)
        return true
    }

    // one random message, in any order, from any sender
    deliverRandom(random: () => number): boolean {
        const waiting = this.peers.filter(({online, inbox}) => online && inbox.length > 0)
        if (waiting.length === 0) {return false}
        const peer = waiting[Math.floor(random() * waiting.length)]
        const [update] = peer.inbox.splice(Math.floor(random() * peer.inbox.length), 1)
        Y.applyUpdate(peer.doc, update, Network)
        return true
    }

    flush(): void {
        let messages = 0
        let delivered = true
        while (delivered) {
            delivered = false
            this.peers.forEach(peer => {
                while (this.deliverOne(peer)) {
                    delivered = true
                    if (++messages > MessageLimit) {panic("The room never settles: peers keep answering each other")}
                }
            })
        }
    }

    // a disconnected client: edits and inbox pile up until it is back
    disconnect(peer: RoomPeer): void {peer.online = false}
    reconnect(peer: RoomPeer): void {
        peer.online = true
        peer.outbox.splice(0).forEach(update => this.peers.forEach(other => {if (other !== peer) {other.inbox.push(update)}}))
    }

    // every violated invariant of a settled room, empty when the room is healthy
    violations(): ReadonlyArray<string> {
        this.peers.forEach(peer => this.reconnect(peer))
        this.flush()
        const problems: Array<string> = []
        const [first] = this.peers
        const checksum = hex(first.graph)
        this.peers.forEach(peer => {
            if (hex(peer.graph) !== checksum) {
                const field = peer.graph.boxes().flatMap(box => first.graph.findBox(box.address.uuid).mapOr(other => {
                    const mine = JSON.stringify(box.toJSON())
                    const theirs = JSON.stringify(other.toJSON())
                    return mine === theirs ? [] : [`${box.name}: ${mine} vs ${theirs}`]
                }, [`${box.name} only here`])).at(0)
                problems.push(`${peer.name} differs from ${first.name}${isDefined(field) ? ` at ${field}` : ""}`)
            }
            if (peer.graph.boxes().length !== peer.boxes.size) {
                problems.push(`${peer.name} graph holds ${peer.graph.boxes().length} boxes, its document ${peer.boxes.size}`)
            }
            peer.graph.boxes().forEach(box => box.outgoingEdges().forEach(([pointer, target]) => {
                if (peer.graph.findVertex(target).isEmpty()) {problems.push(`${peer.name} dangling ${pointer.toString()}`)}
            }))
            if (peer.project.invalid()) {problems.push(`${peer.name} has overlapping regions`)}
        })
        return problems
    }

    // what a client joining right now would build from the document, compared with who is here
    async lateJoinerDiffers(): Promise<boolean> {
        const [first] = this.peers
        const doc = new Y.Doc()
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(first.doc), Network)
        const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        await YSync.joinRoom<BoxIO.TypeMap>({boxGraph, boxes: doc.getMap("boxes")})
        return hex(boxGraph) !== hex(first.graph)
    }

    terminate(): void {this.peers.forEach(({project}) => project.terminate())}
}

export const seededRandom = (seed: number): (() => number) => () => {
    seed = (seed + 0x6D2B79F5) | 0
    let mix = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mix = (mix + Math.imul(mix ^ (mix >>> 7), 61 | mix)) ^ mix
    return ((mix ^ (mix >>> 14)) >>> 0) / 4294967296
}

// UUIDs come from crypto.getRandomValues, with this a seed replays a room exactly
export const seedUuids = (random: () => number): void => {
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true, writable: true,
        value: <T extends ArrayBufferView>(array: T): T => {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
            bytes.forEach((_, index) => bytes[index] = Math.floor(random() * 256))
            return array
        }
    })
}
