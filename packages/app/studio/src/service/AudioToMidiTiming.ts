import {TempoMap} from "@opendaw/lib-dsp"
import {WarpMarkerTemplate} from "@opendaw/studio-core"

/** A snapshot of the clip's local musical-time <-> file-time mapping. */
export class AudioToMidiTiming {
    constructor(readonly tempoMap: TempoMap, readonly origin: number, readonly waveformOffset: number,
                readonly markers: ReadonlyArray<WarpMarkerTemplate>) {
        for (let i = 0; i < markers.length; i++) {
            const marker = markers[i]
            if (!Number.isFinite(marker.position) || !Number.isFinite(marker.seconds)
                || (i > 0 && (marker.position <= markers[i - 1].position || marker.seconds <= markers[i - 1].seconds))) {
                throw new Error("Audio warp markers must increase in time")
            }
        }
    }

    toSeconds(pulses: number): number {
        if (this.markers.length < 2) {
            return this.waveformOffset + this.tempoMap.intervalToSeconds(this.origin, this.origin + pulses)
        }
        return this.waveformOffset + this.#interpolate(pulses, "position", "seconds")
    }

    toPulses(seconds: number): number {
        const local = seconds - this.waveformOffset
        if (this.markers.length < 2) {
            const originSeconds = this.tempoMap.ppqnToSeconds(this.origin)
            return this.tempoMap.intervalToPPQN(originSeconds, originSeconds + local)
        }
        return this.#interpolate(local, "seconds", "position")
    }

    #interpolate(value: number, input: keyof WarpMarkerTemplate, output: keyof WarpMarkerTemplate): number {
        let lo = 0, hi = this.markers.length - 1
        while (lo + 1 < hi) {
            const mid = (lo + hi) >>> 1
            if (this.markers[mid][input] <= value) {lo = mid} else {hi = mid}
        }
        const left = this.markers[lo], right = this.markers[lo + 1]
        return left[output] + (value - left[input]) / (right[input] - left[input]) * (right[output] - left[output])
    }
}
