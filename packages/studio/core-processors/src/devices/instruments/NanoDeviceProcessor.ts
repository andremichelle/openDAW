import {Id, int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioBuffer, AudioData, dbToGain, Event, NoteEvent} from "@opendaw/lib-dsp"
import {NanoDeviceBoxAdapter, SampleLoader} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {AudioProcessor} from "../../AudioProcessor"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {NoteEventSource, NoteEventTarget, NoteLifecycleEvent} from "../../NoteEventSource"
import {NoteEventInstrument} from "../../NoteEventInstrument"
import {DeviceProcessor} from "../../DeviceProcessor"
import {InstrumentDeviceProcessor} from "../../InstrumentDeviceProcessor"

export class NanoDeviceProcessor extends AudioProcessor implements InstrumentDeviceProcessor, NoteEventTarget {
    readonly #adapter: NanoDeviceBoxAdapter

    readonly #voices: Array<Voice>
    readonly #audioOutput: AudioBuffer
    readonly #noteEventProcessor: NoteEventInstrument
    readonly #peakBroadcaster: PeakBroadcaster
    readonly #parameterVolume: AutomatableParameter<number>
    readonly #parameterRelease: AutomatableParameter<number>

    #enabled: boolean = true

    gain: number = 1.0
    release: number = 1.0

    loader: Option<SampleLoader> = Option.None

    constructor(context: EngineContext, adapter: NanoDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter

        this.#voices = []
        this.#audioOutput = new AudioBuffer()
        this.#noteEventProcessor = new NoteEventInstrument(this, context.broadcaster, adapter.audioUnitBoxAdapter().address)
        this.#peakBroadcaster = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#parameterVolume = this.own(this.bindParameter(this.#adapter.namedParameter.volume))
        this.#parameterRelease = this.own(this.bindParameter(this.#adapter.namedParameter.release))

        this.ownAll(
            adapter.box.enabled.catchupAndSubscribe(owner => {
                this.#enabled = owner.getValue()
                if (!this.#enabled) {this.reset()}
            }),
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#audioOutput, this.outgoing),
            adapter.box.file.catchupAndSubscribe((pointer) =>
                this.loader = pointer.targetVertex.map(({box}) =>
                    context.sampleManager.getOrCreate(box.address.uuid)))
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}
    get noteEventTarget(): Option<NoteEventTarget & DeviceProcessor> {return Option.wrap(this)}

    introduceBlock(block: Block): void {this.#noteEventProcessor.introduceBlock(block)}

    setNoteEventSource(source: NoteEventSource): Terminable {return this.#noteEventProcessor.setNoteEventSource(source)}

    reset(): void {
        this.#voices.length = 0
        this.#audioOutput.clear()
        this.eventInput.clear()
        this.#noteEventProcessor.clear()
        this.#peakBroadcaster.clear()
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#audioOutput}
    get adapter(): NanoDeviceBoxAdapter {return this.#adapter}

    handleEvent(event: Event): void {
        if (NoteLifecycleEvent.isStart(event)) {
            this.#voices.push(new Voice(this, event))
        } else if (NoteLifecycleEvent.isStop(event)) {
            this.#voices.find(voice => voice.event().id === event.id)?.stop()
        }
    }

    processAudio(_block: Block, fromIndex: int, toIndex: int): void {
        if (!this.#enabled) {return}
        this.#audioOutput.clear(fromIndex, toIndex)
        for (let i = this.#voices.length - 1; i >= 0; i--) {
            if (this.#voices[i].processAdd(this.#audioOutput, fromIndex, toIndex)) {
                this.#voices.splice(i, 1)
            }
        }
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.#parameterVolume) {
            this.gain = dbToGain(this.#parameterVolume.getValue())
        } else if (parameter === this.#parameterRelease) {
            this.release = this.#parameterRelease.getValue() * sampleRate
        }
    }

    finishProcess(): void {
        this.#audioOutput.assertSanity()
        this.#peakBroadcaster.process(this.#audioOutput.getChannel(0), this.#audioOutput.getChannel(1))
    }

    terminate(): void {
        super.terminate()
        this.loader = Option.None
    }

    toString(): string {return `{NanoDevice}`}
}

class Voice {
    readonly #device: NanoDeviceProcessor
    readonly #event: Id<NoteEvent>

    readonly #speed: number = 1.0

    #position: number = 0.0
    #attack: number = (0.003 * sampleRate) | 0
    #envPosition: int = 0 | 0
    #decayPosition: int = Number.POSITIVE_INFINITY

    constructor(device: NanoDeviceProcessor, event: Id<NoteEvent>) {
        this.#device = device
        this.#event = event

        this.#speed = Math.pow(2.0, (event.pitch + event.cent / 100.0) / 12.0 - 5.0)
    }

    event(): Id<NoteEvent> {return this.#event}

    stop(): void {this.#decayPosition = this.#envPosition}

    processAdd(output: AudioBuffer, fromIndex: int, toIndex: int): boolean {
        const optLoader = this.#device.loader
        if (optLoader.isEmpty()) {return true}
        const loader = optLoader.unwrap()
        if (loader.data.isEmpty()) {return true}
        return this.processSimple(output.channels(), loader.data.unwrap(), fromIndex, toIndex)
    }

    processSimple(output: ReadonlyArray<Float32Array>, data: AudioData, fromIndex: int, toIndex: int): boolean {
        const [outL, outR] = output
        const inpL = data.frames[0]
        const inpR = data.frames[1] ?? inpL
        const numberOfFrames = data.numberOfFrames
        const rateRatio = data.sampleRate / sampleRate
        const gain = this.#device.gain * this.#event.velocity
        const release = this.#device.release
        const releaseInverse = 1.0 / release
        for (let i = fromIndex; i < toIndex; i++) {
            const intPosition = this.#position | 0
            if (intPosition >= numberOfFrames - 1) {return true}
            const frac = this.#position - intPosition
            const att = this.#envPosition < this.#attack ? this.#envPosition / this.#attack : 1.0
            const env = (Math.min(1.0 - (this.#envPosition - this.#decayPosition) * releaseInverse, 1.0) * att) ** 2.0
            const l = inpL[intPosition] * (1.0 - frac) + inpL[intPosition + 1] * frac
            const r = inpR[intPosition] * (1.0 - frac) + inpR[intPosition + 1] * frac
            outL[i] += l * gain * env
            outR[i] += r * gain * env
            this.#position += this.#speed * rateRatio
            if (++this.#envPosition - this.#decayPosition > release) {return true}
        }
        return false
    }
}