import css from "./PitchSection.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {SectionConstruct, sectionKnob} from "./SectionControls"
import {DxEnvelopeEditor} from "./DxEnvelopeEditor"

const className = Html.adoptStyleSheet(css, "PitchSection")

// The pitch envelope (level 50 = no shift) beside its rate and level knobs.
export const PitchSection = (construct: SectionConstruct) => {
    const {lifecycle, service, adapter} = construct
    const {editing} = service.project
    const {pitchEnvelope} = adapter.namedParameter
    const rates = [pitchEnvelope.rate1, pitchEnvelope.rate2, pitchEnvelope.rate3, pitchEnvelope.rate4]
    const levels = [pitchEnvelope.level1, pitchEnvelope.level2, pitchEnvelope.level3, pitchEnvelope.level4]
    return (
        <div className={className}>
            <div className="display">
                <header><span className="title">PITCH EG</span><span className="role">50 = no shift</span></header>
                <DxEnvelopeEditor lifecycle={lifecycle} editing={editing} rates={rates} levels={levels} centred={true}/>
            </div>
            {rates.map((rate, index) => sectionKnob(construct, rate, `Rate ${index + 1}`))}
            {levels.map((level, index) => sectionKnob(construct, level, `Level ${index + 1}`))}
        </div>
    )
}
