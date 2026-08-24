import {Field} from "@opendaw/lib-box"
import {unitValue} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {ModulationBox} from "@opendaw/studio-boxes"
import {ModulatorBox, ModulatorBoxAdapter, Modulators} from "@opendaw/studio-adapters"
import {Project} from "./Project"

export class ProjectModulation {
    readonly #project: Project

    constructor(project: Project) {this.#project = project}

    get kinds(): ReadonlyArray<Modulators.Kind> {return Modulators.Kinds}

    adapters(): ReadonlyArray<ModulatorBoxAdapter> {
        return this.#project.rootBoxAdapter.modulators.adapters()
    }

    create(kind: Modulators.Kind): ModulatorBox {
        return kind.create(this.#project)
    }

    createLfo(label?: string): ModulatorBox {return Modulators.createLfo(this.#project, label)}
    createSteps(label?: string): ModulatorBox {return Modulators.createSteps(this.#project, label)}
    createMacro(label?: string): ModulatorBox {return Modulators.createMacro(this.#project, label)}
    createRandom(label?: string): ModulatorBox {return Modulators.createRandom(this.#project, label)}

    assign(modulator: ModulatorBox, target: Field<Pointers.Modulation>, depth?: unitValue): ModulationBox {
        return Modulators.assign(this.#project, modulator, target, depth)
    }

    replace(modulator: ModulatorBox, kind: Modulators.Kind): ModulatorBox {
        return Modulators.replace(this.#project, modulator, kind)
    }

    duplicate(modulator: ModulatorBox): ModulatorBox {
        return Modulators.duplicate(this.#project, modulator)
    }

    duplicateAll(modulators: ReadonlyArray<ModulatorBox>): ReadonlyArray<ModulatorBox> {
        return Modulators.duplicateAll(this.#project, modulators)
    }

    delete(modulator: ModulatorBox): void {this.deleteAll([modulator])}

    deleteAll(modulators: ReadonlyArray<ModulatorBox>): void {
        Modulators.deleteAll(this.#project, modulators)
    }

    move(modulators: ReadonlyArray<ModulatorBox>, target: ModulatorBox): void {
        Modulators.move(this.#project, modulators, target)
    }
}
