import {dbToGain} from "../utils"
import {SampleEffect} from "./sample-effect"

export const Distortion: SampleEffect = {
    id: "distortion",
    name: "Distortion",
    parameters: [
        {name: "Drive", min: 0, max: 48, defaultValue: 12, unit: "dB"},
        {name: "Mix", min: 0, max: 100, defaultValue: 100, unit: "%"}
    ],
    wholeSample: false,
    accepts: SampleEffect.acceptsAny,
    process: (source, [driveDb, mixPercent], progress) => {
        const drive = dbToGain(driveDb)
        const normalize = 1.0 / Math.tanh(drive)
        const wet = mixPercent * 0.01
        const dry = 1.0 - wet
        return SampleEffect.mapChannels(source, progress, (input, output) => {
            for (let index = 0; index < input.length; index++) {
                const x = input[index]
                output[index] = x * dry + Math.tanh(x * drive) * normalize * wet
            }
        })
    }
}
