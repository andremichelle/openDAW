import {Id, int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioBuffer, AudioData, dbToGain, Event, NoteEvent} from "@opendaw/lib-dsp"
import {SampleLoader, ReSoulDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {AudioProcessor} from "../../AudioProcessor"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {NoteEventSource, NoteEventTarget, NoteLifecycleEvent} from "../../NoteEventSource"
import {NoteEventInstrument} from "../../NoteEventInstrument"
import {DeviceProcessor} from "../../DeviceProcessor"
import {InstrumentDeviceProcessor} from "../../InstrumentDeviceProcessor"

export class ReSoulDeviceProcessor extends AudioProcessor implements InstrumentDeviceProcessor, NoteEventTarget {
    readonly #adapter: ReSoulDeviceBoxAdapter

    readonly #voices: Array<Voice>
    readonly #audioOutput: AudioBuffer
    readonly #noteEventProcessor: NoteEventInstrument
    readonly #peakBroadcaster: PeakBroadcaster
    readonly #parameterVolume: AutomatableParameter<number>
    readonly #parameterOctave: AutomatableParameter<number>
    readonly #parameterReverse: AutomatableParameter<boolean>
    readonly #parameterAttack: AutomatableParameter<number>
    readonly #parameterRelease: AutomatableParameter<number>
    readonly #parameterSampleStart: AutomatableParameter<number>
    readonly #parameterSampleEnd: AutomatableParameter<number>
    readonly #parameterRootKey: AutomatableParameter<number>

    #enabled: boolean = true

    gain: number = 1.0
    octave: int = 0 | 0
    reverse: boolean = false
    attack: number = 1.0
    release: number = 1.0
    sampleStart: number = 0.0
    sampleEnd: number = 1.0
    rootKey: int = 60 | 0

    loader: Option<SampleLoader> = Option.None

    constructor(context: EngineContext, adapter: ReSoulDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter

        this.#voices = []
        this.#audioOutput = new AudioBuffer()
        this.#noteEventProcessor = new NoteEventInstrument(this, context.broadcaster, adapter.audioUnitBoxAdapter().address)
        this.#peakBroadcaster = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#parameterVolume = this.own(this.bindParameter(this.#adapter.namedParameter.volume))
        this.#parameterOctave = this.own(this.bindParameter(this.#adapter.namedParameter.octave))
        this.#parameterReverse = this.own(this.bindParameter(this.#adapter.namedParameter.reverse))
        this.#parameterAttack = this.own(this.bindParameter(this.#adapter.namedParameter.attack))
        this.#parameterRelease = this.own(this.bindParameter(this.#adapter.namedParameter.release))
        this.#parameterSampleStart = this.own(this.bindParameter(this.#adapter.namedParameter.sampleStart))
        this.#parameterSampleEnd = this.own(this.bindParameter(this.#adapter.namedParameter.sampleEnd))
        this.#parameterRootKey = this.own(this.bindParameter(this.#adapter.namedParameter.rootKey))

        const positions = new Float32Array(16)
        this.ownAll(
            adapter.box.enabled.catchupAndSubscribe(owner => {
                this.#enabled = owner.getValue()
                if (!this.#enabled) {this.reset()}
            }),
            context.registerProcessor(this),
            context.broadcaster.broadcastFloats(adapter.positionsAddress, positions, (hasSubscribers) => {
                if (!hasSubscribers) {return}
                const slices = this.#voices.length < positions.length ? this.#voices : this.#voices.slice(0, positions.length)
                slices.forEach(({position}, index) => positions[index] = position)
                positions[slices.length] = -1.0
            }),
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
    get adapter(): ReSoulDeviceBoxAdapter {return this.#adapter}

    handleEvent(event: Event): void {
        if (NoteLifecycleEvent.isStart(event)) {
            this.#voices.push(new Voice(this, event))
        } else if (NoteLifecycleEvent.isStop(event)) {
            this.#voices.find(voice => voice.event().id === event.id)?.stop()
        }
    }

    processAudio({s0, s1}: Block): void {
        if (!this.#enabled) {return}
        this.#audioOutput.clear(s0, s1)
        for (let i = this.#voices.length - 1; i >= 0; i--) {
            if (this.#voices[i].processAdd(this.#audioOutput, s0, s1)) {
                this.#voices.splice(i, 1)
            }
        }
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.#parameterVolume) {
            this.gain = dbToGain(this.#parameterVolume.getValue())
        } else if (parameter === this.#parameterOctave) {
            this.octave = this.#parameterOctave.getValue() | 0
        } else if (parameter === this.#parameterReverse) {
            this.reverse = this.#parameterReverse.getValue()
        } else if (parameter === this.#parameterAttack) {
            this.attack = Math.max(1.0, this.#parameterAttack.getValue() * sampleRate)
        } else if (parameter === this.#parameterRelease) {
            this.release = Math.max(1.0, this.#parameterRelease.getValue() * sampleRate)
        } else if (parameter === this.#parameterSampleStart) {
            this.sampleStart = this.#parameterSampleStart.getValue()
        } else if (parameter === this.#parameterSampleEnd) {
            this.sampleEnd = this.#parameterSampleEnd.getValue()
        } else if (parameter === this.#parameterRootKey) {
            this.rootKey = this.#parameterRootKey.getValue() | 0
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

    toString(): string {return "{ReSoulDevice}"}
}

class Voice {
    readonly #device: ReSoulDeviceProcessor
    readonly #event: Id<NoteEvent>

    readonly #speed: number
    readonly #reverse: boolean
    readonly #attack: number
    readonly #release: number

    #initialized: boolean = false
    #position: number = 0.0
    #start: number = 0.0
    #end: number = 0.0
    #envPosition: int = 0 | 0
    #decayPosition: number = Number.POSITIVE_INFINITY

    constructor(device: ReSoulDeviceProcessor, event: Id<NoteEvent>) {
        this.#device = device
        this.#event = event
        this.#speed = Math.pow(2.0, (event.pitch - device.rootKey + event.cent / 100.0) / 12.0 + device.octave)
        this.#reverse = device.reverse
        this.#attack = device.attack
        this.#release = device.release
    }

    event(): Id<NoteEvent> {return this.#event}

    get position(): number {return this.#position}

    stop(): void {this.#decayPosition = Math.min(this.#decayPosition, this.#envPosition)}

    processAdd(output: AudioBuffer, fromIndex: int, toIndex: int): boolean {
        const optLoader = this.#device.loader
        if (optLoader.isEmpty()) {return true}
        const loader = optLoader.unwrap()
        if (loader.data.isEmpty()) {return true}
        return this.#process(output.channels(), loader.data.unwrap(), fromIndex, toIndex)
    }

    #process(output: ReadonlyArray<Float32Array>, data: AudioData, fromIndex: int, toIndex: int): boolean {
        const [outL, outR] = output
        const inpL = data.frames[0]
        const inpR = data.frames[1] ?? inpL
        const numberOfFrames = data.numberOfFrames
        if (!this.#initialized) {
            const device = this.#device
            const lower = Math.min(device.sampleStart, device.sampleEnd) * (numberOfFrames - 1)
            const upper = Math.max(device.sampleStart, device.sampleEnd) * (numberOfFrames - 1)
            this.#start = lower
            this.#end = upper
            this.#position = this.#reverse ? upper : lower
            this.#initialized = true
        }
        if (this.#end - this.#start < 1.0) {return true}
        const rateRatio = data.sampleRate / sampleRate * this.#speed * (this.#reverse ? -1.0 : 1.0)
        const gain = this.#device.gain * this.#event.velocity
        const attack = this.#attack
        const release = this.#release
        const releaseInverse = 1.0 / release
        for (let i = fromIndex; i < toIndex; i++) {
            if (this.#position <= this.#start && this.#reverse) {return true}
            if (this.#position >= this.#end && !this.#reverse) {return true}
            const intPosition = this.#position | 0
            if (intPosition < 0 || intPosition >= numberOfFrames - 1) {return true}
            const frac = this.#position - intPosition
            const att = this.#envPosition < attack ? this.#envPosition / attack : 1.0
            const env = (Math.min(1.0 - (this.#envPosition - this.#decayPosition) * releaseInverse, 1.0) * att) ** 2.0
            const l = inpL[intPosition] * (1.0 - frac) + inpL[intPosition + 1] * frac
            const r = inpR[intPosition] * (1.0 - frac) + inpR[intPosition + 1] * frac
            outL[i] += l * gain * env
            outR[i] += r * gain * env
            this.#position += rateRatio
            if (++this.#envPosition - this.#decayPosition > release) {return true}
        }
        return false
    }

    toString(): string {return "{ReSoulVoice}"}
}
