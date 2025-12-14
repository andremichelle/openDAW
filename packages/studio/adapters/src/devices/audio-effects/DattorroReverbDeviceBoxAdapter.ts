import {StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {DattorroReverbDeviceBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class DattorroReverbDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"

    readonly #context: BoxAdaptersContext
    readonly #box: DattorroReverbDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: DattorroReverbDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): DattorroReverbDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: DattorroReverbDeviceBox) {
        return {
            preDelay: this.#parametric.createParameter(
                box.preDelay, ValueMapping.linear(0.0, 1000.0),
                StringMapping.numeric({unit: box.preDelay.unit}), "Pre-Delay"
            ),
            bandwidth: this.#parametric.createParameter(
                box.bandwidth,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Bandwidth"
            ),
            inputDiffusion1: this.#parametric.createParameter(
                box.inputDiffusion1,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Tank 1"
            ),
            inputDiffusion2: this.#parametric.createParameter(
                box.inputDiffusion2,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Tank 2"
            ),
            decay: this.#parametric.createParameter(
                box.decay,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Decay"
            ),
            decayDiffusion1: this.#parametric.createParameter(
                box.decayDiffusion1,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Tank 1"
            ),
            decayDiffusion2: this.#parametric.createParameter(
                box.decayDiffusion2,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Tank 2"
            ),
            damping: this.#parametric.createParameter(
                box.damping,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Damping"
            ),
            excursionRate: this.#parametric.createParameter(
                box.excursionRate,
                ValueMapping.unipolar(),
                StringMapping.numeric({unit: box.excursionRate.unit}), "Rate"
            ),
            excursionDepth: this.#parametric.createParameter(
                box.excursionDepth,
                ValueMapping.unipolar(),
                StringMapping.numeric({unit: box.excursionDepth.unit}), "Depth"
            ),
            wet: this.#parametric.createParameter(
                box.wet,
                ValueMapping.DefaultDecibel,
                StringMapping.decible, "Wet"
            ),
            dry: this.#parametric.createParameter(
                box.dry,
                ValueMapping.DefaultDecibel,
                StringMapping.decible, "Dry"
            )
        } as const
    }
}