import {bpm, ppqn, seconds, TempoChangeGrid, TempoMap} from "@opendaw/lib-dsp"
import {Observer, Subscription, Terminable} from "@opendaw/lib-std"
import {TimelineBoxAdapter} from "./timeline/TimelineBoxAdapter"

export class VaryingTempoMap implements TempoMap {
    readonly #adapter: TimelineBoxAdapter

    constructor(adapter: TimelineBoxAdapter) {
        this.#adapter = adapter

        TempoChangeGrid // TODO Take intro account that tempo automation is not continuous
    }

    getTempoAt(ppqn: ppqn): bpm {
        const storageBpm = this.#adapter.box.bpm.getValue()
        return this.#adapter.tempoTrackEvents.mapOr(collection => collection.valueAt(ppqn, storageBpm), storageBpm)
    }

    intervalToPPQN(fromSeconds: seconds, toSeconds: seconds): ppqn {
        // TODO
        return 0
    }

    intervalToSeconds(fromPPQN: ppqn, toPPQN: ppqn): seconds {
        // TODO
        return 0
    }

    ppqnToSeconds(position: ppqn): seconds {
        // TODO
        return 0
    }

    secondsToPPQN(time: seconds): ppqn {
        // TODO
        return 0
    }

    subscribe(observer: Observer<TempoMap>): Subscription {
        // TODO Listen to storage and event tempo changes
        return Terminable.Empty
    }
}