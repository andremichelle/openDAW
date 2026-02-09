import {EngineToClient, NeuralAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {int, isDefined, Nullable, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioAnalyser, AudioBuffer, dbToGain, Event, RenderQuantum, StereoMatrix} from "@opendaw/lib-dsp"
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
    static #wasmLoading: Nullable<Promise<NamWasmModule>> = null

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
            return module
        })()
        return this.#wasmLoading
    }

    readonly #id: int = NeuralAmpDeviceProcessor.ID++
    readonly #context: EngineContext
    readonly #adapter: NeuralAmpDeviceBoxAdapter

    readonly parameterInputGain: AutomatableParameter<number>
    readonly parameterOutputGain: AutomatableParameter<number>
    readonly parameterMix: AutomatableParameter<number>

    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #audioAnalyser: AudioAnalyser
    readonly #spectrum: Float32Array
    readonly #inputs: [Float32Array, Float32Array]
    readonly #outputs: [Float32Array, Float32Array]

    #needsSpectrum: boolean = false
    #pendingModelJson: string = ""
    #source: Option<AudioBuffer> = Option.None
    #instances: [int, int] = [-1, -1]
    #modelLoaded: boolean = false
    #inputGain: number = 1.0
    #outputGain: number = 1.0
    #mono: boolean = true
    #mix: number = 1.0
    #terminated: boolean = false

    constructor(context: EngineContext, adapter: NeuralAmpDeviceBoxAdapter) {
        super(context)
        this.#context = context
        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#audioAnalyser = new AudioAnalyser({decay: 0.96})
        this.#spectrum = new Float32Array(this.#audioAnalyser.numBins())
        this.#inputs = [new Float32Array(RenderQuantum), new Float32Array(RenderQuantum)]
        this.#outputs = [new Float32Array(RenderQuantum), new Float32Array(RenderQuantum)]
        const {namedParameter} = adapter
        this.parameterInputGain = this.own(this.bindParameter(namedParameter.inputGain))
        this.parameterOutputGain = this.own(this.bindParameter(namedParameter.outputGain))
        this.parameterMix = this.own(this.bindParameter(namedParameter.mix))
        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            adapter.modelField.catchupAndSubscribe(() => this.#onModelChanged()),
            adapter.monoField.catchupAndSubscribe(field => this.#onMonoChanged(field.getValue())),
            context.broadcaster.broadcastFloats(adapter.spectrum, this.#spectrum, (hasSubscribers) => {
                this.#needsSpectrum = hasSubscribers
                if (!hasSubscribers) {return}
                this.#spectrum.set(this.#audioAnalyser.bins())
                this.#audioAnalyser.decay = true
            })
        )
        this.#initInstance()
        this.readAllParameters()
        const initialModelJson = adapter.getModelJson()
        if (initialModelJson.length > 0) {
            context.awaitResource(NeuralAmpDeviceProcessor.fetchWasm(context.engineToClient))
        }
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#output.clear()
        this.#peaks.clear()
        this.eventInput.clear()
        if (this.#terminated) {return}
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.nonEmpty()) {
            const wasm = module.unwrap()
            for (const instance of this.#instances) {
                if (instance >= 0) {
                    try {
                        wasm.reset(instance)
                    } catch (error) {
                        console.error("NAM reset failed:", error)
                    }
                }
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
        if (this.#terminated || this.#source.isEmpty()) {return}
        const [inL, inR] = this.#source.unwrap().channels() as StereoMatrix.Channels
        const [outL, outR] = this.#output.channels() as StereoMatrix.Channels
        const numFrames = to - from
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.isEmpty() || !this.#modelLoaded || this.#instances[0] < 0) {
            for (let i = from; i < to; i++) {
                outL[i] = inL[i]
                outR[i] = inR[i]
            }
            this.#peaks.process(outL, outR, from, to)
            return
        }
        const wasm = module.unwrap()
        const [bufInL, bufInR] = this.#inputs
        const [bufOutL, bufOutR] = this.#outputs
        const [instanceL, instanceR] = this.#instances
        const inputGain = this.#inputGain
        const outputGain = this.#outputGain
        const wet = this.#mix
        const dry = 1.0 - wet
        if (this.#mono) {
            for (let i = 0; i < numFrames; i++) {
                bufInL[i] = (inL[from + i] + inR[from + i]) * 0.5 * inputGain
            }
            wasm.process(instanceL, bufInL.subarray(0, numFrames), bufOutL.subarray(0, numFrames))
            for (let i = 0; i < numFrames; i++) {
                const wetSample = bufOutL[i] * outputGain
                outL[from + i] = inL[from + i] * dry + wetSample * wet
                outR[from + i] = inR[from + i] * dry + wetSample * wet
            }
        } else {
            for (let i = 0; i < numFrames; i++) {
                bufInL[i] = inL[from + i] * inputGain
                bufInR[i] = inR[from + i] * inputGain
            }
            wasm.process(instanceL, bufInL.subarray(0, numFrames), bufOutL.subarray(0, numFrames))
            wasm.process(instanceR, bufInR.subarray(0, numFrames), bufOutR.subarray(0, numFrames))
            for (let i = 0; i < numFrames; i++) {
                outL[from + i] = inL[from + i] * dry + bufOutL[i] * outputGain * wet
                outR[from + i] = inR[from + i] * dry + bufOutR[i] * outputGain * wet
            }
        }
        this.#peaks.process(outL, outR, from, to)
        if (this.#needsSpectrum) {
            this.#audioAnalyser.process(outL, outR, from, to)
        }
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
        this.#terminated = true
        super.terminate()
        this.#destroyInstances()
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}

    #initInstance(): void {
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.nonEmpty()) {
            const wasm = module.unwrap()
            if (this.#instances[0] < 0) {
                this.#instances[0] = wasm.createInstance()
            }
            if (!this.#mono && this.#instances[1] < 0) {
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
                    try {
                        wasm.unloadModel(this.#instances[i])
                        wasm.destroyInstance(this.#instances[i])
                    } catch (error) {
                        console.error("NAM destroyInstance failed:", error)
                    }
                    this.#instances[i] = -1
                }
            }
        }
        this.#modelLoaded = false
    }

    #onMonoChanged(mono: boolean): void {
        if (this.#terminated) {return}
        this.#mono = mono
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.isEmpty()) {return}
        const wasm = module.unwrap()
        if (mono) {
            if (this.#instances[1] >= 0) {
                try {
                    wasm.unloadModel(this.#instances[1])
                    wasm.destroyInstance(this.#instances[1])
                } catch (error) {
                    console.error("NAM destroyInstance failed in onMonoChanged:", error)
                }
                this.#instances[1] = -1
            }
        } else {
            if (this.#instances[1] < 0) {
                this.#instances[1] = wasm.createInstance()
                if (this.#pendingModelJson.length > 0) {
                    try {
                        wasm.loadModel(this.#instances[1], this.#pendingModelJson)
                    } catch (error) {
                        console.error("NAM loadModel failed in onMonoChanged:", error)
                    }
                }
            }
        }
    }

    #onModelChanged(): void {
        this.#onModelJsonChanged(this.#adapter.getModelJson())
    }

    #onModelJsonChanged(modelJson: string): void {
        if (this.#terminated) {return}
        this.#pendingModelJson = modelJson
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.nonEmpty()) {
            this.#initInstance()
            this.#applyModel()
        } else {
            NeuralAmpDeviceProcessor.fetchWasm(this.#context.engineToClient)
                .then(() => {
                    if (this.#terminated) {return}
                    this.#initInstance()
                    this.#applyModel()
                })
                .catch(error => console.error("Failed to load NAM WASM:", error))
        }
    }

    #applyModel(): void {
        if (this.#terminated) {return}
        const module = NeuralAmpDeviceProcessor.#wasmModule
        if (module.isEmpty()) {
            this.#modelLoaded = false
            return
        }
        if (this.#instances[0] < 0) {
            this.#initInstance()
        }
        if (this.#instances[0] < 0) {
            this.#modelLoaded = false
            return
        }
        const wasm = module.unwrap()
        if (this.#pendingModelJson.length === 0) {
            for (const instance of this.#instances) {
                if (instance >= 0) {wasm.unloadModel(instance)}
            }
            this.#modelLoaded = false
            return
        }
        try {
            this.#modelLoaded = wasm.loadModel(this.#instances[0], this.#pendingModelJson)
            if (this.#instances[1] >= 0) {
                this.#modelLoaded = this.#modelLoaded && wasm.loadModel(this.#instances[1], this.#pendingModelJson)
            }
        } catch (error) {
            console.error("NAM loadModel failed:", error)
            this.#modelLoaded = false
        }
    }
}
