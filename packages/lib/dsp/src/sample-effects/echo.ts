import {SampleEffect} from "./sample-effect"

export const Echo: SampleEffect = {
    id: "echo",
    name: "Echo",
    parameters: [
        {name: "Delay", min: 1, max: 2000, defaultValue: 250, unit: "ms"},
        {name: "Feedback", min: 0, max: 95, defaultValue: 40, unit: "%"},
        {name: "Mix", min: 0, max: 100, defaultValue: 35, unit: "%"}
    ],
    wholeSample: false,
    accepts: SampleEffect.acceptsAny,
    process: (source, [delayMs, feedbackPercent, mixPercent], progress) => {
        const delayFrames = Math.max(1, Math.round(delayMs * 0.001 * source.sampleRate))
        const feedback = feedbackPercent * 0.01
        const wet = mixPercent * 0.01
        const dry = 1.0 - wet
        return SampleEffect.mapChannels(source, progress, (input, output) => {
            const buffer = new Float32Array(delayFrames)
            let position = 0
            for (let index = 0; index < input.length; index++) {
                const x = input[index]
                const delayed = buffer[position]
                buffer[position] = x + delayed * feedback
                if (++position === delayFrames) {position = 0}
                output[index] = x * dry + delayed * wet
            }
        })
    }
}
