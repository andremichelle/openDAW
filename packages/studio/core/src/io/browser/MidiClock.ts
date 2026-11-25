// Firefox stamps MIDI events on a clock of its own (seconds of system uptime, not `performance.now()`). The
// largest stamp-minus-now seen is its offset less the shortest delivery, so stamps convert with it.
export class MidiClock {
    static readonly SameClockMillis = 1000.0

    #offset: number = Number.NEGATIVE_INFINITY

    toPerformanceTime(timeStamp: number, now: number): number {
        const delta = timeStamp - now
        if (Math.abs(delta) < MidiClock.SameClockMillis) {return timeStamp}
        this.#offset = Math.max(this.#offset, delta)
        return timeStamp - this.#offset
    }
}
