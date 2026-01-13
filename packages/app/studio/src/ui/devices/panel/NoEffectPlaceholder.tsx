import css from "./NoEffectPlaceholder.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {TextButton} from "@/ui/components/TextButton"
import {PanelType} from "@/ui/workspace/PanelType"

const className = Html.adoptStyleSheet(css, "NoEffectPlaceholder")

type Construct = {
    service: StudioService
}

export const NoEffectPlaceholder = ({service}: Construct) => {
    return (
        <div className={className}>
            Drag an effect from the <TextButton onClick={() => {
            service.switchScreen("default")
            service.panelLayout.showIfAvailable(PanelType.BrowserPanel)
        }}>Device Browser</TextButton>
        </div>
    )
}