import {DeviceInterfaceKnobBox} from "@moises-ai/studio-boxes"
import {Address, Box, PointerTypes, PrimitiveField} from "@moises-ai/lib-box"
import {ModuleAdapter, Modules} from "./module"
import {BoxAdapter} from "../BoxAdapter"
import {AutomatableParameterFieldAdapter} from "../AutomatableParameterFieldAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"

export interface DeviceInterfaceElementAdapter extends BoxAdapter {
    get moduleAdapter(): ModuleAdapter
    get parameterAdapter(): AutomatableParameterFieldAdapter
}

export class DeviceInterfaceKnobAdapter implements DeviceInterfaceElementAdapter {
    readonly #context: BoxAdaptersContext
    readonly #box: DeviceInterfaceKnobBox

    constructor(context: BoxAdaptersContext, box: DeviceInterfaceKnobBox) {
        this.#context = context
        this.#box = box
    }

    get box(): Box<PointerTypes, any> {return this.#box}
    get uuid(): Readonly<Uint8Array> {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}

    get moduleAdapter(): ModuleAdapter {
        return Modules.adapterFor(this.#context.boxAdapters, this.#parameterTarget.box)
    }

    get parameterAdapter(): AutomatableParameterFieldAdapter {
        return this.moduleAdapter.parameters.parameterAt(this.#parameterTarget.address)
    }

    get #parameterTarget(): PrimitiveField {
        return this.#box.parameter.targetVertex.unwrap("Parameter not assigned") as PrimitiveField
    }

    terminate(): void {
    }
}