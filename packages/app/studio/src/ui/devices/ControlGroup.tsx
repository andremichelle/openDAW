import css from "./ControlGroup.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {Color, int, Lifecycle} from "@moises-ai/lib-std"
import {createElement, Frag} from "@moises-ai/lib-jsx"
import {AutomatableParameterFieldAdapter, DeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {BoxEditing} from "@moises-ai/lib-box"
import {MIDILearning} from "@moises-ai/studio-core"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"

const className = Html.adoptStyleSheet(css, "ControlGroup")

type Construct = {
    lifecycle: Lifecycle
    gridUV: { u: int, v: int }
    color: Color
    name: string
    editing: BoxEditing
    midiLearning: MIDILearning
    deviceAdapter: DeviceBoxAdapter
    parameters: ReadonlyArray<AutomatableParameterFieldAdapter<number>>
    style?: Partial<CSSStyleDeclaration>
}

export const ControlGroup = ({
                                 lifecycle, color, name, editing, midiLearning, deviceAdapter,
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
                        <RelativeUnitValueDragging lifecycle={lifecycle}
                                                   editing={editing}
                                                   parameter={parameter}
                                                   supressValueFlyout={true}>
                            <ParameterLabel lifecycle={lifecycle}
                                            editing={editing}
                                            midiLearning={midiLearning}
                                            adapter={deviceAdapter}
                                            parameter={parameter}
                                            framed standalone/>
                        </RelativeUnitValueDragging>
                    </Frag>
                ))}
            </div>
        </div>
    )
}