import css from "./OutSection.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Colors} from "@opendaw/studio-enums"
import {Tubular} from "@opendaw/studio-adapters"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {band, display, labelControl, labelRadio, SectionConstruct} from "./SectionControls"
import {TubularFilterDisplay} from "./TubularFilterDisplay"
import {createSpectrumRenderer} from "@/ui/devices/audio-effects/NeuralAmp/SpectrumRenderer"

const className = Html.adoptStyleSheet(css, "OutSection")

export const OutSection = (construct: SectionConstruct) => {
    const {lifecycle, service, adapter} = construct
    const {project} = service
    const {editing} = project
    const {cutoff, resonance, volume, voicingMode, tune, transpose} = adapter.namedParameter
    const spectrum: HTMLCanvasElement = <canvas onInit={canvas => lifecycle.own(createSpectrumRenderer(
        canvas, adapter.spectrum, project.liveStreamReceiver, project.engine.sampleRate))}/>
    return (
        <div className={`${className} rows-3`}>
            {band(Colors.orange, [1, 2], [5, 8], "VOICE")}
            {band(Colors.blue, [2, 3], [5, 8], "MASTER")}
            {band(Colors.green, [3, 4], [5, 8], "FILTER")}
            {display([1, 3], [1, 5], spectrum)}
            {display([3, 4], [1, 5], <TubularFilterDisplay lifecycle={lifecycle} cutoff={cutoff} resonance={resonance}/>)}
            <div className="centered" style={{gridColumn: "5 / 8"}}>
                {labelRadio(lifecycle, "Play-Mode", EditWrapper.forAutomatableParameter(editing, voicingMode), ["MONO", "POLY"])}
                {labelRadio(lifecycle, "Engine", EditWrapper.forValue(editing, adapter.box.engine), Tubular.Engines)}
            </div>
            {labelControl(construct, volume)}
            {labelControl(construct, transpose)}
            {labelControl(construct, tune)}
            {labelControl(construct, cutoff)}
            {labelControl(construct, resonance)}
        </div>
    )
}
