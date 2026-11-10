import {
    DefaultObservableValue, isDefined, MutableObservableOption, Notifier, Observer, Option, panic, Terminable, tryCatch, UUID
} from "@opendaw/lib-std"
import {
    applyUpdateTasks, ArrayField, BoxGraph, Field, ObjectField, PointerField, UpdateTask, UpdateTasks
} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {AudioUnitBox, BoxIO, UserInterfaceBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
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
    compensationExceeded: new DefaultObservableValue(false),
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

// a project outside any room, recording and editing behave as without live sync
export const createSoloProject = async (): Promise<{project: Project, worklet: ReturnType<typeof createFakeWorklet>}> => {
    const {Project} = await import("../../project/Project")
    const project = Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
    const worklet = createFakeWorklet()
    project.engine.setWorklet(worklet as unknown as EngineWorklet)
    return {project, worklet}
}

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
    readonly engine: BoxGraph<BoxIO.TypeMap>
    readonly engineErrors: Array<string>
    online: boolean
    sent: number
}

const hex = (graph: BoxGraph): string =>
    Array.from(graph.checksum(), byte => (byte & 0xff).toString(16).padStart(2, "0")).join("")

// a pointer that names a target in the graph must also be an edge, the checksum only sees the address
export const lostEdges = (graph: BoxGraph): ReadonlyArray<string> => graph.boxes().flatMap(box => {
    const connected = new Set(box.outgoingEdges().map(([pointer]) => pointer))
    const walk = (fields: ReadonlyArray<Field>): ReadonlyArray<string> => fields.flatMap(field => field.accept<ReadonlyArray<string>>({
        visitPointerField: (pointer: PointerField) => pointer.targetAddress
            .mapOr(target => graph.findVertex(target).nonEmpty() && !connected.has(pointer) ? [pointer.toString()] : [], []),
        visitArrayField: (array: ArrayField) => walk(array.fields()),
        visitObjectField: (object: ObjectField<any>) => walk(object.fields())
    }) ?? [])
    return walk(box.fields())
})

// the engine's copy of the graph, fed like SyncSource: committed transactions only, nothing from a rollback
const mirrorEngine = (graph: BoxGraph<BoxIO.TypeMap>, errors: Array<string>): BoxGraph<BoxIO.TypeMap> => {
    const engine = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    const apply = (tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void => {
        const result = tryCatch(() => {
            engine.beginTransaction()
            tasks.forEach(task => {
                if (task.type !== "delete") {return applyUpdateTasks(engine, [task])}
                // the wasm engine drops a box with its own pointers, the box graph insists they are cleared first
                const box = engine.findBox(task.uuid).unwrap(() => `Could not find box ${UUID.toString(task.uuid)}`)
                box.outgoingEdges().forEach(([pointer]) => pointer.targetAddress = Option.None)
                engine.unstageBox(box)
            })
            engine.endTransaction()
        })
        if (result.status === "failure") {
            if (engine.inTransaction()) {engine.abortTransaction()}
            errors.push(String(result.error))
        }
    }
    apply(graph.boxes().map(box => ({type: "new", name: box.name as keyof BoxIO.TypeMap, uuid: box.address.uuid, buffer: box.toArrayBuffer()})))
    const tasks: Array<UpdateTask<BoxIO.TypeMap>> = []
    graph.subscribeToAllUpdatesImmediate({onUpdate: update => {tasks.push(UpdateTasks.of<BoxIO.TypeMap>(update))}})
    graph.subscribeTransaction({
        onBeginTransaction: () => {},
        onEndTransaction: rolledBack => {
            const batch = tasks.splice(0)
            if (!rolledBack && batch.length > 0) {apply(batch)}
        }
    })
    return engine
}

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
        const engineErrors: Array<string> = []
        const engine = mirrorEngine(peer.graph, engineErrors)
        const roomPeer: RoomPeer = {name, doc, boxes, worklet, inbox, outbox: [], engine, engineErrors, online: true, sent: 0, ...peer}
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
            peer.engineErrors.forEach(error => problems.push(`${peer.name} engine could not apply: ${error}`))
            lostEdges(peer.graph).forEach(pointer => problems.push(`${peer.name} lost the edge of ${pointer}`))
            peer.graph.boxes().forEach(box => {
                if (box instanceof AudioUnitBox && box.type.getValue() === AudioUnitType.Instrument && box.capture.isEmpty()) {
                    problems.push(`${peer.name} holds an instrument without a capture`)
                }
            })
            if (hex(peer.engine) !== hex(peer.graph)) {
                const differs = peer.graph.boxes().flatMap(box => peer.engine.findBox(box.address.uuid).mapOr(mirrored =>
                    JSON.stringify(mirrored.toJSON()) === JSON.stringify(box.toJSON()) ? [] : [`${box.name} differs`], [`${box.name} missing`]))
                const extra = peer.engine.boxes().filter(box => peer.graph.findBox(box.address.uuid).isEmpty()).map(box => `${box.name} extra`)
                problems.push(`${peer.name} engine mirror diverged from its graph: ${[...differs, ...extra].join(", ")}`)
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
