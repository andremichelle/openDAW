import {Arrays, asInstanceOf, int, isDefined, isNotNull, Nullable, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ApparatDeviceBoxAdapter, SampleLoader} from "@opendaw/studio-adapters"
import {WerkstattParameterBox, WerkstattSampleBox} from "@opendaw/studio-boxes"
import {AudioBuffer, AudioData, Event, NoteEvent, SimpleLimiter} from "@opendaw/lib-dsp"
import {EngineContext} from "../../EngineContext"
import {AudioProcessor} from "../../AudioProcessor"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {NoteEventSource, NoteEventTarget, NoteLifecycleEvent} from "../../NoteEventSource"
import {NoteEventInstrument} from "../../NoteEventInstrument"
import {DeviceProcessor} from "../../DeviceProcessor"
import {InstrumentDeviceProcessor} from "../../InstrumentDeviceProcessor"

const HEADER_PATTERN = /^\/\/ @apparat (\w+) (\d+) (\d+)\n/
const MAX_AMPLITUDE = 1000.0

const parseUpdate = (code: string): int => {
    const match = code.match(HEADER_PATTERN)
    return match !== null ? parseInt(match[3]) : -1
}

const validateOutput = (channels: ReadonlyArray<Float32Array>, s0: int, s1: int): Nullable<string> => {
    for (let ch = 0; ch < channels.length; ch++) {
        const channel = channels[ch]
        for (let i = s0; i < s1; i++) {
            const sample = channel[i]
            if (sample !== sample) {return `NaN detected in output channel ${ch} at sample ${i}`}
            if (sample > MAX_AMPLITUDE || sample < -MAX_AMPLITUDE) {
                return `Signal overflow in channel ${ch} at sample ${i} (amplitude: ${sample.toFixed(1)})`
            }
        }
    }
    return null
}

interface UserProcessor {
    process(output: ReadonlyArray<Float32Array>, block: Block): void
    noteOn?(pitch: number, velocity: number, cent: number, id: int): void
    noteOff?(id: int): void
    reset?(): void
    paramChanged?(label: string, value: number): void
    samples: Record<string, Nullable<AudioData>>
}

export class ApparatDeviceProcessor extends AudioProcessor
    implements InstrumentDeviceProcessor, NoteEventTarget {
    readonly #adapter: ApparatDeviceBoxAdapter
    readonly #engineToClient: EngineContext["engineToClient"]
    readonly #noteEventInstrument: NoteEventInstrument
    readonly #audioOutput: AudioBuffer
    readonly #limiter: SimpleLimiter
    readonly #peakBroadcaster: PeakBroadcaster
    readonly #uuid: string
    readonly #boundParameters: Array<AutomatableParameter<number>>
    readonly #sampleSlots: Map<string, {loader: Option<SampleLoader>, lifecycle: Terminable}> = new Map()

    #userProcessor: Option<UserProcessor> = Option.None
    #currentUpdate: int = -1
    #silenced: boolean = false
    #enabled: boolean = true

    constructor(context: EngineContext, adapter: ApparatDeviceBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#engineToClient = context.engineToClient
        this.#noteEventInstrument = new NoteEventInstrument(this, context.broadcaster, adapter.audioUnitBoxAdapter().address)
        this.#audioOutput = new AudioBuffer()
        this.#limiter = new SimpleLimiter(sampleRate)
        this.#peakBroadcaster = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#uuid = UUID.toString(adapter.uuid)
        this.#boundParameters = []
        const {parameters, box} = adapter
        this.ownAll(
            box.enabled.catchupAndSubscribe(owner => {
                this.#enabled = owner.getValue()
                if (!this.#enabled) {this.reset()}
            }),
            box.code.catchupAndSubscribe(owner => {
                const newUpdate = parseUpdate(owner.getValue())
                if (newUpdate > 0 && newUpdate !== this.#currentUpdate) {
                    this.#silenced = true
                    this.#userProcessor = Option.None
                    this.#audioOutput.clear()
                    this.#tryLoad(newUpdate)
                }
            }),
            box.parameters.pointerHub.catchupAndSubscribe({
                onAdded: (({box}) => {
                    const paramBox = asInstanceOf(box, WerkstattParameterBox)
                    const bound = this.bindParameter(parameters.parameterAt(paramBox.value.address))
                    this.#boundParameters.push(bound)
                    this.parameterChanged(bound)
                }),
                onRemoved: (({box}) => {
                    const paramBox = asInstanceOf(box, WerkstattParameterBox)
                    Arrays.removeIf(this.#boundParameters, parameter =>
                        parameter.address === paramBox.value.address)
                })
            }),
            box.samples.pointerHub.catchupAndSubscribe({
                onAdded: (({box: sampleBox}) => {
                    const sample = asInstanceOf(sampleBox, WerkstattSampleBox)
                    const label = sample.label.getValue()
                    const slot: {loader: Option<SampleLoader>, lifecycle: Terminable} = {
                        loader: Option.None,
                        lifecycle: Terminable.Empty
                    }
                    this.#sampleSlots.set(label, slot)
                    slot.lifecycle = sample.file.catchupAndSubscribe(pointer => {
                        const target = pointer.targetVertex.unwrapOrNull()
                        if (target === null) {
                            slot.loader = Option.None
                        } else {
                            slot.loader = Option.wrap(context.sampleManager.getOrCreate(target.box.address.uuid))
                        }
                    })
                }),
                onRemoved: (({box: sampleBox}) => {
                    const sample = asInstanceOf(sampleBox, WerkstattSampleBox)
                    const label = sample.label.getValue()
                    const entry = this.#sampleSlots.get(label)
                    if (isDefined(entry)) {
                        entry.lifecycle.terminate()
                        this.#sampleSlots.delete(label)
                    }
                    this.#updateSampleData(label, null)
                })
            }),
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#audioOutput, this.outgoing)
        )
        this.readAllParameters()
    }

    get noteEventTarget(): Option<NoteEventTarget & DeviceProcessor> {return Option.wrap(this)}
    introduceBlock(block: Block): void {this.#noteEventInstrument.introduceBlock(block)}
    setNoteEventSource(source: NoteEventSource): Terminable {return this.#noteEventInstrument.setNoteEventSource(source)}
    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}
    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#audioOutput}

    reset(): void {
        this.#noteEventInstrument.clear()
        this.#peakBroadcaster.clear()
        this.#audioOutput.clear()
        this.eventInput.clear()
        this.#userProcessor.ifSome(proc => {
            if (isDefined(proc.reset)) {proc.reset()}
        })
    }

    handleEvent(event: Event): void {
        if (this.#silenced || this.#userProcessor.isEmpty()) {return}
        const proc = this.#userProcessor.unwrap()
        if (NoteLifecycleEvent.isStart(event)) {
            if (isDefined(proc.noteOn)) {
                proc.noteOn(event.pitch, event.velocity, event.cent, event.id)
            }
        } else if (NoteLifecycleEvent.isStop(event)) {
            if (isDefined(proc.noteOff)) {
                proc.noteOff(event.id)
            }
        }
    }

    processAudio(block: Block): void {
        if (!this.#enabled) {return}
        if (this.#silenced) {
            const expectedUpdate = parseUpdate(this.#adapter.box.code.getValue())
            if (expectedUpdate > 0 && expectedUpdate !== this.#currentUpdate) {
                this.#tryLoad(expectedUpdate)
            }
            if (this.#silenced) {return}
        }
        if (this.#userProcessor.isEmpty()) {return}
        const proc = this.#userProcessor.unwrap()
        this.#pollSamples(proc)
        const outL = this.#audioOutput.getChannel(0)
        const outR = this.#audioOutput.getChannel(1)
        outL.fill(0.0, block.s0, block.s1)
        outR.fill(0.0, block.s0, block.s1)
        try {
            proc.process([outL, outR], block)
        } catch (error) {
            this.#silence(`Runtime error: ${error}`)
            return
        }
        const error = validateOutput([outL, outR], block.s0, block.s1)
        if (isNotNull(error)) {
            this.#silence(error)
            this.#audioOutput.clear(block.s0, block.s1)
            return
        }
        this.#limiter.replace(this.#audioOutput, block.s0, block.s1)
    }

    finishProcess(): void {
        this.#peakBroadcaster.process(
            this.#audioOutput.getChannel(0),
            this.#audioOutput.getChannel(1), 0, 128)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        this.#userProcessor.ifSome(proc => {
            if (isDefined(proc.paramChanged)) {
                const paramBox = asInstanceOf(parameter.adapter.field.box, WerkstattParameterBox)
                proc.paramChanged(paramBox.label.getValue(), parameter.getValue())
            }
        })
    }

    processEvents(_block: Block): void {}

    #tryLoad(expectedUpdate: int): void {
        const registry = (globalThis as any).openDAW?.apparatProcessors?.[this.#uuid]
        if (isDefined(registry) && registry.update === expectedUpdate) {
            this.#swapProcessor(registry.create, expectedUpdate)
        }
    }

    #swapProcessor(ProcessorClass: any, update: int): void {
        try {
            const proc = new ProcessorClass() as UserProcessor
            proc.samples = {}
            for (const [label] of this.#sampleSlots) {
                proc.samples[label] = null
            }
            this.#userProcessor = Option.wrap(proc)
            this.#currentUpdate = update
            this.#silenced = false
            this.#pushAllParameters()
            this.#pollSamples(proc)
        } catch (error) {
            this.#silence(`Failed to instantiate Processor: ${error}`)
        }
    }

    #pushAllParameters(): void {
        this.#userProcessor.ifSome(proc => {
            if (isDefined(proc.paramChanged)) {
                for (const bound of this.#boundParameters) {
                    const paramBox = asInstanceOf(bound.adapter.field.box, WerkstattParameterBox)
                    proc.paramChanged(paramBox.label.getValue(), bound.getValue())
                }
            }
        })
    }

    #pollSamples(proc: UserProcessor): void {
        for (const [label, slot] of this.#sampleSlots) {
            slot.loader.ifSome(loader => {
                const data = loader.data.unwrapOrNull()
                if (proc.samples[label] !== data) {
                    proc.samples[label] = data
                }
            })
        }
    }

    #updateSampleData(label: string, data: Nullable<AudioData>): void {
        this.#userProcessor.ifSome(proc => {
            proc.samples[label] = data
        })
    }

    #reportError(message: string): void {
        this.#engineToClient.deviceMessage(this.#uuid, message)
    }

    #silence(message: string): void {
        this.#silenced = true
        this.#audioOutput.clear()
        this.#reportError(message)
    }
}
