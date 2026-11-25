import {assert, int} from "@opendaw/lib-std"
import {AudioData} from "./audio-data"

export namespace AudioSplice {
    export const empty = ({sampleRate, numberOfChannels}: AudioData): AudioData =>
        AudioData.create(sampleRate, 0, numberOfChannels)

    export const silence = ({sampleRate, numberOfChannels}: AudioData, numberOfFrames: int): AudioData =>
        AudioData.create(sampleRate, numberOfFrames, numberOfChannels)

    export const slice = (audio: AudioData, from: int, to: int): AudioData => {
        assert(0 <= from && from <= to && to <= audio.numberOfFrames, `Invalid range [${from}, ${to})`)
        const target = AudioData.create(audio.sampleRate, to - from, audio.numberOfChannels)
        audio.frames.forEach((channel, index) => target.frames[index].set(channel.subarray(from, to)))
        return target
    }

    export const splice = (audio: AudioData, from: int, removeCount: int, insert: AudioData): AudioData => {
        const to = from + removeCount
        assert(0 <= from && removeCount >= 0 && to <= audio.numberOfFrames, `Invalid range [${from}, ${to})`)
        if (from === 0 && to === audio.numberOfFrames) {return insert}
        assert(insert.numberOfChannels === audio.numberOfChannels, "Channel count must match")
        assert(insert.sampleRate === audio.sampleRate, "Sample rate must match")
        const numberOfFrames = audio.numberOfFrames - removeCount + insert.numberOfFrames
        const target = AudioData.create(audio.sampleRate, numberOfFrames, audio.numberOfChannels)
        audio.frames.forEach((channel, index) => {
            const output = target.frames[index]
            output.set(channel.subarray(0, from))
            output.set(insert.frames[index], from)
            output.set(channel.subarray(to), from + insert.numberOfFrames)
        })
        return target
    }

    export const matchChannels = (audio: AudioData, numberOfChannels: int): AudioData => {
        if (audio.numberOfChannels === numberOfChannels) {return audio}
        const target = AudioData.create(audio.sampleRate, audio.numberOfFrames, numberOfChannels)
        if (audio.numberOfChannels === 1) {
            target.frames.forEach(channel => channel.set(audio.frames[0]))
        } else if (numberOfChannels === 1) {
            const gain = 1.0 / audio.numberOfChannels
            const output = target.frames[0]
            audio.frames.forEach(channel => {
                for (let index = 0; index < channel.length; index++) {output[index] += channel[index] * gain}
            })
        } else {
            target.frames.forEach((channel, index) => channel.set(audio.frames[Math.min(index, audio.numberOfChannels - 1)]))
        }
        return target
    }
}
