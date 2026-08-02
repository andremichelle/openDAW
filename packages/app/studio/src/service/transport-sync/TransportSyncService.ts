import {DefaultObservableValue, isDefined, Option, Optional, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {Engine} from "@opendaw/studio-core"
import {TransportAnchor} from "@/service/transport-sync/TransportAnchor"
import {TransportChannel} from "@/service/transport-sync/TransportChannel"

const ToleranceMillis = 175
const DriftCheckIntervalMillis = 500

export type RejoinGrid = "bar" | "beat"

const RejoinGridPulses: Readonly<Record<RejoinGrid, ppqn>> = {bar: PPQN.Bar, beat: PPQN.Quarter}

// Shared listening (plans/opendaw-shared-transport-plan.md). Last action wins: whoever calls
// play()/stop() locally publishes a fresh anchor. Clients that opt in via `follow` recompute
// their own position from that anchor instead of receiving a running clock. The service itself
// outlives any single room — call attach() with a channel (a live-room Y.Map, or the phase 1
// BroadcastChannel) when one becomes available, and terminate the returned handle to detach.
export class TransportSyncService implements Terminable {
    readonly #terminator = new Terminator()
    readonly #engine: Engine
    readonly #follow = new DefaultObservableValue(false)
    readonly #rejoinGrid = new DefaultObservableValue<RejoinGrid>("bar")

    #channel: Option<TransportChannel> = Option.None
    #channelSubscription: Option<Subscription> = Option.None
    #latestAnchor: Option<TransportAnchor> = Option.None
    #rejoinTimeoutId: Optional<number> = undefined
    #driftIntervalId: Optional<number> = undefined

    constructor(engine: Engine) {
        this.#engine = engine
        this.#terminator.own(this.#follow.subscribe(owner => {
            if (owner.getValue()) {this.#latestAnchor.ifSome(anchor => this.#reconcile(anchor))}
            else {this.#cancelRejoin(); this.#cancelDriftWatch()}
        }))
    }

    get follow(): DefaultObservableValue<boolean> {return this.#follow}
    get rejoinGrid(): DefaultObservableValue<RejoinGrid> {return this.#rejoinGrid}

    attach(channel: TransportChannel): Terminable {
        this.#detach()
        this.#channel = Option.wrap(channel)
        this.#channelSubscription = Option.wrap(channel.subscribe(anchor => this.#onRemoteAnchor(anchor)))
        return {terminate: () => this.#detach()}
    }

    #detach(): void {
        this.#channelSubscription.ifSome(subscription => subscription.terminate())
        this.#channelSubscription = Option.None
        this.#channel = Option.None
        this.#latestAnchor = Option.None
        this.#cancelRejoin()
        this.#cancelDriftWatch()
    }

    publishLocal(playing: boolean): void {
        const anchor: TransportAnchor = {
            playing, epoch: Date.now(), anchorPosition: this.#engine.position.getValue(), bpm: this.#engine.bpm.getValue()
        }
        this.#latestAnchor = Option.wrap(anchor)
        this.#channel.ifSome(channel => channel.publish(anchor))
    }

    #onRemoteAnchor(anchor: TransportAnchor): void {
        this.#latestAnchor = Option.wrap(anchor)
        if (this.#follow.getValue()) {this.#reconcile(anchor)}
    }

    #reconcile(anchor: TransportAnchor): void {
        this.#cancelRejoin()
        if (!anchor.playing) {this.#cancelDriftWatch(); this.#engine.stop(); return}
        if (!this.#engine.isPlaying.getValue()) {this.#snapToAnchor(anchor); return}
        if (Math.abs(this.#driftMillis(anchor)) > ToleranceMillis) {this.#scheduleQuantizedRejoin(anchor)} else {this.#ensureDriftWatch()}
    }

    #driftMillis(anchor: TransportAnchor): number {
        const target = TransportAnchor.recompute(anchor, Date.now())
        const local = this.#engine.position.getValue()
        return PPQN.pulsesToSeconds(local - target, anchor.bpm) * 1000
    }

    #snapToAnchor(anchor: TransportAnchor): void {
        this.#engine.setPosition(TransportAnchor.recompute(anchor, Date.now()))
        if (!this.#engine.isPlaying.getValue()) {this.#engine.play()}
        this.#ensureDriftWatch()
    }

    // Rather than yanking the playhead mid-grid-line (an audible glitch), wait for the next local
    // bar or beat line and snap there — the "quantized rejoin" behaviour from the design doc.
    #scheduleQuantizedRejoin(anchor: TransportAnchor): void {
        this.#cancelDriftWatch()
        const gridPulses = RejoinGridPulses[this.#rejoinGrid.getValue()]
        const localPosition = this.#engine.position.getValue()
        const nextGridLine = (Math.floor(localPosition / gridPulses) + 1) * gridPulses
        const delayMillis = PPQN.pulsesToSeconds(nextGridLine - localPosition, anchor.bpm) * 1000
        this.#rejoinTimeoutId = window.setTimeout(() => {
            this.#rejoinTimeoutId = undefined
            this.#engine.setPosition(TransportAnchor.recompute(anchor, Date.now()))
            this.#ensureDriftWatch()
        }, delayMillis)
    }

    #ensureDriftWatch(): void {
        if (isDefined(this.#driftIntervalId)) {return}
        this.#driftIntervalId = window.setInterval(() => {
            if (!this.#follow.getValue()) {this.#cancelDriftWatch(); return}
            this.#latestAnchor.ifSome(anchor => {
                if (anchor.playing && this.#engine.isPlaying.getValue() && Math.abs(this.#driftMillis(anchor)) > ToleranceMillis) {
                    this.#scheduleQuantizedRejoin(anchor)
                }
            })
        }, DriftCheckIntervalMillis)
    }

    #cancelRejoin(): void {
        if (isDefined(this.#rejoinTimeoutId)) {window.clearTimeout(this.#rejoinTimeoutId); this.#rejoinTimeoutId = undefined}
    }

    #cancelDriftWatch(): void {
        if (isDefined(this.#driftIntervalId)) {window.clearInterval(this.#driftIntervalId); this.#driftIntervalId = undefined}
    }

    terminate(): void {
        this.#detach()
        this.#terminator.terminate()
    }
}
