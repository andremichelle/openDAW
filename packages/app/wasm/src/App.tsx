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
import {CompositePage} from "./pages/composite/CompositePage"
import {TidalPage} from "./pages/tidal/TidalPage"
import {LoadFilePage} from "./pages/load-file/LoadFilePage"
import {BundlePlayerPage} from "./pages/bundle-player/BundlePlayerPage"
import {PerformancePage} from "./pages/performance/PerformancePage"
import {LiveMetersPage} from "./pages/live-meters/LiveMetersPage"
import {SyncLogPage} from "./pages/sync-log/SyncLogPage"

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
                <LocalLink href="/composite">Composite</LocalLink>
                <LocalLink href="/tidal">Tidal</LocalLink>
                <LocalLink href="/load-file">Load File</LocalLink>
                <LocalLink href="/bundle-player">Bundle Player</LocalLink>
                <LocalLink href="/performance">Performance A/B</LocalLink>
                <LocalLink href="/live-meters">Live Meters</LocalLink>
                <LocalLink href="/sync-log">Sync Log</LocalLink>
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
                        {path: "/composite", factory: CompositePage},
                        {path: "/tidal", factory: TidalPage},
                        {path: "/load-file", factory: LoadFilePage},
                        {path: "/bundle-player", factory: BundlePlayerPage},
                        {path: "/performance", factory: PerformancePage},
                        {path: "/live-meters", factory: LiveMetersPage},
                        {path: "/sync-log", factory: SyncLogPage}
                    ]}
                    fallback={() => <div className="page"><h2>404</h2></div>}/>
            </main>
        </div>
    )
}
