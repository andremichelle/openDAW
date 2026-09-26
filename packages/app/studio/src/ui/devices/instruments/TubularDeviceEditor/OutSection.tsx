import css from "./OutSection.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Tubular} from "@opendaw/studio-adapters"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {radioCell, SectionConstruct, sectionKnob} from "./SectionControls"

const className = Html.adoptStyleSheet(css, "OutSection")

// Play-Mode, Engine / Volume, Transpose, Tune / Cutoff, Resonance
export const OutSection = (construct: SectionConstruct) => {
    const {lifecycle, service, adapter} = construct
    const {editing} = service.project
    const {cutoff, resonance, volume, voicingMode, tune, transpose} = adapter.namedParameter
    return (
        <div className={className}>
            {radioCell(lifecycle, "Play-Mode", EditWrapper.forAutomatableParameter(editing, voicingMode), ["MONO", "POLY"])}
            {radioCell(lifecycle, "Engine", EditWrapper.forValue(editing, adapter.box.engine), Tubular.Engines, 2)}
            <div/>
            {sectionKnob(construct, volume)}
            {sectionKnob(construct, transpose)}
            {sectionKnob(construct, tune)}
            <div/>
            {sectionKnob(construct, cutoff)}
            {sectionKnob(construct, resonance)}
        </div>
    )
}
