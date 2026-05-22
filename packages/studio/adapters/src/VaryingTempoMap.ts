import {bpm, ppqn, PPQN, seconds, TempoChangeGrid, TempoMap, ValueEvent} from "@opendaw/lib-dsp"
import {
    BinarySearch,
    Curve,
    int,
    NumberComparator,
    Observer,
    quantizeCeil,
    quantizeFloor,
    Subscription,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {TimelineBoxAdapter} from "./timeline/TimelineBoxAdapter"

type CacheEntry = { ppqn: ppqn, seconds: seconds, bpm: bpm }

/**
 * Allocation-free cursor that walks the TempoChangeGrid as a step function: tempo is constant within
 * each grid cell and sampled at the cell's grid-aligned start (matching BlockRenderer). Tracks the
 * current segment and the recurrence coefficients m, q so a step of exactly TempoChangeGrid within the
 * same zone resolves as v = m * v + q. Because every cell is sampled at its grid origin, the walk is
 * additive: integrate(a, c) === integrate(a, b) + integrate(b, c) for any b.
 */
export class TempoGridCursor {
    #events: ReadonlyArray<ValueEvent> = []
    #storageBpm: bpm = 0.0
    #segmentIndex: int = -2
    #lastPPQN: ppqn = Number.NEGATIVE_INFINITY
    #lastBpm: bpm = 0.0
    #m: number = 1.0
    #q: number = 0.0

    /**
     * Integrates the seconds elapsed across [fromPPQN, toPPQN] by stepping the TempoChangeGrid.
     */
    integrate(events: ReadonlyArray<ValueEvent>, fromPPQN: ppqn, toPPQN: ppqn, storageBpm: bpm): seconds {
        this.#reset(events, storageBpm)
        let acc: seconds = 0.0
        let current: ppqn = fromPPQN
        while (current < toPPQN) {
            const currentBpm = this.#bpmAt(quantizeFloor(current, TempoChangeGrid))
            const nextGrid = quantizeCeil(current, TempoChangeGrid)
            const segmentEnd = nextGrid <= current ? nextGrid + TempoChangeGrid : nextGrid
            const actualEnd = Math.min(segmentEnd, toPPQN)
            acc += PPQN.pulsesToSeconds(actualEnd - current, currentBpm)
            current = actualEnd
        }
        return acc
    }

    /**
     * Walks the TempoChangeGrid forward from fromPPQN, accumulating seconds starting at fromSeconds,
     * until targetSeconds is reached.
     */
    advance(events: ReadonlyArray<ValueEvent>,
            fromPPQN: ppqn,
            fromSeconds: seconds,
            targetSeconds: seconds,
            storageBpm: bpm): ppqn {
        this.#reset(events, storageBpm)
        let accumulatedSeconds: seconds = fromSeconds
        let accumulatedPPQN: ppqn = fromPPQN
        while (accumulatedSeconds < targetSeconds) {
            const currentBpm = this.#bpmAt(quantizeFloor(accumulatedPPQN, TempoChangeGrid))
            const nextGrid = quantizeCeil(accumulatedPPQN, TempoChangeGrid)
            const segmentEnd = nextGrid <= accumulatedPPQN ? nextGrid + TempoChangeGrid : nextGrid
            const segmentPPQN = segmentEnd - accumulatedPPQN
            const segmentSeconds = PPQN.pulsesToSeconds(segmentPPQN, currentBpm)
            if (accumulatedSeconds + segmentSeconds >= targetSeconds) {
                accumulatedPPQN += PPQN.secondsToPulses(targetSeconds - accumulatedSeconds, currentBpm)
                break
            }
            accumulatedSeconds += segmentSeconds
            accumulatedPPQN = segmentEnd
        }
        return accumulatedPPQN
    }

    #reset(events: ReadonlyArray<ValueEvent>, storageBpm: bpm): void {
        this.#events = events
        this.#storageBpm = storageBpm
        this.#segmentIndex = -2
        this.#lastPPQN = Number.NEGATIVE_INFINITY
        this.#lastBpm = 0.0
        this.#m = 1.0
        this.#q = 0.0
    }

    #bpmAt(position: ppqn): bpm {
        const events = this.#events
        if (events.length === 0) {return this.#storageBpm}
        const zone = this.#zoneAt(position)
        if (zone === this.#segmentIndex && position === this.#lastPPQN + TempoChangeGrid) {
            this.#lastPPQN = position
            return this.#lastBpm = this.#m * this.#lastBpm + this.#q
        }
        this.#segmentIndex = zone
        this.#lastPPQN = position
        if (zone < 0) {
            this.#m = 1.0
            this.#q = 0.0
            return this.#lastBpm = zone === -1 ? events[0].value : events[events.length - 1].value
        }
        const a = events[zone]
        const b = events[zone + 1]
        const interpolation = a.interpolation
        if (interpolation.type === "none") {
            this.#m = 1.0
            this.#q = 0.0
            return this.#lastBpm = a.value
        } else if (interpolation.type === "linear") {
            this.#m = 1.0
            this.#q = (b.value - a.value) * TempoChangeGrid / (b.position - a.position)
            return this.#lastBpm = a.value + (position - a.position) / (b.position - a.position) * (b.value - a.value)
        } else {
            const {m, q} = Curve.coefficients({
                slope: interpolation.slope,
                steps: (b.position - a.position) / TempoChangeGrid,
                y0: a.value,
                y1: b.value
            })
            this.#m = m
            this.#q = q
            return this.#lastBpm = Curve.valueAt({
                slope: interpolation.slope,
                steps: b.position - a.position,
                y0: a.value,
                y1: b.value
            }, position - a.position)
        }
    }

    #zoneAt(position: ppqn): int {
        const events = this.#events
        if (position < events[0].position) {return -1}
        const last = events.length - 1
        if (position >= events[last].position) {return -3}
        let low = 0
        let high = last
        while (low < high) {
            const mid = (low + high + 1) >> 1
            if (events[mid].position <= position) {low = mid} else {high = mid - 1}
        }
        return low
    }
}

/**
 * TempoMap implementation that handles varying tempo (tempo automation).
 * Steps through at TempoChangeGrid intervals to match BlockRenderer behavior.
 */
export class VaryingTempoMap implements TempoMap, Terminable {
    readonly #terminator: Terminator = new Terminator()
    readonly #adapter: TimelineBoxAdapter
    readonly #ppqnCache: Array<CacheEntry> = []
    readonly #secondsCache: Array<CacheEntry> = []
    readonly #cursor: TempoGridCursor = new TempoGridCursor()

    #ivFrom: ppqn = Number.NaN
    #ivTo: ppqn = 0.0
    #ivSeconds: seconds = 0.0

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
        this.#ivFrom = Number.NaN
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
            accumulatedSeconds += this.#cursor.integrate(events, currentPPQN, eventPosition, storageBpm)
            currentPPQN = eventPosition
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
        const events = collection.events.asArray()
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
        return startSeconds + this.#cursor.integrate(events, startPPQN, position, storageBpm)
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
        const events = collection.events.asArray()
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
        return this.#cursor.advance(events, startPPQN, startSeconds, targetSeconds, storageBpm)
    }

    intervalToSeconds(fromPPQN: ppqn, toPPQN: ppqn): seconds {
        if (fromPPQN < 0 || toPPQN < fromPPQN) {
            return this.ppqnToSeconds(toPPQN) - this.ppqnToSeconds(fromPPQN)
        }
        const storageBpm = this.#adapter.box.bpm.getValue()
        const tempoEvents = this.#adapter.tempoTrackEvents
        if (tempoEvents.isEmpty()) {return PPQN.pulsesToSeconds(toPPQN - fromPPQN, storageBpm)}
        const collection = tempoEvents.unwrap()
        if (collection.events.isEmpty()) {return PPQN.pulsesToSeconds(toPPQN - fromPPQN, storageBpm)}
        const events = collection.events.asArray()
        if (fromPPQN === this.#ivFrom && toPPQN >= this.#ivTo) {
            this.#ivSeconds += this.#cursor.integrate(events, this.#ivTo, toPPQN, storageBpm)
            this.#ivTo = toPPQN
            return this.#ivSeconds
        }
        this.#ivFrom = fromPPQN
        this.#ivTo = toPPQN
        this.#ivSeconds = this.#cursor.integrate(events, fromPPQN, toPPQN, storageBpm)
        return this.#ivSeconds
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
