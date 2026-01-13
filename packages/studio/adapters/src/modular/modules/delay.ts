import {ModuleDelayBox} from "@moises-ai/studio-boxes"
import {Pointers} from "@moises-ai/studio-enums"
import {StringMapping, ValueMapping} from "@moises-ai/lib-std"
import {AbstractModuleAdapter} from "../abstract"
import {ModuleAdapter} from "../module"
import {AutomatableParameterFieldAdapter} from "../../AutomatableParameterFieldAdapter"
import {Direction, ModuleConnectorAdapter} from "../connector"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"

export class ModuleDelayAdapter extends AbstractModuleAdapter<ModuleDelayBox> implements ModuleAdapter {
    readonly #parameterTime: AutomatableParameterFieldAdapter<number>
    readonly #voltageInput: ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Input>
    readonly #voltageOutput: ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Output>

    constructor(context: BoxAdaptersContext, box: ModuleDelayBox) {
        super(context, box)

        this.#parameterTime = this.parameters.createParameter(box.time,
            ValueMapping.exponential(1.0, 10000.0),
            StringMapping.numeric({unit: "ms"}),
            "Time")
        this.#voltageInput = ModuleConnectorAdapter.create(context.boxAdapters, box.voltageInput, Direction.Input, "Input")
        this.#voltageOutput = ModuleConnectorAdapter.create(context.boxAdapters, box.voltageOutput, Direction.Output, "Output")
    }

    get parameterTime(): AutomatableParameterFieldAdapter<number> {return this.#parameterTime}
    get voltageInput(): ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Input> {return this.#voltageInput}
    get voltageOutput(): ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Output> {return this.#voltageOutput}

    get inputs(): ReadonlyArray<ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Input>> {
        return [this.#voltageInput]
    }
    get outputs(): ReadonlyArray<ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Output>> {
        return [this.#voltageOutput]
    }
}