import css from "./StepsEditor.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {StepsModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ModulatorEditor} from "@/ui/modulation/ModulatorEditor.tsx"
import {StepsDisplay} from "@/ui/modulation/editors/StepsDisplay.tsx"
import {ParameterLabelKnob} from "@/ui/devices/ParameterLabelKnob.tsx"
import {Column} from "@/ui/devices/Column.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {LKR} from "@/ui/devices/constants.ts"

const className = Html.adoptStyleSheet(css, "StepsEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: StepsModulatorBoxAdapter
}

export const StepsEditor = ({lifecycle, service, modulator}: Construct) => {
    const {editing} = service.project
    const {count, rateSync, rateAbsolute, smooth, phase, amount, direction} = modulator.namedParameter
    return (
        <ModulatorEditor lifecycle={lifecycle} service={service} modulator={modulator}>
            <div className={className}>
                <StepsDisplay lifecycle={lifecycle} editing={editing} modulator={modulator}/>
                <div className="knobs">
                    <div className="section"/>
                    {[count, rateSync, rateAbsolute, smooth, phase, amount, direction].map(parameter => (
                        <Column ems={LKR}>
                            <h5>{parameter.name}</h5>
                            <ParameterLabelKnob lifecycle={lifecycle} editing={editing} parameter={parameter}/>
                        </Column>
                    ))}
                </div>
                <div className="buttons">
                    <Button lifecycle={lifecycle}
                            onClick={() => editing.modify(() => modulator.randomize())}
                            appearance={{framed: true, color: Colors.orange}}>Random</Button>
                    <Button lifecycle={lifecycle}
                            onClick={() => editing.modify(() => modulator.rotate(-1))}
                            appearance={{framed: true, color: Colors.blue}}>{"<"}</Button>
                    <Button lifecycle={lifecycle}
                            onClick={() => editing.modify(() => modulator.rotate(1))}
                            appearance={{framed: true, color: Colors.blue}}>{">"}</Button>
                    <Button lifecycle={lifecycle}
                            onClick={() => editing.modify(() => modulator.clear())}
                            appearance={{framed: true, color: Colors.green}}>Clear</Button>
                </div>
            </div>
        </ModulatorEditor>
    )
}
