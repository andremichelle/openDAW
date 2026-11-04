import {isDefined, Nullable, Observer, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {ppqn, seconds} from "@opendaw/lib-dsp"
import {TransportAnchor} from "@opendaw/studio-adapters"
import {EngineFacade, Project, TransportLock} from "@opendaw/studio-core"
import {FollowHost} from "@/follow/FollowService"
import {advancePosition, FollowLoop} from "@/follow/FollowMath"
import {FollowTransportEvent} from "@/follow/FollowTypes"

const RenderQuantum = 128
const MaxStartDelay: seconds = 1.0

const finiteOrZero = (value: number): number => Number.isFinite(value) ? value : 0.0

export class StudioFollowHost implements FollowHost, Terminable {
    readonly #terminator = new Terminator()
    readonly #context: AudioContext
    readonly #engine: EngineFacade
    readonly #project: Project

    #anchor: Nullable<TransportAnchor> = null
    #playRequestedAt: Nullable<seconds> = null
    #startDelay: seconds

    // the studio drives the shared worklet through its own facade, the project through another, both get locked
    constructor(context: AudioContext, engine: EngineFacade, project: Project) {
        this.#context = context
        this.#engine = engine
        this.#project = project
        this.#startDelay = RenderQuantum / context.sampleRate
        this.#terminator.own(project.engine.subscribeTransportAnchors(anchors =>
            anchors.forEach(anchor => this.#onAnchor(anchor))))
    }

    outputLatency(): seconds {
        return finiteOrZero(this.#context.outputLatency) + finiteOrZero(this.#context.baseLatency)
    }

    isPlaying(): boolean {return this.#project.engine.isPlaying.getValue()}

    currentPosition(): ppqn {
        const anchor = this.#anchor
        return this.isPlaying() && isDefined(anchor) && anchor.kind !== "stop"
            ? this.#positionOf(anchor)
            : this.#project.engine.position.getValue()
    }

    advance(position: ppqn, elapsed: seconds): ppqn {
        return advancePosition(this.#project.tempoMap, this.#loop(), position, elapsed)
    }

    startDelay(): seconds {return this.#startDelay}

    lockTransport(): TransportLock {
        const lock = this.#engine.lockTransport()
        const projectLock = this.#project.engine.lockTransport()
        return {
            play: () => {
                if (!this.isPlaying()) {this.#playRequestedAt = this.#context.currentTime}
                lock.play()
            },
            stop: (reset?: boolean) => lock.stop(reset),
            setPosition: (position: ppqn) => lock.setPosition(position),
            terminate: () => {
                lock.terminate()
                projectLock.terminate()
            }
        }
    }

    endRecording(): void {
        if (this.#project.isRecording()) {this.#project.stopRecording()}
    }

    subscribeTransport(observer: Observer<FollowTransportEvent>): Subscription {
        const {engine} = this.#project
        return Terminable.many(
            engine.subscribeTransportAnchors(anchors => {
                const anchor = anchors.at(-1)
                if (!isDefined(anchor)) {return}
                observer(anchor.kind === "stop"
                    ? {playing: false, position: anchor.position}
                    : {playing: true, position: this.#positionOf(anchor)})
            }),
            // seeks while stopped, including the jump back of a stop with reset
            engine.position.subscribe(owner => {
                if (this.#running()) {return}
                observer({playing: false, position: owner.getValue()})
            })
        )
    }

    terminate(): void {this.#terminator.terminate()}

    #running(): boolean {
        const anchor = this.#anchor
        return this.isPlaying() || (isDefined(anchor) && anchor.kind !== "stop")
    }

    #onAnchor(anchor: TransportAnchor): void {
        this.#anchor = anchor
        if (anchor.kind !== "start" || !isDefined(this.#playRequestedAt)) {return}
        const delay = anchor.contextTime - this.#playRequestedAt
        if (delay >= 0.0 && delay < MaxStartDelay) {this.#startDelay = delay}
        this.#playRequestedAt = null
    }

    #positionOf(anchor: TransportAnchor): ppqn {
        return this.advance(anchor.position, this.#context.currentTime - anchor.contextTime)
    }

    #loop(): FollowLoop {
        const {enabled, from, to} = this.#project.timelineBox.loopArea
        return {enabled: enabled.getValue(), from: from.getValue(), to: to.getValue()}
    }
}
