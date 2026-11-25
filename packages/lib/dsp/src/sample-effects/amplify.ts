import {dbToGain} from "../utils"
import {SampleEffect} from "./sample-effect"

export const Amplify: SampleEffect = {
    id: "amplify",
    name: "Amplify",
    parameters: [{name: "Gain", min: -48, max: 48, defaultValue: 0, unit: "dB"}],
    wholeSample: false,
    accepts: SampleEffect.acceptsAny,
    process: (source, [gainDb], progress) => {
        const gain = dbToGain(gainDb)
        return SampleEffect.mapChannels(source, progress, (input, output) => {
            for (let index = 0; index < input.length; index++) {output[index] = input[index] * gain}
        })
    }
}
