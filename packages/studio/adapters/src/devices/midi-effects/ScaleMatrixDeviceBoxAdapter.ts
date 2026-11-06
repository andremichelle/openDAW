import {Pointers} from "@opendaw/studio-enums"
import {StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {ScaleMatrixDeviceBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, MidiEffectDeviceAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class ScaleMatrixDeviceBoxAdapter implements MidiEffectDeviceAdapter {
    readonly type = "midi-effect"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.ScaleMatrix

    readonly #context: BoxAdaptersContext
    readonly #box: ScaleMatrixDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: ScaleMatrixDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): ScaleMatrixDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.MIDIEffectHost> {return this.#box.host}
    get key(): Harmony.Key {
        const {root, scale} = this.namedParameter
        return {root: root.getValue(), bits: MidiKeys.StockScales[scale.getValue()].bits}
    }

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: ScaleMatrixDeviceBox) {
        return {
            root: this.#parametric.createParameter(
                box.root,
                ValueMapping.linearInteger(0, 11),
                StringMapping.indices("", MidiKeys.Names.English), "Root"),
            scale: this.#parametric.createParameter(
                box.scale,
                ValueMapping.linearInteger(0, MidiKeys.StockScales.length - 1),
                StringMapping.indices("", MidiKeys.StockScales.map(scale => scale.name)), "Scale"),
            follow: this.#parametric.createParameter(
                box.follow,
                ValueMapping.bool,
                StringMapping.bool, "Follow")
        } as const
    }
}
