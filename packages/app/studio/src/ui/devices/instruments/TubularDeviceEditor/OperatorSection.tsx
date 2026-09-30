import css from "./OperatorSection.sass?inline"
import {int} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Colors} from "@opendaw/studio-enums"
import {Tubular} from "@opendaw/studio-adapters"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {band, display, labelControl, labelRadio, labelSwitch, SectionConstruct} from "./SectionControls"
import {DxEnvelopeEditor} from "./DxEnvelopeEditor"
import {TubularScalingDisplay} from "./TubularScalingDisplay"

const className = Html.adoptStyleSheet(css, "OperatorSection")

// One operator (panel index 0-5). Rows: oscillator / envelope rates + sensitivity / envelope levels +
// sensitivity / keyboard level scaling. The display column shows the role in the current algorithm, the
// envelope and the level scaling curve.
export const OperatorSection = (construct: SectionConstruct, index: int) => {
    const {lifecycle, service, adapter} = construct
    const {editing} = service.project
    const operator = adapter.namedParameter.operators[index]
    const {algorithm} = adapter.namedParameter
    const rates = [operator.rate1, operator.rate2, operator.rate3, operator.rate4]
    const levels = [operator.level1, operator.level2, operator.level3, operator.level4]
    const head: HTMLElement = (
        <h3 className="head" style={{"--color": Colors.blue.toString()}}>{`OPERATOR ${index + 1}`}</h3>
    )
    const caption: HTMLElement = <h3 className="caption"/>
    lifecycle.own(algorithm.catchupAndSubscribe(() => {
        const {carrier, targets, feedback} = Tubular.roles(algorithm.getValue())[index]
        const role = carrier ? "Carrier" : `Mod → OP ${targets.join(",")}`
        caption.textContent = `${role}${feedback ? " · FB" : ""}`
    }))
    return (
        <div className={`${className} rows-4`}>
            {band(Colors.blue, [1, 2], [2, 8], "OSC")}
            {band(Colors.purple, [2, 4], [2, 6])}
            {band(Colors.yellow, [2, 4], [6, 8], "SENS")}
            {band(Colors.green, [4, 5], [2, 8], "SCALE")}
            <div className="title" style={{gridArea: "1 / 1 / 2 / 2"}}>
                {head}
                {caption}
            </div>
            {display([2, 4], [1, 2], <DxEnvelopeEditor lifecycle={lifecycle} editing={editing} rates={rates} levels={levels}/>)}
            {display([4, 5], [1, 2], <TubularScalingDisplay lifecycle={lifecycle} editing={editing} operator={operator}/>)}
            {labelControl(construct, operator.coarse, "Coarse")}
            {labelControl(construct, operator.fine, "Fine")}
            {labelControl(construct, operator.detune, "Detune")}
            {labelControl(construct, operator.outputLevel, "Level")}
            {labelRadio(lifecycle, "Mode", EditWrapper.forAutomatableParameter(editing, operator.mode), ["RATIO", "FIXED"])}
            {labelSwitch(lifecycle, "Switch", EditWrapper.forAutomatableParameter(editing, operator.enabled), "Operator on/off")}
            {rates.map((rate, stage) => labelControl(construct, rate, `Rate ${stage + 1}`))}
            {labelControl(construct, operator.ampModSens, "AMS")}
            {labelControl(construct, operator.velocitySens, "Velocity")}
            {levels.map((level, stage) => labelControl(construct, level, `Level ${stage + 1}`))}
            {labelControl(construct, operator.rateScaling, "Rate Scl")}
            <div/>
            {labelControl(construct, operator.leftCurve, "L Curve")}
            {labelControl(construct, operator.leftDepth, "L Depth")}
            {labelControl(construct, operator.breakPoint, "Break Pt")}
            {labelControl(construct, operator.rightDepth, "R Depth")}
            {labelControl(construct, operator.rightCurve, "R Curve")}
        </div>
    )
}
