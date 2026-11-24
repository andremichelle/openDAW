import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {Button} from "@/ui/components/Button.tsx"
import {DefaultObservableValue, isDefined, Lifecycle, Option, Terminator} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {ProjectProfile} from "@opendaw/studio-core"
import {Surface} from "@/ui/surface/Surface"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const MidiMapModeButton = ({lifecycle, service}: Construct) => {
    const {projectProfileService} = service
    const disabled = new DefaultObservableValue<boolean>(true)
    const button: HTMLElement = (
        <Button lifecycle={lifecycle}
                disabled={disabled}
                appearance={{
                    color: Colors.gray,
                    activeColor: Colors.purple,
                    tooltip: "MIDI Map Mode: click a control, then move a controller (Esc to leave)"
                }}
                onClick={() => service.runIfProject(({midiLearning: {mapMode}}) =>
                    mapMode.setValue(!mapMode.getValue()))}>
            <span style={{fontSize: "0.625em", fontWeight: "600", letterSpacing: "0.05em"}}>MAP</span>
        </Button>)
    const projectLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(projectProfileService.catchupAndSubscribe((optProfile: Option<ProjectProfile>) => {
        projectLifecycle.terminate()
        button.classList.remove("active")
        disabled.setValue(optProfile.isEmpty())
        optProfile.ifSome(({project: {midiLearning: {mapMode}}}) => projectLifecycle.ownAll(
            mapMode.catchupAndSubscribe(owner => button.classList.toggle("active", owner.getValue())),
            Surface.subscribeKeyboard("keydown", event => {
                if (event.code !== "Escape" || !mapMode.getValue() || Events.isTextInput(event.target)
                    || isDefined(document.querySelector("dialog[open]"))) {return}
                event.preventDefault()
                mapMode.setValue(false)
            })))
    }))
    return button
}
