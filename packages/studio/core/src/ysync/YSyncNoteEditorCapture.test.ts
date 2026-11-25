import {afterEach, describe, expect, it, vi} from "vitest"
import * as Y from "yjs"
import {BoxGraph} from "@opendaw/lib-box"
import {asInstanceOf, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitFactory, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {
    AudioUnitBox,
    BoxIO,
    CaptureMidiBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    RootBox,
    TrackBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {Project} from "../project/Project"
import {CaptureMidi} from "../capture/CaptureMidi"
import {YSync} from "./YSync"

// Error 1198: can two peers editing a room reach a note region whose unit NoteEditor cannot resolve to a CaptureMidi?
// Runs the real Project + CaptureDevices + BoxEditing on both peers, with deliveries interleaved at random.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: {currentTime: 0, sampleRate: 48000}, audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

type Peer = { doc: Y.Doc, project: Project }

const createPeers = async (): Promise<[Peer, Peer]> => {
    const {Project: ProjectClass} = await import("../project/Project")
    const docA = new Y.Doc()
    const project = ProjectClass.fromSkeleton(createEnv(),
        ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
    await YSync.populateRoom<BoxIO.TypeMap>({boxGraph: project.boxGraph, boxes: docA.getMap("boxes")})
    const docB = new Y.Doc()
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    await YSync.joinRoom<BoxIO.TypeMap>({boxGraph, boxes: docB.getMap("boxes")})
    const mandatoryBoxes = ProjectSkeleton.findMandatoryBoxes(boxGraph)
    const joined = ProjectClass.fromSkeleton(createEnv(), {boxGraph, mandatoryBoxes}, false)
    return [{doc: docA, project}, {doc: docB, project: joined}]
}

const deliver = (from: Peer, to: Peer): void =>
    Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), from)

const converge = (a: Peer, b: Peer): void => {
    for (let round = 0; round < 8; round++) {
        deliver(a, b)
        deliver(b, a)
    }
}

const units = ({project}: Peer): ReadonlyArray<AudioUnitBox> => project.boxGraph.boxes()
    .filter((box): box is AudioUnitBox => box instanceof AudioUnitBox && box.type.getValue() === AudioUnitType.Instrument)
const noteTracks = ({project}: Peer): ReadonlyArray<TrackBox> => project.boxGraph.boxes()
    .filter((box): box is TrackBox => box instanceof TrackBox && box.type.getValue() === TrackType.Notes)
const regions = ({project}: Peer): ReadonlyArray<NoteRegionBox> => project.boxGraph.boxes()
    .filter((box): box is NoteRegionBox => box instanceof NoteRegionBox)

const createUnit = ({project}: Peer): void => {
    const {boxGraph, skeleton} = project
    const capture = CaptureMidiBox.create(boxGraph, UUID.generate())
    const unit = AudioUnitFactory.create(skeleton, AudioUnitType.Instrument, Option.wrap(capture))
    VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
    TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(unit.tracks)
        box.target.refer(unit)
    })
}

const createRegion = ({project: {boxGraph}}: Peer, track: TrackBox): void => {
    const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(960)
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
    })
}

const describeBroken = ({project, doc}: Peer): ReadonlyArray<string> => regions({project, doc}).flatMap(region => {
    const track = region.regions.targetVertex.map(({box}) => box).unwrapOrNull()
    if (!(track instanceof TrackBox)) {return ["region without track"]}
    const unit = track.tracks.targetVertex.map(({box}) => box).unwrapOrNull()
    if (!(unit instanceof AudioUnitBox)) {return ["track without unit"]}
    const capture = project.captureDevices.get(unit.address.uuid)
    if (capture.isEmpty()) {
        return [`no capture (pointer set: ${unit.capture.nonEmpty()}, enrolled: ${unit.collection.nonEmpty()})`]
    }
    return capture.unwrap() instanceof CaptureMidi ? [] : ["capture is not midi"]
})

const seededRandom = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
}

const pick = <T>(random: () => number, list: ReadonlyArray<T>): Option<T> =>
    list.length === 0 ? Option.None : Option.wrap(list[Math.floor(random() * list.length)])

const seedUUIDs = (random: () => number): void => {
    vi.spyOn(UUID, "generate").mockImplementation(() => {
        const bytes = new Uint8Array(16)
        for (let index = 0; index < 16; index++) {bytes[index] = Math.floor(random() * 256)}
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return bytes as UUID.Bytes
    })
}

const step = (peer: Peer, random: () => number, allowHistory: boolean = true): void => {
    const {project} = peer
    const {api, editing} = project
    const roll = allowHistory ? random() : random() * 0.8
    if (roll < 0.15) {
        editing.modify(() => createUnit(peer))
    } else if (roll < 0.35) {
        pick(random, noteTracks(peer)).ifSome(track => editing.modify(() => createRegion(peer, track)))
    } else if (roll < 0.55) {
        pick(random, units(peer)).ifSome(unit => editing.modify(() => api.deleteAudioUnit(unit)))
    } else if (roll < 0.7) {
        pick(random, regions(peer)).ifSome(region => pick(random, noteTracks(peer))
            .ifSome(track => editing.modify(() => region.regions.refer(track.regions))))
    } else if (roll < 0.8) {
        pick(random, regions(peer)).ifSome(region => editing.modify(() => region.delete()))
    } else if (roll < 0.9) {
        editing.undo()
    } else {
        editing.redo()
    }
}

describe("YSync note regions keep a CaptureMidi", () => {
    afterEach(() => {vi.restoreAllMocks()})

    it("the fixture sees a remote unit's capture on the joined peer", async () => {
        const [A, B] = await createPeers()
        A.project.editing.modify(() => createUnit(A))
        converge(A, B)
        const unit = units(B)[0]
        expect(B.project.captureDevices.get(unit.address.uuid).unwrap()).toBeInstanceOf(CaptureMidi)
        expect(B.project.boxGraph.boxes().filter(box => box instanceof RootBox).length).toBe(1)
    })

    it("deleting a unit while the peer adds a region to it leaves no broken region", async () => {
        const [A, B] = await createPeers()
        A.project.editing.modify(() => {
            createUnit(A)
            createUnit(A)
        })
        converge(A, B)
        const [unit] = units(A)
        const trackUuid = unit.tracks.pointerHub.incoming()[0].box.address.uuid
        const track = asInstanceOf(B.project.boxGraph.findBox(trackUuid).unwrap("track"), TrackBox)
        A.project.editing.modify(() => A.project.api.deleteAudioUnit(unit))
        B.project.editing.modify(() => createRegion(B, track))
        converge(A, B)
        expect(describeBroken(A)).toEqual([])
        expect(describeBroken(B)).toEqual([])
        expect(regions(A).length).toBe(regions(B).length)
    })

    const fuzz = async (allowHistory: boolean): Promise<ReadonlyArray<string>> => {
        const failures: Array<string> = []
        for (let seed = 1; seed <= 200; seed++) {
            const random = seededRandom(seed)
            seedUUIDs(seededRandom(seed * 7919))
            const [A, B] = await createPeers()
            A.project.editing.modify(() => createUnit(A))
            converge(A, B)
            for (let index = 0; index < 60; index++) {
                step(random() < 0.5 ? A : B, random, allowHistory)
                if (random() < 0.3) {converge(A, B)}
                const broken = [...describeBroken(A), ...describeBroken(B)]
                if (broken.length > 0) {
                    failures.push(`seed ${seed} step ${index}: ${broken.join(", ")}`)
                    break
                }
            }
        }
        return failures
    }

    it("random concurrent edits never strand a note region", async () => {
        expect(await fuzz(false)).toEqual([])
    }, 120_000)

    // Known bug, not error 1198 (whose logs show no local revert): undo or redo in a room recreates boxes on top
    // of a peer's delete, leaving regions without a track and, after a rejected reconcile, units without a capture.
    it.fails("random concurrent edits with undo and redo never strand a note region", async () => {
        expect(await fuzz(true)).toEqual([])
    }, 120_000)
})
