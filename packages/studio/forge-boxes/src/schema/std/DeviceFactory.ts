import {BoxSchema, FieldRecord, mergeFields, reserveMany} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {Objects} from "@opendaw/lib-std"

const DefaultPointers = [Pointers.Device, Pointers.Selection, Pointers.MetaData]
const DefaultAudioPointers = [...DefaultPointers, Pointers.SideChain]

const MidiEffectDeviceAttributes = {
    1: {type: "pointer", name: "host", pointerType: Pointers.MIDIEffectHost, mandatory: true},
    2: {type: "int32", name: "index", constraints: "index", unit: ""},
    3: {type: "string", name: "label"},
    4: {type: "boolean", name: "enabled", value: true},
    5: {type: "boolean", name: "minimized", value: false},
    ...reserveMany(6, 7, 8, 9)
} as const satisfies FieldRecord<Pointers>

const InstrumentDeviceAttributes = {
    1: {type: "pointer", name: "host", pointerType: Pointers.InstrumentHost, mandatory: true},
    2: {type: "string", name: "label"},
    3: {type: "string", name: "icon"},
    4: {type: "boolean", name: "enabled", value: true},
    5: {type: "boolean", name: "minimized", value: false},
    ...reserveMany(6, 7, 8, 9)
} as const satisfies FieldRecord<Pointers>

const AudioEffectDeviceAttributes = {
    1: {type: "pointer", name: "host", pointerType: Pointers.AudioEffectHost, mandatory: true},
    2: {type: "int32", name: "index", constraints: "index", unit: ""},
    3: {type: "string", name: "label"},
    4: {type: "boolean", name: "enabled", value: true},
    5: {type: "boolean", name: "minimized", value: false},
    ...reserveMany(6, 7, 8, 9)
} as const satisfies FieldRecord<Pointers>

export namespace DeviceFactory {
    export const createMidiEffect = <FIELDS extends FieldRecord<Pointers>>(
        name: string,
        fields: Objects.Disjoint<typeof MidiEffectDeviceAttributes, FIELDS> & FieldRecord<Pointers>
    ): BoxSchema<Pointers> => {
        type DisjointFields = Objects.Disjoint<typeof MidiEffectDeviceAttributes, FIELDS>
        return {
            type: "box",
            class: {name, fields: mergeFields(MidiEffectDeviceAttributes, fields as DisjointFields)},
            pointerRules: {accepts: DefaultPointers, mandatory: false},
            tags: {type: "device", "device-type": "midi-effect"}
        }
    }

    export const createInstrument = <FIELDS extends FieldRecord<Pointers>>(
        name: string,
        content: "notes" | "audio",
        fields: Objects.Disjoint<typeof InstrumentDeviceAttributes, FIELDS> & FieldRecord<Pointers>,
        ...pointers: Array<Pointers>
    ): BoxSchema<Pointers> => {
        type DisjointFields = Objects.Disjoint<typeof InstrumentDeviceAttributes, FIELDS>
        return {
            type: "box",
            class: {name, fields: mergeFields(InstrumentDeviceAttributes, fields as DisjointFields)},
            pointerRules: {accepts: DefaultAudioPointers.concat(pointers), mandatory: false},
            tags: {type: "device", "device-type": "instrument", content}
        }
    }

    export const createAudioEffect = <FIELDS extends FieldRecord<Pointers>>(
        name: string,
        fields: Objects.Disjoint<typeof AudioEffectDeviceAttributes, FIELDS> & FieldRecord<Pointers>
    ): BoxSchema<Pointers> => {
        type DisjointFields = Objects.Disjoint<typeof AudioEffectDeviceAttributes, FIELDS>
        return {
            type: "box",
            class: {name, fields: mergeFields(AudioEffectDeviceAttributes, fields as DisjointFields)},
            pointerRules: {accepts: DefaultAudioPointers, mandatory: false},
            tags: {type: "device", "device-type": "audio-effect"}
        }
    }
}