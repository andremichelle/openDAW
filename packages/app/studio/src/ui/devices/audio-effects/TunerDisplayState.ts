/** Visual release only: retained readings never enter the live pitch history. */
export class TunerDisplayState {
    midi = NaN
    opacity = 0
    #lastSignal = -Infinity
    #lastFrame = NaN
    #live = false

    update(midi: number, now: number, damping: number): void {
        const dt = Number.isFinite(this.#lastFrame) ? Math.max(0, Math.min((now - this.#lastFrame) / 1000, 0.1)) : 0
        this.#lastFrame = now
        if (Number.isFinite(midi)) {
            if (!this.#live || !Number.isFinite(this.midi) || Math.abs(midi - this.midi) > 0.75) {this.midi = midi}
            else {this.midi += (midi - this.midi) * (1 - Math.exp(-dt / (0.015 + damping * 0.3)))}
            this.#lastSignal = now
            this.opacity = 1
            this.#live = true
        } else {
            this.#live = false
            const progress = Math.max(0, Math.min(1, (now - this.#lastSignal - 120) / 1000))
            this.opacity = 1 - progress * progress * (3 - 2 * progress)
            if (this.opacity === 0) {this.midi = NaN}
        }
    }

    reset(): void {
        this.midi = NaN
        this.opacity = 0
        this.#lastSignal = -Infinity
        this.#lastFrame = NaN
        this.#live = false
    }
}
