import {Pointers} from "@opendaw/studio-enums"
import {Observer, Option, Subscription, UUID} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {ZeitgeistDeviceBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, MidiEffectDeviceAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {GrooveAdapter} from "../../grooves/GrooveBoxAdapter"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class ZeitgeistDeviceBoxAdapter implements MidiEffectDeviceAdapter {
    readonly type = "midi-effect"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Zeitgeist

    readonly #context: BoxAdaptersContext
    readonly #box: ZeitgeistDeviceBox

    constructor(context: BoxAdaptersContext, box: ZeitgeistDeviceBox) {
        this.#context = context
        this.#box = box
    }

    get box(): ZeitgeistDeviceBox {return this.#box}
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

    // A Zeitgeist may have no groove, it then passes its notes through
    groove(): Option<GrooveAdapter> {
        return this.#box.groove.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, GrooveAdapter.checkType))
    }

    catchupAndSubscribeGroove(observer: Observer<Option<GrooveAdapter>>): Subscription {
        return this.#box.groove.catchupAndSubscribe(() => observer(this.groove()))
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {}
}