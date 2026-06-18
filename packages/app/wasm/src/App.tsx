import {createElement, LocalLink, Router} from "@opendaw/lib-jsx"
import {Terminator} from "@opendaw/lib-std"
import {env} from "./Env"
import {HomePage} from "./pages/home/HomePage"
import {SinePage} from "./pages/sine/SinePage"
import {RackPage} from "./pages/rack/RackPage"
import {MetronomePage} from "./pages/metronome/MetronomePage"
import {TempoAutomationPage} from "./pages/tempo-automation/TempoAutomationPage"
import {NotesPage} from "./pages/notes/NotesPage"
import {LoopTruncationPage} from "./pages/loop-truncation/LoopTruncationPage"

export const App = () => {
    const runtime = new Terminator()
    return (
        <div className="layout">
            <nav className="nav">
                <strong>WASM Engine Tests</strong>
                <LocalLink href="/">Home</LocalLink>
                <LocalLink href="/sine">Sine</LocalLink>
                <LocalLink href="/rack">Rack</LocalLink>
                <LocalLink href="/metronome">Metronome</LocalLink>
                <LocalLink href="/tempo-automation">Tempo Automation</LocalLink>
                <LocalLink href="/notes">Notes</LocalLink>
                <LocalLink href="/loop-truncation">Loop Truncation</LocalLink>
            </nav>
            <main>
                <Router
                    runtime={runtime}
                    service={env}
                    routes={[
                        {path: "/", factory: HomePage},
                        {path: "/sine", factory: SinePage},
                        {path: "/rack", factory: RackPage},
                        {path: "/metronome", factory: MetronomePage},
                        {path: "/tempo-automation", factory: TempoAutomationPage},
                        {path: "/notes", factory: NotesPage},
                        {path: "/loop-truncation", factory: LoopTruncationPage}
                    ]}
                    fallback={() => <div className="page"><h2>404</h2></div>}/>
            </main>
        </div>
    )
}
