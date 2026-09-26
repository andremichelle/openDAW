import css from "./OperatorSection.sass?inline"
import {int} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Tubular} from "@opendaw/studio-adapters"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {headerToggle, SectionConstruct, sectionKnob, switchCheckbox} from "./SectionControls"
import {DxEnvelopeEditor} from "./DxEnvelopeEditor"

const className = Html.adoptStyleSheet(css, "OperatorSection")

// One operator (panel index 0-5): the envelope with the operator's role in the current algorithm, its switch
// and mode in the header, then Level, Coarse, Fine, Detune / Break Pt, L Depth, R Depth, Rate Scl / L Curve,
// R Curve, AMS, Velocity.
export const OperatorSection = (construct: SectionConstruct, index: int) => {
    const {lifecycle, service, adapter} = construct
    const {editing} = service.project
    const operator = adapter.namedParameter.operators[index]
    const {algorithm} = adapter.namedParameter
    const rates = [operator.rate1, operator.rate2, operator.rate3, operator.rate4]
    const levels = [operator.level1, operator.level2, operator.level3, operator.level4]
    const role: HTMLElement = <span className="role"/>
    lifecycle.own(algorithm.catchupAndSubscribe(() => {
        const {carrier, targets, feedback} = Tubular.roles(algorithm.getValue())[index]
        role.textContent = `${carrier ? "CARRIER" : `MOD → ${targets.join(",")}`}${feedback ? " · FB" : ""}`
    }))
    return (
        <div className={className}>
            <div className="display">
                <header>
                    <span className="title">{`OP ${index + 1}`}</span>
                    {role}
                    {headerToggle(lifecycle, EditWrapper.forAutomatableParameter(editing, operator.mode), ["RATIO", "FIXED"])}
                    {switchCheckbox(lifecycle, EditWrapper.forAutomatableParameter(editing, operator.enabled), "Operator on/off")}
                </header>
                <DxEnvelopeEditor lifecycle={lifecycle} editing={editing} rates={rates} levels={levels}/>
            </div>
            {sectionKnob(construct, operator.outputLevel, "Level")}
            {sectionKnob(construct, operator.coarse, "Coarse")}
            {sectionKnob(construct, operator.fine, "Fine")}
            {sectionKnob(construct, operator.detune, "Detune")}
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
