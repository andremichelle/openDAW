import {BiquadCoeff} from "../biquad-coeff"
import {BiquadMono} from "../biquad-processor"
import {SampleEffect} from "./sample-effect"

export const HighPass: SampleEffect = {
    id: "high-pass",
    name: "High Pass",
    parameters: [{name: "Cutoff", min: 20, max: 20000, defaultValue: 200, unit: "Hz"}],
    wholeSample: false,
    accepts: SampleEffect.acceptsAny,
    process: (source, [cutoff], progress) => {
        const coeff = new BiquadCoeff().setHighpassParams(cutoff / source.sampleRate)
        return SampleEffect.mapChannels(source, progress, (input, output) =>
            new BiquadMono().process(coeff, input, output, 0, input.length))
    }
}
