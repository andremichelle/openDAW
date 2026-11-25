import {DefaultObservableValue, int, isDefined, Nullable, Option, Terminable} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {SampleRange} from "./SampleDocument"

type Playing = Readonly<{ node: AudioBufferSourceNode, startTime: number, range: SampleRange, loop: boolean, sampleRate: number }>

export class SamplePlayer implements Terminable {
    readonly isPlaying: DefaultObservableValue<boolean>
    readonly #context: AudioContext

    #buffer: Nullable<[AudioData, AudioBuffer]>
    #playing: Option<Playing>

    constructor(context: AudioContext) {
        this.#context = context
        this.isPlaying = new DefaultObservableValue(false)
        this.#buffer = null
        this.#playing = Option.None
    }

    play(audio: AudioData, range: SampleRange, loop: boolean): void {
        this.stop()
        if (range.to <= range.from) {return}
        const {sampleRate} = audio
        const node = this.#context.createBufferSource()
        node.buffer = this.#bufferOf(audio)
        node.loop = loop
        node.loopStart = range.from / sampleRate
        node.loopEnd = range.to / sampleRate
        node.connect(this.#context.destination)
        const startTime = this.#context.currentTime
        if (loop) {
            node.start(startTime, range.from / sampleRate)
        } else {
            node.start(startTime, range.from / sampleRate, (range.to - range.from) / sampleRate)
        }
        node.onended = () => {
            if (this.#playing.unwrapOrNull()?.node !== node) {return}
            this.#playing = Option.None
            this.isPlaying.setValue(false)
        }
        this.#playing = Option.wrap({node, startTime, range, loop, sampleRate})
        this.isPlaying.setValue(true)
    }

    stop(): void {
        this.#playing.ifSome(({node}) => {
            node.onended = null
            node.stop()
            node.disconnect()
        })
        this.#playing = Option.None
        this.isPlaying.setValue(false)
    }

    position(): Option<int> {
        return this.#playing.map(({startTime, range: {from, to}, loop, sampleRate}) => {
            const elapsed = Math.max(0.0, this.#context.currentTime - startTime) * sampleRate
            const length = to - from
            return Math.floor(from + (loop ? elapsed % length : Math.min(elapsed, length)))
        })
    }

    terminate(): void {
        this.stop()
        this.#buffer = null
    }

    #bufferOf(audio: AudioData): AudioBuffer {
        if (isDefined(this.#buffer) && this.#buffer[0] === audio) {return this.#buffer[1]}
        const {sampleRate, numberOfFrames, numberOfChannels, frames} = audio
        const buffer = this.#context.createBuffer(numberOfChannels, numberOfFrames, sampleRate)
        frames.forEach((channel, index) => buffer.getChannelData(index).set(channel))
        this.#buffer = [audio, buffer]
        return buffer
    }
}
