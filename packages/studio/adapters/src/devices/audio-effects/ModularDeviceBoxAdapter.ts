import {ModularDeviceBox} from "@moises-ai/studio-boxes"
import {Option, panic, UUID} from "@moises-ai/lib-std"
import {Pointers} from "@moises-ai/studio-enums"
import {Address, BooleanField, FieldKeys, Int32Field, PointerField, StringField} from "@moises-ai/lib-box"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {AutomatableParameterFieldAdapter} from "../../AutomatableParameterFieldAdapter"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {ModularAdapter} from "../../modular/modular"
import {DeviceInterfaceKnobAdapter} from "../../modular/user-interface"

export class ModularDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Modular

    readonly #context: BoxAdaptersContext
    readonly #box: ModularDeviceBox

    constructor(context: BoxAdaptersContext, box: ModularDeviceBox) {
        this.#context = context
        this.#box = box
    }

    get box(): ModularDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}

    parameterAt(_fieldIndices: FieldKeys): AutomatableParameterFieldAdapter {return panic("Not yet implemented")}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    modular(): ModularAdapter {
        return this.#context.boxAdapters
            .adapterFor(this.#box.modularSetup.targetVertex.unwrap("No Modular found").box, ModularAdapter)
    }

    elements(): ReadonlyArray<DeviceInterfaceKnobAdapter> {
        return this.#box.userInterface.elements.pointerHub.filter(Pointers.DeviceUserInterface)
            .map(pointer => this.#context.boxAdapters.adapterFor(pointer.box, DeviceInterfaceKnobAdapter))
    }

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {}
}