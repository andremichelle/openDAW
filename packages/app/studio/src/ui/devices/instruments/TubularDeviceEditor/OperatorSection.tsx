import css from "./OperatorSection.sass?inline"
import {int} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Tubular} from "@opendaw/studio-adapters"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {radioCell, SectionConstruct, sectionKnob} from "./SectionControls"
import {DxEnvelopeEditor} from "./DxEnvelopeEditor"

const className = Html.adoptStyleSheet(css, "OperatorSection")

// One operator (panel index 0-5): the envelope widget, then Switch (titled with the operator's role in the
// current algorithm), Level, Coarse, Fine, Detune / Mode, Break point, L depth, R depth, Rate scaling /
// L curve, R curve, Amp mod sens, Velocity sens.
export const OperatorSection = (construct: SectionConstruct, index: int) => {
    const {lifecycle, service, adapter} = construct
    const {editing} = service.project
    const operator = adapter.namedParameter.operators[index]
    const {algorithm} = adapter.namedParameter
    const rates = [operator.rate1, operator.rate2, operator.rate3, operator.rate4]
    const levels = [operator.level1, operator.level2, operator.level3, operator.level4]
    const switchCell = radioCell(lifecycle, "", EditWrapper.forAutomatableParameter(editing, operator.enabled), ["OFF", "ON"])
    const title = switchCell.querySelector("h5") as HTMLElement
    lifecycle.own(algorithm.catchupAndSubscribe(() => {
        const role = Tubular.roles(algorithm.getValue())[index]
        const feedback = role.feedback ? " ⟲" : ""
        title.textContent = role.carrier ? `CARRIER${feedback}` : `MOD → ${role.targets.join(",")}${feedback}`
    }))
    return (
        <div className={className}>
            <div className="envelope">
                <DxEnvelopeEditor lifecycle={lifecycle} editing={editing} rates={rates} levels={levels}/>
            </div>
            {switchCell}
            {sectionKnob(construct, operator.outputLevel, "Level")}
            {sectionKnob(construct, operator.coarse, "Coarse")}
            {sectionKnob(construct, operator.fine, "Fine")}
            {sectionKnob(construct, operator.detune, "Detune")}
            {radioCell(lifecycle, "Mode", EditWrapper.forAutomatableParameter(editing, operator.mode), ["RATIO", "FIXED"])}
            {sectionKnob(construct, operator.breakPoint, "Break Pt")}
            {sectionKnob(construct, operator.leftDepth, "L Depth")}
            {sectionKnob(construct, operator.rightDepth, "R Depth")}
            {sectionKnob(construct, operator.rateScaling, "Rate Scl")}
            {sectionKnob(construct, operator.leftCurve, "L Curve")}
            {sectionKnob(construct, operator.rightCurve, "R Curve")}
            {sectionKnob(construct, operator.ampModSens, "AMS")}
            {sectionKnob(construct, operator.velocitySens, "Velocity")}
        </div>
    )
}
