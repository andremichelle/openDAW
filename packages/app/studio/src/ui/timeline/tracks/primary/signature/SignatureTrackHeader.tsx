import css from "./SignatureTrackHeader.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {Lifecycle} from "@opendaw/lib-std"
import {TimelineBox} from "@opendaw/studio-boxes"
import {BoxEditing} from "@opendaw/lib-box"

const className = Html.adoptStyleSheet(css, "SignatureTrackHeader")

type Construct = {
    lifecycle: Lifecycle
    editing: BoxEditing
    timelineBox: TimelineBox
}

export const SignatureTrackHeader = ({lifecycle, editing, timelineBox}: Construct) => {
    return (
        <div className={className}>
            <header>
                <span>Signature</span>
                <Checkbox lifecycle={lifecycle}
                          model={EditWrapper.forValue(editing, timelineBox.signatureTrack.enabled)}>
                    <Icon symbol={IconSymbol.Checkbox} style={{fontSize: "11px"}}/>
                </Checkbox>
            </header>
        </div>
    )
}