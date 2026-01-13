import {ModuleMultiplierBox} from "@moises-ai/studio-boxes"
import {Pointers} from "@moises-ai/studio-enums"
import {AbstractModuleAdapter} from "../abstract"
import {ModuleAdapter} from "../module"
import {Direction, ModuleConnectorAdapter} from "../connector"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"

export class ModuleMultiplierAdapter extends AbstractModuleAdapter<ModuleMultiplierBox> implements ModuleAdapter {
    readonly #voltageInputX: ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Input>
    readonly #voltageInputY: ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Input>
    readonly #voltageOutput: ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Output>

    constructor(context: BoxAdaptersContext, box: ModuleMultiplierBox) {
        super(context, box)

        this.#voltageInputX = ModuleConnectorAdapter.create(context.boxAdapters, box.voltageInputX, Direction.Input, "X")
        this.#voltageInputY = ModuleConnectorAdapter.create(context.boxAdapters, box.voltageInputY, Direction.Input, "Y")
        this.#voltageOutput = ModuleConnectorAdapter.create(context.boxAdapters, box.voltageOutput, Direction.Output, "Result")
    }

    get inputs(): ReadonlyArray<ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Input>> {
        return [this.#voltageInputX, this.#voltageInputY]
    }
    get outputs(): ReadonlyArray<ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Output>> {
        return [this.#voltageOutput]
    }
}