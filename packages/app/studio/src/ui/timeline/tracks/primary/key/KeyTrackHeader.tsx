import css from "./KeyTrackHeader.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {Editing, Lifecycle} from "@opendaw/lib-std"
import {TimelineBox} from "@opendaw/studio-boxes"

const className = Html.adoptStyleSheet(css, "KeyTrackHeader")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    timelineBox: TimelineBox
}

export const KeyTrackHeader = ({lifecycle, editing, timelineBox}: Construct) => (
    <div className={className}>
        <header>
            <span>Key</span>
            <Checkbox lifecycle={lifecycle}
                      model={EditWrapper.forValue(editing, timelineBox.keyTrack.enabled)}>
                <Icon symbol={IconSymbol.Checkbox} style={{fontSize: "11px"}}/>
            </Checkbox>
        </header>
    </div>
)
