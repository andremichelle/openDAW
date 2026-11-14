import {Pointers} from "@opendaw/studio-enums"
import {clamp, int, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {EuclidDeviceBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, MidiEffectDeviceAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {Euclid} from "./Euclid"

// -1 shows as Off, the patterns from 1
const PatternStrings: StringMapping<int> = {
    x: (value: int) => ({unit: "", value: value < 0 ? "Off" : String(value + 1)}),
    y: (text: string) => {
        if (text.trim().toLowerCase() === "off") {return {type: "explicit", value: Euclid.Off}}
        const number = parseInt(text, 10)
        return Number.isFinite(number)
            ? {type: "explicit", value: clamp(number - 1, 0, Euclid.Patterns - 1)}
            : {type: "unknown", value: text}
    }
}

// 0 shows as Off, the lanes then never restart
const LengthStrings: StringMapping<int> = {
    x: (value: int) => ({unit: "", value: value === 0 ? "Off" : String(value)}),
    y: (text: string) => {
        if (text.trim().toLowerCase() === "off") {return {type: "explicit", value: 0}}
        const number = parseInt(text, 10)
        return Number.isFinite(number)
            ? {type: "explicit", value: clamp(number, 0, Euclid.MaxLength)}
            : {type: "unknown", value: text}
    }
}

export class EuclidDeviceBoxAdapter implements MidiEffectDeviceAdapter {
    readonly type = "midi-effect"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Euclid

    readonly #context: BoxAdaptersContext
    readonly #box: EuclidDeviceBox
    readonly #parametric: ParameterAdapterSet

    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: EuclidDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): EuclidDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.MIDIEffectHost> {return this.#box.host}
    /** Where the engine reports the active and the waiting pattern. */
    get state(): Address {return this.#box.address.append(Euclid.StateKey)}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: EuclidDeviceBox) {
        return {
            pattern: this.#parametric.createParameter(
                box.pattern,
                ValueMapping.linearInteger(Euclid.Off, Euclid.Patterns - 1),
                PatternStrings, "Pattern"),
            length: this.#parametric.createParameter(
                box.length,
                ValueMapping.linearInteger(0, Euclid.MaxLength),
                LengthStrings, "Length"),
            rate: this.#parametric.createParameter(
                box.rate,
                ValueMapping.linearInteger(0, Euclid.GlobalRates.length - 1),
                StringMapping.indices("", Euclid.GlobalRates), "Rate")
        } as const
    }
}
