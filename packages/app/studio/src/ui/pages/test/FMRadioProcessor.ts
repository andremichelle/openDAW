/**
 * FM Radio Tuning Effect Processor
 *
 * Physical modeling of FM radio tuning:
 * - FM modulates input audio onto a carrier
 * - Demodulates with a local oscillator that can be offset
 * - Frequency offset creates characteristic tuning artifacts:
 *   - Beat frequencies and pitch shifting
 *   - Increased noise floor
 *   - Signal distortion
 */

// AudioWorklet global types (not available in standard lib)
declare const sampleRate: number
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void
declare class AudioWorkletProcessor {
    readonly port: MessagePort
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
interface AudioParamDescriptor {
    name: string
    defaultValue?: number
    minValue?: number
    maxValue?: number
    automationRate?: "a-rate" | "k-rate"
}

// Constants - no magic numbers
const TWO_PI = 2.0 * Math.PI

// Default parameter values
const DEFAULT_CARRIER_FREQUENCY = 10000.0      // Hz - carrier frequency for FM modulation
const DEFAULT_MODULATION_INDEX = 5.0           // FM modulation depth
const DEFAULT_FREQUENCY_OFFSET = 0.0           // 0 = tuned, 1 = completely off-tune
const DEFAULT_OFFSET_RANGE = 500.0             // Hz - max frequency offset when offset = 1
const DEFAULT_NOISE_AMOUNT = 0.8               // How much noise at full offset

class FMRadioProcessor extends AudioWorkletProcessor {
    // Phase accumulators for oscillators
    private carrierPhase: number = 0.0
    private localOscillatorPhase: number = 0.0

    // Integrator for FM modulation
    private modulationIntegral: number = 0.0

    // Simple lowpass filter state for demodulation
    private lowpassState: number = 0.0
    private readonly lowpassCoeff: number

    // Noise generator state (simple LFSR-based)
    private noiseState: number = 1

    constructor() {
        super()

        // Lowpass filter coefficient for ~5kHz cutoff (audio bandwidth)
        const cutoffFrequency = 5000.0
        this.lowpassCoeff = Math.exp(-TWO_PI * cutoffFrequency / sampleRate)
    }

    static get parameterDescriptors(): AudioParamDescriptor[] {
        return [
            {
                name: "frequencyOffset",
                defaultValue: DEFAULT_FREQUENCY_OFFSET,
                minValue: 0.0,
                maxValue: 1.0,
                automationRate: "k-rate"
            },
            {
                name: "carrierFrequency",
                defaultValue: DEFAULT_CARRIER_FREQUENCY,
                minValue: 1000.0,
                maxValue: 20000.0,
                automationRate: "k-rate"
            },
            {
                name: "modulationIndex",
                defaultValue: DEFAULT_MODULATION_INDEX,
                minValue: 0.1,
                maxValue: 20.0,
                automationRate: "k-rate"
            },
            {
                name: "offsetRange",
                defaultValue: DEFAULT_OFFSET_RANGE,
                minValue: 10.0,
                maxValue: 2000.0,
                automationRate: "k-rate"
            },
            {
                name: "noiseAmount",
                defaultValue: DEFAULT_NOISE_AMOUNT,
                minValue: 0.0,
                maxValue: 1.0,
                automationRate: "k-rate"
            }
        ]
    }

    /**
     * Generate white noise using a simple LFSR
     */
    private generateNoise(): number {
        // Galois LFSR for pseudo-random noise
        const bit = this.noiseState & 1
        this.noiseState >>>= 1
        if (bit) {
            this.noiseState ^= 0xB400 // Taps for 16-bit LFSR
        }
        // Convert to -1..1 range
        return (this.noiseState / 0x7FFF) * 2.0 - 1.0
    }

    process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>
    ): boolean {
        const input = inputs[0]
        const output = outputs[0]

        if (!input || !input[0] || !output || !output[0]) {
            return true
        }

        // Get parameter values (k-rate, so just first sample)
        const frequencyOffset = parameters.frequencyOffset[0]
        const carrierFrequency = parameters.carrierFrequency[0]
        const modulationIndex = parameters.modulationIndex[0]
        const offsetRange = parameters.offsetRange[0]
        const noiseAmount = parameters.noiseAmount[0]

        // Calculate local oscillator frequency based on offset
        const localOscFreq = carrierFrequency + (frequencyOffset * offsetRange)

        // Phase increment per sample
        const carrierPhaseInc = TWO_PI * carrierFrequency / sampleRate
        const localOscPhaseInc = TWO_PI * localOscFreq / sampleRate

        // Calculate noise level based on offset (more offset = more noise)
        const noiseLevel = frequencyOffset * noiseAmount

        // Calculate signal level (inverse of offset for capture effect)
        // Use a non-linear curve for sharper "capture" feel
        const captureSharpness = 8.0
        const signalLevel = Math.pow(1.0 - frequencyOffset, captureSharpness)

        const inputChannel = input[0]
        const outputLeft = output[0]
        const outputRight = output[1] || output[0]

        for (let i = 0; i < inputChannel.length; i++) {
            const inputSample = inputChannel[i]

            // === FM Modulation ===
            // Integrate the input signal for frequency modulation
            this.modulationIntegral += inputSample

            // Calculate instantaneous phase of FM signal
            const fmPhase = this.carrierPhase + modulationIndex * this.modulationIntegral

            // Generate FM modulated signal
            const fmSignal = Math.cos(fmPhase)

            // Advance carrier phase
            this.carrierPhase += carrierPhaseInc
            if (this.carrierPhase > TWO_PI) {
                this.carrierPhase -= TWO_PI
                // Also wrap the modulation integral to prevent overflow
                this.modulationIntegral = 0.0
            }

            // === FM Demodulation with offset local oscillator ===
            // Mix with local oscillator (multiply)
            const localOsc = Math.cos(this.localOscillatorPhase)
            const mixed = fmSignal * localOsc

            // Advance local oscillator phase
            this.localOscillatorPhase += localOscPhaseInc
            if (this.localOscillatorPhase > TWO_PI) {
                this.localOscillatorPhase -= TWO_PI
            }

            // Lowpass filter to extract baseband
            this.lowpassState = mixed + this.lowpassCoeff * (this.lowpassState - mixed)

            // The demodulated signal
            let demodulated = this.lowpassState * 2.0 // Compensate for mixing loss

            // === Add noise based on frequency offset ===
            const noise = this.generateNoise() * noiseLevel

            // === Mix signal and noise ===
            // When tuned (offset=0): full signal, no noise
            // When off-tune (offset=1): no signal, full noise
            const finalSample = (demodulated * signalLevel) + noise

            // Output (mono to stereo)
            outputLeft[i] = finalSample
            outputRight[i] = finalSample
        }

        return true
    }
}

registerProcessor("fm-radio-processor", FMRadioProcessor)
