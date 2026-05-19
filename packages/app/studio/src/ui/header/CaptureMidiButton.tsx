import {Icon} from "@/ui/components/Icon.tsx"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {Button} from "@/ui/components/Button.tsx"
import {DefaultObservableValue, Lifecycle, Option, Terminator} from "@opendaw/lib-std"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ProjectProfile} from "@opendaw/studio-core"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const CaptureMidiButton = ({lifecycle, service}: Construct) => {
    const {projectProfileService} = service
    const disabled = new DefaultObservableValue<boolean>(true)
    const button: HTMLElement = (
        <Button lifecycle={lifecycle}
                disabled={disabled}
                appearance={{
                    color: Colors.gray,
                    activeColor: Colors.orange,
                    tooltip: "Create region from captured notes."
                }}
                onClick={() => service.runIfProject(project => project.commitMidiCapture())}>
            <Icon symbol={IconSymbol.Capture}/>
        </Button>)
    const captureLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(projectProfileService.catchupAndSubscribe((optProfile: Option<ProjectProfile>) => {
        captureLifecycle.terminate()
        button.classList.remove("active")
        disabled.setValue(true)
        optProfile.ifSome(({project}) => {
            captureLifecycle.own(project.subscribeMidiCaptureAvailable(available => {
                button.classList.toggle("active", available)
                disabled.setValue(!available)
            }))
        })
    }))
    return button
}
