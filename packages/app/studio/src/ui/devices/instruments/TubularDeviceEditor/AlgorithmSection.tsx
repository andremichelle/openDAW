import css from "./AlgorithmSection.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Colors} from "@opendaw/studio-enums"
import {band, display, labelControl, labelRadio, labelStack, SectionConstruct} from "./SectionControls"
import {TubularAlgorithmDisplay} from "./TubularAlgorithmDisplay"

const className = Html.adoptStyleSheet(css, "AlgorithmSection")

// The algorithm as a drawn diagram (from Tubular.roles) with Osc key sync in its header, Algorithm and
// Feedback, and a strip of all six operators (name = jump to its tab, Level, Switch) so carriers and
// modulators balance without tab hopping.
export const AlgorithmSection = (construct: SectionConstruct) => {
    const {lifecycle, service, adapter} = construct
    const {editing} = service.project
    const {algorithm, feedback, oscKeySync, operators} = adapter.namedParameter
    const canvas = <TubularAlgorithmDisplay lifecycle={lifecycle} algorithm={algorithm} box={13} padding={6} labels={true}/>
    return (
        <div className={`${className} rows-3`}>
            {band(Colors.orange, [1, 2], [5, 8], "ALGO")}
            {band(Colors.blue, [2, 4], [5, 8], "LEVELS")}
            {display([1, 4], [1, 5], canvas)}
            {labelControl(construct, algorithm)}
            {labelControl(construct, feedback)}
            {labelRadio(lifecycle, "Osc Sync", EditWrapper.forAutomatableParameter(editing, oscKeySync), ["OFF", "ON"])}
            {operators.map((operator, index) => labelStack(construct, `OP ${index + 1}`, operator.outputLevel,
                EditWrapper.forAutomatableParameter(editing, operator.enabled), `Operator ${index + 1} on/off`))}
        </div>
    )
}
