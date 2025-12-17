import css from "./Dashboard.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement, LocalLink} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {Resources} from "@/ui/dashboard/Resources"
import {DemoProjects} from "@/ui/dashboard/DemoProjects"

const className = Html.adoptStyleSheet(css, "Dashboard")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const Dashboard = ({lifecycle, service}: Construct) => {
    return (
        <div className={className}>
            <article>
                <h1>Welcome to openDAW</h1>
                <h2>A new holistic exploration of music creation inside your browser</h2>
                <p style={{margin: "0.5em 0 0 0"}}>
                    openDAW is an open source web based music studio with a clear focus on <a
                    href="https://opendaw.org/education" target="education">education</a> and <LocalLink
                    href="/privacy">data privacy</LocalLink>,
                    open to everyone with no login required so you can start creating <a
                    href="https://music.opendaw.studio/" target="music">music</a> right away. The studio is still
                    evolving and not production ready yet.
                </p>
                <div className="columns">
                    <DemoProjects lifecycle={lifecycle} service={service}/>
                    <Resources lifecycle={lifecycle} service={service}/>
                </div>
                <p style={{marginTop: "3em", fontSize: "11px", textAlign: "center"}}>
                    Visit <a
                    href="https://discord.opendaw.studio/" target="discord">Discord</a> and <a
                    href="https://github.com/andremichelle/opendaw" target="github">GitHub</a> for more information.
                    Built with ❤️
                </p>
            </article>
        </div>
    )
}