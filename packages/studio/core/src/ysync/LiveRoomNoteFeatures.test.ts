import {afterEach, describe, expect, it} from "vitest"
import {asInstanceOf, Exec, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {NoteEventBox, NoteEventCollectionBox, NoteEventGroupBox, NoteRegionBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, NoteEventBoxAdapter, NoteEventFeatures} from "@opendaw/studio-adapters"
import {LiveRoom, RoomPeer, seededRandom, seedUuids} from "./testing/LiveRoom"

// Two people edit the chance, repeat and group of the same notes at the same time. Who wins does not matter,
// every peer and every late joiner has to settle on the same state, and no note may end up with two chance
// or two repeat boxes.

const {GroupMode} = NoteEventFeatures

type Scene = {room: LiveRoom, collection: UUID.Bytes, notes: ReadonlyArray<UUID.Bytes>}

const rooms: Array<LiveRoom> = []
afterEach(() => rooms.splice(0).forEach(room => room.terminate()))

// One instrument with one region holding six notes, known to both peers.
const createScene = async (): Promise<Scene> => {
    const room = await LiveRoom.create(["A", "B"])
    rooms.push(room)
    const {project} = room.peer("A")
    const {collection, notes} = project.editing.modify(() => {
        const {trackBox} = project.api.createInstrument(InstrumentFactories.Vaporisateur)
        const region = asInstanceOf(project.api.createTrackRegion(trackBox, 0, 3840).unwrap("region"), NoteRegionBox)
        const events = asInstanceOf(region.events.targetVertex.unwrap("events").box, NoteEventCollectionBox)
        const notes = Array.from({length: 6}, (_, index) => NoteEventBox.create(project.boxGraph, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(index * 480)
            box.duration.setValue(480)
            // float32 exact, so the creator and the receiver hold the same velocity
            box.velocity.setValue(0.5)
            box.pitch.setValue(60 + index)
        }).address.uuid)
        return {collection: events.address.uuid, notes}
    }).unwrap("modify")
    room.flush()
    return {room, collection, notes}
}

const noteOf = (peer: RoomPeer, uuid: UUID.Bytes): NoteEventBox =>
    asInstanceOf(peer.graph.findBox(uuid).unwrap("note"), NoteEventBox)
const notesOf = (peer: RoomPeer, {collection}: Scene): ReadonlyArray<NoteEventBox> =>
    peer.graph.findBox(collection).mapOr(box => asInstanceOf(box, NoteEventCollectionBox).events.pointerHub.incoming()
        .map(({box}) => asInstanceOf(box, NoteEventBox)), [])
const adapterOf = (peer: RoomPeer, note: NoteEventBox): NoteEventBoxAdapter =>
    peer.project.boxAdapters.adapterFor(note, NoteEventBoxAdapter)
const edit = (peer: RoomPeer, exec: Exec): void => {peer.project.editing.modify(exec)}

const expectSettled = async (room: LiveRoom): Promise<void> => {
    expect(room.violations()).toEqual([])
    expect(await room.lateJoinerDiffers()).toBe(false)
    room.peers.forEach(peer => peer.graph.boxes().forEach((box: Box) => {
        if (box instanceof NoteEventBox) {
            expect(box.random.pointerHub.size(), `${peer.name} chance boxes`).toBeLessThanOrEqual(1)
            expect(box.split.pointerHub.size(), `${peer.name} repeat boxes`).toBeLessThanOrEqual(1)
        }
    }))
}

describe("live room: note chance, repeat and groups", () => {
    it("both set a chance on the same note", async () => {
        const scene = await createScene()
        const {room, notes: [first]} = scene
        edit(room.peer("A"), () => NoteEventFeatures.writeChance(noteOf(room.peer("A"), first), 30))
        edit(room.peer("B"), () => NoteEventFeatures.writeChance(noteOf(room.peer("B"), first), 70))
        await expectSettled(room)
        const [a, b] = room.peers.map(peer => NoteEventFeatures.readChance(noteOf(peer, first)))
        expect(a).toBe(b)
        expect([30, 70]).toContain(a)
    })

    it("both set repeats on the same note", async () => {
        const scene = await createScene()
        const {room, notes: [first]} = scene
        edit(room.peer("A"), () => NoteEventFeatures.writePlayCount(noteOf(room.peer("A"), first), 3))
        edit(room.peer("B"), () => {
            const note = noteOf(room.peer("B"), first)
            NoteEventFeatures.writePlayCount(note, 5)
            NoteEventFeatures.writeVelocityFade(note, -0.5)
        })
        await expectSettled(room)
        const [a, b] = room.peers.map(peer => adapterOf(peer, noteOf(peer, first)).parts())
        expect(a).toEqual(b)
        expect(a.length).toBeGreaterThan(1)
    })

    it("both group an overlapping set of notes", async () => {
        const scene = await createScene()
        const {room, notes} = scene
        edit(room.peer("A"), () => NoteEventFeatures.group([0, 1, 2].map(index => noteOf(room.peer("A"), notes[index])),
            GroupMode.PlayAll))
        edit(room.peer("B"), () => NoteEventFeatures.group([2, 3].map(index => noteOf(room.peer("B"), notes[index])),
            GroupMode.PlayOne))
        await expectSettled(room)
        const groupsOf = (peer: RoomPeer) => notes.map(uuid => NoteEventFeatures.groupBox(noteOf(peer, uuid))
            .mapOr(group => UUID.toString(group.address.uuid), "none"))
        expect(groupsOf(room.peer("A"))).toEqual(groupsOf(room.peer("B")))
    })

    it("one groups notes while the other deletes one of them", async () => {
        const scene = await createScene()
        const {room, notes} = scene
        edit(room.peer("A"), () => NoteEventFeatures.group([0, 1].map(index => noteOf(room.peer("A"), notes[index])),
            GroupMode.PlayOne))
        edit(room.peer("B"), () => noteOf(room.peer("B"), notes[1]).delete())
        await expectSettled(room)
    })

    it("one changes the group chance while the other dissolves the group", async () => {
        const scene = await createScene()
        const {room, notes} = scene
        edit(room.peer("A"), () => NoteEventFeatures.group([0, 1, 2].map(index => noteOf(room.peer("A"), notes[index])),
            GroupMode.PlayAll))
        room.flush()
        edit(room.peer("A"), () => NoteEventFeatures.writeChance(noteOf(room.peer("A"), notes[0]), 25))
        edit(room.peer("B"), () => NoteEventFeatures.ungroup([noteOf(room.peer("B"), notes[1])]))
        await expectSettled(room)
    })

    it("one switches a group to Play One while the other moves a member into a new group", async () => {
        const scene = await createScene()
        const {room, notes} = scene
        edit(room.peer("A"), () => NoteEventFeatures.group([0, 1, 2].map(index => noteOf(room.peer("A"), notes[index])),
            GroupMode.PlayAll))
        room.flush()
        edit(room.peer("A"), () => NoteEventFeatures.groupBox(noteOf(room.peer("A"), notes[0]))
            .ifSome(group => group.mode.setValue(GroupMode.PlayOne)))
        edit(room.peer("B"), () => NoteEventFeatures.group([2, 3].map(index => noteOf(room.peer("B"), notes[index])),
            GroupMode.PlayAll))
        await expectSettled(room)
    })

    it("one consolidates a repeated note while the other changes its repeats and chance", async () => {
        const scene = await createScene()
        const {room, notes: [first]} = scene
        edit(room.peer("A"), () => {
            NoteEventFeatures.writePlayCount(noteOf(room.peer("A"), first), 4)
            NoteEventFeatures.writeChance(noteOf(room.peer("A"), first), 50)
        })
        room.flush()
        edit(room.peer("A"), () => adapterOf(room.peer("A"), noteOf(room.peer("A"), first)).consolidate())
        edit(room.peer("B"), () => {
            const note = noteOf(room.peer("B"), first)
            NoteEventFeatures.writePlayCount(note, 2)
            NoteEventFeatures.writeChance(note, 80)
        })
        await expectSettled(room)
    })

    // Random edits from both peers, delivered in random order, replayed exactly from the seed.
    const Seeds = Number(process.env.FUZZ_SEEDS ?? 30)
    const Steps = 40
    it(`random concurrent edits settle on one state (${Seeds} seeds)`, async () => {
        for (let seed = 1; seed <= Seeds; seed++) {
            const random = seededRandom(seed)
            seedUuids(seededRandom(seed ^ 0x2545f491))
            const scene = await createScene()
            const {room} = scene
            const pick = <T>(values: ReadonlyArray<T>): T => values[Math.floor(random() * values.length)]
            const some = (notes: ReadonlyArray<NoteEventBox>): ReadonlyArray<NoteEventBox> =>
                notes.filter(() => random() < 0.4)
            const operations: ReadonlyArray<[string, (peer: RoomPeer, notes: ReadonlyArray<NoteEventBox>) => void]> = [
                ["chance", (_, notes) => NoteEventFeatures.writeChance(pick(notes), Math.floor(random() * 101))],
                ["count", (_, notes) => NoteEventFeatures.writePlayCount(pick(notes), 1 + Math.floor(random() * 6))],
                ["curve", (_, notes) => NoteEventFeatures.writePlayCurve(pick(notes), random() * 2 - 1)],
                ["length", (_, notes) => NoteEventFeatures.writeRepeatLength(pick(notes), random())],
                ["fade", (_, notes) => NoteEventFeatures.writeVelocityFade(pick(notes), random() * 2 - 1)],
                ["group", (_, notes) => {
                    const chosen = some(notes)
                    if (chosen.length > 0) {NoteEventFeatures.group(chosen, random() < 0.5 ? GroupMode.PlayAll : GroupMode.PlayOne)}
                }],
                ["mode", (_, notes) => NoteEventFeatures.groupBox(pick(notes))
                    .ifSome((group: NoteEventGroupBox) => group.mode.setValue(random() < 0.5 ? GroupMode.PlayAll : GroupMode.PlayOne))],
                ["leave", (_, notes) => NoteEventFeatures.leaveGroup(some(notes))],
                ["ungroup", (_, notes) => NoteEventFeatures.ungroup([pick(notes)])],
                ["delete", (_, notes) => pick(notes).delete()],
                ["consolidate", (peer, notes) => {
                    const adapter = adapterOf(peer, pick(notes))
                    if (adapter.canConsolidate()) {adapter.consolidate()}
                }],
                ["duplicate", (peer, notes) => {
                    const chosen = some(notes)
                    if (chosen.length > 0) {peer.project.api.duplicateNotes(chosen.map(note => adapterOf(peer, note)))}
                }]
            ]
            const log: Array<string> = []
            for (let step = 0; step < Steps; step++) {
                const peer = pick(room.peers)
                const notes = notesOf(peer, scene)
                if (notes.length > 0) {
                    const [name, operation] = pick(operations)
                    log.push(`${peer.name} ${name}`)
                    edit(peer, () => operation(peer, notes))
                }
                const deliveries = Math.floor(random() * 4)
                for (let delivery = 0; delivery < deliveries; delivery++) {room.deliverRandom(random)}
            }
            const violations = room.violations()
            expect(violations, `seed ${seed}: ${log.join(", ")}`).toEqual([])
            expect(await room.lateJoinerDiffers(), `seed ${seed} late joiner`).toBe(false)
            await expectSettled(room)
            rooms.pop()?.terminate()
        }
    }, 120_000)
})
