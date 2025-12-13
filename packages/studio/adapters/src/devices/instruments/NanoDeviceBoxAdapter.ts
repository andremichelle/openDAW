import {NanoDeviceBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, Terminable, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class NanoDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"

    readonly #context: BoxAdaptersContext
    readonly #box: NanoDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly #outputRegistration: Terminable
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: NanoDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
        this.#outputRegistration = context.isMainThread
            ? context.audioOutputInfoRegistry.register({address: box.address, owner: Option.None, label: () => box.label.getValue()})
            : Terminable.Empty
    }

    get box(): NanoDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {
        this.#parametric.terminate()
        this.#outputRegistration.terminate()
    }

    #wrapParameters(box: NanoDeviceBox) {
        return {
            volume: this.#parametric.createParameter(
                box.volume,
                ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "db", fractionDigits: 1}), "volume"),
            release: this.#parametric.createParameter(
                box.release,
                ValueMapping.exponential(0.001, 8.0),
                StringMapping.numeric({unit: "s", fractionDigits: 3}), "release")
        } as const
    }
}