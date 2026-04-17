import css from "./Dashboard.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement, LocalLink} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@moises-ai/lib-dom"
import {Resources} from "@/ui/dashboard/Resources"
import {DemoProjects} from "@/ui/dashboard/DemoProjects"
import {Colors} from "@moises-ai/studio-enums"

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
                <p style={{color: Colors.cream.toString(), margin: "1em 0"}}>Coming from <a href="https://remix.ruhr"
                                                                                            target="remix.ruhr">remix.ruhr</a>?
                    Set the tempo to 156 BPM, then import your zip file via Menu, Import, Stems (Zip). Have fun!</p>
                <div className="columns">
                    <DemoProjects lifecycle={lifecycle} service={service}/>
                    <Resources lifecycle={lifecycle} service={service}/>
                </div>
                <p style={{marginTop: "3em", fontSize: "11px", textAlign: "center"}}>
                    Visit <a
                    href="https://discord.opendaw.studio/" target="discord">Discord</a> and <a
                    href="https://github.com/andremichelle/opendaw" target="github">GitHub</a> for more information.
                    Subscribe to our <a href="https://buttondown.com/opendaw" target="newsletter">Newsletter</a>.
                    Built with ❤️
                </p>
            </article>
        </div>
    )
}