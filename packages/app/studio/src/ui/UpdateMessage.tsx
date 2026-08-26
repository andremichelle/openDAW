import css from "./UpdateMessage.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {TextButton} from "@/ui/components/TextButton"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "UpdateMessage")

export const UpdateMessage = ({service}: { service: StudioService }) => {
    const saveAndReload = async () => {
        const profileService = service.projectProfileService
        await profileService.save()
        const unsaved = profileService.getValue().mapOr(profile => profile.hasUnsavedChanges(), false)
        if (unsaved) {return}
        location.reload()
    }
    return (
        <div className={className}>
            <span>Update available!</span>
            <TextButton onClick={() => saveAndReload()}>Save and reload</TextButton>
        </div>
    )
}