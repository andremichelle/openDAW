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
    readonly parameterMix: AutomatableParameter<number>

    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #inputs: [Float32Array, Float32Array]
    readonly #outputs: [Float32Array, Float32Array]

    #source: Option<AudioBuffer> = Option.None
    #instances: [int, int] = [-1, -1]
    #modelLoaded: boolean = false
    #inputGain: number = 1.0
    #outputGain: number = 1.0
    #mono: boolean = true
    #mix: number = 1.0

    constructor(context: EngineContext, adapter: NeuralAmpDeviceBoxAdapter) {
        super(context)

        this.#context = context
        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#inputs = [new Float32Array(128), new Float32Array(128)]
        this.#outputs = [new Float32Array(128), new Float32Array(128)]

        const {namedParameter} = adapter
        this.parameterInputGain = this.own(this.bindParameter(namedParameter.inputGain))
        this.parameterOutputGain = this.own(this.bindParameter(namedParameter.outputGain))
        this.parameterMix = this.own(this.bindParameter(namedParameter.mix))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            adapter.modelJsonField.catchupAndSubscribe(field => this.#onModelJsonChanged(field.getValue())),
            adapter.monoField.catchupAndSubscribe(field => this.#onMonoChanged(field.getValue()))
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
        if (module.nonEmpty()) {
            const wasm = module.unwrap()
            for (const instance of this.#instances) {
                if (instance >= 0) {wasm.reset(instance)}
            }
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
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.isEmpty() || !this.#modelLoaded || this.#instances[0] < 0) {
            for (let i = from; i < to; i++) {
                output[0][i] = input[0][i]
                output[1][i] = input[1][i]
            }
            this.#peaks.process(output[0], output[1], from, to)
            return
        }
        const wasm = module.unwrap()
        const wet = this.#mix
        const dry = 1.0 - wet
        if (this.#mono) {
            for (let i = 0; i < numFrames; i++) {
                this.#inputs[0][i] = (input[0][from + i] + input[1][from + i]) * 0.5 * this.#inputGain
            }
            wasm.process(this.#instances[0], this.#inputs[0].subarray(0, numFrames), this.#outputs[0].subarray(0, numFrames))
            for (let i = 0; i < numFrames; i++) {
                const wetSample = this.#outputs[0][i] * this.#outputGain
                output[0][from + i] = input[0][from + i] * dry + wetSample * wet
                output[1][from + i] = input[1][from + i] * dry + wetSample * wet
            }
        } else {
            for (let i = 0; i < numFrames; i++) {
                this.#inputs[0][i] = input[0][from + i] * this.#inputGain
                this.#inputs[1][i] = input[1][from + i] * this.#inputGain
            }
            wasm.process(this.#instances[0], this.#inputs[0].subarray(0, numFrames), this.#outputs[0].subarray(0, numFrames))
            wasm.process(this.#instances[1], this.#inputs[1].subarray(0, numFrames), this.#outputs[1].subarray(0, numFrames))
            for (let i = 0; i < numFrames; i++) {
                output[0][from + i] = input[0][from + i] * dry + this.#outputs[0][i] * this.#outputGain * wet
                output[1][from + i] = input[1][from + i] * dry + this.#outputs[1][i] * this.#outputGain * wet
            }
        }
        this.#peaks.process(output[0], output[1], from, to)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterInputGain) {
            this.#inputGain = dbToGain(this.parameterInputGain.getValue())
        } else if (parameter === this.parameterOutputGain) {
            this.#outputGain = dbToGain(this.parameterOutputGain.getValue())
        } else if (parameter === this.parameterMix) {
            this.#mix = this.parameterMix.getValue()
        }
    }

    terminate(): void {
        super.terminate()
        this.#destroyInstances()
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}

    #initInstance(): void {
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.nonEmpty()) {
            const wasm = module.unwrap()
            this.#instances[0] = wasm.createInstance()
            if (!this.#mono) {
                this.#instances[1] = wasm.createInstance()
            }
        }
    }

    #destroyInstances(): void {
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.nonEmpty()) {
            const wasm = module.unwrap()
            for (let i = 0; i < 2; i++) {
                if (this.#instances[i] >= 0) {
                    wasm.destroyInstance(this.#instances[i])
                    this.#instances[i] = -1
                }
            }
        }
    }

    #onMonoChanged(mono: boolean): void {
        this.#mono = mono
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.isEmpty()) {return}
        const wasm = module.unwrap()
        if (mono) {
            if (this.#instances[1] >= 0) {
                wasm.destroyInstance(this.#instances[1])
                this.#instances[1] = -1
            }
        } else {
            if (this.#instances[1] < 0) {
                this.#instances[1] = wasm.createInstance()
                if (this.#pendingModelJson.length > 0) {
                    wasm.loadModel(this.#instances[1], this.#pendingModelJson)
                }
            }
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
        if (this.#instances[0] < 0) {
            this.#initInstance()
        }
        const wasm = module.unwrap()
        if (this.#pendingModelJson.length === 0) {
            for (const instance of this.#instances) {
                if (instance >= 0) {wasm.unloadModel(instance)}
            }
            this.#modelLoaded = false
            return
        }
        this.#modelLoaded = wasm.loadModel(this.#instances[0], this.#pendingModelJson)
        if (this.#instances[1] >= 0) {
            this.#modelLoaded = this.#modelLoaded && wasm.loadModel(this.#instances[1], this.#pendingModelJson)
        }
    }
}