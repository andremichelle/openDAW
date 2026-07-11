import {DefaultObservableValue, EmptyExec, isDefined, Nullable, Option} from "@opendaw/lib-std"
import {RouteLocation} from "@opendaw/lib-jsx"
import {Workspace} from "@/ui/workspace/Workspace.ts"
import {ProjectProfileService} from "@/service/ProjectProfileService"

// The project profile is the single source of truth: project open ⇔ "/create" + a studio screen,
// no project ⇔ "/" + dashboard. Other routes are plain pages and leave everything untouched.
// Routes never mutate state directly: "/" with an open project is a close request (confirmed when
// there are unsaved changes), "/create" without a project is invalid and re-derived back to "/".
export class StudioNavigation {
    readonly #screen: DefaultObservableValue<Nullable<Workspace.ScreenKeys>>
    readonly #profiles: ProjectProfileService

    #confirming: boolean = false

    constructor(screen: DefaultObservableValue<Nullable<Workspace.ScreenKeys>>, profiles: ProjectProfileService) {
        this.#screen = screen
        this.#profiles = profiles
        RouteLocation.get().catchupAndSubscribe(({path}) => {
            const hasProfile = this.#profiles.getValue().nonEmpty()
            if (path === "/" && hasProfile) {
                this.closeProject().then(EmptyExec)
            } else if (path === "/create" && !hasProfile) {
                RouteLocation.get().replaceWith("/")
            }
        })
    }

    switchScreen(key: Nullable<Workspace.ScreenKeys>): void {
        if (key === "dashboard") {
            this.closeProject().then(EmptyExec)
        } else {
            this.#screen.setValue(key)
            if (isDefined(key)) {RouteLocation.get().navigateTo("/create")}
        }
    }

    async closeProject(): Promise<void> {
        if (this.#profiles.getValue().isEmpty()) {
            this.#screen.setValue("dashboard")
            RouteLocation.get().navigateTo("/")
            return
        }
        if (this.#confirming) {return}
        this.#confirming = true
        const approved = await this.#profiles.approveLosingChanges()
        this.#confirming = false
        if (approved) {
            this.#profiles.setValue(Option.None)
        } else {
            RouteLocation.get().navigateTo("/create")
        }
    }

    onProjectOpened(): void {
        this.#screen.setValue("default")
        const route = RouteLocation.get()
        if (route.path === "/") {
            route.navigateTo("/create")
        } else {
            route.replaceWith("/create")
        }
    }

    onProjectClosed(): void {
        this.#screen.setValue("dashboard")
        const route = RouteLocation.get()
        if (route.path === "/create") {route.replaceWith("/")}
    }
}
