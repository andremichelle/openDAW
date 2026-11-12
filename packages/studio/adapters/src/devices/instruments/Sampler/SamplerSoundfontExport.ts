import {clamp, int, isDefined, Optional} from "@opendaw/lib-std"
import {AudioFileBox, SamplerDeviceBox, SamplerGroupBox} from "@opendaw/studio-boxes"
import {SamplerImport} from "./SamplerImport"
import {SamplerZones} from "./SamplerZones"

// A Sampler as a soundfont (.sf2) with one preset. The reverse of SamplerSoundfont.
export namespace SamplerSoundfontExport {
    export type Description = {
        readonly instrument: SamplerImport.Instrument
        readonly files: ReadonlyArray<AudioFileBox> // the sample of each zone's `sample` index
        readonly skipped: int // zones a soundfont cannot hold: further round robins and release triggers
    }
    export type Quantized = { readonly frames: Int16Array, readonly clipped: int }
    type Generator = readonly [type: int, amount: int]
    type Header = {
        readonly name: string, readonly start: int, readonly frames: int, readonly loopStart: int, readonly loopEnd: int,
        readonly sampleRate: int, readonly rootKey: int, readonly link: int, readonly type: int
    }

    // the generator numbers of the SF2 specification
    const StartOffset = 0, EndOffset = 1, LoopStartOffset = 2, LoopEndOffset = 3, StartCoarse = 4, FilterCutoff = 8,
        FilterQ = 9, EndCoarse = 12, Pan = 17, VolDelay = 33, VolAttack = 34, VolHold = 35, VolDecay = 36,
        VolSustain = 37, VolRelease = 38, Instrument = 41, KeyRange = 43, VelRange = 44, LoopStartCoarse = 45,
        Attenuation = 48, LoopEndCoarse = 50, CoarseTune = 51, FineTune = 52, SampleId = 53, SampleModes = 54,
        ScaleTuning = 56, ExclusiveClass = 57, RootKey = 58
    const TypeMono = 1, TypeRight = 2, TypeLeft = 4
    const Coarse = 32768
    const Padding = 46 // silent frames the specification wants after every sample
    const MaxFrame: int = 0x7FFFFFFF
    const AttenuationScale = 0.04 // as SamplerSoundfont reads it
    const TriggerRelease = 1
    const FilterLowPass12 = 1, FilterLowPass24 = 2

    export const describe = (device: SamplerDeviceBox): Description => {
        const groupBoxes: ReadonlyArray<SamplerGroupBox> = device.groups.pointerHub.incoming()
            .map(({box}) => box as SamplerGroupBox)
            .sort((left, right) => left.index.getValue() - right.index.getValue())
        const groups: Array<SamplerImport.Group> = groupBoxes.map(box => ({
            label: box.label.getValue(), roundRobin: 0, choke: box.choke.getValue(), trigger: 0
        }))
        const files: Array<AudioFileBox> = []
        const zones: Array<SamplerImport.Zone> = []
        let skipped = 0
        const stacks = new Set<string>()
        SamplerZones.zonesOf(device)
            .filter(zone => zone.enabled.getValue())
            .sort((left, right) => left.sequence.getValue() - right.sequence.getValue() || left.index.getValue() - right.index.getValue())
            .forEach(zone => {
                const file = zone.file.targetVertex.unwrapOrNull()?.box
                const groupBox = zone.group.targetVertex.unwrapOrNull()?.box
                const group = groupBoxes.findIndex(box => box === groupBox)
                if (!(file instanceof AudioFileBox) || group < 0) {return}
                const {roundRobin, trigger} = groupBoxes[group]
                // zones of a group on the same range take turns, whatever their sequence says: the first one stays
                const stack = [group, zone.keyLow.getValue(), zone.keyHigh.getValue(), zone.velocityLow.getValue(), zone.velocityHigh.getValue()].join("/")
                const further = roundRobin.getValue() !== 0 && stacks.has(stack)
                stacks.add(stack)
                if (trigger.getValue() === TriggerRelease || further) {
                    skipped++
                    return
                }
                const known = files.indexOf(file)
                const sample = known >= 0 ? known : files.push(file) - 1
                const sampleEnd = zone.sampleEnd.getValue(), loopEnd = zone.loopEnd.getValue()
                zones.push({
                    sample, group,
                    keyLow: zone.keyLow.getValue(), keyHigh: zone.keyHigh.getValue(),
                    velocityLow: zone.velocityLow.getValue(), velocityHigh: zone.velocityHigh.getValue(),
                    rootKey: zone.rootKey.getValue(), transpose: zone.transpose.getValue(), tune: zone.tune.getValue(),
                    keyTrack: zone.keyTrack.getValue(), gain: zone.gain.getValue(), panning: zone.panning.getValue(),
                    sequence: 1, reverse: zone.reverse.getValue(), oneShot: zone.oneShot.getValue(),
                    sampleStart: zone.sampleStart.getValue(), sampleEnd: sampleEnd >= MaxFrame ? undefined : sampleEnd,
                    loopMode: zone.loopMode.getValue(),
                    loopStart: zone.loopStart.getValue(), loopEnd: loopEnd >= MaxFrame ? undefined : loopEnd
                })
            })
        const {ampEnvelope, filterType, cutoff, resonance} = device
        const type = filterType.getValue()
        return {
            instrument: {
                name: device.label.getValue(), groups, zones,
                envelope: {
                    delay: ampEnvelope.delay.getValue(), attack: ampEnvelope.attack.getValue(),
                    hold: ampEnvelope.hold.getValue(), decay: ampEnvelope.decay.getValue(),
                    sustain: ampEnvelope.sustain.getValue(), release: ampEnvelope.release.getValue()
                },
                filter: type === FilterLowPass12 || type === FilterLowPass24
                    ? {cutoff: cutoff.getValue(), resonance: resonance.getValue()} : undefined
            },
            files, skipped
        }
    }

    // 16 bit as soundfonts store samples. `clipped` counts the frames beyond full scale.
    export const quantize = (source: Float32Array): Quantized => {
        const frames = new Int16Array(source.length)
        let clipped = 0
        for (let index = 0; index < source.length; index++) {
            const value = Math.round(source[index] * 32768.0)
            if (value > 32767 || value < -32768) {clipped++}
            frames[index] = clamp(value, -32768, 32767)
        }
        return {frames, clipped}
    }

    // `samples` holds the sample of each zone's `sample` index, a zone whose sample is missing is left out.
    export const encode = (described: SamplerImport.Instrument,
                           sources: ReadonlyArray<Optional<SamplerImport.Sample>>): ArrayBuffer => {
        const {instrument, samples} = forward(described, sources)
        const headers: Array<Header> = []
        const data: Array<Int16Array> = []
        const firstHeader: Array<int> = []
        const zonesOfSample = (index: int) => instrument.zones.filter(zone => zone.sample === index)
        let cursor = 0
        samples.forEach((sample, index) => {
            firstHeader.push(headers.length)
            if (!isDefined(sample) || sample.channels.length === 0) {return}
            const [zone] = zonesOfSample(index)
            const stereo = sample.channels.length > 1
            const frames = stereo ? Math.min(sample.channels[0].length, sample.channels[1].length) : sample.channels[0].length
            const loopStart = clamp(zone?.loopStart ?? 0, 0, frames)
            const loopEnd = clamp(zone?.loopEnd ?? frames, loopStart, frames)
            const first = headers.length
            sample.channels.slice(0, 2).forEach((channel, side) => {
                headers.push({
                    name: stereo ? `${sample.name.slice(0, 17)} ${side === 0 ? "L" : "R"}` : sample.name,
                    start: cursor, frames, loopStart, loopEnd,
                    sampleRate: Math.round(sample.sampleRate),
                    rootKey: clamp(zone?.rootKey ?? 60, 0, 127),
                    link: stereo ? first + 1 - side : 0,
                    type: stereo ? side === 0 ? TypeLeft : TypeRight : TypeMono
                })
                data.push(channel.subarray(0, frames))
                cursor += frames + Padding
            })
        })
        const generators: Array<Generator> = []
        const bags: Array<int> = []
        const word = (value: number): int => Math.round(value) & 0xFFFF
        const range = (low: int, high: int): int => clamp(low, 0, 127) | (clamp(high, 0, 127) << 8)
        const timecents = (seconds: number, max: int): Optional<int> =>
            seconds > 0.0 ? clamp(Math.round(1200.0 * Math.log2(seconds)), -12000, max) : undefined
        const {envelope, filter} = instrument
        instrument.zones.forEach(zone => {
            const sample = samples[zone.sample]
            const first = firstHeader[zone.sample]
            if (!isDefined(sample) || sample.channels.length === 0) {return}
            const stereo = sample.channels.length > 1
            const header = headers[first]
            const choke = instrument.groups[zone.group]?.choke ?? 0
            const sides = stereo ? [0, 1] : [0]
            sides.forEach(side => {
                bags.push(generators.length)
                const add = (type: int, amount: Optional<number>, neutral?: number): void => {
                    if (isDefined(amount) && amount !== neutral) {generators.push([type, word(amount)])}
                }
                const offset = (fine: int, coarse: int, frames: int): void => {
                    const steps = Math.trunc(frames / Coarse)
                    add(fine, frames - steps * Coarse, 0)
                    add(coarse, steps, 0)
                }
                const sampleStart = clamp(zone.sampleStart, 0, header.frames)
                const pan = stereo ? (side === 0 ? -500 : 500) + zone.panning * 500.0 : zone.panning * 500.0
                generators.push([KeyRange, range(zone.keyLow, zone.keyHigh)], [VelRange, range(zone.velocityLow, zone.velocityHigh)])
                offset(StartOffset, StartCoarse, sampleStart)
                offset(EndOffset, EndCoarse, clamp(zone.sampleEnd ?? header.frames, sampleStart, header.frames) - header.frames)
                offset(LoopStartOffset, LoopStartCoarse, clamp(zone.loopStart, 0, header.frames) - header.loopStart)
                offset(LoopEndOffset, LoopEndCoarse, clamp(zone.loopEnd ?? header.frames, 0, header.frames) - header.loopEnd)
                if (isDefined(filter)) {
                    add(FilterCutoff, clamp(1200.0 * Math.log2(filter.cutoff / 8.176), 1500, 13500))
                    add(FilterQ, clamp(filter.resonance * 960.0, 0, 960), 0)
                }
                add(Pan, clamp(pan, -500, 500), 0)
                if (isDefined(envelope)) {
                    add(VolDelay, timecents(envelope.delay, 5000))
                    add(VolAttack, timecents(envelope.attack, 8000))
                    add(VolHold, timecents(envelope.hold, 5000))
                    add(VolDecay, timecents(envelope.decay, 8000))
                    add(VolSustain, clamp(-200.0 * Math.log10(Math.max(envelope.sustain, 1.0e-8)), 0, 1440), 0)
                    add(VolRelease, timecents(envelope.release, 8000))
                }
                add(Attenuation, clamp(-zone.gain / AttenuationScale, 0, 1440), 0)
                add(CoarseTune, clamp(zone.transpose, -120, 120), 0)
                add(FineTune, clamp(zone.tune, -99, 99), 0)
                add(SampleModes, zone.loopMode === 2 ? 1 : zone.loopMode === 1 ? 3 : 0, 0)
                add(ScaleTuning, clamp(zone.keyTrack * 100.0, 0, 1200), 100)
                add(ExclusiveClass, clamp(choke, 0, 127), 0)
                add(RootKey, clamp(zone.rootKey, 0, 127))
                generators.push([SampleId, first + side])
            })
        })
        const name = instrument.name.length > 0 ? instrument.name : "Sampler"
        const sampleBytes = cursor * 2
        const info = 4 + 12 + 16 + 8 + even(name.length + 1)
        const pdta = 4 + 8 * 9 + 76 + 8 + 10 + 8 + 44 + (bags.length + 1) * 4 + 10 + (generators.length + 1) * 4
            + (headers.length + 1) * 46
        const total = 12 + 8 + info + 8 + 4 + 8 + sampleBytes + 8 + pdta
        const buffer = new ArrayBuffer(total)
        const view = new DataView(buffer)
        let position = 0
        const ascii = (text: string, length: int): void => {
            for (let index = 0; index < length; index++) {
                view.setUint8(position + index, index < text.length ? text.charCodeAt(index) & 0x7F : 0)
            }
            position += length
        }
        const u16 = (value: int): void => {
            view.setUint16(position, value, true)
            position += 2
        }
        const u32 = (value: int): void => {
            view.setUint32(position, value, true)
            position += 4
        }
        const chunk = (id: string, size: int): void => {
            ascii(id, 4)
            u32(size)
        }
        const label = (text: string): void => ascii(text.slice(0, 19), 20)
        ascii("RIFF", 4)
        u32(total - 8)
        ascii("sfbk", 4)
        chunk("LIST", info)
        ascii("INFO", 4)
        chunk("ifil", 4)
        u16(2)
        u16(1)
        chunk("isng", 8)
        ascii("EMU8000", 8)
        chunk("INAM", even(name.length + 1))
        ascii(name, even(name.length + 1))
        chunk("LIST", 4 + 8 + sampleBytes)
        ascii("sdta", 4)
        chunk("smpl", sampleBytes)
        data.forEach(channel => {
            new Int16Array(buffer, position, channel.length).set(channel)
            position += (channel.length + Padding) * 2
        })
        chunk("LIST", pdta)
        ascii("pdta", 4)
        chunk("phdr", 76)
        label(name)
        position += 18
        label("EOP")
        u16(0)
        u16(0)
        u16(1)
        position += 12
        chunk("pbag", 8)
        u32(0)
        u16(1)
        u16(0)
        chunk("pmod", 10)
        position += 10
        chunk("pgen", 8)
        u16(Instrument)
        u16(0)
        u32(0)
        chunk("inst", 44)
        label(name)
        u16(0)
        label("EOI")
        u16(bags.length)
        chunk("ibag", (bags.length + 1) * 4)
        bags.concat(generators.length).forEach(index => {
            u16(index)
            u16(0)
        })
        chunk("imod", 10)
        position += 10
        chunk("igen", (generators.length + 1) * 4)
        generators.forEach(([type, amount]) => {
            u16(type)
            u16(amount)
        })
        u32(0)
        chunk("shdr", (headers.length + 1) * 46)
        headers.forEach(header => {
            label(header.name)
            u32(header.start)
            u32(header.start + header.frames)
            u32(header.start + header.loopStart)
            u32(header.start + header.loopEnd)
            u32(header.sampleRate)
            view.setUint8(position++, header.rootKey)
            view.setInt8(position++, 0)
            u16(header.link)
            u16(header.type)
        })
        label("EOS")
        return buffer
    }

    // A soundfont only plays forward: a reversed zone gets a reversed copy of its sample, its points mirrored.
    const forward = (instrument: SamplerImport.Instrument, sources: ReadonlyArray<Optional<SamplerImport.Sample>>) => {
        const samples: Array<Optional<SamplerImport.Sample>> = sources.slice()
        const copies = new Map<int, int>()
        const zones = instrument.zones.map(zone => {
            const sample = sources[zone.sample]
            if (!zone.reverse || !isDefined(sample) || sample.channels.length === 0) {return zone}
            const frames = sample.channels.reduce((shortest, channel) => Math.min(shortest, channel.length), sample.channels[0].length)
            const mirror = (position: Optional<int>, open: int): int => frames - clamp(position ?? open, 0, frames)
            const copy = copies.get(zone.sample) ?? samples.push({
                name: `${sample.name.slice(0, 15)} rev`,
                sampleRate: sample.sampleRate,
                channels: sample.channels.map(channel => channel.slice(0, frames).reverse())
            }) - 1
            copies.set(zone.sample, copy)
            return {
                ...zone, sample: copy, reverse: false,
                sampleStart: mirror(zone.sampleEnd, frames), sampleEnd: mirror(zone.sampleStart, 0),
                loopStart: mirror(zone.loopEnd, frames), loopEnd: mirror(zone.loopStart, 0)
            }
        })
        return {instrument: {...instrument, zones}, samples}
    }

    const even = (length: int): int => length + (length & 1)
}
