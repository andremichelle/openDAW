import {AudioData} from "../audio-data"
import {SampleEffect} from "./sample-effect"

export const ConvertToMono: SampleEffect = {
    id: "convert-to-mono",
    name: "Convert to Mono",
    parameters: [],
    wholeSample: true,
    accepts: ({numberOfChannels}) => numberOfChannels > 1,
    process: ({sampleRate, numberOfFrames, numberOfChannels, frames}, _values, progress) => {
        const mono = AudioData.create(sampleRate, numberOfFrames, 1)
        const target = mono.frames[0]
        const gain = 1.0 / numberOfChannels
        frames.forEach((source, channel) => {
            for (let index = 0; index < numberOfFrames; index++) {target[index] += source[index] * gain}
            progress((channel + 1) / numberOfChannels)
        })
        return mono
    }
}
