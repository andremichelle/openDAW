import {ppqn} from "@moises-ai/lib-dsp"

export class TimeInfo {
    #position: number = 0.0

    #transporting: boolean = false
    #leap: boolean = false
    isRecording: boolean = false
    isCountingIn: boolean = false
    metronomeEnabled: boolean = false

    getLeapStateAndReset(): boolean {
        const leap = this.#leap
        this.#leap = false
        return leap
    }

    get position(): number {return this.#position}
    set position(value: ppqn) {
        this.#position = value
        this.#leap = true
    }

    get transporting(): boolean {return this.#transporting}
    set transporting(value: boolean) {
        if (this.#transporting === value) {return}
        this.#transporting = value
    }

    pause(): void {
        this.#transporting = false
        this.isRecording = false
        this.isCountingIn = false
    }

    advanceTo(position: ppqn): void {this.#position = position}
}