import {describe, expect, test} from "vitest"
import {AudioData} from "../audio-data"
import {SampleEffect} from "./sample-effect"
import {SampleEffects} from "./sample-effects"
import {Amplify} from "./amplify"
import {Normalize} from "./normalize"
import {FadeIn} from "./fade-in"
import {FadeOut} from "./fade-out"
import {Reverse} from "./reverse"
import {ConvertToMono} from "./convert-to-mono"
import {LowPass} from "./low-pass"
import {HighPass} from "./high-pass"
import {Echo} from "./echo"
import {Reverb} from "./reverb"
import {Distortion} from "./distortion"

const SampleRate = 48000

const create = (channels: ReadonlyArray<ReadonlyArray<number>>): AudioData => {
    const audio = AudioData.create(SampleRate, channels[0].length, channels.length)
    channels.forEach((channel, index) => audio.frames[index].set(channel))
    return audio
}

const sine = (frequency: number, numberOfFrames: number, numberOfChannels: number = 1): AudioData => {
    const audio = AudioData.create(SampleRate, numberOfFrames, numberOfChannels)
    audio.frames.forEach(channel => {
        for (let index = 0; index < numberOfFrames; index++) {
            channel[index] = Math.sin(2.0 * Math.PI * frequency * index / SampleRate)
        }
    })
    return audio
}

const impulse = (numberOfFrames: number): AudioData => {
    const audio = AudioData.create(SampleRate, numberOfFrames, 1)
    audio.frames[0][0] = 1.0
    return audio
}

const peakOf = (channel: Float32Array, from: number = 0): number => {
    let peak = 0.0
    for (let index = from; index < channel.length; index++) {peak = Math.max(peak, Math.abs(channel[index]))}
    return peak
}

const run = (effect: SampleEffect, source: AudioData, values?: ReadonlyArray<number>): AudioData =>
    effect.process(source, values ?? SampleEffect.defaultsOf(effect), () => {})

describe("SampleEffects", () => {
    test("ids are unique", () => {
        const ids = SampleEffects.All.map(({id}) => id)
        expect(new Set(ids).size).toBe(ids.length)
    })
    test("byId finds every effect and nothing else", () => {
        SampleEffects.All.forEach(effect => expect(SampleEffects.byId(effect.id).unwrap()).toBe(effect))
        expect(SampleEffects.byId("unknown").isEmpty()).toBe(true)
    })
    test("defaults lie within their range", () => {
        SampleEffects.All.forEach(({parameters}) => parameters.forEach(({min, max, defaultValue}) => {
            expect(defaultValue).toBeGreaterThanOrEqual(min)
            expect(defaultValue).toBeLessThanOrEqual(max)
        }))
    })
    test("every effect leaves the source untouched", () => {
        SampleEffects.All.forEach(effect => {
            const source = sine(440, 512, 2)
            const copy = source.frames.map(channel => channel.slice())
            run(effect, source)
            source.frames.forEach((channel, index) => expect(channel).toEqual(copy[index]))
        })
    })
    test("every effect keeps length, rate and (except mono) channels", () => {
        SampleEffects.All.forEach(effect => {
            const result = run(effect, sine(440, 777, 2))
            expect(result.numberOfFrames).toBe(777)
            expect(result.sampleRate).toBe(SampleRate)
            expect(result.numberOfChannels).toBe(effect === ConvertToMono ? 1 : 2)
        })
    })
    test("every effect handles zero frames", () => {
        SampleEffects.All.forEach(effect => expect(run(effect, AudioData.create(SampleRate, 0, 2)).numberOfFrames).toBe(0))
    })
    test("every effect handles a single frame", () => {
        SampleEffects.All.forEach(effect => {
            const result = run(effect, create([[0.5], [0.5]]))
            expect(result.numberOfFrames).toBe(1)
            result.frames.forEach(channel => expect(Number.isFinite(channel[0])).toBe(true))
        })
    })
    test("every effect stays finite at its parameter extremes", () => {
        SampleEffects.All.forEach(effect => {
            const extremes = [effect.parameters.map(({min}) => min), effect.parameters.map(({max}) => max)]
            extremes.forEach(values => run(effect, sine(1000, 4096, 2), values).frames
                .forEach(channel => channel.forEach(value => expect(Number.isFinite(value)).toBe(true))))
        })
    })
    test("progress ends at one", () => {
        SampleEffects.All.forEach(effect => {
            const reports: Array<number> = []
            effect.process(sine(440, 64, 2), SampleEffect.defaultsOf(effect), value => reports.push(value))
            expect(reports.at(-1)).toBe(1)
        })
    })
})

describe("Amplify", () => {
    test("0 dB is identity", () => {
        expect(Array.from(run(Amplify, create([[0.5, -0.25]]), [0]).frames[0])).toEqual([0.5, -0.25])
    })
    test("+6 dB roughly doubles", () => {
        expect(run(Amplify, create([[0.25]]), [6]).frames[0][0]).toBeCloseTo(0.4988, 3)
    })
    test("-48 dB attenuates", () => {
        expect(run(Amplify, create([[1.0]]), [-48]).frames[0][0]).toBeCloseTo(0.00398, 4)
    })
})

describe("Normalize", () => {
    test("scales the peak to the target", () => {
        const result = run(Normalize, create([[0.1, -0.2], [0.05, 0.0]]), [0])
        expect(peakOf(result.frames[0])).toBeCloseTo(1.0, 6)
        expect(result.frames[1][0]).toBeCloseTo(0.25, 6)
    })
    test("keeps silence silent", () => {
        expect(Array.from(run(Normalize, create([[0, 0, 0]]), [-1]).frames[0])).toEqual([0, 0, 0])
    })
    test("uses one gain for all channels", () => {
        const result = run(Normalize, create([[0.5], [0.25]]), [0])
        expect(result.frames[0][0]).toBeCloseTo(1.0, 6)
        expect(result.frames[1][0]).toBeCloseTo(0.5, 6)
    })
})

describe("Fades", () => {
    test("fade in starts at zero and ends at full level", () => {
        const result = run(FadeIn, create([[1, 1, 1, 1, 1]]))
        expect(Array.from(result.frames[0])).toEqual([0, 0.25, 0.5, 0.75, 1])
    })
    test("fade out starts at full level and ends at zero", () => {
        const result = run(FadeOut, create([[1, 1, 1, 1, 1]]))
        expect(Array.from(result.frames[0])).toEqual([1, 0.75, 0.5, 0.25, 0])
    })
    test("two frame fades", () => {
        expect(Array.from(run(FadeIn, create([[1, 1]])).frames[0])).toEqual([0, 1])
        expect(Array.from(run(FadeOut, create([[1, 1]])).frames[0])).toEqual([1, 0])
    })
})

describe("Reverse", () => {
    test("reverses each channel", () => {
        const result = run(Reverse, create([[1, 2, 3], [4, 5, 6]]))
        expect(Array.from(result.frames[0])).toEqual([3, 2, 1])
        expect(Array.from(result.frames[1])).toEqual([6, 5, 4])
    })
    test("reversing twice restores", () => {
        const source = sine(100, 99, 2)
        expect(run(Reverse, run(Reverse, source)).frames[1]).toEqual(source.frames[1])
    })
})

describe("Convert to Mono", () => {
    test("averages the channels", () => {
        expect(Array.from(run(ConvertToMono, create([[1, 0.5], [0, 0.5]])).frames[0])).toEqual([0.5, 0.5])
    })
    test("is a whole sample effect that needs more than one channel", () => {
        expect(ConvertToMono.wholeSample).toBe(true)
        expect(ConvertToMono.accepts(create([[0]]))).toBe(false)
        expect(ConvertToMono.accepts(create([[0], [0]]))).toBe(true)
    })
    test("all other effects accept mono", () => {
        SampleEffects.All.filter(effect => effect !== ConvertToMono)
            .forEach(effect => expect(effect.accepts(create([[0]]))).toBe(true))
    })
})

describe("Filters", () => {
    test("low pass passes low and damps high frequencies", () => {
        expect(peakOf(run(LowPass, sine(100, 9600), [1000]).frames[0], 4800)).toBeGreaterThan(0.95)
        expect(peakOf(run(LowPass, sine(10000, 9600), [1000]).frames[0], 4800)).toBeLessThan(0.02)
    })
    test("high pass passes high and damps low frequencies", () => {
        expect(peakOf(run(HighPass, sine(10000, 9600), [200]).frames[0], 4800)).toBeGreaterThan(0.95)
        expect(peakOf(run(HighPass, sine(20, 48000), [2000]).frames[0], 24000)).toBeLessThan(0.01)
    })
    test("channels are filtered independently", () => {
        const source = create([[1, 0, 0, 0], [0, 0, 0, 0]])
        const result = run(LowPass, source, [1000])
        expect(Array.from(result.frames[1])).toEqual([0, 0, 0, 0])
    })
})

describe("Echo", () => {
    test("repeats an impulse after the delay with feedback", () => {
        const delayFrames = SampleRate / 100
        const result = run(Echo, impulse(delayFrames * 3 + 1), [10, 50, 100]).frames[0]
        expect(result[0]).toBe(0)
        expect(result[delayFrames]).toBeCloseTo(1.0, 6)
        expect(result[delayFrames * 2]).toBeCloseTo(0.5, 6)
        expect(result[delayFrames * 3]).toBeCloseTo(0.25, 6)
    })
    test("mix 0 is dry", () => {
        const source = sine(440, 4800)
        expect(run(Echo, source, [250, 40, 0]).frames[0]).toEqual(source.frames[0])
    })
})

describe("Reverb", () => {
    test("mix 0 is dry", () => {
        const source = sine(440, 4800)
        expect(run(Reverb, source, [70, 40, 0]).frames[0]).toEqual(source.frames[0])
    })
    test("an impulse produces a tail", () => {
        const result = run(Reverb, impulse(SampleRate), [70, 40, 100]).frames[0]
        expect(peakOf(result, SampleRate / 2)).toBeGreaterThan(0.0)
    })
    test("channels get different tails", () => {
        const source = create([Array.from(impulse(SampleRate).frames[0]), Array.from(impulse(SampleRate).frames[0])])
        const result = run(Reverb, source, [70, 40, 100])
        expect(result.frames[0]).not.toEqual(result.frames[1])
    })
})

describe("Distortion", () => {
    test("keeps full scale at full scale", () => {
        expect(run(Distortion, create([[1, -1]]), [24, 100]).frames[0][0]).toBeCloseTo(1.0, 6)
        expect(run(Distortion, create([[1, -1]]), [24, 100]).frames[0][1]).toBeCloseTo(-1.0, 6)
    })
    test("raises quiet signals", () => {
        expect(run(Distortion, create([[0.1]]), [24, 100]).frames[0][0]).toBeGreaterThan(0.5)
    })
    test("mix 0 is dry", () => {
        expect(run(Distortion, create([[0.3]]), [24, 0]).frames[0][0]).toBeCloseTo(0.3, 6)
    })
})
