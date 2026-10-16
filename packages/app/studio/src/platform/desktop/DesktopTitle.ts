import {StudioService} from "@/service/StudioService"
import {Shell} from "@/platform/desktop/Shell"

// unsaved changes have no notification, so the state is sampled
export namespace DesktopTitle {
    const state = {sent: ""}

    export const attach = (service: StudioService): void => {
        setInterval(() => {
            const profile = service.projectProfileService.getValue()
            const title = profile.mapOr(({meta: {name}}) => name.trim().length > 0 ? name : "Untitled", "")
            const edited = profile.mapOr(current => current.hasUnsavedChanges(), false)
            const key = `${edited}:${title}`
            if (key === state.sent) {return}
            state.sent = key
            Shell.request("title", {title, edited: String(edited)}).catch(error => console.warn("[DesktopTitle]", error))
        }, 500)
    }
}
