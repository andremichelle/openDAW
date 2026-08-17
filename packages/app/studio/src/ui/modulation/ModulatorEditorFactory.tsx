import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {asDefined, Lifecycle} from "@opendaw/lib-std"
import {LfoModulatorBox} from "@opendaw/studio-boxes"
import {LfoModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {LfoEditor} from "@/ui/modulation/editors/LfoEditor.tsx"

export const createModulatorEditor = (lifecycle: Lifecycle,
                                      service: StudioService,
                                      modulator: LfoModulatorBoxAdapter): JsxValue =>
    asDefined(modulator.box.accept<JsxValue>({
        visitLfoModulatorBox: (_box: LfoModulatorBox) => (
            <LfoEditor lifecycle={lifecycle} service={service} modulator={modulator}/>
        )
    }), `No editor for ${modulator.box.name}`)
