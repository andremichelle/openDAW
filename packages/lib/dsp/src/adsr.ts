import {int, unitValue} from "@moises-ai/lib-std"

const enum State { Idle, Attack, Decay, Sustain, Release }

export class Adsr {
    readonly #invSampleRate

    #state = State.Idle
    #value = 0.0
    #phase = 0.0
    #attack = 0.0
    #decay = 0.0
    #sustain = 0.0
    #release = 0.0
    #attackInc = 0.0
    #decayDec = 0.0
    #releaseDec = 0.0

    constructor(sampleRate: number) {this.#invSampleRate = 1.0 / sampleRate}

    get gate(): boolean { return this.#state !== State.Idle && this.#state !== State.Release }
    get complete(): boolean { return this.#state === State.Idle }
    get value(): number { return this.#value }
    get phase(): number { return this.#phase }

    set(attack: number, decay: number, sustain: unitValue, release: number): void {
        this.#attack = attack
        this.#decay = decay
        this.#sustain = sustain
        this.#release = release
        this.#updateRates()
    }

    #updateRates(): void {
        switch (this.#state) {
            case State.Attack: {
                const remain = 1.0 - this.#value
                this.#attackInc = remain * this.#invSampleRate / Math.max(this.#attack, 1e-6)
                break
            }
            case State.Decay: {
                const remain = this.#value - this.#sustain
                this.#decayDec = remain * this.#invSampleRate / Math.max(this.#decay, 1e-6)
                break
            }
            case State.Release: {
                const remain = this.#value
                this.#releaseDec = remain * this.#invSampleRate / Math.max(this.#release, 1e-6)
                break
            }
            case State.Sustain:
            case State.Idle: {
                this.#attackInc = this.#invSampleRate / Math.max(this.#attack, 1e-6)
                this.#decayDec = (1.0 - this.#sustain) * this.#invSampleRate / Math.max(this.#decay, 1e-6)
                this.#releaseDec = this.#sustain * this.#invSampleRate / Math.max(this.#release, 1e-6)
                break
            }
        }
    }

    gateOn(): void {this.#state = State.Attack}

    gateOff(): void {
        if (this.#state !== State.Idle) {
            this.#state = State.Release
            this.#updateRates()
        }
    }

    forceStop(): void {
        this.#state = State.Idle
        this.#value = 0.0
    }

    process(output: Float32Array, fromIndex: int, toIndex: int): void {
        for (let i = fromIndex; i < toIndex;) {
            switch (this.#state) {
                case State.Attack:
                    while (i < toIndex) {
                        this.#value += this.#attackInc
                        if (this.#value >= 1.0) {
                            this.#value = 1.0
                            this.#phase = 1.0
                            output[i++] = this.#value
                            this.#state = State.Decay
                            this.#updateRates()
                            break
                        }
                        output[i++] = this.#phase = this.#value
                    }
                    break

                case State.Decay:
                    while (i < toIndex) {
                        this.#value -= this.#decayDec
                        if (this.#value <= this.#sustain) {
                            this.#value = this.#sustain
                            this.#phase = 2.0
                            output[i++] = this.#value
                            this.#state = State.Sustain
                            this.#updateRates()
                            break
                        }
                        this.#phase = 1.0 + (1.0 - this.#value) / (1.0 - this.#sustain)
                        output[i++] = this.#value
                    }
                    break

                case State.Sustain:
                    output.fill(this.#sustain, i, toIndex)
                    return

                case State.Release:
                    while (i < toIndex) {
                        this.#value -= this.#releaseDec
                        if (this.#value <= 0.0) {
                            this.#value = 0.0
                            this.#phase = 0.0
                            output[i++] = this.#value
                            this.#state = State.Idle
                            this.#updateRates()
                            break
                        }
                        this.#phase = 3.0 + (1.0 - (this.#value / this.#sustain))
                        output[i++] = this.#value
                    }
                    break

                case State.Idle:
                    output.fill(0.0, i, toIndex)
                    return
            }
        }
    }
}