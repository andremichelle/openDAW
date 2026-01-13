import css from "./SignatureTrackHeader.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {IconSymbol} from "@moises-ai/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {Lifecycle} from "@moises-ai/lib-std"
import {TimelineBox} from "@moises-ai/studio-boxes"
import {BoxEditing} from "@moises-ai/lib-box"

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