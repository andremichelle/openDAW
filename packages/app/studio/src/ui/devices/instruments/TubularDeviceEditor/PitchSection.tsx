import css from "./PitchSection.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Colors} from "@opendaw/studio-enums"
import {band, display, labelControl, SectionConstruct} from "./SectionControls"
import {DxEnvelopeEditor} from "./DxEnvelopeEditor"

const className = Html.adoptStyleSheet(css, "PitchSection")

// The pitch envelope (level 50 = no shift) beside its rates and levels.
export const PitchSection = (construct: SectionConstruct) => {
    const {lifecycle, service, adapter} = construct
    const {editing} = service.project
    const {pitchEnvelope} = adapter.namedParameter
    const rates = [pitchEnvelope.rate1, pitchEnvelope.rate2, pitchEnvelope.rate3, pitchEnvelope.rate4]
    const levels = [pitchEnvelope.level1, pitchEnvelope.level2, pitchEnvelope.level3, pitchEnvelope.level4]
    return (
        <div className={`${className} rows-4`}>
            {band(Colors.yellow, [1, 5], [6, 8], "STAGES")}
            {display([1, 5], [1, 6], <DxEnvelopeEditor lifecycle={lifecycle} editing={editing} rates={rates} levels={levels} centred={true}/>)}
            {rates.flatMap((rate, index) => [
                labelControl(construct, rate, `Rate ${index + 1}`),
                labelControl(construct, levels[index], `Level ${index + 1}`)
            ])}
        </div>
    )
}
