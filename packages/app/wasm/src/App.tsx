import {createElement, LocalLink, Router} from "@opendaw/lib-jsx"
import {Terminator} from "@opendaw/lib-std"
import {env} from "./Env"
import {HomePage} from "./pages/home/HomePage"
import {SinePage} from "./pages/sine/SinePage"
import {MetronomePage} from "./pages/metronome/MetronomePage"
import {TempoAutomationPage} from "./pages/tempo-automation/TempoAutomationPage"
import {NotesPage} from "./pages/notes/NotesPage"
import {LoopTruncationPage} from "./pages/loop-truncation/LoopTruncationPage"
import {MultiplePluginsPage} from "./pages/multiple-plugins/MultiplePluginsPage"
import {TidalPage} from "./pages/tidal/TidalPage"

export const App = () => {
    const runtime = new Terminator()
    return (
        <div className="layout">
            <nav className="nav">
                <strong>WASM Engine Tests</strong>
                <LocalLink href="/">Home</LocalLink>
                <LocalLink href="/sine">Sine</LocalLink>
                <LocalLink href="/metronome">Metronome</LocalLink>
                <LocalLink href="/tempo-automation">Tempo Automation</LocalLink>
                <LocalLink href="/notes">Notes</LocalLink>
                <LocalLink href="/loop-truncation">Loop Truncation</LocalLink>
                <LocalLink href="/multiple-plugins">Multiple Plugins</LocalLink>
                <LocalLink href="/tidal">Tidal</LocalLink>
            </nav>
            <main>
                <Router
                    runtime={runtime}
                    service={env}
                    routes={[
                        {path: "/", factory: HomePage},
                        {path: "/sine", factory: SinePage},
                        {path: "/metronome", factory: MetronomePage},
                        {path: "/tempo-automation", factory: TempoAutomationPage},
                        {path: "/notes", factory: NotesPage},
                        {path: "/loop-truncation", factory: LoopTruncationPage},
                        {path: "/multiple-plugins", factory: MultiplePluginsPage},
                        {path: "/tidal", factory: TidalPage}
                    ]}
                    fallback={() => <div className="page"><h2>404</h2></div>}/>
            </main>
        </div>
    )
}
