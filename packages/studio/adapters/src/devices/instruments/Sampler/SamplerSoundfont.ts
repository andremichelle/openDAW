import {clamp, int, isDefined, Optional} from "@opendaw/lib-std"
import type {Sample as SoundfontSample, SoundFont2} from "soundfont2"
import {SamplerImport} from "./SamplerImport"

// One preset of a soundfont as a Sampler instrument. Envelopes and the filter are per zone in a soundfont and
// per instrument in the Sampler: the first zone's are taken.
export namespace SamplerSoundfont {
    export type Result = { readonly instrument: SamplerImport.Instrument, readonly samples: ReadonlyArray<SamplerImport.Sample> }
    type Generators = Record<number, Optional<{ value?: number, range?: { lo: number, hi: number } }>>

    // the generator numbers of the SF2 specification
    const StartOffset = 0, EndOffset = 1, LoopStartOffset = 2, LoopEndOffset = 3, StartCoarse = 4, FilterCutoff = 8,
        FilterQ = 9, EndCoarse = 12, Pan = 17, VolDelay = 33, VolAttack = 34, VolHold = 35, VolDecay = 36,
        VolSustain = 37, VolRelease = 38, KeyRange = 43, VelRange = 44, LoopStartCoarse = 45, Attenuation = 48,
        LoopEndCoarse = 50, CoarseTune = 51, FineTune = 52, SampleModes = 54, ScaleTuning = 56, ExclusiveClass = 57,
        RootKey = 58
    const TypeRight = 2, TypeLeft = 4
    const Coarse = 32768
    const TimecentsOff = -12000
    const OpenFilter = 13000 // cents, above it the filter is not worth having
    // real instruments are far quieter with the attenuation taken at face value, players scale it like this
    const AttenuationScale = 0.04

    export const presetNames = (soundfont: SoundFont2): ReadonlyArray<string> =>
        soundfont.presets.map(({header: {name, bank, preset}}) => `${String(bank).padStart(3, "0")}:${String(preset).padStart(3, "0")} ${name}`)

    const valueOf = (generators: Generators, type: int): Optional<number> => generators[type]?.value
    const rangeOf = (generators: Generators, type: int): { lo: number, hi: number } => generators[type]?.range ?? {lo: 0, hi: 127}
    const seconds = (timecents: number): number => timecents <= TimecentsOff ? 0.0 : Math.pow(2.0, timecents / 1200.0)

    export const convert = (soundfont: SoundFont2, presetIndex: int): Result => {
        const preset = soundfont.presets[presetIndex]
        const samples: Array<SamplerImport.Sample> = []
        const sampleIndices = new Map<string, int>()
        const groups: Array<SamplerImport.Group> = []
        const zones: Array<SamplerImport.Zone> = []
        let envelope: Optional<SamplerImport.Envelope> = undefined
        let filter: Optional<SamplerImport.Filter> = undefined
        const groupFor = (choke: int): int => {
            const existing = groups.findIndex(group => group.choke === choke)
            if (existing >= 0) {return existing}
            groups.push({label: choke === 0 ? "Group 1" : `Choke ${choke}`, roundRobin: 0, choke, trigger: 0})
            return groups.length - 1
        }
        const intern = (key: string, create: () => SamplerImport.Sample): int => {
            const known = sampleIndices.get(key)
            if (isDefined(known)) {return known}
            samples.push(create())
            sampleIndices.set(key, samples.length - 1)
            return samples.length - 1
        }
        if (!isDefined(preset)) {return {instrument: {name: "", groups, zones, envelope, filter}, samples}}
        preset.zones.forEach(presetZone => {
            const presetGenerators = presetZone.generators as Generators
            const instrumentZones = presetZone.instrument.zones
            const paired = new Set<int>()
            instrumentZones.forEach((zone, zoneIndex) => {
                if (paired.has(zoneIndex)) {return}
                const generators = zone.generators as Generators
                // a preset generator is an offset on top of the instrument's
                const sum = (type: int, fallback: number): number =>
                    (valueOf(generators, type) ?? fallback) + (valueOf(presetGenerators, type) ?? 0)
                const own = (type: int, fallback: number): number => valueOf(generators, type) ?? fallback
                const keys = rangeOf(generators, KeyRange), presetKeys = rangeOf(presetGenerators, KeyRange)
                const velocities = rangeOf(generators, VelRange), presetVelocities = rangeOf(presetGenerators, VelRange)
                const keyLow = Math.max(keys.lo, presetKeys.lo), keyHigh = Math.min(keys.hi, presetKeys.hi)
                const velocityLow = Math.max(velocities.lo, presetVelocities.lo, 1)
                const velocityHigh = Math.min(velocities.hi, presetVelocities.hi)
                const sample: Optional<SoundfontSample> = zone.sample
                if (keyLow > keyHigh || velocityLow > velocityHigh || !isDefined(sample) || sample.data.length === 0) {return}
                const {header} = sample
                // the other side of a stereo pair is a zone of its own on the same keys and velocities
                const partnerIndex = header.type === TypeLeft || header.type === TypeRight
                    ? instrumentZones.findIndex((other, otherIndex) => {
                        if (otherIndex === zoneIndex || paired.has(otherIndex) || !isDefined(other.sample)) {return false}
                        const otherGenerators = other.generators as Generators
                        const otherKeys = rangeOf(otherGenerators, KeyRange), otherVelocities = rangeOf(otherGenerators, VelRange)
                        return soundfont.samples[header.link] === other.sample && other.sample !== sample
                            && other.sample.data.length === sample.data.length
                            && other.sample.header.type !== header.type
                            && otherKeys.lo === keys.lo && otherKeys.hi === keys.hi
                            && otherVelocities.lo === velocities.lo && otherVelocities.hi === velocities.hi
                    }) : -1
                const partner = partnerIndex >= 0 ? instrumentZones[partnerIndex].sample : undefined
                if (partnerIndex >= 0) {paired.add(partnerIndex)}
                const sampleIndex = isDefined(partner)
                    ? intern(`${soundfont.samples.indexOf(sample)}+${soundfont.samples.indexOf(partner)}`, () => ({
                        name: header.name.replace(/[\s_-]*[LR]$/i, "").trim() || header.name,
                        sampleRate: header.sampleRate,
                        channels: header.type === TypeLeft ? [sample.data, partner.data] : [partner.data, sample.data]
                    }))
                    : intern(String(soundfont.samples.indexOf(sample)),
                        () => ({name: header.name, sampleRate: header.sampleRate, channels: [sample.data]}))
                const frames = sample.data.length
                const cents = sum(CoarseTune, 0) * 100 + sum(FineTune, 0) + header.pitchCorrection
                const transpose = clamp(Math.round(cents / 100), -24, 24)
                const rootKey = own(RootKey, -1)
                const modes = own(SampleModes, 0)
                const sampleStart = clamp(own(StartOffset, 0) + own(StartCoarse, 0) * Coarse, 0, frames)
                const sampleEnd = clamp(frames + own(EndOffset, 0) + own(EndCoarse, 0) * Coarse, sampleStart, frames)
                const loopStart = clamp(header.startLoop + own(LoopStartOffset, 0) + own(LoopStartCoarse, 0) * Coarse, 0, frames)
                const loopEnd = clamp(header.endLoop + own(LoopEndOffset, 0) + own(LoopEndCoarse, 0) * Coarse, loopStart, frames)
                zones.push({
                    sample: sampleIndex,
                    group: groupFor(clamp(own(ExclusiveClass, 0), 0, 127)),
                    keyLow, keyHigh, velocityLow, velocityHigh,
                    rootKey: rootKey >= 0 && rootKey <= 127 ? rootKey : header.originalPitch <= 127 ? header.originalPitch : 60,
                    transpose,
                    tune: cents - transpose * 100,
                    keyTrack: clamp(sum(ScaleTuning, 100) / 100.0, 0.0, 1.0),
                    gain: 0.0 - Math.max(0.0, sum(Attenuation, 0)) * AttenuationScale,
                    panning: isDefined(partner) ? 0.0 : clamp(sum(Pan, 0) / 500.0, -1.0, 1.0),
                    sequence: 1,
                    reverse: false,
                    oneShot: false,
                    sampleStart, sampleEnd,
                    loopMode: modes === 1 ? 2 : modes === 3 ? 1 : 0,
                    loopStart, loopEnd
                })
                if (!isDefined(envelope)) {
                    envelope = {
                        delay: seconds(sum(VolDelay, TimecentsOff)),
                        attack: seconds(sum(VolAttack, TimecentsOff)),
                        hold: seconds(sum(VolHold, TimecentsOff)),
                        decay: seconds(sum(VolDecay, TimecentsOff)),
                        sustain: Math.pow(10.0, -clamp(sum(VolSustain, 0), 0, 1440) / 200.0),
                        release: seconds(sum(VolRelease, TimecentsOff))
                    }
                    const cutoffCents = sum(FilterCutoff, 13500)
                    if (cutoffCents < OpenFilter) {
                        filter = {
                            cutoff: 8.176 * Math.pow(2.0, cutoffCents / 1200.0),
                            resonance: clamp(sum(FilterQ, 0) / 960.0, 0.0, 1.0)
                        }
                    }
                }
            })
        })
        return {instrument: {name: preset.header.name.trim(), groups, zones, envelope, filter}, samples}
    }
}
