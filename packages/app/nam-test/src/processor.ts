import {RenderQuantum} from "@moises-ai/lib-dsp"
import {createNamModule, NamWasmModule} from "@opendaw/nam-wasm"
import {isDefined} from "@moises-ai/lib-std"
import {Communicator, Messenger} from "@moises-ai/lib-runtime"
import {NamProcessorProtocol} from "./protocol"

registerProcessor("nam-test-processor", class NamTestProcessor extends AudioWorkletProcessor {
    #namModule: NamWasmModule | null = null
    #instanceL: number = -1
    #instanceR: number = -1
    #modelLoaded: boolean = false
    #inputGain: number = 1.0
    #outputGain: number = 1.0
    #mix: number = 1.0
    #bypass: boolean = false
    #mono: boolean = true
    #loudnessCompensation: number = 1.0
    #modelInputGain: number = 1.0

    readonly #inputL: Float32Array = new Float32Array(RenderQuantum)
    readonly #inputR: Float32Array = new Float32Array(RenderQuantum)
    readonly #outputL: Float32Array = new Float32Array(RenderQuantum)
    readonly #outputR: Float32Array = new Float32Array(RenderQuantum)

    constructor() {
        super()

        const protocol: NamProcessorProtocol = {
            initWasm: async (wasmBinary: ArrayBuffer): Promise<void> => {
                console.log("[Processor] Received WASM binary, size:", wasmBinary?.byteLength)
                console.log("[Processor] Creating NAM module via Emscripten...")
                this.#namModule = await NamWasmModule.create(() => createNamModule({
                    wasmBinary,
                    locateFile: () => ""
                }))
                console.log("[Processor] NamWasmModule created:", this.#namModule)
                console.log("[Processor] Setting sample rate:", sampleRate)
                this.#namModule.setSampleRate(sampleRate)
                console.log("[Processor] Creating instances (L/R)...")
                this.#instanceL = this.#namModule.createInstance()
                this.#instanceR = this.#namModule.createInstance()
                console.log(`[Processor] NAM ready, instances: L=${this.#instanceL}, R=${this.#instanceR}`)
            },
            loadModel: async (modelJson: string): Promise<boolean> => {
                if (!isDefined(this.#namModule)) {
                    return false
                }
                console.log("[Processor] Loading model...")
                console.log("[Processor] Model JSON length:", modelJson?.length)
                const parsed = JSON.parse(modelJson)
                console.log("[Processor] Model version:", parsed.version)
                console.log("[Processor] Model architecture:", parsed.architecture)
                const loadedL = this.#namModule.loadModel(this.#instanceL, modelJson)
                const loadedR = this.#namModule.loadModel(this.#instanceR, modelJson)
                this.#modelLoaded = loadedL && loadedR
                console.log(`[Processor] Model loaded: L=${loadedL}, R=${loadedR}`)
                if (parsed.metadata?.gain !== undefined) {
                    this.#modelInputGain = parsed.metadata.gain
                    console.log(`[Processor] Model input gain: ${this.#modelInputGain.toFixed(4)}`)
                } else {
                    this.#modelInputGain = 1.0
                }
                if (this.#modelLoaded && this.#namModule.hasModelLoudness(this.#instanceL)) {
                    const loudnessDb = this.#namModule.getModelLoudness(this.#instanceL)
                    const targetDb = -18
                    const compensationDb = targetDb - loudnessDb
                    this.#loudnessCompensation = Math.pow(10, compensationDb / 20)
                    console.log(`[Processor] Model loudness: ${loudnessDb.toFixed(2)} dB, target: ${targetDb} dB, compensation: ${this.#loudnessCompensation.toFixed(2)}x`)
                } else {
                    this.#loudnessCompensation = 1.0
                }
                return this.#modelLoaded
            },
            setInputGain: (value: number): void => {
                this.#inputGain = value
            },
            setOutputGain: (value: number): void => {
                this.#outputGain = value
            },
            setMix: (value: number): void => {
                this.#mix = value
            },
            setBypass: (value: boolean): void => {
                this.#bypass = value
            },
            setMono: (value: boolean): void => {
                this.#mono = value
            }
        }

        Communicator.executor(Messenger.for(this.port), protocol)
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const input = inputs[0]
        const output = outputs[0]
        if (input.length === 0 || input[0].length === 0) {
            return true
        }
        const inL = input[0]
        const inR = input.length > 1 ? input[1] : input[0]
        const outL = output[0]
        const outR = output.length > 1 ? output[1] : output[0]
        if (this.#bypass || !this.#modelLoaded || !isDefined(this.#namModule)) {
            outL.set(inL)
            if (outR !== outL) {
                outR.set(inR)
            }
            return true
        }
        const gain = this.#modelInputGain * this.#inputGain
        const wetGain = this.#loudnessCompensation * this.#outputGain
        if (this.#mono) {
            for (let i = 0; i < RenderQuantum; i++) {
                this.#inputL[i] = (inL[i] + inR[i]) * 0.5 * gain
            }
            this.#namModule.process(this.#instanceL, this.#inputL, this.#outputL)
            for (let i = 0; i < RenderQuantum; i++) {
                const dry = (inL[i] + inR[i]) * 0.5
                const wet = this.#outputL[i] * wetGain
                const mixed = dry * (1 - this.#mix) + wet * this.#mix
                outL[i] = mixed
                outR[i] = mixed
            }
        } else {
            for (let i = 0; i < RenderQuantum; i++) {
                this.#inputL[i] = inL[i] * gain
                this.#inputR[i] = inR[i] * gain
            }
            this.#namModule.process(this.#instanceL, this.#inputL, this.#outputL)
            this.#namModule.process(this.#instanceR, this.#inputR, this.#outputR)
            for (let i = 0; i < RenderQuantum; i++) {
                const wetL = this.#outputL[i] * wetGain
                const wetR = this.#outputR[i] * wetGain
                outL[i] = inL[i] * (1 - this.#mix) + wetL * this.#mix
                outR[i] = inR[i] * (1 - this.#mix) + wetR * this.#mix
            }
        }
        return true
    }
})
