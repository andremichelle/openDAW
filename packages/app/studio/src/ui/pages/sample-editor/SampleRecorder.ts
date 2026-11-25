import {int, isDefined, Optional, Terminable, tryCatch} from "@opendaw/lib-std"
import {AudioData, RenderQuantum} from "@opendaw/lib-dsp"
import {mergeChunkPlanes, RingBuffer} from "@opendaw/studio-adapters"
import {AudioDevices} from "@opendaw/studio-core"

const RingChunks = 1024

export class SampleRecorder implements Terminable {
    static async start(context: AudioContext, deviceId: Optional<string>, numberOfChannels: 1 | 2): Promise<SampleRecorder> {
        const stream = await AudioDevices.requestStream({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: {ideal: numberOfChannels},
            deviceId: isDefined(deviceId) ? {exact: deviceId} : undefined
        })
        return new SampleRecorder(context, stream, numberOfChannels)
    }

    readonly analyser: AnalyserNode
    readonly #context: AudioContext
    readonly #stream: MediaStream
    readonly #source: MediaStreamAudioSourceNode
    readonly #mixer: GainNode
    readonly #sink: GainNode
    readonly #worklet: AudioWorkletNode
    readonly #reader: RingBuffer.Reader
    readonly #chunks: Array<ReadonlyArray<Float32Array>>
    readonly #numberOfChannels: int

    #recording: boolean

    private constructor(context: AudioContext, stream: MediaStream, numberOfChannels: 1 | 2) {
        this.#context = context
        this.#stream = stream
        this.#numberOfChannels = numberOfChannels
        this.#chunks = []
        this.#recording = false
        this.#source = context.createMediaStreamSource(stream)
        this.#mixer = context.createGain()
        this.#mixer.channelCount = numberOfChannels
        this.#mixer.channelCountMode = "explicit"
        this.#mixer.channelInterpretation = "speakers"
        this.#sink = context.createGain()
        this.#sink.gain.value = 0.0
        this.analyser = context.createAnalyser()
        this.analyser.fftSize = 2048
        const audioBytes = numberOfChannels * RingChunks * RenderQuantum * Float32Array.BYTES_PER_ELEMENT
        const config: RingBuffer.Config = {
            sab: new SharedArrayBuffer(audioBytes + Int32Array.BYTES_PER_ELEMENT * 2),
            numChunks: RingChunks, numberOfChannels, bufferSize: RenderQuantum
        }
        this.#worklet = new AudioWorkletNode(context, "recording-processor", {
            numberOfInputs: 1,
            channelCount: numberOfChannels,
            channelCountMode: "explicit",
            processorOptions: config
        })
        this.#reader = RingBuffer.reader(config, chunk => {if (this.#recording) {this.#chunks.push(chunk)}})
        this.#source.connect(this.#mixer)
        this.#mixer.connect(this.#worklet)
        this.#mixer.connect(this.analyser)
        this.#mixer.connect(this.#sink)
        this.#sink.connect(context.destination)
    }

    get numberOfFrames(): int {return this.#chunks.length * RenderQuantum}

    record(): void {
        this.#chunks.length = 0
        this.#recording = true
    }

    finish(): AudioData {
        this.#recording = false
        const numberOfFrames = this.numberOfFrames
        const audio = AudioData.create(this.#context.sampleRate, numberOfFrames, this.#numberOfChannels)
        mergeChunkPlanes(this.#chunks, RenderQuantum, numberOfFrames)
            .forEach((channel, index) => audio.frames[index].set(channel))
        this.#chunks.length = 0
        return audio
    }

    terminate(): void {
        this.#recording = false
        this.#reader.stop()
        tryCatch(() => {
            this.#source.disconnect()
            this.#mixer.disconnect()
            this.#sink.disconnect()
            this.#worklet.disconnect()
        })
        this.#stream.getAudioTracks().forEach(track => track.stop())
    }
}
