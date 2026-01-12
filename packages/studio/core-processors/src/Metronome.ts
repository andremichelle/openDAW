import {BlockFlag, ProcessInfo} from "./processing"
import {AudioBuffer, AudioData, dbToGain, PPQN, RenderQuantum} from "@opendaw/lib-dsp"
import {assert, Bits, int, isNotNull, Iterables, TAU} from "@opendaw/lib-std"
import {EngineContext} from "./EngineContext"

export class Metronome {
    static createDefaultClickSounds(): ReadonlyArray<AudioData> {
        return [880.0, 440.0].map(frequency => {
            const attack = Math.floor(0.002 * sampleRate)
            const release = Math.floor(0.050 * sampleRate)
            const numberOfFrames = attack + release
            const data = AudioData.create(sampleRate, numberOfFrames, 1)
            for (let index = 0; index < numberOfFrames; index++) {
                const env = Math.min(index / attack, 1.0 - (index - attack) / release)
                const amp = Math.sin(index / sampleRate * TAU * frequency) * env * env
                data.frames[0][index] += amp
            }
            return data
        })
    }

    readonly #context: EngineContext
    readonly #output = new AudioBuffer()
    readonly #clickSounds = Metronome.createDefaultClickSounds()
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
                        const clickIndex = beatIndex % curr.nominator === 0 ? 0 : 1
                        this.#clicks.push(new Click(this.#clickSounds[clickIndex], s0 + distanceToEvent, gain))
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
    readonly #audioData: AudioData
    readonly #gainInDb: number

    #position: int = 0 | 0
    #startIndex: int = 0 | 0

    constructor(audioData: AudioData, startIndex: int, gainInDb: number) {
        assert(startIndex >= 0 && startIndex < RenderQuantum, `${startIndex} out of bounds`)
        this.#audioData = audioData
        this.#gainInDb = gainInDb
        this.#startIndex = startIndex
    }

    processAdd(buffer: AudioBuffer, start: int, end: int): boolean {
        const [out0, out1] = buffer.channels()
        const gain = dbToGain(this.#gainInDb)
        const {frames, numberOfChannels, numberOfFrames, sampleRate: dataSampleRate} = this.#audioData
        const inp0 = frames[0]
        const inp1 = frames[numberOfChannels > 1 ? 1 : 0]
        const ratio = dataSampleRate / sampleRate
        for (let index = Math.max(this.#startIndex, start); index < end; index++) {
            const pFloat = this.#position
            const pInt = pFloat | 0
            const pAlpha = pFloat - pInt
            out0[index] += (inp0[pInt] + pAlpha * (inp0[pInt + 1] - inp0[pInt])) * gain
            out1[index] += (inp1[pInt] + pAlpha * (inp1[pInt + 1] - inp1[pInt])) * gain
            this.#position += ratio
            if (this.#position >= numberOfFrames - 1) {return true}
        }
        this.#startIndex = 0
        return false
    }
}