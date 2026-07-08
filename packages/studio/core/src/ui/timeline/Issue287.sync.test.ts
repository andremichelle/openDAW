// Regression (#287): dragging a block of audio regions over existing ones clips/splits the ground
// regions; undoing that inverse-trims the split regions (setValue on duration/loopOffset/loopDuration)
// and then unstages them WITHIN ONE transaction. The WASM SyncSource ships that as a single forward-only
// batch [update-primitive .../11, ..., delete uuid]. The serializer used to re-resolve each field's codec
// from the LIVE (post-transaction) graph, where the just-deleted box is gone -> "no field at <uuid>/11",
// thrown out of endTransaction (surfaced as "History changed by another participant") and poisoning the
// batch. The fix makes every update-primitive task self-contained (it carries its primitiveType), so the
// batch is serializable without touching the graph. This drives the exact reported file through the real
// SyncSource and asserts: (a) the undo really does emit primitive updates for boxes it deletes in the same
// batch (the bug shape), and (b) every such task still carries a resolvable primitiveType.

import {describe, expect, it} from "vitest"
import {isDefined, Notifier, Observer, Option, panic, Subscription, Terminable, tryCatch, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Address, Synchronization, SyncSource, UpdateTask, ValueSerialization} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {TrackBoxAdapter, AnyRegionBoxAdapter, AnyLoopableRegionBoxAdapter} from "@opendaw/studio-adapters"
import {ppqn, RegionCollection} from "@opendaw/lib-dsp"
import {readFileSync} from "fs"
import {resolve} from "path"
import {RegionModifyStrategies, RegionModifyStrategy} from "./RegionModifyStrategies"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}
const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})
const createAudioNode = (): any => new Proxy({
    gain: {value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}}, pan: {value: 0, setValueAtTime() {}}
}, {get: (target, prop) => prop in target ? (target as any)[prop] : (() => createAudioNode())})
const createAudioContext = (): any => new Proxy({
    sampleRate: 48000, currentState: "running", destination: createAudioNode()
}, {get: (target, prop) => prop in target ? (target as any)[prop] : (() => createAudioNode())})
const createEnv = () => ({
    audioContext: createAudioContext(), audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as any
const loadProject = async () => {
    const {Project} = await import("../../project/Project")
    const path = resolve(__dirname, "../../../../../../test-files/audio-bug.od")
    const buffer = readFileSync(path)
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    return Project.loadAnyVersion(createEnv(), arrayBuffer as ArrayBuffer)
}
const findTrackWithRegions = (project: any): TrackBoxAdapter =>
    project.rootBoxAdapter.audioUnits.adapters()
        .flatMap((unit: any) => unit.tracks.values())
        .find((track: TrackBoxAdapter) => track.regions.collection.asArray().length > 0)!
// A synchronous in-process Messenger pair (mirror of core-wasm's createSyncLoopback), so SyncSource's
// batches are delivered to the target within the same endTransaction call stack, exactly like WasmEngine.
const createSyncLoopback = (): {source: Messenger, target: Messenger} & Terminable => {
    const toTarget = new Notifier<any>()
    const toSource = new Notifier<any>()
    const port = (outgoing: Notifier<any>, incoming: Notifier<any>): Messenger => ({
        send: (message: any): void => outgoing.notify(message),
        channel: (): Messenger => panic("no channels"),
        subscribe: (observer: Observer<any>): Subscription => incoming.subscribe(observer),
        terminate: (): void => {}
    })
    return {
        source: port(toTarget, toSource),
        target: port(toSource, toTarget),
        terminate: (): void => {toTarget.terminate(); toSource.terminate()}
    }
}

const makeMoveStrategy = (deltaPosition: ppqn): RegionModifyStrategies => ({
    showOrigin: () => false,
    selectedModifyStrategy: (): RegionModifyStrategy => ({
        translateTrackIndex: (index) => index,
        readPosition: (region) => region.position + deltaPosition,
        readComplete: (region) => region.resolveComplete(region.position + deltaPosition),
        readLoopDuration: (region) => (region as AnyLoopableRegionBoxAdapter).resolveLoopDuration(region.position + deltaPosition),
        readMirror: (region) => region.canMirror && region.isMirrowed,
        readLoopOffset: (region) => (region as AnyLoopableRegionBoxAdapter).loopOffset,
        iterateRange: <R extends AnyRegionBoxAdapter>(regions: RegionCollection<R>, from: ppqn, to: ppqn) =>
            regions.iterateRange(from - deltaPosition, to - deltaPosition)
    }),
    unselectedModifyStrategy: () => RegionModifyStrategy.Identity
})

describe("issue 287: move regions over others, then undo (real SyncSource batches stay self-contained)", () => {
    it("emits self-contained primitive tasks even for boxes deleted later in the same batch", async () => {
        const project = await loadProject()
        const graph = project.boxGraph
        const track = findTrackWithRegions(project)
        // Mirror the serializer's contract: a batch is only serializable without the live graph if every
        // update-primitive carries its codec. Assert exactly that, and that the batch resolves cleanly.
        let orphanedPrimitiveTasks = 0
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates: (tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void => {
                tasks.forEach(task => {
                    if (task.type !== "update-primitive") {return}
                    expect(isDefined(ValueSerialization[task.primitiveType])).toBe(true)
                    if (graph.findVertex(Address.reconstruct(task.address)).isEmpty()) {orphanedPrimitiveTasks++}
                })
            },
            checksum: (_value: Int8Array): Promise<void> => Promise.resolve()
        }
        const loopback = createSyncLoopback()
        const executor = Communicator.executor<Synchronization<BoxIO.TypeMap>>(loopback.target, target)
        const syncSource = new SyncSource<BoxIO.TypeMap>(graph as any, loopback.source, true)
        const deltaPosition = -3840 // one bar left
        const selected: ReadonlyArray<AnyRegionBoxAdapter> = track.regions.collection.asArray()
            .filter(region => region.position >= 80640 && region.position < 88320) // bars 22-23 (one-based)
        expect(selected.length).toBeGreaterThan(0)
        selected.forEach(region => (region as any).onSelected())
        const move = tryCatch(() => project.overlapResolver.apply([track], selected, makeMoveStrategy(deltaPosition), 0, () => {
            selected.forEach(region => region.position += deltaPosition)
        }))
        expect(move.status).toBe("success")
        const undo = tryCatch(() => project.editing.undo())
        expect(undo.status).toBe("success")
        expect((undo as any).value).toBe(true)
        // The bug shape actually occurred: the undo deleted split regions it had just primitive-updated.
        expect(orphanedPrimitiveTasks).toBeGreaterThan(0)
        syncSource.terminate()
        executor.terminate()
        loopback.terminate()
        project.terminate()
    })
})
