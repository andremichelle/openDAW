import {int, isDefined, Nullable, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioEffectDeviceAdapter, EngineToClient, WerkstattDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer} from "@opendaw/lib-dsp"
import {AudioProcessor} from "../../AudioProcessor"

const HEADER_PATTERN = /^\/\/ @werkstatt (\w+) (\d+) (\d+)\n/
const MAX_AMPLITUDE = 1000.0 // ~60dB

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

interface UserIO {
    src: ReadonlyArray<Float32Array>
    out: ReadonlyArray<Float32Array>
}

interface UserProcessor {
    process(io: UserIO, block: Block): void
}

export class WerkstattDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = WerkstattDeviceProcessor.ID++

    readonly #adapter: WerkstattDeviceBoxAdapter
    readonly #engineToClient: EngineToClient
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #uuid: string

    #source: Option<AudioBuffer> = Option.None
    #userProcessor: Option<UserProcessor> = Option.None
    #currentUpdate: int = -1
    #silenced: boolean = false

    constructor(context: EngineContext, adapter: WerkstattDeviceBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#engineToClient = context.engineToClient
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#uuid = UUID.toString(adapter.uuid)
        this.ownAll(
            adapter.box.code.catchupAndSubscribe(owner => {
                const newUpdate = parseUpdate(owner.getValue())
                if (newUpdate > 0 && newUpdate !== this.#currentUpdate) {
                    this.#silenced = true
                    this.#userProcessor = Option.None
                    this.#tryLoad(newUpdate)
                }
            }),
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing)
        )
    }

    #tryLoad(update: int): void {
        const registry = (globalThis as any).openDAW?.werkstattProcessors?.[this.#uuid]
        if (isDefined(registry) && registry.update === update) {
            this.#swapProcessor(registry.create, update)
        }
    }

    #swapProcessor(ProcessorClass: any, update: int): void {
        try {
            this.#userProcessor = Option.wrap(new ProcessorClass() as UserProcessor)
            this.#currentUpdate = update
            this.#silenced = false
        } catch (error) {
            this.#reportError(`Failed to instantiate Processor: ${error}`)
            this.#silenced = true
        }
    }

    #reportError(message: string): void {
        this.#engineToClient.deviceMessage(this.#uuid, message)
    }

    #silence(message: string): void {
        this.#silenced = true
        this.#output.clear()
        this.#reportError(message)
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#peaks.clear()
        this.#output.clear()
        this.eventInput.clear()
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#output}

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return {terminate: () => this.#source = Option.None}
    }

    index(): int {return this.#adapter.indexField.getValue()}
    adapter(): AudioEffectDeviceAdapter {return this.#adapter}

    processAudio(block: Block): void {
        if (this.#silenced) {
            const expectedUpdate = parseUpdate(this.#adapter.box.code.getValue())
            if (expectedUpdate > 0 && expectedUpdate !== this.#currentUpdate) {
                this.#tryLoad(expectedUpdate)
            }
            if (this.#silenced) {return}
        }
        if (this.#source.isEmpty() || this.#userProcessor.isEmpty()) {return}
        const source = this.#source.unwrap()
        const proc = this.#userProcessor.unwrap()
        const io: UserIO = {
            src: [source.getChannel(0), source.getChannel(1)],
            out: [this.#output.getChannel(0), this.#output.getChannel(1)]
        }
        try {
            proc.process(io, block)
        } catch (error) {
            this.#silence(`Runtime error: ${error}`)
            return
        }
        const validationError = validateOutput(io.out, block.s0, block.s1)
        if (validationError !== null) {
            this.#silence(validationError)
            return
        }
        this.#peaks.process(io.out[0], io.out[1], block.s0, block.s1)
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})`}
}
