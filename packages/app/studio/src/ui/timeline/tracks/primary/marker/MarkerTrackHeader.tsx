import css from "./MarkerTrackHeader.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@moises-ai/studio-enums"
import {Lifecycle} from "@moises-ai/lib-std"
import {BoxEditing} from "@moises-ai/lib-box"
import {TimelineBox} from "@moises-ai/studio-boxes"

const className = Html.adoptStyleSheet(css, "MarkerTrackHeader")

type Construct = {
    lifecycle: Lifecycle
    editing: BoxEditing
    timelineBox: TimelineBox
}

export const MarkerTrackHeader = ({lifecycle, editing, timelineBox}: Construct) => {
    return (
        <div className={className}>
            <header>
                <span>Markers</span>
                <Checkbox lifecycle={lifecycle}
                          model={EditWrapper.forValue(editing, timelineBox.markerTrack.enabled)}>
                    <Icon symbol={IconSymbol.Checkbox} style={{fontSize: "11px"}}/>
                </Checkbox>
            </header>
        </div>
    )
}