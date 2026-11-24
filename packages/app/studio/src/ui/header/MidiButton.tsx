import css from "./MidiButton.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {MidiDevices} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "MidiButton")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const MidiButton = ({lifecycle, service}: Construct) => {
    const available = MidiDevices.available()
    const isMappingVisible = (): boolean =>
        service.visibleCodeEditor.mapOr(state => state.type === "midi-mapping", false)
    const toggleMapping = () => service.runIfProject(() => {
        if (isMappingVisible()) {
            service.closeCodeEditor()
        } else {
            service.openCodeEditor({type: "midi-mapping", previousScreen: service.layout.screen.getValue()})
        }
    })
    const button: HTMLElement = (
        <Button lifecycle={lifecycle}
                className={className}
                onClick={() => available.getValue() ? toggleMapping() : available.setValue(true)}
                appearance={{
                    activeColor: Colors.orange,
                    cursor: "pointer",
                    tooltip: () => available.getValue() ? "MIDI Mapping" : "MIDI Access"
                }}>
            <Icon symbol={IconSymbol.Midi}/>
        </Button>
    )
    lifecycle.own(available.catchupAndSubscribe(owner => button.classList.toggle("active", owner.getValue())))
    return button
}
