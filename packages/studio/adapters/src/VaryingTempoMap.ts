import {bpm, ppqn, PPQN, seconds, TempoChangeGrid, TempoMap} from "@opendaw/lib-dsp"
import {Observer, quantizeCeil, Subscription, Terminator} from "@opendaw/lib-std"
import {TimelineBoxAdapter} from "./timeline/TimelineBoxAdapter"

/**
 * TempoMap implementation that handles varying tempo (tempo automation).
 * Steps through at TempoChangeGrid intervals to match BlockRenderer behavior.
 */
export class VaryingTempoMap implements TempoMap {
    readonly #adapter: TimelineBoxAdapter

    constructor(adapter: TimelineBoxAdapter) {
        this.#adapter = adapter
    }

    getTempoAt(position: ppqn): bpm {
        const storageBpm = this.#adapter.box.bpm.getValue()
        return this.#adapter.tempoTrackEvents.mapOr(
            collection => collection.valueAt(position, storageBpm),
            storageBpm
        )
    }

    ppqnToSeconds(position: ppqn): seconds {
        return this.intervalToSeconds(0, position)
    }

    secondsToPPQN(time: seconds): ppqn {
        return this.#absoluteSecondsToPPQN(time)
    }

    // Internal: find PPQN position for an absolute time (seconds from timeline start)
    #absoluteSecondsToPPQN(targetSeconds: seconds): ppqn {
        if (targetSeconds <= 0) {return 0.0}
        const storageBpm = this.#adapter.box.bpm.getValue()
        const tempoEvents = this.#adapter.tempoTrackEvents
        if (tempoEvents.isEmpty()) {return PPQN.secondsToPulses(targetSeconds, storageBpm)}
        const collection = tempoEvents.unwrap()
        if (collection.events.isEmpty()) {return PPQN.secondsToPulses(targetSeconds, storageBpm)}
        let accumulatedSeconds: seconds = 0.0
        let accumulatedPPQN: ppqn = 0.0
        while (accumulatedSeconds < targetSeconds) {
            const currentBpm = collection.valueAt(accumulatedPPQN, storageBpm)
            const nextGrid = quantizeCeil(accumulatedPPQN, TempoChangeGrid)
            const segmentEnd = nextGrid <= accumulatedPPQN ? nextGrid + TempoChangeGrid : nextGrid
            const segmentPPQN = segmentEnd - accumulatedPPQN
            const segmentSeconds = PPQN.pulsesToSeconds(segmentPPQN, currentBpm)
            if (accumulatedSeconds + segmentSeconds >= targetSeconds) {
                const remainingSeconds = targetSeconds - accumulatedSeconds
                accumulatedPPQN += PPQN.secondsToPulses(remainingSeconds, currentBpm)
                break
            }
            accumulatedSeconds += segmentSeconds
            accumulatedPPQN = segmentEnd
        }
        return accumulatedPPQN
    }

    intervalToSeconds(fromPPQN: ppqn, toPPQN: ppqn): seconds {
        if (fromPPQN >= toPPQN) {return 0.0}
        const storageBpm = this.#adapter.box.bpm.getValue()
        const tempoEvents = this.#adapter.tempoTrackEvents
        if (tempoEvents.isEmpty()) {
            return PPQN.pulsesToSeconds(toPPQN - fromPPQN, storageBpm)
        }
        const collection = tempoEvents.unwrap()
        if (collection.events.isEmpty()) {
            return PPQN.pulsesToSeconds(toPPQN - fromPPQN, storageBpm)
        }
        let totalSeconds: seconds = 0.0
        let currentPPQN = fromPPQN
        while (currentPPQN < toPPQN) {
            const currentBpm = collection.valueAt(currentPPQN, storageBpm)
            const nextGrid = quantizeCeil(currentPPQN, TempoChangeGrid)
            const segmentEnd = nextGrid <= currentPPQN ? nextGrid + TempoChangeGrid : nextGrid
            const actualEnd = Math.min(segmentEnd, toPPQN)
            totalSeconds += PPQN.pulsesToSeconds(actualEnd - currentPPQN, currentBpm)
            currentPPQN = actualEnd
        }
        return totalSeconds
    }

    intervalToPPQN(fromSeconds: seconds, toSeconds: seconds): ppqn {
        if (fromSeconds >= toSeconds) {return 0.0}
        // Find PPQN positions for both absolute times, return the difference
        const fromPPQN = this.#absoluteSecondsToPPQN(fromSeconds)
        const toPPQN = this.#absoluteSecondsToPPQN(toSeconds)
        return toPPQN - fromPPQN
    }

    subscribe(observer: Observer<TempoMap>): Subscription {
        const terminator = new Terminator()
        terminator.ownAll(
            this.#adapter.box.bpm.subscribe(() => observer(this)),
            this.#adapter.catchupAndSubscribeTempoAutomation(() => observer(this))
        )
        return terminator
    }
}