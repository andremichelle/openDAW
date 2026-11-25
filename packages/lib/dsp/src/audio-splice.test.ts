import {describe, expect, test} from "vitest"
import {AudioData} from "./audio-data"
import {AudioSplice} from "./audio-splice"

const ramp = (numberOfFrames: number, numberOfChannels: number = 2, sampleRate: number = 48000): AudioData => {
    const audio = AudioData.create(sampleRate, numberOfFrames, numberOfChannels)
    audio.frames.forEach((channel, channelIndex) => {
        for (let index = 0; index < numberOfFrames; index++) {channel[index] = index + channelIndex * 1000}
    })
    return audio
}

const values = (audio: AudioData, channel: number = 0): Array<number> => Array.from(audio.frames[channel])

describe("AudioSplice", () => {
    test("slice copies the range", () => {
        const sliced = AudioSplice.slice(ramp(10), 2, 5)
        expect(sliced.numberOfFrames).toBe(3)
        expect(values(sliced)).toEqual([2, 3, 4])
        expect(values(sliced, 1)).toEqual([1002, 1003, 1004])
    })
    test("slice of an empty range has zero frames", () => {
        expect(AudioSplice.slice(ramp(10), 4, 4).numberOfFrames).toBe(0)
    })
    test("slice is a copy, not a view", () => {
        const source = ramp(4)
        const sliced = AudioSplice.slice(source, 0, 4)
        sliced.frames[0][0] = 99
        expect(source.frames[0][0]).toBe(0)
    })
    test("slice rejects invalid ranges", () => {
        expect(() => AudioSplice.slice(ramp(4), 3, 2)).toThrow()
        expect(() => AudioSplice.slice(ramp(4), 0, 5)).toThrow()
        expect(() => AudioSplice.slice(ramp(4), -1, 2)).toThrow()
    })
    test("splice removes a range", () => {
        const source = ramp(6)
        const result = AudioSplice.splice(source, 1, 2, AudioSplice.empty(source))
        expect(values(result)).toEqual([0, 3, 4, 5])
        expect(values(result, 1)).toEqual([1000, 1003, 1004, 1005])
    })
    test("splice inserts without removing", () => {
        const source = ramp(3)
        const result = AudioSplice.splice(source, 1, 0, AudioSplice.silence(source, 2))
        expect(values(result)).toEqual([0, 0, 0, 1, 2])
    })
    test("splice inserts at the very start and the very end", () => {
        const source = ramp(3, 1)
        expect(values(AudioSplice.splice(source, 0, 0, AudioSplice.silence(source, 1)))).toEqual([0, 0, 1, 2])
        const insert = AudioData.create(48000, 1, 1)
        insert.frames[0][0] = 7
        expect(values(AudioSplice.splice(source, 3, 0, insert))).toEqual([0, 1, 2, 7])
    })
    test("splice replaces a range with a longer one", () => {
        const source = ramp(4, 1)
        const insert = AudioData.create(48000, 3, 1)
        insert.frames[0].fill(9)
        expect(values(AudioSplice.splice(source, 1, 1, insert))).toEqual([0, 9, 9, 9, 2, 3])
    })
    test("splice of the whole audio returns the insert, even with another channel count", () => {
        const source = ramp(4, 2)
        const mono = ramp(2, 1)
        expect(AudioSplice.splice(source, 0, 4, mono)).toBe(mono)
    })
    test("splice rejects a partial range with another channel count", () => {
        expect(() => AudioSplice.splice(ramp(4, 2), 1, 1, ramp(1, 1))).toThrow()
    })
    test("splice rejects another sample rate", () => {
        expect(() => AudioSplice.splice(ramp(4, 1, 48000), 1, 1, ramp(1, 1, 44100))).toThrow()
    })
    test("splice rejects a range beyond the end", () => {
        const source = ramp(4)
        expect(() => AudioSplice.splice(source, 3, 2, AudioSplice.empty(source))).toThrow()
    })
    test("splice and its inverse restore the original", () => {
        const source = ramp(8)
        const removed = AudioSplice.slice(source, 2, 5)
        const insert = AudioSplice.silence(source, 1)
        const edited = AudioSplice.splice(source, 2, 3, insert)
        const restored = AudioSplice.splice(edited, 2, 1, removed)
        expect(values(restored)).toEqual(values(source))
        expect(values(restored, 1)).toEqual(values(source, 1))
    })
    test("matchChannels duplicates mono", () => {
        const stereo = AudioSplice.matchChannels(ramp(3, 1), 2)
        expect(stereo.numberOfChannels).toBe(2)
        expect(values(stereo, 1)).toEqual([0, 1, 2])
    })
    test("matchChannels averages to mono", () => {
        const mono = AudioSplice.matchChannels(ramp(2, 2), 1)
        expect(values(mono)).toEqual([500, 501])
    })
    test("matchChannels returns the same audio for equal counts", () => {
        const source = ramp(2)
        expect(AudioSplice.matchChannels(source, 2)).toBe(source)
    })
})
