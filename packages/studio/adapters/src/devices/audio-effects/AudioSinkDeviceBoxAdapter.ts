import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {AudioSinkDeviceBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {AudioUnitOutput} from "../../audio-unit/AudioUnitOutput"

export class AudioSinkDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Sink

    readonly #context: BoxAdaptersContext
    readonly #box: AudioSinkDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly #targetBus: AudioUnitOutput
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: AudioSinkDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.#targetBus = new AudioUnitOutput(box.targetBus, this.#context.boxAdapters)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): AudioSinkDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    get targetBus(): AudioUnitOutput {return this.#targetBus}

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
        this.#targetBus.terminate()
    }

    #wrapParameters(box: AudioSinkDeviceBox) {
        return {
            pass: this.#parametric.createParameter(box.pass, ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Pass")
        } as const
    }
}
