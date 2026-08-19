import css from "./LfoEditor.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {LfoModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ModulatorEditor} from "@/ui/modulation/ModulatorEditor.tsx"
import {ShapeDisplay} from "@/ui/modulation/editors/ShapeDisplay.tsx"
import {ModulatorKnob} from "@/ui/modulation/ModulatorKnob.tsx"

const className = Html.adoptStyleSheet(css, "LfoEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: LfoModulatorBoxAdapter
}

export const LfoEditor = ({lifecycle, service, modulator}: Construct) => {
    const {shape, rateSync, rateAbsolute, phase, amount, exponent} = modulator.namedParameter
    return (
        <ModulatorEditor lifecycle={lifecycle} service={service} modulator={modulator}>
            <div className={className}>
                <ShapeDisplay lifecycle={lifecycle} modulator={modulator}/>
                <div className="knobs">
                    <div className="section"/>
                    {[shape, rateSync, rateAbsolute, exponent, phase, amount].map(parameter => (
                        <ModulatorKnob lifecycle={lifecycle} service={service} parameter={parameter}
                                       anchor={parameter === exponent ? 0.5 : 0.0}/>
                    ))}
                </div>
            </div>
        </ModulatorEditor>
    )
}
