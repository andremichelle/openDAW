import {int, isDefined, Optional} from "@opendaw/lib-std"
import type {BasicSample, BasicSoundBank, BasicZone} from "spessasynth_core"

// The only view of a soundfont (SF2, SF3, DLS) openDAW reads, built from a spessasynth_core bank.
export namespace SoundfontBank {
    export type Range = { readonly lo: int, readonly hi: int }
    export type Generators = Readonly<Record<number, { readonly value?: number, readonly range?: Range }>>
    export type SampleHeader = {
        readonly name: string
        readonly sampleRate: number
        readonly startLoop: int
        readonly endLoop: int
        readonly originalPitch: int
        readonly pitchCorrection: int
        readonly type: int
        readonly link: int
    }
    // plain data: a bank crosses to the audio worklet by structured clone
    export type Sample = { readonly header: SampleHeader, readonly data: Int16Array }
    export type InstrumentZone = { readonly generators: Generators, readonly sample: Sample }
    export type Instrument = { readonly name: string, readonly zones: ReadonlyArray<InstrumentZone> }
    export type PresetZone = { readonly generators: Generators, readonly instrument: Instrument }
    export type PresetHeader = { readonly name: string, readonly bank: int, readonly preset: int }
    export type Preset = { readonly header: PresetHeader, readonly zones: ReadonlyArray<PresetZone> }
    export type MetaData = { readonly name: string, readonly copyright: Optional<string> }
    export type Bank = {
        readonly metaData: MetaData
        readonly presets: ReadonlyArray<Preset>
        readonly samples: ReadonlyArray<Sample>
    }

    const KeyRange = 43
    const VelRange = 44

    const generatorsOf = (zone: BasicZone): Generators => {
        const record: Record<number, { value?: number, range?: Range }> = {}
        zone.generators.forEach(({type, value}) => record[type] = {value})
        if (zone.keyRange.min !== -1) {record[KeyRange] = {range: {lo: zone.keyRange.min, hi: zone.keyRange.max}}}
        if (zone.velRange.min !== -1) {record[VelRange] = {range: {lo: zone.velRange.min, hi: zone.velRange.max}}}
        return record
    }

    const sampleFrom = (source: BasicSample, link: int): Sample => {
        const audio = source.getAudioData()
        const data = new Int16Array(audio.length)
        for (let index = 0; index < audio.length; index++) {
            data[index] = Math.max(-32768, Math.min(32767, Math.round(audio[index] * 32768)))
        }
        return {
            header: {
                name: source.name, sampleRate: source.sampleRate, startLoop: source.loopStart, endLoop: source.loopEnd,
                originalPitch: source.originalKey, pitchCorrection: source.pitchCorrection,
                type: source.sampleType, link
            },
            data
        }
    }

    const ascii = (bytes: Uint8Array, from: int, length: int): string => {
        let text = ""
        for (let index = from; index < from + length && bytes[index] !== 0; index++) {text += String.fromCharCode(bytes[index])}
        return text
    }

    // the presets as the SF2 file lists them, spessasynth sorts them by bank and program
    const fileOrder = (bytes: Uint8Array): Optional<ReadonlyArray<PresetHeader>> => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4).toLowerCase() !== "sfbk") {return undefined}
        let position = 12
        while (position + 12 <= bytes.byteLength) {
            const id = ascii(bytes, position, 4)
            const size = view.getUint32(position + 4, true)
            if (id === "LIST" && ascii(bytes, position + 8, 4) === "pdta") {
                let inner = position + 12
                const end = Math.min(position + 8 + size, bytes.byteLength)
                while (inner + 8 <= end) {
                    const innerSize = view.getUint32(inner + 4, true)
                    if (ascii(bytes, inner, 4) === "phdr") {
                        const headers: Array<PresetHeader> = []
                        const count = Math.floor(innerSize / 38) - 1
                        for (let index = 0; index < count; index++) {
                            const at = inner + 8 + index * 38
                            if (at + 38 > end) {break}
                            headers.push({name: ascii(bytes, at, 20), preset: view.getUint16(at + 20, true), bank: view.getUint16(at + 22, true)})
                        }
                        return headers
                    }
                    inner += 8 + innerSize + (innerSize & 1)
                }
                return undefined
            }
            position += 8 + size + (size & 1)
        }
        return undefined
    }

    export const from = (bank: BasicSoundBank, bytes: ArrayBuffer): Bank => {
        const samples = new Map<BasicSample, Sample>()
        const sampleOf = (source: BasicSample): Sample => {
            const existing = samples.get(source)
            if (isDefined(existing)) {return existing}
            const created = sampleFrom(source, isDefined(source.linkedSample) ? Math.max(0, bank.samples.indexOf(source.linkedSample)) : 0)
            samples.set(source, created)
            return created
        }
        const presets = bank.presets.map(preset => ({
            header: {
                name: preset.name, preset: preset.program,
                bank: preset.bankMSB | (preset.isGMGSDrum ? 0x80 : 0) | (preset.bankLSB << 8)
            },
            zones: preset.zones.map(zone => ({
                generators: generatorsOf(zone),
                instrument: {
                    name: zone.instrument.name,
                    zones: zone.instrument.zones.map(instrumentZone => ({
                        generators: generatorsOf(instrumentZone),
                        sample: sampleOf(instrumentZone.sample)
                    }))
                }
            }))
        }))
        const headers = fileOrder(new Uint8Array(bytes))
        const ordered: Array<Preset> = []
        if (isDefined(headers) && headers.length === presets.length) {
            const remaining = presets.slice()
            const take = (match: (header: PresetHeader) => boolean): Optional<Preset> => {
                const index = remaining.findIndex(preset => match(preset.header))
                return index < 0 ? undefined : remaining.splice(index, 1)[0]
            }
            headers.forEach(header => {
                const preset = take(({name, bank, preset}) => name === header.name && bank === header.bank && preset === header.preset)
                    ?? take(({bank, preset}) => bank === header.bank && preset === header.preset)
                if (isDefined(preset)) {ordered.push(preset)}
            })
            ordered.push(...remaining)
        } else {
            ordered.push(...presets)
        }
        const {name, copyright} = bank.soundBankInfo
        return {
            metaData: {name: name ?? "", copyright: isDefined(copyright) && copyright.length > 0 ? copyright : undefined},
            presets: ordered,
            samples: bank.samples.map(sampleOf)
        }
    }
}
