import {clamp, int, isDefined, Optional} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioFileBox, SamplerDeviceBox, SamplerGroupBox} from "@opendaw/studio-boxes"
import {SamplerZones} from "./SamplerZones"

// An instrument as an import reads it (soundfont preset, SFZ file), before it becomes boxes.
export namespace SamplerImport {
    // 16 bit frames as soundfonts store them, one array per channel
    export type Sample = {
        readonly name: string
        readonly sampleRate: number
        readonly channels: ReadonlyArray<Int16Array>
    }
    export type Group = {
        readonly label: string
        readonly roundRobin: int
        readonly choke: int
        readonly trigger: int
    }
    export type Zone = {
        readonly sample: int // index into the samples of the instrument
        readonly group: int // index into the groups of the instrument
        readonly keyLow: int
        readonly keyHigh: int
        readonly velocityLow: int
        readonly velocityHigh: int
        readonly rootKey: int
        readonly transpose: int
        readonly tune: number
        readonly keyTrack: number
        readonly gain: number
        readonly panning: number
        readonly sequence: int
        readonly reverse: boolean
        readonly oneShot: boolean
        readonly sampleStart: int
        readonly sampleEnd: Optional<int> // frames, the whole sample when absent
        readonly loopMode: int
        readonly loopStart: int
        readonly loopEnd: Optional<int>
    }
    export type Envelope = {
        readonly delay: number
        readonly attack: number
        readonly hold: number
        readonly decay: number
        readonly sustain: number
        readonly release: number
    }
    export type Filter = { readonly cutoff: number, readonly resonance: number }
    export type Instrument = {
        readonly name: string
        readonly groups: ReadonlyArray<Group>
        readonly zones: ReadonlyArray<Zone>
        readonly envelope: Optional<Envelope>
        readonly filter: Optional<Filter>
    }

    export const DefaultGroup: Group = {label: "Group 1", roundRobin: 0, choke: 0, trigger: 0}
    const MaxFrame: int = 0x7FFFFFFF
    const FilterLowPass12: int = 1

    // Replaces the zones and groups of the device with the instrument. `files` holds the sample of each zone's
    // `sample` index, a zone whose sample is missing is left out.
    export const apply = (boxGraph: BoxGraph, device: SamplerDeviceBox, instrument: Instrument,
                          files: ReadonlyArray<Optional<AudioFileBox>>): int => {
        // the old zones go last: a sample they share with the new ones must never be without a zone
        const oldZones = SamplerZones.zonesOf(device)
        const oldGroups = device.groups.pointerHub.incoming().map(({box}) => box)
        const described = instrument.groups.length > 0 ? instrument.groups : [DefaultGroup]
        const groups: ReadonlyArray<SamplerGroupBox> = described.map(({label, roundRobin, choke, trigger}) => {
            const group = SamplerZones.createGroup(boxGraph, device, label)
            group.roundRobin.setValue(clamp(roundRobin, 0, 2))
            group.choke.setValue(clamp(choke, 0, 127))
            group.trigger.setValue(clamp(trigger, 0, 1))
            return group
        })
        let created = 0
        instrument.zones.forEach(zone => {
            const file = files[zone.sample]
            if (!isDefined(file)) {return}
            const box = SamplerZones.create(boxGraph, device, groups[clamp(zone.group, 0, groups.length - 1)], file)
            const keyLow = clamp(zone.keyLow, 0, 127)
            const velocityLow = clamp(zone.velocityLow, 1, 127)
            box.keyLow.setValue(keyLow)
            box.keyHigh.setValue(clamp(zone.keyHigh, keyLow, 127))
            box.velocityLow.setValue(velocityLow)
            box.velocityHigh.setValue(clamp(zone.velocityHigh, velocityLow, 127))
            box.rootKey.setValue(clamp(zone.rootKey, 0, 127))
            box.transpose.setValue(clamp(zone.transpose, -24, 24))
            box.tune.setValue(clamp(zone.tune, -100.0, 100.0))
            box.keyTrack.setValue(clamp(zone.keyTrack, 0.0, 1.0))
            box.gain.setValue(clamp(zone.gain, -72.0, 12.0))
            box.panning.setValue(clamp(zone.panning, -1.0, 1.0))
            box.sequence.setValue(clamp(zone.sequence, 1, 128))
            box.reverse.setValue(zone.reverse)
            box.oneShot.setValue(zone.oneShot)
            box.sampleStart.setValue(clamp(zone.sampleStart, 0, MaxFrame))
            box.sampleEnd.setValue(clamp(zone.sampleEnd ?? MaxFrame, 0, MaxFrame))
            box.loopMode.setValue(clamp(zone.loopMode, 0, 2))
            box.loopStart.setValue(clamp(zone.loopStart, 0, MaxFrame))
            box.loopEnd.setValue(clamp(zone.loopEnd ?? MaxFrame, 0, MaxFrame))
            created++
        })
        SamplerZones.remove(oldZones)
        oldGroups.forEach(box => box.delete())
        if (instrument.name.length > 0) {device.label.setValue(instrument.name)}
        const envelope = instrument.envelope
        if (isDefined(envelope)) {
            const target = device.ampEnvelope
            target.delay.setValue(clamp(envelope.delay, 0.0, 5.0))
            target.attack.setValue(clamp(envelope.attack, 0.001, 8.0))
            target.hold.setValue(clamp(envelope.hold, 0.0, 5.0))
            target.decay.setValue(clamp(envelope.decay, 0.001, 8.0))
            target.sustain.setValue(clamp(envelope.sustain, 0.0, 1.0))
            target.release.setValue(clamp(envelope.release, 0.001, 8.0))
        }
        const filter = instrument.filter
        if (isDefined(filter)) {
            device.filterType.setValue(FilterLowPass12)
            device.cutoff.setValue(clamp(filter.cutoff, 20.0, 20_000.0))
            device.resonance.setValue(clamp(filter.resonance, 0.0, 1.0))
        }
        return created
    }

    // A 16 bit WAV file of the sample, frame for frame what the soundfont holds
    export const encodeWav = ({sampleRate, channels}: Sample): ArrayBuffer => {
        const numberOfChannels = channels.length
        const numberOfFrames = channels.reduce((shortest, channel) => Math.min(shortest, channel.length), channels[0]?.length ?? 0)
        const dataBytes = numberOfFrames * numberOfChannels * 2
        const buffer = new ArrayBuffer(44 + dataBytes)
        const view = new DataView(buffer)
        const ascii = (offset: int, text: string): void =>
            Array.from(text).forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
        ascii(0, "RIFF")
        view.setUint32(4, 36 + dataBytes, true)
        ascii(8, "WAVE")
        ascii(12, "fmt ")
        view.setUint32(16, 16, true)
        view.setUint16(20, 1, true)
        view.setUint16(22, numberOfChannels, true)
        view.setUint32(24, sampleRate, true)
        view.setUint32(28, sampleRate * numberOfChannels * 2, true)
        view.setUint16(32, numberOfChannels * 2, true)
        view.setUint16(34, 16, true)
        ascii(36, "data")
        view.setUint32(40, dataBytes, true)
        for (let frame = 0; frame < numberOfFrames; frame++) {
            for (let channel = 0; channel < numberOfChannels; channel++) {
                view.setInt16(44 + (frame * numberOfChannels + channel) * 2, channels[channel][frame], true)
            }
        }
        return buffer
    }
}
