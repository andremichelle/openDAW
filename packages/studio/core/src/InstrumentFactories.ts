import {
    AudioFileBox,
    BoxIO,
    MIDIOutputDeviceBox,
    NanoDeviceBox,
    PlayfieldDeviceBox,
    PlayfieldSampleBox,
    SoundfontDeviceBox,
    SoundfontFileBox,
    TapeDeviceBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {byte, isDefined, UUID} from "@opendaw/lib-std"
import {Waveform} from "@opendaw/lib-dsp"
import {BoxGraph, Field} from "@opendaw/lib-box"
import {IconSymbol, TrackType} from "@opendaw/studio-adapters"

import {InstrumentFactory} from "./InstrumentFactory"
import {Pointers} from "@opendaw/studio-enums"

export namespace InstrumentFactories {
    export const Tape: InstrumentFactory<void, TapeDeviceBox> = {
        defaultName: "Tape",
        defaultIcon: IconSymbol.Tape,
        description: "Plays audio regions & clips",
        trackType: TrackType.Audio,
        create: (boxGraph: BoxGraph,
                 host: Field<Pointers.InstrumentHost | Pointers.AudioOutput>,
                 name: string,
                 icon: IconSymbol,
                 _attachment?: void): TapeDeviceBox =>
            TapeDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue(name)
                box.icon.setValue(IconSymbol.toName(icon))
                box.flutter.setValue(0.2)
                box.wow.setValue(0.05)
                box.noise.setValue(0.02)
                box.saturation.setValue(0.5)
                box.host.refer(host)
            })
    }

    export const Nano: InstrumentFactory<void, NanoDeviceBox> = {
        defaultName: "Nano",
        defaultIcon: IconSymbol.NanoWave,
        description: "Simple sampler",
        trackType: TrackType.Notes,
        create: (boxGraph: BoxGraph,
                 host: Field<Pointers.InstrumentHost | Pointers.AudioOutput>,
                 name: string,
                 icon: IconSymbol,
                 _attachment?: void): NanoDeviceBox => {
            const fileUUID = UUID.parse("c1678daa-4a47-4cba-b88f-4f4e384663c3")
            const fileDuration = 5.340
            const audioFileBox: AudioFileBox = boxGraph.findBox<AudioFileBox>(fileUUID)
                .unwrapOrElse(() => AudioFileBox.create(boxGraph, fileUUID, box => {
                    box.fileName.setValue("Rhode")
                    box.endInSeconds.setValue(fileDuration)
                }))
            return NanoDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue(name)
                box.icon.setValue(IconSymbol.toName(icon))
                box.file.refer(audioFileBox)
                box.host.refer(host)
            })
        }
    }

    export type PlayfieldAttachment = ReadonlyArray<{
        note: byte
        uuid: UUID.Bytes
        name: string
        durationInSeconds: number
        exclude: boolean
    }>

    export const Playfield: InstrumentFactory<PlayfieldAttachment, PlayfieldDeviceBox> = {
        defaultName: "Playfield",
        defaultIcon: IconSymbol.Playfield,
        description: "Drum computer",
        trackType: TrackType.Notes,
        create: (boxGraph: BoxGraph,
                 host: Field<Pointers.InstrumentHost | Pointers.AudioOutput>,
                 name: string,
                 icon: IconSymbol,
                 attachment?: PlayfieldAttachment): PlayfieldDeviceBox => {
            const deviceBox = PlayfieldDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue(name)
                box.icon.setValue(IconSymbol.toName(icon))
                box.host.refer(host)
            })
            if (isDefined(attachment)) {
                attachment.filter(({note, uuid, name, durationInSeconds, exclude}) => {
                    const fileBox = useAudioFile(boxGraph, uuid, name, durationInSeconds)
                    PlayfieldSampleBox.create(boxGraph, UUID.generate(), box => {
                        box.device.refer(deviceBox.samples)
                        box.file.refer(fileBox)
                        box.index.setValue(note)
                        box.exclude.setValue(exclude)
                    })
                })
            }
            return deviceBox
        }
    }

    export const Vaporisateur: InstrumentFactory<void, VaporisateurDeviceBox> = {
        defaultName: "Vaporisateur",
        defaultIcon: IconSymbol.Piano,
        description: "Classic subtractive synthesizer",
        trackType: TrackType.Notes,
        create: (boxGraph: BoxGraph<BoxIO.TypeMap>,
                 host: Field<Pointers.InstrumentHost | Pointers.AudioOutput>,
                 name: string,
                 icon: IconSymbol,
                 _attachment?: void): VaporisateurDeviceBox =>
            VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue(name)
                box.icon.setValue(IconSymbol.toName(icon))
                box.tune.setInitValue(0.0)
                box.cutoff.setInitValue(1000.0)
                box.resonance.setInitValue(0.1)
                box.attack.setInitValue(0.005)
                box.release.setInitValue(0.1)
                box.waveform.setInitValue(Waveform.sine)
                box.host.refer(host)
            })
    }

    export const MIDIOutput: InstrumentFactory<void, MIDIOutputDeviceBox> = {
        defaultName: "MIDIOutput",
        defaultIcon: IconSymbol.Midi,
        description: "MIDI Output",
        trackType: TrackType.Notes,
        create: (boxGraph: BoxGraph<BoxIO.TypeMap>,
                 host: Field<Pointers.InstrumentHost | Pointers.AudioOutput>,
                 name: string,
                 icon: IconSymbol,
                 _attachment?: void): MIDIOutputDeviceBox =>
            MIDIOutputDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue(name)
                box.icon.setValue(IconSymbol.toName(icon))
                box.host.refer(host)
            })
    }

    export const Soundfont: InstrumentFactory<{ uuid: UUID.String, name: string }, SoundfontDeviceBox> = {
        defaultName: "Soundfont",
        defaultIcon: IconSymbol.SoundFont,
        description: "Soundfont Player",
        trackType: TrackType.Notes,
        create: (boxGraph: BoxGraph<BoxIO.TypeMap>,
                 host: Field<Pointers.InstrumentHost | Pointers.AudioOutput>,
                 name: string,
                 icon: IconSymbol,
                 attachment?: { uuid: UUID.String, name: string }): SoundfontDeviceBox => {
            attachment ??= {uuid: "d9f51577-2096-4671-9067-27ca2e12b329", name: "Upright Piano KW"}
            const soundFontUUIDAsString = attachment.uuid
            const soundfontUUID = UUID.parse(soundFontUUIDAsString)
            const soundfontBox = useSoundfontFile(boxGraph, soundfontUUID, attachment.name)
            return SoundfontDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue(name)
                box.icon.setValue(IconSymbol.toName(icon))
                box.host.refer(host)
                box.file.refer(soundfontBox)
            })
        }
    }

    export const Named = {Vaporisateur, Playfield, Nano, Tape, Soundfont, MIDIOutput}
    export type Keys = keyof typeof Named

    const useAudioFile = (boxGraph: BoxGraph, fileUUID: UUID.Bytes, name: string, duration: number) =>
        boxGraph.findBox<AudioFileBox>(fileUUID)
            .unwrapOrElse(() => AudioFileBox.create(boxGraph, fileUUID, box => {
                box.fileName.setValue(name)
                box.endInSeconds.setValue(duration)
            }))

    const useSoundfontFile = (boxGraph: BoxGraph, fileUUID: UUID.Bytes, name: string) =>
        boxGraph.findBox<SoundfontFileBox>(fileUUID)
            .unwrapOrElse(() => SoundfontFileBox.create(boxGraph, fileUUID, box => box.fileName.setValue(name)))
}