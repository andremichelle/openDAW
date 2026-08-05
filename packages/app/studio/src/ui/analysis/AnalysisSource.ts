import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {Project} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"

// Binds to the active project and re-binds when it changes. `bind` receives a runtime terminator that is
// cleared before each re-bind, so subscriptions registered on it drop when the project changes or the panel
// unmounts (which is what gates the engine-side measurement to when a card is actually visible).
export const observeProject = (lifecycle: Lifecycle, service: StudioService,
                               bind: (project: Project, runtime: Terminator) => void): void => {
    const runtime = lifecycle.own(new Terminator())
    lifecycle.own(service.projectProfileService.catchupAndSubscribe(optProfile => {
        runtime.terminate()
        optProfile.ifSome(({project}) => bind(project, runtime))
    }))
}
