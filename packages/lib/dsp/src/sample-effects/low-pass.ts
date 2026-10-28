import {BiquadCoeff} from "../biquad-coeff"
import {BiquadMono} from "../biquad-processor"
import {SampleEffect} from "./sample-effect"

export const LowPass: SampleEffect = {
    id: "low-pass",
    name: "Low Pass",
    parameters: [{name: "Cutoff", min: 20, max: 20000, defaultValue: 1000, unit: "Hz"}],
    wholeSample: false,
    accepts: SampleEffect.acceptsAny,
    process: (source, [cutoff], progress) => {
        const coeff = new BiquadCoeff().setLowpassParams(cutoff / source.sampleRate)
        return SampleEffect.mapChannels(source, progress, (input, output) =>
            new BiquadMono().process(coeff, input, output, 0, input.length))
    }
}
