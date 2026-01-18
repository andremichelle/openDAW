import {RenderQuantum} from "@opendaw/lib-dsp"
import {createNamModule, NamWasmModule} from "@andremichelle/nam-wasm"
import {isDefined} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {NamProcessorProtocol} from "./protocol"

registerProcessor("nam-test-processor", class NamTestProcessor extends AudioWorkletProcessor {
    #namModule: NamWasmModule | null = null
    #instanceId: number = -1
    #modelLoaded: boolean = false
    #inputGain: number = 1.0
    #outputGain: number = 1.0
    #mix: number = 1.0
    #bypass: boolean = false
    #loudnessCompensation: number = 1.0
    #modelInputGain: number = 1.0

    readonly #monoInput: Float32Array = new Float32Array(RenderQuantum)
    readonly #monoOutput: Float32Array = new Float32Array(RenderQuantum)

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
                console.log("[Processor] Creating instance...")
                this.#instanceId = this.#namModule.createInstance()
                console.log(`[Processor] NAM ready, instance ID: ${this.#instanceId}`)
            },
            loadModel: async (modelJson: string): Promise<boolean> => {
                if (!isDefined(this.#namModule)) {
                    return false
                }
                console.log("[Processor] Loading model...")
                console.log("[Processor] Instance ID:", this.#instanceId)
                console.log("[Processor] Model JSON length:", modelJson?.length)

                const parsed = JSON.parse(modelJson)
                console.log("[Processor] Model version:", parsed.version)
                console.log("[Processor] Model architecture:", parsed.architecture)

                this.#modelLoaded = this.#namModule.loadModel(this.#instanceId, modelJson)
                console.log(`[Processor] Model loaded: ${this.#modelLoaded}`)

                if (parsed.metadata?.gain !== undefined) {
                    this.#modelInputGain = parsed.metadata.gain
                    console.log(`[Processor] Model input gain: ${this.#modelInputGain.toFixed(4)}`)
                } else {
                    this.#modelInputGain = 1.0
                }

                if (this.#modelLoaded && this.#namModule.hasModelLoudness(this.#instanceId)) {
                    const loudnessDb = this.#namModule.getModelLoudness(this.#instanceId)
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

        const inputL = input[0]
        const inputR = input.length > 1 ? input[1] : input[0]
        const outputL = output[0]
        const outputR = output.length > 1 ? output[1] : output[0]

        if (this.#bypass || !this.#modelLoaded || !isDefined(this.#namModule)) {
            outputL.set(inputL)
            if (outputR !== outputL) {
                outputR.set(inputR)
            }
            return true
        }

        for (let i = 0; i < RenderQuantum; i++) {
            this.#monoInput[i] = (inputL[i] + inputR[i]) * 0.5 * this.#modelInputGain * this.#inputGain
        }

        this.#namModule.process(this.#instanceId, this.#monoInput, this.#monoOutput)

        for (let i = 0; i < RenderQuantum; i++) {
            const dry = (inputL[i] + inputR[i]) * 0.5
            const wet = this.#monoOutput[i] * this.#loudnessCompensation * this.#outputGain
            const mixed = dry * (1 - this.#mix) + wet * this.#mix
            outputL[i] = mixed
            outputR[i] = mixed
        }

        return true
    }
})
