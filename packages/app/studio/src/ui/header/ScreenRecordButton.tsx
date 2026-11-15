import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {ScreenRecorder} from "@/service/ScreenRecorder"
import {ShortcutTooltip} from "@/ui/shortcuts/ShortcutTooltip"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"

type Construct = {
    lifecycle: Lifecycle
    recorder: ScreenRecorder
}

export const ScreenRecordButton = ({lifecycle, recorder}: Construct) => {
    const element: HTMLElement = (
        <div style={{display: "flex"}}>
            <Button lifecycle={lifecycle}
                    onClick={() => recorder.stop()}
                    appearance={{
                        color: Colors.red, activeColor: Colors.red, cursor: "pointer",
                        tooltip: ShortcutTooltip.create("Stop Studio Recording", GlobalShortcuts["toggle-studio-recording"].shortcut)
                    }}>
                <Icon symbol={IconSymbol.Stop}/>
            </Button>
        </div>
    )
    lifecycle.own(recorder.recording.catchupAndSubscribe(owner => element.classList.toggle("hidden", !owner.getValue())))
    return element
}
