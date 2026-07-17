import {BooleanField, Box, Field, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Arrays, assert, AssertType, int, Option, panic, UUID} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {TrackType} from "./timeline/TrackType"
import {IndexedBoxAdapterCollection} from "./IndexedBoxAdapterCollection"
import {BoxAdapter} from "./BoxAdapter"
import {AudioUnitInputAdapter} from "./audio-unit/AudioUnitInputAdapter"
import {AudioUnitBoxAdapter} from "./audio-unit/AudioUnitBoxAdapter"
import {DeviceBoxUtils} from "./DeviceBox"
import {LabeledAudioOutputsOwner} from "./LabeledAudioOutputsOwner"

export type DeviceType = "midi-effect" | "bus" | "instrument" | "audio-effect"
export type DeviceAccepts = "midi" | "audio" | false

export namespace DeviceAccepts {
    export const toTrackType = (type: DeviceAccepts) => {
        switch (type) {
            case "midi":
                return TrackType.Notes
            case "audio":
                return TrackType.Audio
            default:
                return panic()
        }
    }
}

export interface MidiEffectDeviceAdapter extends EffectDeviceBoxAdapter<Pointers.MIDIEffectHost> {
    readonly type: "midi-effect"
    readonly accepts: "midi"
}

export interface AudioEffectDeviceAdapter extends EffectDeviceBoxAdapter<Pointers.AudioEffectHost>, LabeledAudioOutputsOwner {
    readonly type: "audio-effect"
    readonly accepts: "audio"
}

export type EffectPointerType = Pointers.AudioEffectHost | Pointers.MIDIEffectHost

export interface EffectDeviceBoxAdapter<P extends EffectPointerType = EffectPointerType> extends DeviceBoxAdapter {
    readonly type: "audio-effect" | "midi-effect"
    readonly accepts: "audio" | "midi"

    get indexField(): Int32Field
    get enabledField(): BooleanField
    get host(): PointerField<P>
}

export interface InstrumentDeviceBoxAdapter extends DeviceBoxAdapter, LabeledAudioOutputsOwner {
    readonly type: "instrument"

    get iconField(): StringField
    get defaultTrackType(): TrackType
    get acceptsMidiEvents(): boolean
}

// A host of device chains. A host is ONE-SIDED when it hosts only one kind of chain: an AudioEffectCompositeCellBox
// entry hosts audio effects but no midi effects. So the chain accessors are `Option`: `None` means "this host
// does not host that kind at all", which is NOT the same as an empty chain.
// The `Option` IS the capability flag — a caller that wants to insert / render / copy a chain must handle absence,
// so a midi effect can never be inserted into an audio-only entry.
export interface DeviceHost extends BoxAdapter, LabeledAudioOutputsOwner {
    readonly class: "device-host"

    get midiEffects(): Option<IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MIDIEffectHost>>
    get midiEffectsField(): Option<Field<Pointers.MIDIEffectHost>>
    get inputAdapter(): Option<AudioUnitInputAdapter>
    get audioEffects(): Option<IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>>
    get audioEffectsField(): Option<Field<Pointers.AudioEffectHost>>
    get inputField(): Field<Pointers.InstrumentHost | Pointers.AudioOutput>
    get tracksField(): Field<Pointers.TrackCollection>
    get minimizedField(): BooleanField
    get isAudioUnit(): boolean
    // Whether this host holds an INSTRUMENT at the head of its chains (an audio unit, a Playfield slot). A
    // composite entry does not: it processes a signal handed to it by its composite. Distinct from
    // `inputAdapter.isEmpty()`, which for an instrument-hosting host only means "no instrument YET".
    get hostsInstrument(): boolean
    get label(): string

    deviceHost(): DeviceHost
    audioUnitBoxAdapter(): AudioUnitBoxAdapter
}

export namespace DeviceHost {
    // The chain collection a host keeps for effects of `accepts`, or `None` when it hosts no such chain.
    export const chainOf = (host: DeviceHost, accepts: "audio" | "midi")
        : Option<IndexedBoxAdapterCollection<EffectDeviceBoxAdapter, EffectPointerType>> =>
        accepts === "audio" ? host.audioEffects : host.midiEffects

    // The chain HOST FIELD an effect of `accepts` attaches to, or `None` when the host takes no such chain.
    export const chainFieldOf = (host: DeviceHost, accepts: "audio" | "midi"): Option<Field<EffectPointerType>> =>
        accepts === "audio" ? host.audioEffectsField : host.midiEffectsField

    // Whether an effect of `accepts` may be inserted into this host. The host must hold a chain of that kind
    // at all; a MIDI effect additionally requires a note CONSUMER, so an instrument-hosting host must have an
    // instrument that takes notes. A composite entry hosts no instrument — its notes flow on to whatever
    // consumes them downstream — so there the chain's presence alone decides.
    export const takesEffect = (host: DeviceHost, accepts: "audio" | "midi"): boolean =>
        chainFieldOf(host, accepts).nonEmpty()
        && (accepts === "audio" || !host.hostsInstrument
            || host.inputAdapter.mapOr(input => input.accepts === "midi", false))
}

export interface DeviceBoxAdapter extends BoxAdapter {
    readonly type: DeviceType
    readonly manualUrl: string

    get box(): Box
    get labelField(): StringField
    get enabledField(): BooleanField
    get minimizedField(): BooleanField
    get accepts(): DeviceAccepts

    deviceHost(): DeviceHost
    audioUnitBoxAdapter(): AudioUnitBoxAdapter
}

export namespace Devices {
    export const isAny: AssertType<DeviceBoxAdapter> = (adapter: unknown): adapter is DeviceBoxAdapter =>
        adapter !== null && typeof adapter === "object" && "type" in adapter
        && (adapter.type === "midi-effect" || adapter.type === "bus"
            || adapter.type === "instrument" || adapter.type === "audio-effect")
    export const isEffect: AssertType<EffectDeviceBoxAdapter> = (adapter: unknown): adapter is EffectDeviceBoxAdapter =>
        adapter !== null && typeof adapter === "object" && "type" in adapter
        && (adapter.type === "midi-effect" || adapter.type === "audio-effect")
    export const isInstrument: AssertType<InstrumentDeviceBoxAdapter> = (adapter: unknown): adapter is InstrumentDeviceBoxAdapter =>
        adapter !== null && typeof adapter === "object" && "type" in adapter && adapter.type === "instrument"
    export const isMidiEffect: AssertType<MidiEffectDeviceAdapter> = (adapter: unknown): adapter is MidiEffectDeviceAdapter =>
        adapter !== null && typeof adapter === "object" && "type" in adapter && adapter.type === "midi-effect"
    export const isAudioEffect: AssertType<AudioEffectDeviceAdapter> = (adapter: unknown): adapter is AudioEffectDeviceAdapter =>
        adapter !== null && typeof adapter === "object" && "type" in adapter && adapter.type === "audio-effect"
    export const isHost: AssertType<DeviceHost> = (value: unknown): value is DeviceHost =>
        value !== null && typeof value === "object" && "class" in value && value.class === "device-host"

    export const deleteEffectDevices = (devices: ReadonlyArray<EffectDeviceBoxAdapter>): void => {
        if (devices.length === 0) {return}
        assert(Arrays.satisfy(devices, (a, b) => a.deviceHost().address.equals(b.deviceHost().address)),
            "Devices are not connected to the same host")
        const device: EffectDeviceBoxAdapter = devices[0]
        const field = DeviceHost.chainFieldOf(device.deviceHost(), device.accepts)
            .unwrap(`host takes no ${device.accepts} effects`)
        const targets = field.pointerHub.filter(device.accepts === "audio"
            ? Pointers.AudioEffectHost
            : Pointers.MIDIEffectHost)
        targets.map(({box}) => DeviceBoxUtils.lookupIndexField(box))
            .filter(index => devices.some(device => UUID.Comparator(device.uuid, index.address.uuid) !== 0))
            .sort((a, b) => a.getValue() - b.getValue())
            .forEach((indexField, index: int) => indexField.setValue(index))
        devices.forEach(device => device.box.delete())
    }
}