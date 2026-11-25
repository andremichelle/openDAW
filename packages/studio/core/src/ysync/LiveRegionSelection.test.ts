import {describe, expect, it} from "vitest"
import * as Y from "yjs"
import {isDefined, Option, panic, Terminable, UUID} from "@opendaw/lib-std"
import {Box, BoxGraph} from "@opendaw/lib-box"
import {PPQN} from "@opendaw/lib-dsp"
import {
    AnyRegionBoxAdapter,
    AudioUnitBoxAdapter,
    InstrumentFactories,
    ProjectSkeleton,
    TrackBoxAdapter
} from "@opendaw/studio-adapters"
import {AudioUnitBox, BoxIO, TrackBox, UserInterfaceBox} from "@opendaw/studio-boxes"
import {YSync} from "./YSync"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {Project} from "../project/Project"

// Live error 1194: "trackBoxAdapter" panicked in canFlatten while opening the region context menu in a live room.
// The menu deselects all, selects the clicked region, then calls canFlatten(selection.selected()). The predicate
// only runs with two or more selected regions, so after that sequence the region selection still held a region
// whose track was gone. These tests drive two peers through concurrent edits and require that the region
// selection stays a subset of the vertex selection and that every selected region resolves its track.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

type Peer = { name: string, doc: Y.Doc, project: Project }

const createPeers = async (): Promise<[Peer, Peer]> => {
    const {Project} = await import("../project/Project")
    const docA = new Y.Doc()
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const projectA = Project.fromSkeleton(createEnv(), skeleton)
    projectA.own(await YSync.populateRoom({
        boxGraph: projectA.boxGraph, boxes: docA.getMap("boxes"), conflict: () => projectA.invalid()
    }))
    projectA.follow(skeleton.mandatoryBoxes.userInterfaceBoxes[0])
    const docB = new Y.Doc()
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    const holder: { project: Option<Project> } = {project: Option.None}
    const sync = await YSync.joinRoom({
        boxGraph, boxes: docB.getMap("boxes"), conflict: () => holder.project.mapOr(project => project.invalid(), false)
    })
    const mandatoryBoxes = ProjectSkeleton.findMandatoryBoxes(boxGraph)
    const projectB = Project.fromSkeleton(createEnv(), {boxGraph, mandatoryBoxes}, false)
    holder.project = Option.wrap(projectB)
    projectB.own(sync)
    boxGraph.beginTransaction()
    const userB = UserInterfaceBox.create(boxGraph, UUID.generate(), box => box.root.refer(mandatoryBoxes.rootBox.users))
    boxGraph.endTransaction()
    projectB.follow(userB)
    const peerA: Peer = {name: "A", doc: docA, project: projectA}
    const peerB: Peer = {name: "B", doc: docB, project: projectB}
    converge(peerA, peerB)
    return [peerA, peerB]
}

// non-string origin, so the receiving YSync treats the batch as a genuine remote update
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

const live = <B extends Box>(peer: Peer, box: B): B =>
    peer.project.boxGraph.findBox<B>(box.address.uuid).unwrap(`${peer.name}: box is gone`)

const unitAdapter = (peer: Peer, box: AudioUnitBox): AudioUnitBoxAdapter =>
    peer.project.boxAdapters.adapterFor(live(peer, box), AudioUnitBoxAdapter)

const trackAdapter = (peer: Peer, box: TrackBox): TrackBoxAdapter =>
    peer.project.boxAdapters.adapterFor(live(peer, box), TrackBoxAdapter)

const regionsOf = (peer: Peer, box: TrackBox): ReadonlyArray<AnyRegionBoxAdapter> =>
    trackAdapter(peer, box).regions.collection.asArray()

const addInstrumentWithRegions = (peer: Peer, count: number): { audioUnitBox: AudioUnitBox, trackBox: TrackBox } => {
    const {editing, api} = peer.project
    const {audioUnitBox, trackBox} = editing.modify(() => api.createInstrument(InstrumentFactories.Vaporisateur)).unwrap()
    editing.modify(() => {
        for (let index = 0; index < count; index++) {
            api.createNoteRegion({trackBox, position: index * PPQN.Bar, duration: PPQN.Bar})
        }
    })
    return {audioUnitBox, trackBox}
}

const selectRegions = (peer: Peer, box: TrackBox): void =>
    peer.project.regionSelection.select(...regionsOf(peer, box))

// mirrors RegionContextMenu: replace the selection with the clicked region unless it is selected, then canFlatten
const openContextMenu = (peer: Peer, region: AnyRegionBoxAdapter): boolean => {
    const {regionSelection} = peer.project
    if (!regionSelection.isSelected(region)) {
        regionSelection.deselectAll()
        regionSelection.select(region)
    }
    return region.canFlatten(regionSelection.selected())
}

// every region the timeline thinks is selected must be selected in the vertex selection and own a track
const inconsistencies = (peer: Peer): ReadonlyArray<string> => {
    const {selection, regionSelection} = peer.project
    return regionSelection.selected().flatMap(region => {
        const issues: Array<string> = []
        if (!region.box.isAttached()) {issues.push(`${peer.name}: ${region.address.toString()} detached`)}
        if (!selection.isSelected(region.box)) {issues.push(`${peer.name}: ${region.address.toString()} not in vertex selection`)}
        if (region.trackBoxAdapter.isEmpty()) {issues.push(`${peer.name}: ${region.address.toString()} has no track`)}
        return issues
    })
}

describe("live room region selection (live 1194)", () => {
    it("B deletes the unit of A's selected regions", async () => {
        const [A, B] = await createPeers()
        const unit = addInstrumentWithRegions(A, 3)
        const other = addInstrumentWithRegions(A, 1)
        converge(A, B)
        selectRegions(A, unit.trackBox)
        converge(A, B)
        B.project.editing.modify(() => B.project.api.deleteAudioUnit(live(B, unit.audioUnitBox)))
        converge(A, B)
        expect(inconsistencies(A)).toEqual([])
        expect(() => openContextMenu(A, regionsOf(A, other.trackBox)[0])).not.toThrow()
    })

    it("B deletes the track of A's selected regions", async () => {
        const [A, B] = await createPeers()
        const unit = addInstrumentWithRegions(A, 3)
        converge(A, B)
        const secondTrack = A.project.editing.modify(() =>
            A.project.api.createNoteTrack(live(A, unit.audioUnitBox))).unwrap()
        A.project.editing.modify(() =>
            A.project.api.createNoteRegion({trackBox: secondTrack, position: 0, duration: PPQN.Bar}))
        converge(A, B)
        selectRegions(A, unit.trackBox)
        converge(A, B)
        B.project.editing.modify(() => unitAdapter(B, unit.audioUnitBox).deleteTrack(trackAdapter(B, unit.trackBox)))
        converge(A, B)
        expect(inconsistencies(A)).toEqual([])
        expect(() => openContextMenu(A, regionsOf(A, secondTrack)[0])).not.toThrow()
    })

    it("A selects regions while B concurrently deletes their unit", async () => {
        const [A, B] = await createPeers()
        const unit = addInstrumentWithRegions(A, 3)
        const other = addInstrumentWithRegions(A, 1)
        converge(A, B)
        selectRegions(A, unit.trackBox)
        B.project.editing.modify(() => B.project.api.deleteAudioUnit(live(B, unit.audioUnitBox)))
        converge(A, B)
        expect(inconsistencies(A)).toEqual([])
        expect(inconsistencies(B)).toEqual([])
        expect(() => openContextMenu(A, regionsOf(A, other.trackBox)[0])).not.toThrow()
    })

    // B's repair of A's dangling SelectionBoxes needs a round trip, so A works in between with only B's delete applied
    it("A selects regions while B concurrently deletes their unit, before B's repair arrives", async () => {
        const [A, B] = await createPeers()
        const unit = addInstrumentWithRegions(A, 3)
        const other = addInstrumentWithRegions(A, 1)
        converge(A, B)
        selectRegions(A, unit.trackBox)
        B.project.editing.modify(() => B.project.api.deleteAudioUnit(live(B, unit.audioUnitBox)))
        deliver(B, A)
        expect(inconsistencies(A)).toEqual([])
        expect(() => openContextMenu(A, regionsOf(A, other.trackBox)[0])).not.toThrow()
        converge(A, B)
        expect(inconsistencies(A)).toEqual([])
        expect(inconsistencies(B)).toEqual([])
    })

    // B's batch deletes A's selected regions (with their SelectionBoxes) and also fails A's first attempt, because A
    // concurrently added a region to another unit B deletes. YSync aborts that attempt before it reconciles (see 1159)
    it("B's batch deletes A's selected regions and conflicts elsewhere, so A rolls back before reconciling", async () => {
        const [A, B] = await createPeers()
        const selected = addInstrumentWithRegions(A, 3)
        const conflicting = addInstrumentWithRegions(A, 1)
        const other = addInstrumentWithRegions(A, 1)
        converge(A, B)
        selectRegions(A, selected.trackBox)
        converge(A, B)
        A.project.editing.modify(() => A.project.api.createNoteRegion({
            trackBox: live(A, conflicting.trackBox), position: 4 * PPQN.Bar, duration: PPQN.Bar
        }))
        B.project.editing.modify(() => {
            B.project.api.deleteAudioUnit(live(B, selected.audioUnitBox))
            B.project.api.deleteAudioUnit(live(B, conflicting.audioUnitBox))
        })
        deliver(B, A)
        expect(() => openContextMenu(A, regionsOf(A, other.trackBox)[0])).not.toThrow()
        expect(inconsistencies(A)).toEqual([])
        converge(A, B)
        expect(inconsistencies(A)).toEqual([])
    })

    it("A selects regions while B concurrently deletes their track", async () => {
        const [A, B] = await createPeers()
        const unit = addInstrumentWithRegions(A, 3)
        const secondTrack = A.project.editing.modify(() =>
            A.project.api.createNoteTrack(live(A, unit.audioUnitBox))).unwrap()
        A.project.editing.modify(() =>
            A.project.api.createNoteRegion({trackBox: secondTrack, position: 0, duration: PPQN.Bar}))
        converge(A, B)
        selectRegions(A, unit.trackBox)
        B.project.editing.modify(() => unitAdapter(B, unit.audioUnitBox).deleteTrack(trackAdapter(B, unit.trackBox)))
        converge(A, B)
        expect(inconsistencies(A)).toEqual([])
        expect(() => openContextMenu(A, regionsOf(A, secondTrack)[0])).not.toThrow()
    })

    it("A adds a region to a track while B concurrently deletes the track, with A's other regions selected", async () => {
        const [A, B] = await createPeers()
        const unit = addInstrumentWithRegions(A, 2)
        const other = addInstrumentWithRegions(A, 2)
        converge(A, B)
        selectRegions(A, unit.trackBox)
        converge(A, B)
        A.project.editing.modify(() =>
            A.project.api.createNoteRegion({trackBox: live(A, unit.trackBox), position: 4 * PPQN.Bar, duration: PPQN.Bar}))
        B.project.editing.modify(() => B.project.api.deleteAudioUnit(live(B, unit.audioUnitBox)))
        converge(A, B)
        expect(inconsistencies(A)).toEqual([])
        expect(() => openContextMenu(A, regionsOf(A, other.trackBox)[0])).not.toThrow()
    })

    it("B moves A's selected regions to another unit's track", async () => {
        const [A, B] = await createPeers()
        const unit = addInstrumentWithRegions(A, 2)
        const other = addInstrumentWithRegions(A, 1)
        converge(A, B)
        selectRegions(A, unit.trackBox)
        converge(A, B)
        B.project.editing.modify(() => regionsOf(B, unit.trackBox)
            .forEach(region => region.box.regions.refer(live(B, other.trackBox).regions)))
        B.project.editing.modify(() => B.project.api.deleteAudioUnit(live(B, unit.audioUnitBox)))
        converge(A, B)
        expect(inconsistencies(A)).toEqual([])
        expect(() => openContextMenu(A, regionsOf(A, other.trackBox)[0])).not.toThrow()
    })
})
