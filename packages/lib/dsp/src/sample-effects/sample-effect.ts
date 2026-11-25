import {int, Procedure, unitValue} from "@opendaw/lib-std"
import {AudioData} from "../audio-data"

export interface SampleEffect {
    readonly id: string
    readonly name: string
    readonly parameters: ReadonlyArray<SampleEffect.Parameter>
    readonly wholeSample: boolean
    accepts(audio: AudioData): boolean
    process(source: AudioData, values: ReadonlyArray<number>, progress: Procedure<unitValue>): AudioData
}

export namespace SampleEffect {
    export type Parameter = Readonly<{
        name: string
        min: number
        max: number
        defaultValue: number
        unit: string
    }>

    export type ChannelProcessor = (input: Float32Array, output: Float32Array, channel: int) => void

    export const defaultsOf = ({parameters}: SampleEffect): ReadonlyArray<number> =>
        parameters.map(({defaultValue}) => defaultValue)

    export const acceptsAny = (_audio: AudioData): boolean => true

    export const mapChannels = (source: AudioData,
                                progress: Procedure<unitValue>,
                                processor: ChannelProcessor): AudioData => {
        const {sampleRate, numberOfFrames, numberOfChannels, frames} = source
        const target = AudioData.create(sampleRate, numberOfFrames, numberOfChannels)
        for (let channel = 0; channel < numberOfChannels; channel++) {
            processor(frames[channel], target.frames[channel], channel)
            progress((channel + 1) / numberOfChannels)
        }
        return target
    }
}
