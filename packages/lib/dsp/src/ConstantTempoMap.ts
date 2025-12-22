import {Notifier, ObservableValue, Observer, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {bpm, PPQN, ppqn, seconds} from "./ppqn"
import {TempoMap} from "./tempo"

/**
 * Simple constant tempo map implementation.
 * All conversions are linear since the tempo never changes.
 */
export class ConstantTempoMap implements TempoMap, Terminable {
    readonly #terminator = new Terminator()
    readonly #notifier: Notifier<this>

    #tempo: bpm

    constructor(observableTempo: ObservableValue<bpm>) {
        this.#notifier = this.#terminator.own(new Notifier())
        this.#terminator.own(observableTempo.subscribe(owner => {
            this.#tempo = owner.getValue()
            this.#notifier.notify(this)
        }))
        this.#tempo = observableTempo.getValue()
    }

    subscribe(observer: Observer<TempoMap>): Subscription {
        return this.#notifier.subscribe(observer)
    }

    getTempoAt(_position: ppqn): bpm {return this.#tempo}

    ppqnToSeconds(position: ppqn): seconds {
        return PPQN.pulsesToSeconds(position, this.#tempo)
    }

    secondsToPPQN(time: seconds): ppqn {
        return PPQN.secondsToPulses(time, this.#tempo)
    }

    intervalToSeconds(fromPPQN: ppqn, toPPQN: ppqn): seconds {
        return PPQN.pulsesToSeconds(toPPQN - fromPPQN, this.#tempo)
    }

    intervalToPPQN(fromSeconds: seconds, toSeconds: seconds): ppqn {
        return PPQN.secondsToPulses(toSeconds - fromSeconds, this.#tempo)
    }

    terminate(): void {this.#notifier.terminate()}
}