import css from "./CollabSettingsPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {BackButton} from "@/ui/pages/BackButton"
import {CollabSettings} from "@/ui/collab/CollabSettings"

const className = Html.adoptStyleSheet(css, "CollabSettingsPage")

export const CollabSettingsPage: PageFactory<StudioService> = ({}: PageContext<StudioService>) => {
    return (
        <div className={className}>
            <BackButton/>
            <h1>Collaboration Settings</h1>
            <CollabSettings/>
        </div>
    )
}
