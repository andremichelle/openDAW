import {Pointers} from "@opendaw/studio-enums"
import {int, ParseResult, StringMapping, StringResult, UUID, ValueMapping} from "@opendaw/lib-std"
import {MidiKeys} from "@opendaw/lib-dsp"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {NoteFilterDeviceBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, MidiEffectDeviceAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

const KeyLabels: ReadonlyArray<string> = Array.from({length: 128}, (_, note) => MidiKeys.toFullString(note))

const KeyMapping: StringMapping<int> = new class implements StringMapping<int> {
    x(y: int): StringResult {return {unit: "", value: KeyLabels[y]}}
    y(x: string): ParseResult<int> {
        const text = x.trim()
        const number = /^\d+$/.test(text) ? parseInt(text, 10) : KeyLabels.findIndex(label => label.toLowerCase() === text.toLowerCase())
        return number >= 0 && number <= 127 ? {type: "explicit", value: number} : {type: "unknown", value: text}
    }
}

export class NoteFilterDeviceBoxAdapter implements MidiEffectDeviceAdapter {
    readonly type = "midi-effect"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.NoteFilter

    readonly #context: BoxAdaptersContext
    readonly #box: NoteFilterDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: NoteFilterDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): NoteFilterDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.MIDIEffectHost> {return this.#box.host}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: NoteFilterDeviceBox) {
        return {
            min: this.#parametric.createParameter(
                box.min,
                ValueMapping.linearInteger(0, 127),
                KeyMapping, "Min", 0.0),
            max: this.#parametric.createParameter(
                box.max,
                ValueMapping.linearInteger(0, 127),
                KeyMapping, "Max", 1.0),
            set: this.#parametric.createParameter(
                box.set,
                ValueMapping.bool,
                StringMapping.bool, "Set"),
            transpose: this.#parametric.createParameter(
                box.transpose,
                ValueMapping.linearInteger(-127, 127),
                StringMapping.numeric({unit: "st", fractionDigits: 0}), "Semitones", 0.5),
            key: this.#parametric.createParameter(
                box.key,
                ValueMapping.linearInteger(0, 127),
                KeyMapping, "Key", 60 / 127)
        } as const
    }
}
