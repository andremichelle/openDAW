import {bpm, ppqn, PPQN, seconds, TempoMap, ValueEvent} from "@opendaw/lib-dsp"
import {Observer, Subscription, Terminator} from "@opendaw/lib-std"
import {TimelineBoxAdapter} from "./timeline/TimelineBoxAdapter"
import {ValueEventBoxAdapter} from "./timeline/event/ValueEventBoxAdapter"

/**
 * TempoMap implementation that handles varying tempo (tempo automation).
 * Integrates over the tempo curve to convert between PPQN and seconds.
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

        const events = tempoEvents.unwrap().events
        if (events.isEmpty()) {
            return PPQN.pulsesToSeconds(toPPQN - fromPPQN, storageBpm)
        }

        // Integrate over tempo curve
        let totalSeconds: seconds = 0
        let currentPPQN = fromPPQN

        const eventArray = events.asArray() as ReadonlyArray<ValueEventBoxAdapter>

        // Find starting event index
        let eventIndex = 0
        while (eventIndex < eventArray.length - 1 && eventArray[eventIndex + 1].position <= fromPPQN) {
            eventIndex++
        }

        while (currentPPQN < toPPQN) {
            const currentEvent = eventArray[eventIndex]
            const nextEvent = eventArray[eventIndex + 1] as ValueEventBoxAdapter | undefined

            // Determine segment end
            let segmentEnd: ppqn
            if (nextEvent && nextEvent.position < toPPQN) {
                segmentEnd = nextEvent.position
            } else {
                segmentEnd = toPPQN
            }

            // Calculate seconds for this segment
            const segmentStart = Math.max(currentPPQN, currentEvent?.position ?? 0)
            const segmentPPQN = segmentEnd - segmentStart

            if (segmentPPQN > 0) {
                if (!currentEvent || currentEvent.interpolation.type === "none" || !nextEvent) {
                    // Constant tempo segment
                    const tempo = currentEvent?.value ?? storageBpm
                    totalSeconds += PPQN.pulsesToSeconds(segmentPPQN, tempo)
                } else {
                    // Interpolated tempo - use trapezoidal approximation
                    const startTempo = ValueEvent.valueAt(events, segmentStart, storageBpm)
                    const endTempo = ValueEvent.valueAt(events, segmentEnd, storageBpm)
                    // Average tempo approximation for the segment
                    const avgTempo = (startTempo + endTempo) / 2
                    totalSeconds += PPQN.pulsesToSeconds(segmentPPQN, avgTempo)
                }
            }

            currentPPQN = segmentEnd

            if (nextEvent && currentPPQN >= nextEvent.position) {
                eventIndex++
            }

            // Safety check
            if (eventIndex >= eventArray.length) {
                // Past last event - use last tempo
                const lastTempo = eventArray[eventArray.length - 1]?.value ?? storageBpm
                totalSeconds += PPQN.pulsesToSeconds(toPPQN - currentPPQN, lastTempo)
                break
            }
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

        const events = tempoEvents.unwrap().events
        if (events.isEmpty()) {
            return PPQN.secondsToPulses(toSeconds - fromSeconds, storageBpm)
        }

        // Use iterative approach: accumulate PPQN while tracking seconds
        const targetSeconds = toSeconds - fromSeconds
        let accumulatedSeconds: seconds = 0
        let accumulatedPPQN: ppqn = 0

        const eventArray = events.asArray() as ReadonlyArray<ValueEventBoxAdapter>

        // Start from beginning and accumulate until we reach target seconds
        let eventIndex = 0

        while (accumulatedSeconds < targetSeconds) {
            const currentEvent = eventArray[eventIndex]
            const nextEvent = eventArray[eventIndex + 1] as ValueEventBoxAdapter | undefined

            // Determine tempo for this segment
            const currentTempo = currentEvent?.value ?? storageBpm

            if (!nextEvent) {
                // No more events - use current tempo for remaining time
                const remainingSeconds = targetSeconds - accumulatedSeconds
                accumulatedPPQN += PPQN.secondsToPulses(remainingSeconds, currentTempo)
                break
            }

            // Calculate how much time this segment takes
            const segmentPPQN = nextEvent.position - (currentEvent?.position ?? 0)

            let segmentSeconds: seconds
            if (!currentEvent || currentEvent.interpolation.type === "none") {
                segmentSeconds = PPQN.pulsesToSeconds(segmentPPQN, currentTempo)
            } else {
                // Interpolated - use average tempo
                const avgTempo = (currentTempo + nextEvent.value) / 2
                segmentSeconds = PPQN.pulsesToSeconds(segmentPPQN, avgTempo)
            }

            if (accumulatedSeconds + segmentSeconds >= targetSeconds) {
                // Target is within this segment
                const remainingSeconds = targetSeconds - accumulatedSeconds
                if (!currentEvent || currentEvent.interpolation.type === "none") {
                    accumulatedPPQN += PPQN.secondsToPulses(remainingSeconds, currentTempo)
                } else {
                    // Approximate with average tempo
                    const avgTempo = (currentTempo + nextEvent.value) / 2
                    accumulatedPPQN += PPQN.secondsToPulses(remainingSeconds, avgTempo)
                }
                break
            }

            accumulatedSeconds += segmentSeconds
            accumulatedPPQN += segmentPPQN
            eventIndex++
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
