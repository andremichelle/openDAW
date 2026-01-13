// Pulses per quarter note (PPQN)
// 960 = 3*5*2^6

import {int} from "@moises-ai/lib-std"

export type ppqn = number
export type seconds = number
export type samples = number
export type bpm = number

const Quarter = 960 as const
const Bar: ppqn = Quarter << 2 // 3_840
const SemiQuaver: ppqn = Quarter >>> 2 // 240
const fromSignature = (nominator: int, denominator: int) => Math.floor(Bar / denominator) * nominator
const toParts = (ppqn: ppqn, nominator: int = 4, denominator: int = 4) => {
    const lowerPulses = fromSignature(1, denominator)
    const beats = Math.floor(ppqn / lowerPulses)
    const bars = Math.floor(beats / nominator)
    const remainingPulses = Math.floor(ppqn) - fromSignature(bars * nominator, denominator)
    const ticks = remainingPulses % lowerPulses
    const semiquavers = Math.floor(ticks / SemiQuaver)
    const remainingTicks = ticks % SemiQuaver
    return {
        bars,
        beats: beats - bars * nominator,
        semiquavers,
        ticks: remainingTicks
    } as const
}

const secondsToPulses = (seconds: seconds, bpm: bpm): ppqn => seconds * bpm / 60.0 * Quarter
const pulsesToSeconds = (pulses: ppqn, bpm: bpm): seconds => (pulses * 60.0 / Quarter) / bpm
const secondsToBpm = (seconds: seconds, pulses: ppqn): bpm => (pulses * 60.0 / Quarter) / seconds
const samplesToPulses = (samples: samples, bpm: bpm, sampleRate: number): ppqn => secondsToPulses(samples / sampleRate, bpm)
const pulsesToSamples = (pulses: ppqn, bpm: bpm, sampleRate: number): number => pulsesToSeconds(pulses, bpm) * sampleRate

export const PPQN = {
    Bar,
    Quarter,
    SemiQuaver,
    fromSignature,
    toParts,
    secondsToPulses,
    pulsesToSeconds,
    secondsToBpm,
    samplesToPulses,
    pulsesToSamples,
    toString: (pulses: ppqn, nominator: int = 4, denominator: int = 4): string => {
        const {bars, beats, semiquavers, ticks} = toParts(pulses | 0, nominator, denominator)
        return `${bars + 1}.${beats + 1}.${semiquavers + 1}:${ticks}`
    }
} as const