import {SampleEffect} from "./sample-effect"

export const Reverse: SampleEffect = {
    id: "reverse",
    name: "Reverse",
    parameters: [],
    wholeSample: false,
    accepts: SampleEffect.acceptsAny,
    process: (source, _values, progress) => SampleEffect.mapChannels(source, progress, (input, output) => {
        const last = input.length - 1
        for (let index = 0; index < input.length; index++) {output[index] = input[last - index]}
    })
}
