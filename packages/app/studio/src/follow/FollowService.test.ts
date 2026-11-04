import {describe, expect, it} from "vitest"
import * as Y from "yjs"
import {applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates} from "y-protocols/awareness"
import {Notifier, Observer, Procedure} from "@opendaw/lib-std"
import {TransportLock} from "@opendaw/studio-core"
import {FollowAwarenessField, FollowHost, FollowService} from "./FollowService"
import {FollowMessage, FollowTransportEvent} from "./FollowTypes"

// a fake engine: constant 120 bpm (1920 pulses per second), no loop, logs every transport call of the lock
class FakeHost implements FollowHost {
    readonly calls: Array<string> = []
    readonly transport = new Notifier<FollowTransportEvent>()
    playing = false
    position = 0
    latency = 0.0
    delay = 0.05
    locked = false
    outputLatency(): number {return this.latency}
    isPlaying(): boolean {return this.playing}
    currentPosition(): number {return this.position}
    advance(position: number, elapsed: number): number {return position + elapsed * 1920}
    startDelay(): number {return this.delay}
    lockTransport(): TransportLock {
        this.locked = true
        this.calls.push("lock")
        return {
            play: () => this.calls.push("play"),
            stop: () => this.calls.push("stop"),
            setPosition: (position: number) => this.calls.push(`position:${position.toFixed(1)}`),
            terminate: () => {
                this.locked = false
                this.calls.push("release")
            }
        }
    }
    endRecording(): void {this.calls.push("endRecording")}
    subscribeTransport(observer: Observer<FollowTransportEvent>) {return this.transport.subscribe(observer)}
}

type Peer = {
    readonly id: number
    readonly awareness: Awareness
    readonly host: FakeHost
    readonly service: FollowService
}

const createRoom = (size: number, skews: ReadonlyArray<number> = []) => {
    const clock = {now: 0}
    const queue: Array<{ sender: number, message: FollowMessage }> = []
    const handlers = new Map<number, Procedure<FollowMessage>>()
    const peers: Array<Peer> = []
    const awarenesses: Array<Awareness> = []
    for (let index = 0; index < size; index++) {
        const awareness = new Awareness(new Y.Doc())
        awareness.setLocalStateField("user", {name: `user ${index}`, color: "#fff"})
        awarenesses.push(awareness)
    }
    awarenesses.forEach(source => {
        source.on("update", ({added, updated, removed}: { added: Array<number>, updated: Array<number>, removed: Array<number> }) => {
            const changed = [...added, ...updated, ...removed]
            const update = encodeAwarenessUpdate(source, changed)
            awarenesses.filter(target => target !== source).forEach(target => applyAwarenessUpdate(target, update, "test"))
        })
    })
    awarenesses.forEach(source => awarenesses.filter(target => target !== source).forEach(target =>
        applyAwarenessUpdate(target, encodeAwarenessUpdate(source, [source.clientID]), "test")))
    awarenesses.forEach((awareness, index) => {
        const host = new FakeHost()
        const skew = skews[index] ?? 0
        const service = new FollowService(awareness, host, onMessage => {
            handlers.set(awareness.clientID, onMessage)
            return {
                publish: (message: FollowMessage) => queue.push({sender: awareness.clientID, message}),
                terminate: () => handlers.delete(awareness.clientID)
            }
        }, () => clock.now + skew)
        peers.push({id: awareness.clientID, awareness, host, service})
    })
    const flush = () => {
        const pending = queue.splice(0)
        pending.forEach(({sender, message}) => handlers.forEach((handler, id) => {if (id !== sender) {handler(message)}}))
    }
    const settle = () => {while (queue.length > 0) {flush()}}
    const disconnect = (peer: Peer) => awarenesses.filter(other => other !== peer.awareness)
        .forEach(other => removeAwarenessStates(other, [peer.id], "test"))
    return {peers, clock, queue, flush, settle, disconnect}
}

describe("FollowService", () => {
    it("starts at the leader's current position when it is playing", () => {
        const {peers: [leader, follower], clock, flush} = createRoom(2)
        Object.assign(leader.host, {playing: true, position: 1920, latency: 0.01})
        Object.assign(follower.host, {latency: 0.03, delay: 0.05})
        follower.service.follow(leader.id)
        flush()
        clock.now = 40
        flush()
        // transit 0.02 + start 0.05 + own output 0.03 - leader output 0.01 = 0.09 seconds
        expect(follower.host.calls).toEqual(["endRecording", "lock", `position:${(1920 + 0.09 * 1920).toFixed(1)}`, "play"])
        expect(follower.host.locked).toBe(true)
        expect(follower.service.leader.getValue()).toBe(leader.id)
    })
    it("applies only the first answer and keeps the others for the clock", () => {
        const {peers: [leader, follower], settle} = createRoom(2)
        Object.assign(leader.host, {playing: false, position: 960})
        follower.service.follow(leader.id)
        settle()
        expect(follower.host.calls.filter(call => call === "stop")).toEqual(["stop"])
    })
    it("measures the transit of pushed messages against the leader's clock", () => {
        const {peers: [leader, follower], clock, flush} = createRoom(2, [5000, 0])
        follower.service.follow(leader.id)
        clock.now = 20
        flush()
        clock.now = 40
        flush()
        follower.host.calls.length = 0
        clock.now = 100
        leader.host.transport.notify({playing: true, position: 0})
        clock.now = 130
        flush()
        // sent at leader time 5100, the leader runs 5000 ms ahead, received 30 ms later, plus the 50 ms start
        expect(follower.host.calls).toEqual([`position:${((0.03 + 0.05) * 1920).toFixed(1)}`, "play"])
    })
    it("stops at the leader's position when it is stopped", () => {
        const {peers: [leader, follower], settle} = createRoom(2)
        Object.assign(leader.host, {playing: false, position: 960})
        follower.service.follow(leader.id)
        settle()
        expect(follower.host.calls).toEqual(["endRecording", "lock", "stop", "position:960.0"])
    })
    it("skips the start delay for a jump while already playing", () => {
        const {peers: [leader, follower], settle} = createRoom(2)
        Object.assign(leader.host, {playing: true, position: 0})
        Object.assign(follower.host, {playing: true, delay: 0.5})
        follower.service.follow(leader.id)
        settle()
        expect(follower.host.calls.slice(2)).toEqual(["position:0.0", "play"])
    })
    it("forwards the leader's transport only while someone follows", () => {
        const {peers: [leader, follower], queue, settle} = createRoom(2)
        leader.host.transport.notify({playing: true, position: 0})
        expect(queue).toEqual([])
        follower.service.follow(leader.id)
        settle()
        follower.host.calls.length = 0
        leader.host.transport.notify({playing: true, position: 3840})
        expect(queue.map(({message}) => message.type)).toEqual(["transport"])
        settle()
        expect(follower.host.calls[1]).toBe("play")
        leader.host.transport.notify({playing: false, position: 4000})
        settle()
        expect(follower.host.calls.slice(2)).toEqual(["stop", "position:4000.0"])
    })
    it("follows the person at the end of a chain", () => {
        const {peers: [first, middle, last], queue, settle} = createRoom(3)
        middle.service.follow(first.id)
        settle()
        last.service.follow(middle.id)
        expect(queue.map(({message}) => message.type === "request" ? message.to : -1)).toEqual([first.id, first.id, first.id, first.id])
        settle()
        expect(last.service.leader.getValue()).toBe(first.id)
        expect(first.service.followers()).toEqual(expect.arrayContaining([middle.id, last.id]))
    })
    it("refuses to close a loop", () => {
        const {peers: [first, second], settle} = createRoom(2)
        first.service.follow(second.id)
        settle()
        expect(second.service.canFollow(first.id)).toBe(false)
        second.service.follow(first.id)
        expect(second.host.locked).toBe(false)
        expect(second.service.target.getValue()).toBeNull()
    })
    it("gives the transport back when the leader leaves", () => {
        const {peers: [leader, follower], settle, disconnect} = createRoom(2)
        follower.service.follow(leader.id)
        settle()
        disconnect(leader)
        expect(follower.host.locked).toBe(false)
        expect(follower.service.target.getValue()).toBeNull()
        expect(follower.awareness.getLocalState()?.[FollowAwarenessField]).toBeNull()
    })
    it("gives the transport back when someone in the chain leaves", () => {
        const {peers: [first, middle, last], settle, disconnect} = createRoom(3)
        middle.service.follow(first.id)
        settle()
        last.service.follow(middle.id)
        settle()
        disconnect(first)
        expect(last.host.locked).toBe(false)
        expect(middle.host.locked).toBe(false)
    })
    it("ends when the end of the chain changes", () => {
        const {peers: [first, middle, last, other], settle} = createRoom(4)
        middle.service.follow(first.id)
        settle()
        last.service.follow(middle.id)
        settle()
        middle.service.follow(other.id)
        expect(last.host.locked).toBe(false)
        expect(last.service.target.getValue()).toBeNull()
        middle.service.unfollow()
        last.service.follow(middle.id)
        settle()
        middle.service.unfollow()
        expect(last.host.locked).toBe(true)
        expect(last.service.leader.getValue()).toBe(middle.id)
    })
    it("switches to another person without releasing the transport", () => {
        const {peers: [first, second, follower], queue, settle} = createRoom(3)
        follower.service.follow(first.id)
        settle()
        follower.service.follow(second.id)
        expect(follower.host.locked).toBe(true)
        expect(follower.service.leader.getValue()).toBe(second.id)
        expect(queue.map(({message}) => message.type === "request" ? message.to : -1)).toEqual([second.id, second.id, second.id, second.id])
        expect(follower.host.calls.filter(call => call === "lock")).toEqual(["lock"])
    })
    it("ignores answers and transport from anyone but the leader", () => {
        const {peers: [leader, follower, other], queue, flush, settle} = createRoom(3)
        follower.service.follow(leader.id)
        const request = queue[0].message
        const nonce = request.type === "request" ? request.nonce : -1
        queue.length = 0
        queue.push({sender: other.id, message: {type: "state", from: other.id, to: follower.id, nonce, playing: true, position: 1, outputLatency: 0, sentAt: 0}})
        queue.push({sender: other.id, message: {type: "transport", from: other.id, playing: true, position: 2, outputLatency: 0, sentAt: 0}})
        queue.push({sender: leader.id, message: {type: "state", from: leader.id, to: follower.id, nonce: nonce + 99, playing: true, position: 3, outputLatency: 0, sentAt: 0}})
        flush()
        settle()
        expect(follower.host.calls).toEqual(["endRecording", "lock"])
    })
    it("releases the lock and clears the presence field on terminate", () => {
        const {peers: [leader, follower], settle} = createRoom(2)
        follower.service.follow(leader.id)
        settle()
        follower.service.terminate()
        expect(follower.host.locked).toBe(false)
        expect(leader.awareness.getStates().get(follower.id)?.[FollowAwarenessField]).toBeNull()
    })
    it("survives terminate after the room's presence is already gone", () => {
        const {peers: [leader, follower], settle} = createRoom(2)
        follower.service.follow(leader.id)
        settle()
        follower.awareness.destroy()
        expect(() => follower.service.terminate()).not.toThrow()
        expect(follower.host.locked).toBe(false)
    })
})
