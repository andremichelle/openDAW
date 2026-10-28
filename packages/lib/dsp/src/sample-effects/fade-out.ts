import {SampleEffect} from "./sample-effect"

export const FadeOut: SampleEffect = {
    id: "fade-out",
    name: "Fade Out",
    parameters: [],
    wholeSample: false,
    accepts: SampleEffect.acceptsAny,
    process: (source, _values, progress) => {
        const scale = 1.0 / Math.max(1, source.numberOfFrames - 1)
        return SampleEffect.mapChannels(source, progress, (input, output) => {
            for (let index = 0; index < input.length; index++) {output[index] = input[index] * (1.0 - index * scale)}
        })
    }
}
