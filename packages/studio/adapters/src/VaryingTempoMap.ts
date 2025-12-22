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
        return this.intervalToPPQN(0, time)
    }

    intervalToSeconds(fromPPQN: ppqn, toPPQN: ppqn): seconds {
        if (fromPPQN >= toPPQN) {return 0}

        const storageBpm = this.#adapter.box.bpm.getValue()
        const tempoEvents = this.#adapter.tempoTrackEvents

        // No tempo automation - use constant tempo
        if (tempoEvents.isEmpty()) {
            return PPQN.pulsesToSeconds(toPPQN - fromPPQN, storageBpm)
        }

        const collection = tempoEvents.unwrap()
        if (collection.events.isEmpty()) {
            return PPQN.pulsesToSeconds(toPPQN - fromPPQN, storageBpm)
        }

        // Step through at TempoChangeGrid intervals (matches BlockRenderer)
        let totalSeconds: seconds = 0
        let currentPPQN = fromPPQN

        while (currentPPQN < toPPQN) {
            // Get tempo at current position
            const currentTempo = collection.valueAt(currentPPQN, storageBpm)

            // Find next grid boundary
            const nextGrid = Math.ceil(currentPPQN / TempoChangeGrid) * TempoChangeGrid
            const segmentEnd = nextGrid <= currentPPQN ? nextGrid + TempoChangeGrid : nextGrid

            // Clamp to target
            const actualEnd = Math.min(segmentEnd, toPPQN)
            const segmentPPQN = actualEnd - currentPPQN

            // Accumulate seconds for this segment at constant tempo
            totalSeconds += PPQN.pulsesToSeconds(segmentPPQN, currentTempo)

            currentPPQN = actualEnd
        }

        return totalSeconds
    }

    intervalToPPQN(fromSeconds: seconds, toSeconds: seconds): ppqn {
        if (fromSeconds >= toSeconds) {return 0}

        const storageBpm = this.#adapter.box.bpm.getValue()
        const tempoEvents = this.#adapter.tempoTrackEvents

        // No tempo automation - use constant tempo
        if (tempoEvents.isEmpty()) {
            return PPQN.secondsToPulses(toSeconds - fromSeconds, storageBpm)
        }

        const collection = tempoEvents.unwrap()
        if (collection.events.isEmpty()) {
            return PPQN.secondsToPulses(toSeconds - fromSeconds, storageBpm)
        }

        // Step through grid by grid, accumulating until we reach target seconds
        const targetSeconds = toSeconds - fromSeconds
        let accumulatedSeconds: seconds = 0
        let accumulatedPPQN: ppqn = 0

        while (accumulatedSeconds < targetSeconds) {
            // Get tempo at current position
            const currentTempo = collection.valueAt(accumulatedPPQN, storageBpm)

            // Calculate next grid boundary
            const nextGrid = quantizeCeil(accumulatedPPQN, TempoChangeGrid)
            const segmentEnd = nextGrid <= accumulatedPPQN ? nextGrid + TempoChangeGrid : nextGrid
            const segmentPPQN = segmentEnd - accumulatedPPQN

            // How many seconds does this segment take?
            const segmentSeconds = PPQN.pulsesToSeconds(segmentPPQN, currentTempo)

            if (accumulatedSeconds + segmentSeconds >= targetSeconds) {
                // Target is within this segment - calculate remaining PPQN
                const remainingSeconds = targetSeconds - accumulatedSeconds
                accumulatedPPQN += PPQN.secondsToPulses(remainingSeconds, currentTempo)
                break
            }

            accumulatedSeconds += segmentSeconds
            accumulatedPPQN = segmentEnd
        }

        return accumulatedPPQN
    }

    subscribe(observer: Observer<TempoMap>): Subscription {
        const terminator = new Terminator()

        // Subscribe to BPM changes
        terminator.own(this.#adapter.box.bpm.subscribe(() => observer(this)))

        // Subscribe to tempo automation changes
        terminator.own(this.#adapter.tempoAutomation.subscribe(() => observer(this)))

        return terminator
    }
}
