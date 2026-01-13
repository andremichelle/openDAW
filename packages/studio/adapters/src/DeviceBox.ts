import {Pointers} from "@moises-ai/studio-enums"
import {BooleanField, Box, Int32Field, PointerField, StringField} from "@moises-ai/lib-box"
import {isDefined, isInstanceOf, Maybe, panic} from "@moises-ai/lib-std"

export type DeviceBox = {
    host: PointerField
    label: StringField
    enabled: BooleanField
    minimized: BooleanField
} & Box

export type InstrumentDeviceBox = {
    host: PointerField<Pointers.InstrumentHost>
} & DeviceBox

export type EffectDeviceBox = {
    host: PointerField<Pointers.AudioEffectHost | Pointers.MIDIEffectHost>
    index: Int32Field
} & DeviceBox

export namespace DeviceBoxUtils {
    export const isDeviceBox = (box: Box): box is DeviceBox =>
        "host" in box && isInstanceOf(box.host, PointerField) &&
        "label" in box && isInstanceOf(box.label, StringField) &&
        "enabled" in box && isInstanceOf(box.enabled, BooleanField) &&
        "minimized" in box && isInstanceOf(box.minimized, BooleanField)

    export const isInstrumentDeviceBox = (box: Box): box is InstrumentDeviceBox =>
        isDeviceBox(box) && box.host.pointerType === Pointers.InstrumentHost

    export const isEffectDeviceBox = (box: Box): box is EffectDeviceBox =>
        isDeviceBox(box) && "index" in box && isInstanceOf(box.index, Int32Field) &&
        (box.host.pointerType === Pointers.MIDIEffectHost || box.host.pointerType === Pointers.AudioEffectHost)

    export const lookupHostField = (box: Maybe<Box>): PointerField =>
        isDefined(box) && "host" in box && isInstanceOf(box.host, PointerField)
            ? box.host : panic(`Could not find 'host' field in '${box?.name}'`)
    export const lookupLabelField = (box: Maybe<Box>): StringField =>
        isDefined(box) && "label" in box && isInstanceOf(box.label, StringField)
            ? box.label : panic(`Could not find 'label' field in '${box?.name}'`)
    export const lookupEnabledField = (box: Maybe<Box>): BooleanField =>
        isDefined(box) && "enabled" in box && isInstanceOf(box.enabled, BooleanField)
            ? box.enabled : panic(`Could not find 'enabled' field in '${box?.name}'`)
    export const lookupMinimizedField = (box: Maybe<Box>): BooleanField =>
        isDefined(box) && "minimized" in box && isInstanceOf(box.minimized, BooleanField)
            ? box.minimized : panic(`Could not find 'minimized' field in '${box?.name}'`)
    export const lookupIndexField = (box: Maybe<Box>): Int32Field =>
        isDefined(box) && "index" in box && isInstanceOf(box.index, Int32Field)
            ? box.index : panic(`Could not find 'index' field in '${box?.name}'`)
}