import {Address, BooleanField, Box, Field, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Arrays, assert, AssertType, int, Option, panic, UUID} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {TrackType} from "./timeline/TrackType"
import {IndexedBoxAdapterCollection} from "./IndexedBoxAdapterCollection"
import {BoxAdapter} from "./BoxAdapter"
import {AudioUnitInputAdapter} from "./audio-unit/AudioUnitInputAdapter"
import {AudioUnitBoxAdapter} from "./audio-unit/AudioUnitBoxAdapter"
import {DeviceBoxUtils} from "./DeviceBox"

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

export interface MidiEffectDeviceAdapter extends EffectDeviceBoxAdapter<Pointers.MidiEffectHost> {
    readonly type: "midi-effect"
    readonly accepts: "midi"
}

export interface AudioEffectDeviceAdapter extends EffectDeviceBoxAdapter<Pointers.AudioEffectHost> {
    readonly type: "audio-effect"
    readonly accepts: "audio"
}

export type EffectPointerType = Pointers.AudioEffectHost | Pointers.MidiEffectHost

export interface EffectDeviceBoxAdapter<P extends EffectPointerType = EffectPointerType> extends DeviceBoxAdapter {
    readonly type: "audio-effect" | "midi-effect"
    readonly accepts: "audio" | "midi"

    get indexField(): Int32Field
    get enabledField(): BooleanField
    get host(): PointerField<P>
}

export interface InstrumentDeviceBoxAdapter extends DeviceBoxAdapter {
    readonly type: "instrument"

    get iconField(): StringField
    get defaultTrackType(): TrackType
    get acceptsMidiEvents(): boolean
}

export type LabeledAudioOutput = { readonly address: Address, readonly label: string }

export interface LabeledAudioOutputs {
    labeledAudioOutputs(): Iterable<LabeledAudioOutput>
}

export namespace LabeledAudioOutputs {
    export const is = (value: unknown): value is LabeledAudioOutputs =>
        value !== null && typeof value === "object" && "labeledAudioOutputs" in value
}

export interface DeviceHost extends BoxAdapter {
    readonly class: "device-host"

    get midiEffects(): IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MidiEffectHost>
    get inputAdapter(): Option<AudioUnitInputAdapter>
    get audioEffects(): IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>
    get inputField(): Field<Pointers.InstrumentHost | Pointers.AudioOutput>
    get tracksField(): Field<Pointers.TrackCollection>
    get minimizedField(): BooleanField
    get isAudioUnit(): boolean
    get label(): string

    audioUnitBoxAdapter(): AudioUnitBoxAdapter
}

export interface DeviceBoxAdapter extends BoxAdapter {
    readonly type: DeviceType

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
        const targets = device.accepts === "audio"
            ? device.deviceHost().audioEffects.field().pointerHub.filter(Pointers.AudioEffectHost)
            : device.accepts === "midi"
                ? device.deviceHost().midiEffects.field().pointerHub.filter(Pointers.MidiEffectHost)
                : panic("unknown type")
        targets.map(({box}) => DeviceBoxUtils.lookupIndexField(box))
            .filter(index => devices.some(device => UUID.Comparator(device.uuid, index.address.uuid) !== 0))
            .sort((a, b) => a.getValue() - b.getValue())
            .forEach((indexField, index: int) => indexField.setValue(index))
        devices.forEach(device => device.box.delete())
    }
}