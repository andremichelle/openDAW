import {RenderQuantum} from "@opendaw/lib-dsp"
import {NamWasmModule} from "@andremichelle/nam-wasm"
import createNamModule from "@andremichelle/nam-wasm/nam.js"
import {isDefined} from "@opendaw/lib-std"

registerProcessor("nam-test-processor", class NamTestProcessor extends AudioWorkletProcessor {
    #namModule: NamWasmModule | null = null
    #instanceId: number = -1
    #modelLoaded: boolean = false
    #inputGain: number = 1.0
    #outputGain: number = 1.0
    #mix: number = 1.0
    #bypass: boolean = false
    #loudnessCompensation: number = 1.0 // Linear multiplier to normalize model output
    #modelInputGain: number = 1.0 // Input gain from model metadata

    // Reusable buffers
    readonly #monoInput: Float32Array = new Float32Array(RenderQuantum)
    readonly #monoOutput: Float32Array = new Float32Array(RenderQuantum)

    constructor() {
        super()

        // Handle all messages from main thread
        this.port.onmessage = async (event) => {
            console.log("[Processor] Received message:", event.data.type)
            const {type, ...data} = event.data

            switch (type) {
                case "init-wasm": {
                    try {
                        console.log("[Processor] Received WASM binary, size:", data.wasmBinary?.byteLength)
                        console.log("[Processor] Creating NAM module via Emscripten...")
                        // Pass wasmBinary to Emscripten so it doesn't try to fetch it
                        // Also provide locateFile to prevent Emscripten from using URL (not available in AudioWorklet)
                        this.#namModule = await NamWasmModule.create(() => createNamModule({
                            wasmBinary: data.wasmBinary,
                            locateFile: () => "" // Not used since we provide wasmBinary
                        }))
                        console.log("[Processor] NamWasmModule created:", this.#namModule)
                        console.log("[Processor] Setting sample rate:", sampleRate)
                        this.#namModule.setSampleRate(sampleRate)
                        console.log("[Processor] Creating instance...")
                        this.#instanceId = this.#namModule.createInstance()
                        console.log(`[Processor] NAM ready, instance ID: ${this.#instanceId}`)
                        this.port.postMessage({type: "wasm-ready"})
                    } catch (error) {
                        console.error("[Processor] Failed to init WASM:", error)
                        this.port.postMessage({type: "wasm-error", error: String(error)})
                    }
                    break
                }
                case "load-model": {
                    if (isDefined(this.#namModule)) {
                        console.log("[Processor] Loading model...")
                        console.log("[Processor] Instance ID:", this.#instanceId)
                        console.log("[Processor] Model JSON length:", data.modelJson?.length)
                        console.log("[Processor] Model JSON preview:", data.modelJson?.substring(0, 200))
                        try {
                            // Verify JSON is valid first
                            const parsed = JSON.parse(data.modelJson)
                            console.log("[Processor] Model version:", parsed.version)
                            console.log("[Processor] Model architecture:", parsed.architecture)
                            console.log("[Processor] Config:", JSON.stringify(parsed.config)?.substring(0, 300))
                            this.#modelLoaded = this.#namModule.loadModel(this.#instanceId, data.modelJson)
                            console.log(`[Processor] Model loaded: ${this.#modelLoaded}`)

                            // Apply model gain from metadata (input normalization)
                            if (parsed.metadata?.gain !== undefined) {
                                this.#modelInputGain = parsed.metadata.gain
                                console.log(`[Processor] Model input gain: ${this.#modelInputGain.toFixed(4)}`)
                            } else {
                                this.#modelInputGain = 1.0
                            }

                            // Apply loudness compensation targeting -18 dBFS reference level
                            if (this.#modelLoaded && this.#namModule.hasModelLoudness(this.#instanceId)) {
                                const loudnessDb = this.#namModule.getModelLoudness(this.#instanceId)
                                const targetDb = -18 // Common mixing reference level
                                const compensationDb = targetDb - loudnessDb
                                this.#loudnessCompensation = Math.pow(10, compensationDb / 20)
                                console.log(`[Processor] Model loudness: ${loudnessDb.toFixed(2)} dB, target: ${targetDb} dB, compensation: ${this.#loudnessCompensation.toFixed(2)}x`)
                            } else {
                                this.#loudnessCompensation = 1.0
                            }

                            this.port.postMessage({type: "model-loaded", success: this.#modelLoaded})
                        } catch (error) {
                            console.error("[Processor] Failed to load model:", error)
                            console.error("[Processor] Error type:", typeof error, error?.constructor?.name)
                            // Emscripten exceptions are numbers (pointers) - try to get more info
                            let errorMsg = String(error)
                            if (typeof error === "number") {
                                errorMsg = `WASM exception at address ${error} (0x${error.toString(16)})`
                            }
                            this.port.postMessage({type: "model-loaded", success: false, error: errorMsg})
                        }
                    }
                    break
                }
                case "set-input-gain":
                    this.#inputGain = data.value
                    break
                case "set-output-gain":
                    this.#outputGain = data.value
                    break
                case "set-mix":
                    this.#mix = data.value
                    break
                case "set-bypass":
                    this.#bypass = data.value
                    break
            }
        }
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const input = inputs[0]
        const output = outputs[0]

        // No input connected
        if (input.length === 0 || input[0].length === 0) {
            return true
        }

        const inputL = input[0]
        const inputR = input.length > 1 ? input[1] : input[0]
        const outputL = output[0]
        const outputR = output.length > 1 ? output[1] : output[0]

        // Bypass mode or no model
        if (this.#bypass || !this.#modelLoaded || !isDefined(this.#namModule)) {
            outputL.set(inputL)
            if (outputR !== outputL) {
                outputR.set(inputR)
            }
            return true
        }

        // Mix stereo to mono with model input gain and user input gain
        for (let i = 0; i < RenderQuantum; i++) {
            this.#monoInput[i] = (inputL[i] + inputR[i]) * 0.5 * this.#modelInputGain * this.#inputGain
        }

        // Process through NAM
        this.#namModule.process(this.#instanceId, this.#monoInput, this.#monoOutput)

        // Apply loudness compensation, output gain, and mix, expand to stereo
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
