import css from "./Dashboard.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {Resources} from "@/ui/dashboard/Resources"
import {IntroTiles} from "@/ui/dashboard/IntroTiles"
import {ActionButtons} from "@/ui/dashboard/ActionButtons"
import {Backup} from "@/ui/dashboard/Backup"
import {Sponsors} from "@/ui/dashboard/Sponsors"
import {HelpFeedback} from "@/ui/dashboard/HelpFeedback"
import {Links} from "@/ui/dashboard/Links"

const className = Html.adoptStyleSheet(css, "Dashboard")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const Dashboard = ({lifecycle, service}: Construct) => (
    <div className={className}>
        <header className="hero">
            <h1>openDAW</h1>
            <span>Create music online</span>
        </header>
        <IntroTiles/>
        <div className="main">
            <div className="rail left">
                <ActionButtons lifecycle={lifecycle} service={service}/>
                <Backup service={service}/>
                <Sponsors/>
            </div>
            <div className="lists">
                <Resources lifecycle={lifecycle} service={service}/>
            </div>
            <div className="rail right">
                <HelpFeedback/>
                <Links/>
            </div>
        </div>
    </div>
)
