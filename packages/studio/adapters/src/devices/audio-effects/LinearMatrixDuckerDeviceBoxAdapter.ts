import {LinearMatrixDuckerDeviceBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class LinearMatrixDuckerDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.LinearMatrixDucker

    readonly #context: BoxAdaptersContext
    readonly #box: LinearMatrixDuckerDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: LinearMatrixDuckerDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): LinearMatrixDuckerDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    get sideChain(): PointerField<Pointers.SideChain> {return this.#box.sideChain}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: LinearMatrixDuckerDeviceBox) {
        return {
            threshold: this.#parametric.createParameter(
                box.threshold, ValueMapping.linear(-48.0, 0.0), StringMapping.decible, "Threshold"),
            attack: this.#parametric.createParameter(
                box.attack, ValueMapping.linear(0.0, 10.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 2}), "Attack"),
            hold: this.#parametric.createParameter(
                box.hold, ValueMapping.linear(0.0, 500.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 2}), "Hold"),
            release: this.#parametric.createParameter(
                box.release, ValueMapping.exponential(1.0, 2000.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 2}), "Release"),
            mode: this.#parametric.createParameter(
                box.mode, ValueMapping.linearInteger(0, 2),
                StringMapping.indices("", ["Peak", "ISP", "RMS"]), "Mode"),
            range: this.#parametric.createParameter(
                box.range, ValueMapping.linear(0.0, 2.0), StringMapping.percent({fractionDigits: 0}), "Range"),
            stereo: this.#parametric.createParameter(
                box.stereo, ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Stereo"),
            mix: this.#parametric.createParameter(
                box.mix, ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Mix")
        } as const
    }
}
