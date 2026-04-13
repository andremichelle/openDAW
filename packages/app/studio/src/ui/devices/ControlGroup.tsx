import css from "./ControlGroup.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Color, Editing, int, Lifecycle} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {AudioUnitTracks, AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {MIDILearning} from "@opendaw/studio-core"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {AutomationControl} from "@/ui/components/AutomationControl"

const className = Html.adoptStyleSheet(css, "ControlGroup")

type Construct = {
    lifecycle: Lifecycle
    gridUV: { u: int, v: int }
    color: Color
    name: string
    editing: Editing
    midiLearning: MIDILearning
    tracks: AudioUnitTracks
    parameters: ReadonlyArray<AutomatableParameterFieldAdapter<number>>
    style?: Partial<CSSStyleDeclaration>
}

export const ControlGroup = ({
                                 lifecycle, color, name, editing, midiLearning, tracks,
                                 parameters, gridUV: {u, v}, style
                             }: Construct) => {
    return (
        <div className={className}
             style={{...style, ...{gridArea: `${v + 1}/${u + 1}/auto/span 2`}}}
             onInit={element => element.style.setProperty("--background-color", color?.toString() ?? "red")}>
            <h1>{name}</h1>
            <div className="controls">
                {parameters.map(parameter => (
                    <Frag>
                        <span className="parameter-name">{parameter.name}</span>
                        <AutomationControl lifecycle={lifecycle}
                                           editing={editing}
                                           midiLearning={midiLearning}
                                           tracks={tracks}
                                           parameter={parameter}>
                            <RelativeUnitValueDragging lifecycle={lifecycle}
                                                       editing={editing}
                                                       parameter={parameter}
                                                       supressValueFlyout={true}>
                                <ParameterLabel lifecycle={lifecycle}
                                                parameter={parameter}
                                                framed/>
                            </RelativeUnitValueDragging>
                        </AutomationControl>
                    </Frag>
                ))}
            </div>
        </div>
    )
}