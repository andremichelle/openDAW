import {BlockFlag, ProcessInfo} from "./processing"
import {AudioBuffer, dbToGain, PPQN, RenderQuantum} from "@opendaw/lib-dsp"
import {assert, Bits, int, isNotNull, Iterables, TAU} from "@opendaw/lib-std"
import {EngineContext} from "./EngineContext"

export class Metronome {
    readonly #context: EngineContext
    readonly #output = new AudioBuffer()
    readonly #clicks: Click[] = []

    constructor(context: EngineContext) {this.#context = context}

    process({blocks}: ProcessInfo): void {
        const enabled = this.#context.timeInfo.metronomeEnabled
        const signatureTrack = this.#context.timelineBoxAdapter.signatureTrack
        const metronome = this.#context.preferences.settings.metronome
        const {beatSubDivision, gain} = metronome
        blocks.forEach(({p0, p1, bpm, s0, s1, flags}) => {
            if (enabled && Bits.every(flags, BlockFlag.transporting)) {
                for (const [curr, next] of Iterables.pairWise(signatureTrack.iterateAll())) {
                    const signatureStart = curr.accumulatedPpqn
                    const signatureEnd = isNotNull(next) ? next.accumulatedPpqn : Infinity
                    if (signatureEnd <= p0) {continue}
                    if (signatureStart >= p1 && curr.index !== -1) {break}
                    const regionStart = curr.index === -1 ? p0 : Math.max(p0, signatureStart)
                    const regionEnd = Math.min(p1, signatureEnd)
                    const denominator = curr.denominator * beatSubDivision
                    const stepSize = PPQN.fromSignature(1, denominator)
                    const offset = regionStart - signatureStart
                    const firstBeatIndex = Math.ceil(offset / stepSize)
                    let position = signatureStart + firstBeatIndex * stepSize
                    while (position < regionEnd) {
                        const distanceToEvent = Math.floor(PPQN.pulsesToSamples(position - p0, bpm, sampleRate))
                        const beatIndex = Math.round((position - signatureStart) / stepSize)
                        this.#clicks.push(new Click(s0 + distanceToEvent, beatIndex % curr.nominator === 0, gain))
                        position += stepSize
                    }
                }
            }
            this.#output.clear(s0, s1)
            for (let i = this.#clicks.length - 1; i >= 0; i--) {
                const processor = this.#clicks[i]
                if (processor.processAdd(this.#output, s0, s1)) {
                    this.#clicks.splice(i, 1)
                }
            }
        })
    }

    get output(): AudioBuffer {return this.#output}
}

class Click {
    readonly #frequency: number
    readonly #gainInDb: number

    #position: int = 0 | 0
    #startIndex: int = 0 | 0

    constructor(startIndex: int, isAccent: boolean, gainInDb: number) {
        assert(startIndex >= 0 && startIndex < RenderQuantum, `${startIndex} out of bounds`)
        this.#frequency = isAccent ? 880.0 : 440.0
        this.#gainInDb = gainInDb
        this.#startIndex = startIndex
    }

    processAdd(buffer: AudioBuffer, start: int, end: int): boolean {
        const [l, r] = buffer.channels()
        const attack = Math.floor(0.002 * sampleRate)
        const release = Math.floor(0.050 * sampleRate)
        const gain = dbToGain(this.#gainInDb)
        for (let index = Math.max(this.#startIndex, start); index < end; index++) {
            const env = Math.min(this.#position / attack, 1.0 - (this.#position - attack) / release)
            const amp = Math.sin(this.#position / sampleRate * TAU * this.#frequency) * gain * env * env
            l[index] += amp
            r[index] += amp
            if (++this.#position > attack + release) {return true}
        }
        this.#startIndex = 0
        return false
    }
}