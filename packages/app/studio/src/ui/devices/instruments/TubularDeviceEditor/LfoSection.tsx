import css from "./LfoSection.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {band, display, iconRadio, labelControl, labelRadio, SectionConstruct} from "./SectionControls"
import {TubularLfoDisplay} from "./TubularLfoDisplay"

const className = Html.adoptStyleSheet(css, "LfoSection")

const flipped = (symbol: IconSymbol): HTMLElement => (
    <span style={{transform: "scaleX(-1)", display: "inline-flex"}}>
        <Icon symbol={symbol}/>
    </span>
)

export const LfoSection = (construct: SectionConstruct) => {
    const {lifecycle, service, adapter} = construct
    const {editing} = service.project
    const {lfo, pitchModSens} = adapter.namedParameter
    return (
        <div className={`${className} rows-4`}>
            {band(Colors.blue, [1, 2], [6, 8], "WAVE")}
            {band(Colors.purple, [2, 5], [6, 8], "LFO")}
            {display([1, 5], [1, 6], <TubularLfoDisplay lifecycle={lifecycle} wave={lfo.wave} speed={lfo.speed} delay={lfo.delay}/>)}
            {iconRadio(lifecycle, EditWrapper.forAutomatableParameter(editing, lfo.wave), [
                {value: 0, tooltip: "Triangle", element: <Icon symbol={IconSymbol.Triangle}/>},
                {value: 1, tooltip: "Saw Down", element: flipped(IconSymbol.Sawtooth)},
                {value: 2, tooltip: "Saw Up", element: <Icon symbol={IconSymbol.Sawtooth}/>},
                {value: 3, tooltip: "Square", element: <Icon symbol={IconSymbol.Square}/>},
                {value: 4, tooltip: "Sine", element: <Icon symbol={IconSymbol.Sine}/>},
                {value: 5, tooltip: "Sample & Hold", element: <Icon symbol={IconSymbol.Random}/>}
            ], 2, "11px")}
            {labelControl(construct, lfo.speed, "Speed")}
            {labelControl(construct, lfo.delay, "Delay")}
            {labelControl(construct, lfo.pmDepth, "PM Depth")}
            {labelControl(construct, lfo.amDepth, "AM Depth")}
            {labelControl(construct, pitchModSens, "PM Sens")}
            {labelRadio(lifecycle, "Key Sync", EditWrapper.forAutomatableParameter(editing, lfo.sync), ["OFF", "ON"])}
        </div>
    )
}
