import css from "./ValueRange.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Column} from "@/ui/devices/Column.tsx"
import {ParameterLabel} from "@/ui/components/ParameterLabel.tsx"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {attachModulatorParameterContextMenu} from "@/ui/menu/automation.ts"
import {installControlSourceIndicator} from "@/ui/components/AutomationControl.tsx"
import {LKR} from "@/ui/devices/constants.ts"

const className = Html.adoptStyleSheet(css, "ValueRange")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: ModulatorBoxAdapter
}

export const ValueRange = ({lifecycle, service, modulator}: Construct): HTMLElement => {
    const {editing, midiLearning} = service.project
    const {amount} = modulator
    const label: HTMLElement = (<ParameterLabel lifecycle={lifecycle} parameter={amount} framed={true}/>)
    const column: HTMLElement = (
        <Column ems={LKR}>
            <h5>{amount.name}</h5>
            <div className={className}>
                <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={amount}
                                           supressValueFlyout={true}>
                    {label}
                </RelativeUnitValueDragging>
                <Checkbox lifecycle={lifecycle}
                          model={EditWrapper.forValue(editing, modulator.bipolarField)}
                          appearance={{
                              framed: true,
                              color: Colors.gray,
                              activeColor: Colors.blue,
                              tooltip: "Bipolar"
                          }}>
                    <Icon symbol={IconSymbol.Bipolar}/>
                </Checkbox>
            </div>
        </Column>
    )
    installControlSourceIndicator(lifecycle, amount, column, label)
    lifecycle.own(attachModulatorParameterContextMenu(editing, midiLearning, amount, label))
    return column
}
