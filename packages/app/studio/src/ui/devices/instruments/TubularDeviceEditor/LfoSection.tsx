import css from "./LfoSection.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {headerToggle, radioCell, SectionConstruct, sectionKnob} from "./SectionControls"
import {TubularLfoDisplay} from "./TubularLfoDisplay"

const className = Html.adoptStyleSheet(css, "LfoSection")

const flipped = (symbol: IconSymbol): HTMLElement => (
    <span style={{transform: "scaleX(-1)", display: "inline-flex"}}>
        <Icon symbol={symbol}/>
    </span>
)

// The LFO shape display (key sync in its header), then Speed, Delay, PM Depth, AM Depth / Wave, PM Sens.
export const LfoSection = (construct: SectionConstruct) => {
    const {lifecycle, service, adapter} = construct
    const {editing} = service.project
    const {lfo, pitchModSens} = adapter.namedParameter
    return (
        <div className={className}>
            <div className="display">
                <header>
                    <span className="title">LFO</span>
                    {headerToggle(lifecycle, EditWrapper.forAutomatableParameter(editing, lfo.sync), ["FREE", "SYNC"])}
                </header>
                <TubularLfoDisplay lifecycle={lifecycle} wave={lfo.wave} speed={lfo.speed} delay={lfo.delay}/>
            </div>
            {sectionKnob(construct, lfo.speed, "Speed")}
            {sectionKnob(construct, lfo.delay, "Delay")}
            {sectionKnob(construct, lfo.pmDepth, "PM Depth")}
            {sectionKnob(construct, lfo.amDepth, "AM Depth")}
            {radioCell(lifecycle, "Wave", EditWrapper.forAutomatableParameter(editing, lfo.wave), [
                {value: 0, tooltip: "Triangle", element: <Icon symbol={IconSymbol.Triangle}/>},
                {value: 1, tooltip: "Saw Down", element: flipped(IconSymbol.Sawtooth)},
                {value: 2, tooltip: "Saw Up", element: <Icon symbol={IconSymbol.Sawtooth}/>},
                {value: 3, tooltip: "Square", element: <Icon symbol={IconSymbol.Square}/>},
                {value: 4, tooltip: "Sine", element: <Icon symbol={IconSymbol.Sine}/>},
                {value: 5, tooltip: "Sample & Hold", element: <Icon symbol={IconSymbol.Random}/>}
            ], 3, "10px")}
            {sectionKnob(construct, pitchModSens, "PM Sens")}
        </div>
    )
}
