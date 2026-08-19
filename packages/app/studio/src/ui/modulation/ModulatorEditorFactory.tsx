import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {asDefined, Lifecycle} from "@opendaw/lib-std"
import {LfoModulatorBox, MacroModulatorBox, RandomModulatorBox, StepsModulatorBox} from "@opendaw/studio-boxes"
import {
    LfoModulatorBoxAdapter,
    MacroModulatorBoxAdapter,
    ModulatorBoxAdapter,
    RandomModulatorBoxAdapter,
    StepsModulatorBoxAdapter
} from "@opendaw/studio-adapters"
import {asInstanceOf} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {LfoEditor} from "@/ui/modulation/editors/LfoEditor.tsx"
import {StepsEditor} from "@/ui/modulation/editors/StepsEditor.tsx"
import {MacroEditor} from "@/ui/modulation/editors/MacroEditor.tsx"
import {RandomEditor} from "@/ui/modulation/editors/RandomEditor.tsx"

export const createModulatorEditor = (lifecycle: Lifecycle,
                                      service: StudioService,
                                      modulator: ModulatorBoxAdapter): JsxValue =>
    asDefined(modulator.box.accept<JsxValue>({
        visitLfoModulatorBox: (_box: LfoModulatorBox) => (
            <LfoEditor lifecycle={lifecycle} service={service}
                       modulator={asInstanceOf(modulator, LfoModulatorBoxAdapter)}/>
        ),
        visitStepsModulatorBox: (_box: StepsModulatorBox) => (
            <StepsEditor lifecycle={lifecycle} service={service}
                         modulator={asInstanceOf(modulator, StepsModulatorBoxAdapter)}/>
        ),
        visitMacroModulatorBox: (_box: MacroModulatorBox) => (
            <MacroEditor lifecycle={lifecycle} service={service}
                         modulator={asInstanceOf(modulator, MacroModulatorBoxAdapter)}/>
        ),
        visitRandomModulatorBox: (_box: RandomModulatorBox) => (
            <RandomEditor lifecycle={lifecycle} service={service}
                          modulator={asInstanceOf(modulator, RandomModulatorBoxAdapter)}/>
        )
    }), `No editor for ${modulator.box.name}`)
