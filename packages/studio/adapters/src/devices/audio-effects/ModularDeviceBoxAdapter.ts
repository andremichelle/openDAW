import {ModularDeviceBox} from "@opendaw/studio-boxes"
import {panic, UUID} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {Address, BooleanField, FieldKeys, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {AutomatableParameterFieldAdapter} from "../../AutomatableParameterFieldAdapter"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {ModularAdapter} from "../../modular/modular"
import {DeviceInterfaceKnobAdapter} from "../../modular/user-interface"

export class ModularDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"

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

    terminate(): void {}
}