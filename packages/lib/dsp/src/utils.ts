import {unitValue} from "@opendaw/lib-std"

const LogDb = Math.log(10.0) / 20.0

export const midiToHz = (note: number = 60.0, baseFrequency: number = 440.0): number =>
    baseFrequency * Math.pow(2.0, (note + 3.0) / 12.0 - 6.0)
export const hzToMidi = (hz: number, baseFrequency: number = 440.0): number =>
    (12.0 * Math.log(hz / baseFrequency) + 69.0 * Math.LN2) / Math.LN2
export const dbToGain = (db: number): number => Math.exp(db * LogDb)
export const gainToDb = (gain: number): number => Math.log(gain) / LogDb
export const velocityToGain = (velocity: unitValue): number => dbToGain(20 * Math.log10(velocity))
export const barsToBpm = (bars: number, duration: number): number => (bars * 240.0) / duration
export const bpmToBars = (bpm: number, duration: number): number => (bpm * duration) / 240.0
export const estimateBpm = (duration: number, maxBpm: number = 180.0): number => {
    const bpm = barsToBpm(Math.pow(2.0, Math.floor(Math.log(bpmToBars(maxBpm, duration)) / Math.LN2)), duration)
    return Math.round(bpm * 1000.0) / 1000.0
}
export const semitoneToHz = (semitones: number, baseFrequency: number = 440.0) =>
    baseFrequency * Math.pow(2.0, (semitones - 69.0) / 12.0)
export const hzToSemitone = (hz: number, baseFrequency: number = 440.0) =>
    69.0 + 12.0 * Math.log2(hz / baseFrequency)