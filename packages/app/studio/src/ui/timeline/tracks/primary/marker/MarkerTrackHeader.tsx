import css from "./MarkerTrackHeader.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {Lifecycle} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {TimelineBox} from "@opendaw/studio-boxes"

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