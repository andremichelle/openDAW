import {SampleEffect} from "./sample-effect"

export const FadeIn: SampleEffect = {
    id: "fade-in",
    name: "Fade In",
    parameters: [],
    wholeSample: false,
    accepts: SampleEffect.acceptsAny,
    process: (source, _values, progress) => {
        const scale = 1.0 / Math.max(1, source.numberOfFrames - 1)
        return SampleEffect.mapChannels(source, progress, (input, output) => {
            for (let index = 0; index < input.length; index++) {output[index] = input[index] * index * scale}
        })
    }
}
