import {bpm, ppqn, PPQN, seconds, TempoChangeGrid, TempoMap} from "@opendaw/lib-dsp"
import {
    BinarySearch,
    NumberComparator,
    Observer,
    quantizeCeil,
    Subscription,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {TimelineBoxAdapter} from "./timeline/TimelineBoxAdapter"

type CacheEntry = { ppqn: ppqn, seconds: seconds, bpm: bpm }

/**
 * TempoMap implementation that handles varying tempo (tempo automation).
 * Steps through at TempoChangeGrid intervals to match BlockRenderer behavior.
 */
export class VaryingTempoMap implements TempoMap, Terminable {
    readonly #terminator: Terminator = new Terminator()
    readonly #adapter: TimelineBoxAdapter
    readonly #ppqnCache: Array<CacheEntry> = []
    readonly #secondsCache: Array<CacheEntry> = []

    constructor(adapter: TimelineBoxAdapter) {
        this.#adapter = adapter
        this.#terminator.ownAll(
            adapter.box.bpm.subscribe(() => this.#rebuildCache()),
            adapter.catchupAndSubscribeTempoAutomation(() => this.#rebuildCache())
        )
    }

    terminate(): void {
        this.#terminator.terminate()
    }

    #rebuildCache(): void {
        this.#ppqnCache.length = 0
        this.#secondsCache.length = 0
        const tempoEvents = this.#adapter.tempoTrackEvents
        if (tempoEvents.isEmpty()) {return}
        const collection = tempoEvents.unwrap()
        if (collection.events.isEmpty()) {return}
        const events = collection.events.asArray()
        const storageBpm = this.#adapter.box.bpm.getValue()
        const entries: Array<CacheEntry> = [{ppqn: 0, seconds: 0, bpm: collection.valueAt(0, storageBpm)}]
        let accumulatedSeconds: seconds = 0.0
        let currentPPQN: ppqn = 0.0
        for (const event of events) {
            const eventPosition: ppqn = event.position
            if (eventPosition <= currentPPQN) {continue}
            while (currentPPQN < eventPosition) {
                const currentBpm = collection.valueAt(currentPPQN, storageBpm)
                const nextGrid = quantizeCeil(currentPPQN, TempoChangeGrid)
                const segmentEnd = nextGrid <= currentPPQN ? nextGrid + TempoChangeGrid : nextGrid
                const actualEnd = Math.min(segmentEnd, eventPosition)
                accumulatedSeconds += PPQN.pulsesToSeconds(actualEnd - currentPPQN, currentBpm)
                currentPPQN = actualEnd
            }
            entries.push({ppqn: eventPosition, seconds: accumulatedSeconds, bpm: collection.valueAt(eventPosition, storageBpm)})
        }
        this.#ppqnCache.push(...entries)
        const sortedBySeconds = entries.slice().sort((a, b) => a.seconds - b.seconds)
        this.#secondsCache.push(...sortedBySeconds)
    }

    getTempoAt(position: ppqn): bpm {
        const storageBpm = this.#adapter.box.bpm.getValue()
        return this.#adapter.tempoTrackEvents.mapOr(
            collection => collection.valueAt(position, storageBpm),
            storageBpm
        )
    }

    ppqnToSeconds(position: ppqn): seconds {
        if (position < 0) {return -this.#ppqnToSecondsPositive(-position)}
        return this.#ppqnToSecondsPositive(position)
    }

    #ppqnToSecondsPositive(position: ppqn): seconds {
        if (position <= 0) {return 0.0}
        const storageBpm = this.#adapter.box.bpm.getValue()
        const tempoEvents = this.#adapter.tempoTrackEvents
        if (tempoEvents.isEmpty()) {return PPQN.pulsesToSeconds(position, storageBpm)}
        const collection = tempoEvents.unwrap()
        if (collection.events.isEmpty()) {return PPQN.pulsesToSeconds(position, storageBpm)}
        let startPPQN: ppqn = 0.0
        let startSeconds: seconds = 0.0
        if (this.#ppqnCache.length > 0) {
            const index = BinarySearch.rightMostMapped(
                this.#ppqnCache, position, NumberComparator, (entry: CacheEntry) => entry.ppqn
            )
            if (index >= 0) {
                const entry = this.#ppqnCache[index]
                startPPQN = entry.ppqn
                startSeconds = entry.seconds
                if (index === this.#ppqnCache.length - 1) {
                    return startSeconds + PPQN.pulsesToSeconds(position - startPPQN, entry.bpm)
                }
            }
        }
        let accumulatedSeconds = startSeconds
        let currentPPQN = startPPQN
        while (currentPPQN < position) {
            const currentBpm = collection.valueAt(currentPPQN, storageBpm)
            const nextGrid = quantizeCeil(currentPPQN, TempoChangeGrid)
            const segmentEnd = nextGrid <= currentPPQN ? nextGrid + TempoChangeGrid : nextGrid
            const actualEnd = Math.min(segmentEnd, position)
            accumulatedSeconds += PPQN.pulsesToSeconds(actualEnd - currentPPQN, currentBpm)
            currentPPQN = actualEnd
        }
        return accumulatedSeconds
    }

    secondsToPPQN(time: seconds): ppqn {
        return this.#absoluteSecondsToPPQN(time)
    }

    #absoluteSecondsToPPQN(targetSeconds: seconds): ppqn {
        if (targetSeconds <= 0) {return 0.0}
        const storageBpm = this.#adapter.box.bpm.getValue()
        const tempoEvents = this.#adapter.tempoTrackEvents
        if (tempoEvents.isEmpty()) {return PPQN.secondsToPulses(targetSeconds, storageBpm)}
        const collection = tempoEvents.unwrap()
        if (collection.events.isEmpty()) {return PPQN.secondsToPulses(targetSeconds, storageBpm)}
        let startPPQN: ppqn = 0.0
        let startSeconds: seconds = 0.0
        if (this.#secondsCache.length > 0) {
            const index = BinarySearch.rightMostMapped(
                this.#secondsCache, targetSeconds, NumberComparator, (entry: CacheEntry) => entry.seconds
            )
            if (index >= 0) {
                const entry = this.#secondsCache[index]
                startPPQN = entry.ppqn
                startSeconds = entry.seconds
                if (index === this.#secondsCache.length - 1) {
                    return startPPQN + PPQN.secondsToPulses(targetSeconds - startSeconds, entry.bpm)
                }
            }
        }
        let accumulatedSeconds = startSeconds
        let accumulatedPPQN = startPPQN
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
        return this.#ppqnToSecondsPositive(toPPQN) - this.#ppqnToSecondsPositive(fromPPQN)
    }

    intervalToPPQN(fromSeconds: seconds, toSeconds: seconds): ppqn {
        if (fromSeconds >= toSeconds) {return 0.0}
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
