import css from "./ChordTrackHeader.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {Editing, Lifecycle} from "@opendaw/lib-std"
import {TimelineBox} from "@opendaw/studio-boxes"
import {TextTooltip} from "@/ui/surface/TextTooltip"

const className = Html.adoptStyleSheet(css, "ChordTrackHeader")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    timelineBox: TimelineBox
}

export const ChordTrackHeader = ({lifecycle, editing, timelineBox}: Construct) => (
    <div className={className}>
        <header>
            <span onInit={element => lifecycle.own(TextTooltip.default(element, () =>
                "Clicking a chord plays it on the instrument in edit mode. Keys 1 to 7 set its step, Delete removes it."))}>
                Chords
            </span>
            <Checkbox lifecycle={lifecycle}
                      model={EditWrapper.forValue(editing, timelineBox.chordTrack.enabled)}>
                <Icon symbol={IconSymbol.Checkbox} style={{fontSize: "11px"}}/>
            </Checkbox>
        </header>
    </div>
)
