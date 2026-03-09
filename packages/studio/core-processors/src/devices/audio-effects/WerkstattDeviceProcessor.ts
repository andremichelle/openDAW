import {int, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioEffectDeviceAdapter, WerkstattDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer} from "@opendaw/lib-dsp"
import {AudioProcessor} from "../../AudioProcessor"

const HEADER_PATTERN = /^\/\/ @werkstatt (\w+) (\d+) (\d+)\n/

const parseUpdate = (code: string): int => {
    const match = code.match(HEADER_PATTERN)
    return match !== null ? parseInt(match[3]) : -1
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
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster

    #source: Option<AudioBuffer> = Option.None
    #userProcessor: Option<UserProcessor> = Option.None
    #currentUpdate: int = -1
    #silenced: boolean = false

    constructor(context: EngineContext, adapter: WerkstattDeviceBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
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
        const uuid = UUID.toString(this.#adapter.uuid)
        const registry = (globalThis as any).openDAW?.werkstattProcessors?.[uuid]
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
            console.error("Werkstatt: failed to instantiate Processor", error)
            this.#silenced = true
        }
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
            const uuid = UUID.toString(this.#adapter.uuid)
            const registry = (globalThis as any).openDAW?.werkstattProcessors?.[uuid]
            const expectedUpdate = parseUpdate(this.#adapter.box.code.getValue())
            if (isDefined(registry) && registry.update === expectedUpdate) {
                this.#swapProcessor(registry.create, expectedUpdate)
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
            console.error("Werkstatt: runtime error in process()", error)
            this.#silenced = true
        }
        this.#peaks.process(io.out[0], io.out[1], block.s0, block.s1)
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})`}
}
