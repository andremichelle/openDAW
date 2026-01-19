import {EngineToClient, NeuralAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {int, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioBuffer, dbToGain, Event, StereoMatrix} from "@opendaw/lib-dsp"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AudioProcessor} from "../../AudioProcessor"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {createNamModule, NamWasmModule} from "@opendaw/nam-wasm"

export class NeuralAmpDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    // Singleton WASM module - shared across all instances
    static #wasmModule: Option<NamWasmModule> = Option.None
    static #wasmLoading: Promise<NamWasmModule> | null = null
    static #pendingCallbacks: Array<() => void> = []

    /**
     * Fetches and initializes the NAM WASM module.
     * The module is shared across all instances.
     */
    static async fetchWasm(engineToClient: EngineToClient): Promise<NamWasmModule> {
        if (this.#wasmModule.nonEmpty()) {
            return this.#wasmModule.unwrap()
        }
        if (isDefined(this.#wasmLoading)) {
            return this.#wasmLoading
        }
        this.#wasmLoading = (async () => {
            const wasmBinary = await engineToClient.fetchNamWasm()
            const emscriptenModule = await createNamModule({
                wasmBinary,
                locateFile: () => "" // Prevent URL usage in worklet context
            })
            const module = NamWasmModule.fromModule(emscriptenModule)
            module.setSampleRate(sampleRate)
            this.#wasmModule = Option.wrap(module)
            this.#wasmLoading = null
            // Notify all pending processors
            for (const callback of this.#pendingCallbacks) {
                callback()
            }
            this.#pendingCallbacks = []
            return module
        })()
        return this.#wasmLoading
    }

    static get wasmModule(): Option<NamWasmModule> {
        return this.#wasmModule
    }

    static onWasmReady(callback: () => void): void {
        if (this.#wasmModule.nonEmpty()) {
            callback()
        } else {
            this.#pendingCallbacks.push(callback)
        }
    }

    readonly #id: int = NeuralAmpDeviceProcessor.ID++
    readonly #context: EngineContext
    readonly #adapter: NeuralAmpDeviceBoxAdapter

    readonly parameterInputGain: AutomatableParameter<number>
    readonly parameterOutputGain: AutomatableParameter<number>

    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #monoInput: Float32Array
    readonly #monoOutput: Float32Array

    #source: Option<AudioBuffer> = Option.None
    #instanceId: int = -1
    #modelLoaded: boolean = false
    #inputGain: number = 1.0
    #outputGain: number = 1.0

    constructor(context: EngineContext, adapter: NeuralAmpDeviceBoxAdapter) {
        super(context)

        this.#context = context
        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#monoInput = new Float32Array(128)
        this.#monoOutput = new Float32Array(128)

        const {namedParameter} = adapter
        this.parameterInputGain = this.own(this.bindParameter(namedParameter.inputGain))
        this.parameterOutputGain = this.own(this.bindParameter(namedParameter.outputGain))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            adapter.modelJsonField.catchupAndSubscribe(field => this.#onModelJsonChanged(field.getValue()))
        )

        this.#initInstance()
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#output.clear()
        this.#peaks.clear()
        this.eventInput.clear()
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.nonEmpty() && this.#instanceId >= 0) {
            module.unwrap().reset(this.#instanceId)
        }
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#output}

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return {terminate: () => this.#source = Option.None}
    }

    index(): int {return this.#adapter.indexField.getValue()}
    adapter(): NeuralAmpDeviceBoxAdapter {return this.#adapter}

    handleEvent(_event: Event): void {}

    processAudio(_block: Block, from: number, to: number): void {
        if (this.#source.isEmpty()) {return}

        const source = this.#source.unwrap()
        const input = source.channels() as StereoMatrix.Channels
        const output = this.#output.channels() as StereoMatrix.Channels
        const numFrames = to - from

        // If no WASM or no model, pass through
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.isEmpty() || !this.#modelLoaded || this.#instanceId < 0) {
            for (let i = from; i < to; i++) {
                output[0][i] = input[0][i]
                output[1][i] = input[1][i]
            }
            this.#peaks.process(output[0], output[1], from, to)
            return
        }

        const wasm = module.unwrap()

        // Mix to mono with input gain
        for (let i = 0; i < numFrames; i++) {
            this.#monoInput[i] = (input[0][from + i] + input[1][from + i]) * 0.5 * this.#inputGain
        }

        // Process through NAM
        wasm.process(this.#instanceId, this.#monoInput.subarray(0, numFrames), this.#monoOutput.subarray(0, numFrames))

        // Apply output gain and copy to stereo output
        for (let i = 0; i < numFrames; i++) {
            const sample = this.#monoOutput[i] * this.#outputGain
            output[0][from + i] = sample
            output[1][from + i] = sample
        }

        this.#peaks.process(output[0], output[1], from, to)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterInputGain) {
            this.#inputGain = dbToGain(this.parameterInputGain.getValue())
        } else if (parameter === this.parameterOutputGain) {
            this.#outputGain = dbToGain(this.parameterOutputGain.getValue())
        }
    }

    terminate(): void {
        super.terminate()
        this.#destroyInstance()
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}

    #initInstance(): void {
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.nonEmpty()) {
            this.#instanceId = module.unwrap().createInstance()
        }
    }

    #destroyInstance(): void {
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.nonEmpty() && this.#instanceId >= 0) {
            module.unwrap().destroyInstance(this.#instanceId)
            this.#instanceId = -1
        }
    }

    #onModelJsonChanged(modelJson: string): void {
        this.#pendingModelJson = modelJson

        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.isEmpty()) {
            // WASM not loaded yet - trigger loading and register callback
            NeuralAmpDeviceProcessor.fetchWasm(this.#context.engineToClient).catch(error => {
                console.error("Failed to load NAM WASM:", error)
            })
            NeuralAmpDeviceProcessor.onWasmReady(() => this.#applyModel())
            return
        }

        this.#applyModel()
    }

    #pendingModelJson: string = ""

    #applyModel(): void {
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.isEmpty()) {
            this.#modelLoaded = false
            return
        }

        if (this.#instanceId < 0) {
            this.#initInstance()
        }

        if (this.#pendingModelJson.length === 0) {
            module.unwrap().unloadModel(this.#instanceId)
            this.#modelLoaded = false
            return
        }

        this.#modelLoaded = module.unwrap().loadModel(this.#instanceId, this.#pendingModelJson)
    }
}
