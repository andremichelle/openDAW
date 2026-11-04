import type {Awareness} from "y-protocols/awareness"
import {
    DefaultObservableValue,
    Func,
    isDefined,
    Nullable,
    ObservableValue,
    Observer,
    Procedure,
    Provider,
    Subscription,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {ppqn, seconds} from "@opendaw/lib-dsp"
import {TransportLock} from "@opendaw/studio-core"
import {canFollow, FollowLinks, followersOf, resolveChain} from "@/follow/FollowMath"
import {
    asFollowTarget,
    FollowMessage,
    FollowState,
    FollowTransport,
    FollowTransportEvent,
    isAddressedTo
} from "@/follow/FollowTypes"

export interface FollowHost {
    outputLatency(): seconds
    isPlaying(): boolean
    currentPosition(): ppqn
    advance(position: ppqn, elapsed: seconds): ppqn
    startDelay(): seconds
    lockTransport(): TransportLock
    endRecording(): void
    subscribeTransport(observer: Observer<FollowTransportEvent>): Subscription
}

export interface FollowChannel extends Terminable {
    publish(message: FollowMessage): void
}

export const FollowAwarenessField = "follow"

const DefaultTransit: seconds = 0.05
// requests sent on follow, the fastest answer gives the best estimate of the leader's clock
const ClockRequests = 4

export class FollowService implements Terminable {
    readonly #terminator = new Terminator()
    readonly #awareness: Awareness
    readonly #host: FollowHost
    readonly #channel: FollowChannel
    readonly #clock: Provider<number>
    readonly #target: DefaultObservableValue<Nullable<number>>
    readonly #leader: DefaultObservableValue<Nullable<number>>
    readonly #requests: Map<number, number> = new Map()

    #lock: Nullable<TransportLock> = null
    #offset: Nullable<number> = null
    #bestRoundTrip: number = Number.POSITIVE_INFINITY
    #synced: boolean = false
    #nonce: number = 0

    constructor(awareness: Awareness, host: FollowHost,
                createChannel: Func<Procedure<FollowMessage>, FollowChannel>,
                clock: Provider<number> = () => performance.timeOrigin + performance.now()) {
        this.#awareness = awareness
        this.#host = host
        this.#clock = clock
        this.#target = this.#terminator.own(new DefaultObservableValue<Nullable<number>>(null))
        this.#leader = this.#terminator.own(new DefaultObservableValue<Nullable<number>>(null))
        this.#channel = this.#terminator.own(createChannel(message => this.#onMessage(message)))
        const onAwareness = () => this.#reconcile()
        awareness.on("change", onAwareness)
        this.#terminator.own({terminate: () => awareness.off("change", onAwareness)})
        this.#terminator.own(host.subscribeTransport(event => this.#onLocalTransport(event)))
    }

    get clientId(): number {return this.#awareness.clientID}
    get target(): ObservableValue<Nullable<number>> {return this.#target}
    get leader(): ObservableValue<Nullable<number>> {return this.#leader}

    links(): FollowLinks {
        const links = new Map<number, Nullable<number>>()
        this.#awareness.getStates().forEach((state, clientId) =>
            links.set(clientId, asFollowTarget(state[FollowAwarenessField])))
        return links
    }

    canFollow(clientId: number): boolean {return canFollow(this.links(), this.clientId, clientId)}

    followers(): ReadonlyArray<number> {return followersOf(this.links(), this.clientId)}

    follow(clientId: number): void {
        if (!this.canFollow(clientId)) {return}
        if (!isDefined(this.#lock)) {
            this.#host.endRecording()
            this.#lock = this.#host.lockTransport()
        }
        this.#leader.setValue(null)
        this.#target.setValue(clientId)
        this.#awareness.setLocalStateField(FollowAwarenessField, clientId)
        this.#reconcile()
    }

    unfollow(): void {
        this.#resetClock()
        this.#target.setValue(null)
        this.#leader.setValue(null)
        this.#lock?.terminate()
        this.#lock = null
        if (isDefined(this.#awareness.getLocalState())) {
            this.#awareness.setLocalStateField(FollowAwarenessField, null)
        }
    }

    terminate(): void {
        this.unfollow()
        this.#terminator.terminate()
    }

    #reconcile(): void {
        const target = this.#target.getValue()
        if (!isDefined(target)) {return}
        const chain = resolveChain(this.links(), target)
        const leader = this.#leader.getValue()
        // the person at the end of the chain changed or left: following ends, the transport comes back
        if (chain.type !== "leader" || chain.leader === this.clientId || (isDefined(leader) && leader !== chain.leader)) {
            this.unfollow()
            return
        }
        if (leader === chain.leader) {return}
        this.#leader.setValue(chain.leader)
        this.#resetClock()
        for (let index = 0; index < ClockRequests; index++) {this.#request(chain.leader)}
    }

    #resetClock(): void {
        this.#requests.clear()
        this.#offset = null
        this.#bestRoundTrip = Number.POSITIVE_INFINITY
        this.#synced = false
    }

    #request(leader: number): void {
        const nonce = ++this.#nonce
        this.#requests.set(nonce, this.#clock())
        this.#channel.publish({type: "request", from: this.clientId, to: leader, nonce})
    }

    #onMessage(message: FollowMessage): void {
        if (message.from === this.clientId || !isAddressedTo(message, this.clientId)) {return}
        switch (message.type) {
            case "request":
                this.#channel.publish({
                    type: "state", from: this.clientId, to: message.from, nonce: message.nonce,
                    playing: this.#host.isPlaying(), position: this.#host.currentPosition(),
                    outputLatency: this.#host.outputLatency(), sentAt: this.#clock()
                })
                return
            case "state": {
                const sentAt = this.#requests.get(message.nonce)
                if (!isDefined(sentAt) || message.from !== this.#leader.getValue()) {return}
                this.#requests.delete(message.nonce)
                const receivedAt = this.#clock()
                const roundTrip = receivedAt - sentAt
                if (roundTrip < this.#bestRoundTrip) {
                    this.#bestRoundTrip = roundTrip
                    this.#offset = message.sentAt - (sentAt + receivedAt) / 2.0
                }
                if (this.#synced) {return}
                this.#synced = true
                this.#apply(message, receivedAt)
                return
            }
            case "transport":
                if (message.from === this.#leader.getValue()) {this.#apply(message, this.#clock())}
                return
        }
    }

    #apply({playing, position, outputLatency, sentAt}: FollowState | FollowTransport, receivedAt: number): void {
        const lock = this.#lock
        if (!isDefined(lock)) {return}
        if (playing) {
            const offset = this.#offset
            const transit = isDefined(offset) ? Math.max(0.0, (receivedAt - (sentAt - offset)) / 1000.0) : DefaultTransit
            const startDelay = this.#host.isPlaying() ? 0.0 : this.#host.startDelay()
            const elapsed = transit + startDelay + this.#host.outputLatency() - outputLatency
            lock.setPosition(this.#host.advance(position, elapsed))
            lock.play()
        } else {
            lock.stop()
            lock.setPosition(position)
        }
    }

    #onLocalTransport({playing, position}: FollowTransportEvent): void {
        if (this.followers().length === 0) {return}
        this.#channel.publish({
            type: "transport", from: this.clientId, playing, position, outputLatency: this.#host.outputLatency(),
            sentAt: this.#clock()
        })
    }
}
