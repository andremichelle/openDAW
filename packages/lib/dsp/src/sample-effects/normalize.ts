import {dbToGain} from "../utils"
import {SampleEffect} from "./sample-effect"

export const Normalize: SampleEffect = {
    id: "normalize",
    name: "Normalize",
    parameters: [{name: "Peak", min: -48, max: 0, defaultValue: -1, unit: "dB"}],
    wholeSample: false,
    accepts: SampleEffect.acceptsAny,
    process: (source, [peakDb], progress) => {
        let peak = 0.0
        for (const channel of source.frames) {
            for (let index = 0; index < channel.length; index++) {peak = Math.max(peak, Math.abs(channel[index]))}
        }
        const gain = peak === 0.0 ? 1.0 : dbToGain(peakDb) / peak
        return SampleEffect.mapChannels(source, progress, (input, output) => {
            for (let index = 0; index < input.length; index++) {output[index] = input[index] * gain}
        })
    }
}
