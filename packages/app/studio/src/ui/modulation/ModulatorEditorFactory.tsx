import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {asDefined, Lifecycle} from "@opendaw/lib-std"
import {LfoModulatorBox, MacroModulatorBox, StepsModulatorBox} from "@opendaw/studio-boxes"
import {
    LfoModulatorBoxAdapter,
    MacroModulatorBoxAdapter,
    ModulatorBoxAdapter,
    StepsModulatorBoxAdapter
} from "@opendaw/studio-adapters"
import {asInstanceOf} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {LfoEditor} from "@/ui/modulation/editors/LfoEditor.tsx"
import {StepsEditor} from "@/ui/modulation/editors/StepsEditor.tsx"
import {MacroEditor} from "@/ui/modulation/editors/MacroEditor.tsx"

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
        )
    }), `No editor for ${modulator.box.name}`)
