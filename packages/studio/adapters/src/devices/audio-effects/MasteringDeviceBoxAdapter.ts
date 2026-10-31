import {asInstanceOf, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField} from "@opendaw/lib-box"
import {AudioUnitBox, MasteringDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdapter} from "../../BoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

// Attached to an audio unit's `mastering` field, processed after its effect chain, never part of a device chain
export class MasteringDeviceBoxAdapter implements BoxAdapter {
    readonly manualUrl = DeviceManualUrls.Mastering

    readonly #context: BoxAdaptersContext
    readonly #box: MasteringDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: MasteringDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): MasteringDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get enabledField(): BooleanField {return this.#box.enabled}

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {
        const box = asInstanceOf(this.#box.host.targetVertex.unwrap("no audio-unit").box, AudioUnitBox)
        return this.#context.boxAdapters.adapterFor(box, AudioUnitBoxAdapter)
    }

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: MasteringDeviceBox) {
        return {
            amount: this.#parametric.createParameter(
                box.amount, ValueMapping.unipolar(),
                StringMapping.percent({fractionDigits: 0}), "Amount"),
            gain: this.#parametric.createParameter(
                box.gain, ValueMapping.linear(-12.0, 12.0),
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Gain", 0.5),
            width: this.#parametric.createParameter(
                box.width, ValueMapping.linear(0.0, 2.0),
                StringMapping.percent({fractionDigits: 0}), "Width", 0.5),
            ceiling: this.#parametric.createParameter(
                box.ceiling, ValueMapping.linear(-6.0, 0.0),
                StringMapping.numeric({unit: "dB", fractionDigits: 2}), "Ceiling", 1.0)
        } as const
    }
}
