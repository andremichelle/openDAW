// maps the main thread clock (`performance.now()`, also the MIDI event stamp) to the audio context time
export interface ContextClock {
    // the context time of the sample that was audible at this `performance.now()` time
    audibleTimeAt(performanceTime: number): number
}
