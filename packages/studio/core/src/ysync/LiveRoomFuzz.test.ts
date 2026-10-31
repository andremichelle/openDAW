import {beforeEach, describe, expect, it} from "vitest"
import {asInstanceOf, Option, tryCatch} from "@opendaw/lib-std"
import {BoxEditing, EditingCheckpoint, IndexedBox} from "@opendaw/lib-box"
import {AudioUnitBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, InstrumentFactories} from "@opendaw/studio-adapters"
import {EffectFactories} from "../EffectFactories"
import {RoomTake} from "../capture/RoomTake"
import type {LocalLayer} from "./YSync"
import {LiveRoom, RoomPeer, seededRandom, seedUuids} from "./testing/LiveRoom"

// Every run replays from its seed: a failure names the seed and the operations that led to it.

type PeerState = {
    preview: Option<{layer: LocalLayer, checkpoint: EditingCheckpoint, apply: () => void}>
    take: Option<{layer: LocalLayer, region: NoteRegionBox}>
}

const Seeds = Number(process.env.FUZZ_SEEDS ?? 40)
const Steps = 70

const units = ({project}: RoomPeer): ReadonlyArray<AudioUnitBox> =>
    IndexedBox.collectIndexedBoxes(project.rootBox.audioUnits, AudioUnitBox)
        .filter(unit => unit !== project.primaryAudioUnitBox && unit.input.pointerHub.nonEmpty())
const tracks = (unit: AudioUnitBox): ReadonlyArray<TrackBox> =>
    unit.tracks.pointerHub.incoming().map(({box}) => asInstanceOf(box, TrackBox))

const run = async (seed: number, peerCount: number): Promise<void> => {
    const random = seededRandom(seed)
    seedUuids(seededRandom(seed ^ 0x5bd1e995))
    const pick = <T>(values: ReadonlyArray<T>): T => values[Math.floor(random() * values.length)]
    const room = await LiveRoom.create(Array.from({length: peerCount}, (_, index) => String.fromCharCode(65 + index)))
    room.flush()
    const states = new Map<RoomPeer, PeerState>(room.peers.map(peer => [peer, {preview: Option.None, take: Option.None}]))
    const log: Array<string> = []
    const editing = ({project}: RoomPeer) => project.editing as BoxEditing
    const endPreview = (peer: RoomPeer, approve: boolean): void => {
        const state = states.get(peer)!
        state.preview.ifSome(({layer, checkpoint, apply}) => {
            layer.revert()
            checkpoint.discard()
            if (approve) {apply()}
            layer.terminate()
        })
        state.preview = Option.None
    }
    const endTake = (peer: RoomPeer): void => {
        const state = states.get(peer)!
        state.take.ifSome(({layer}) => {
            RoomTake.settle(peer.project, layer)
            layer.publish()
            layer.terminate()
        })
        state.take = Option.None
    }
    const operations: ReadonlyArray<[string, (peer: RoomPeer) => void]> = [
        ["instrument", ({project}) => {project.editing.modify(() => project.api.createInstrument(InstrumentFactories.Vaporisateur))}],
        ["delete unit", peer => {
            const candidates = units(peer)
            if (candidates.length > 0) {peer.project.editing.modify(() => peer.project.api.deleteAudioUnit(pick(candidates)))}
        }],
        ["effect", peer => {
            const candidates = units(peer)
            if (candidates.length === 0) {return}
            const host = peer.project.boxAdapters.adapterFor(pick(candidates), Devices.isHost)
            const field = DeviceHost.chainFieldOf(host, "audio").unwrap()
            peer.project.editing.modify(() => peer.project.api.insertEffect(field, EffectFactories.AudioNamed.Delay, 0))
        }],
        ["region", peer => {
            const candidates = units(peer).flatMap(tracks).filter(track => track.regions.pointerHub.isEmpty())
            if (candidates.length > 0) {
                peer.project.editing.modify(() => peer.project.api.createTrackRegion(pick(candidates), 0, 960))
            }
        }],
        ["volume", peer => {
            const candidates = units(peer)
            if (candidates.length > 0) {peer.project.editing.modify(() => pick(candidates).volume.setValue(random() * -24))}
        }],
        ["undo", peer => {
            if (states.get(peer)!.preview.isEmpty()) {editing(peer).undo()}
        }],
        ["redo", peer => {
            if (states.get(peer)!.preview.isEmpty()) {editing(peer).redo()}
        }],
        ["preview pick", peer => {
            const state = states.get(peer)!
            endPreview(peer, false)
            const candidates = units(peer)
            if (candidates.length === 0) {return}
            const unit = pick(candidates)
            const host = peer.project.boxAdapters.adapterFor(unit, Devices.isHost)
            const field = DeviceHost.chainFieldOf(host, "audio").unwrap()
            const replaces = random() < 0.5 && !field.pointerHub.isEmpty()
            const insert = () => {
                if (!unit.isAttached()) {return}
                if (replaces) {IndexedBox.collectIndexedBoxes(field)[0]?.delete()}
                peer.project.api.insertEffect(field, EffectFactories.AudioNamed.Compressor, 0)
            }
            const layer = peer.sync.createLayer("preview")
            const checkpoint = editing(peer).checkpoint()
            layer.subscribeInvalid(() => {
                checkpoint.discard()
                state.preview = Option.None
            })
            layer.run(() => peer.project.editing.modify(insert, false))
            state.preview = Option.wrap({layer, checkpoint, apply: () => {peer.project.editing.modify(insert)}})
        }],
        ["preview new unit", peer => {
            const state = states.get(peer)!
            endPreview(peer, false)
            const create = () => {peer.project.api.createInstrument(InstrumentFactories.Nano)}
            const layer = peer.sync.createLayer("preview")
            const checkpoint = editing(peer).checkpoint()
            layer.subscribeInvalid(() => {
                checkpoint.discard()
                state.preview = Option.None
            })
            layer.run(() => peer.project.editing.modify(create, false))
            state.preview = Option.wrap({layer, checkpoint, apply: () => {peer.project.editing.modify(create)}})
        }],
        ["preview ok", peer => endPreview(peer, true)],
        ["preview cancel", peer => endPreview(peer, false)],
        ["take start", peer => {
            const state = states.get(peer)!
            const candidates = units(peer)
            if (state.take.nonEmpty() || candidates.length === 0) {return}
            const layer = peer.sync.createLayer("take")
            const unit = pick(candidates)
            const region = layer.run(() => peer.project.editing.modify(() => {
                const track = peer.project.api.createNoteTrack(unit)
                return peer.project.api.createTrackRegion(track, 0, 480).unwrap() as NoteRegionBox
            }, false)).unwrap()
            state.take = Option.wrap({layer, region})
        }],
        ["take grow", peer => {
            states.get(peer)!.take.ifSome(({layer, region}) => {
                if (region.isAttached()) {
                    layer.run(() => peer.project.editing.modify(() => region.duration.setValue(region.duration.getValue() + 240), false))
                }
            })
        }],
        ["take stop", endTake],
        ["disconnect", peer => room.disconnect(peer)],
        ["reconnect", peer => room.reconnect(peer)],
        ["deliver", () => {
            const count = Math.floor(random() * 6)
            for (let index = 0; index < count; index++) {room.deliverRandom(random)}
        }]
    ]
    const excluded = (process.env.FUZZ_EXCLUDE ?? "").split(",").filter(word => word.length > 0)
    const enabled = operations.filter(([name]) => !excluded.some(word => name.includes(word)))
    for (let step = 0; step < Steps; step++) {
        const peer = pick(room.peers)
        const [name, operation] = pick(enabled)
        log.push(`${peer.name} ${name}`)
        const result = tryCatch(() => operation(peer))
        if (result.status === "failure") {
            throw new Error(`seed ${seed} step ${step} '${name}': ${result.error}\n${log.join(", ")}`)
        }
    }
    room.peers.forEach(peer => {
        room.reconnect(peer)
        endPreview(peer, false)
        endTake(peer)
    })
    const settled = tryCatch(() => room.violations())
    if (settled.status === "failure") {throw new Error(`seed ${seed}: ${settled.error}\n${log.join(", ")}`)}
    const problems = settled.value
    if (problems.length > 0) {throw new Error(`seed ${seed}: ${problems.join("; ")}\n${log.join(", ")}`)}
    if (await room.lateJoinerDiffers()) {throw new Error(`seed ${seed}: a late joiner differs\n${log.join(", ")}`)}
    room.terminate()
}

describe("LiveRoom fuzz", () => {
    beforeEach(() => {
        console.debug = () => {}
        console.warn = (...args: Array<unknown>) => {if (process.env.FUZZ_VERBOSE === "1" && String(args[0]).includes("rejected")) {console.log("REJECT", String(args[1]).slice(0, 130))}}
    })
    it.each([2, 3, 4])(`%i peers stay healthy over ${Seeds} seeds`, async peerCount => {
        const failures: Array<string> = []
        for (let seed = 0; seed < Seeds; seed++) {
            const result = await run(seed * 7919 + peerCount, peerCount).then(() => null, (reason: unknown) => String(reason))
            if (result !== null) {
                failures.push(result)
                if (process.env.FUZZ_VERBOSE === "1") {console.log(`FUZZFAIL ${result}`)}
            }
        }
        expect(`${failures.length} failed\n${failures.slice(0, 2).join("\n")}`).toBe("0 failed\n")
    }, 300_000)
})
