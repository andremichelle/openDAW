import {Address, BooleanField, Propagation, StringField} from "@opendaw/lib-box"
import {Observer, Subscription, UUID} from "@opendaw/lib-std"
import {AudioBusBox} from "@opendaw/studio-boxes"
import {DeviceBoxAdapter, DeviceHost, Devices} from "../DeviceAdapter"
import {LabeledAudioOutput, LabeledAudioOutputsOwner} from "../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {AudioUnitBoxAdapter} from "./AudioUnitBoxAdapter"
import {IconSymbol} from "@opendaw/studio-enums"

export class AudioBusBoxAdapter implements DeviceBoxAdapter, LabeledAudioOutputsOwner {
    readonly type = "bus"
    readonly accepts = "audio"

    readonly #context: BoxAdaptersContext
    readonly #box: AudioBusBox

    constructor(context: BoxAdaptersContext, box: AudioBusBox) {
        this.#context = context
        this.#box = box
    }

    catchupAndSubscribe(observer: Observer<this>): Subscription {
        observer(this)
        return this.#box.subscribe(Propagation.Children, () => observer(this))
    }

    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get box(): AudioBusBox {return this.#box}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get iconField(): StringField {return this.#box.icon}
    get labelField(): StringField {return this.#box.label}
    get colorField(): StringField {return this.#box.color}
    get iconSymbol(): IconSymbol {return IconSymbol.fromName(this.iconField.getValue() ?? "audio-bus")}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.output.targetVertex.unwrap("No AudioUnitBox found").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue()}
    }

    terminate(): void {}

    toString(): string {return `{${this.constructor.name}}`}
}