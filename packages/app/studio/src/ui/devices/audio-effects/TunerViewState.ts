import {clamp, isAbsent, Optional} from "@opendaw/lib-std"
import {TunerDisplayState} from "./TunerDisplayState"

export type TunerPoint = {time: number, midi: number}
export type TunerRange = {center: number, span: number}
export const TunerTiming = Object.freeze({history: 8000, freshness: 300, interval: 1000 / 30, follow: 0.2, damping: 0.15})

export class TunerViewState {
    readonly display: TunerDisplayState
    readonly history: TunerPoint[]
    center: number
    span: number
    phase = 0
    valid = false
    preview: Optional<TunerRange>
    #frequency = 0
    #confidence = 0
    #received = -Infinity
    #lastFrame = NaN
    #lastPoint = -Infinity

    constructor(center: number, span: number) {
        this.display = new TunerDisplayState()
        this.history = []
        this.center = center
        this.span = span
    }

    receive(values: Float32Array, now: number): boolean {
        const changed = values[0] !== this.#frequency || values[1] !== this.#confidence
            || now - this.#received >= TunerTiming.freshness
        this.#frequency = values[0]
        this.#confidence = values[1]
        this.#received = now
        return changed
    }

    update(now: number, enabled: boolean, reference: number, autoFollow: boolean, range: TunerRange): void {
        const wasValid = this.valid
        const dt = Number.isFinite(this.#lastFrame) ? clamp((now - this.#lastFrame) / 1000, 0, 0.1) : 0
        this.#lastFrame = now
        this.valid = enabled && now - this.#received < TunerTiming.freshness
            && Number.isFinite(this.#frequency) && this.#frequency >= 30 && this.#confidence >= 0.85
        const midi = this.valid ? 69 + 12 * Math.log2(this.#frequency / reference) : NaN
        if (!enabled) {this.display.reset()}
        this.display.update(midi, now, TunerTiming.damping)
        this.span = this.preview?.span ?? range.span
        if (isAbsent(this.preview) && autoFollow) {
            if (this.valid) {this.center += (Math.round(this.display.midi) - this.center) * (1 - Math.exp(-dt / TunerTiming.follow))}
        } else {this.center = this.preview?.center ?? range.center}
        if (this.valid) {this.phase = (this.phase + this.cents * dt / 100) % 1}
        if (now - this.#lastPoint >= TunerTiming.interval && this.valid) {
            this.history.push({time: now, midi: this.display.midi})
            this.#lastPoint = now
        }
        if (wasValid && !this.valid) {this.history.push({time: now, midi: NaN})}
        while (this.history.length > 0 && now - this.history[0].time > TunerTiming.history) {this.history.shift()}
    }

    get visible(): boolean {return Number.isFinite(this.display.midi) && this.display.opacity > 0}
    get cents(): number {return this.visible ? (this.display.midi - Math.round(this.display.midi)) * 100 : 0}
    animating(histogram: boolean): boolean {return this.valid || this.visible || (histogram && this.history.length > 0)}
}
