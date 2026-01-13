import css from "./AddParameterButton.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {asInstanceOf, UUID} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {MIDIOutputParameterBox, TrackBox} from "@moises-ai/studio-boxes"
import {IconSymbol, Pointers} from "@moises-ai/studio-enums"
import {MIDIOutputDeviceBoxAdapter, TrackType} from "@moises-ai/studio-adapters"
import {Project} from "@moises-ai/studio-core"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "AddParameterButton")

type Construct = {
    project: Project
    adapter: MIDIOutputDeviceBoxAdapter
}

export const AddParameterButton = ({project: {boxGraph, editing}, adapter}: Construct) => {
    return (
        <div className={className}
             onclick={() => editing.modify(() => {
                 const tracks = adapter.audioUnitBoxAdapter().box.tracks
                 const index = tracks.pointerHub.incoming().length

                 const nextController = Math.min(adapter.box.parameters.pointerHub.filter(Pointers.Parameter)
                     .reduce((id, {box}) => Math.max(id,
                         asInstanceOf(box, MIDIOutputParameterBox).controller.getValue() + 1), 64), 127)

                 const parameter = MIDIOutputParameterBox.create(
                     boxGraph, UUID.generate(), box => {
                         box.label.setValue("CC")
                         box.owner.refer(adapter.box.parameters)
                         box.controller.setValue(nextController)
                     })
                 TrackBox.create(boxGraph, UUID.generate(), box => {
                     box.index.setValue(index)
                     box.target.refer(parameter.value)
                     box.type.setValue(TrackType.Value)
                     box.tracks.refer(tracks)
                 })
             })}><Icon symbol={IconSymbol.Add}/> <span>CC</span></div>
    )
}