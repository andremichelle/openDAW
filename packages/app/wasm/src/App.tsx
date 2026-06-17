import {createElement, Frag, LocalLink, Router} from "@opendaw/lib-jsx"
import {Terminator} from "@opendaw/lib-std"
import {env} from "./Env"
import {HomePage} from "./pages/home/HomePage"
import {SinePage} from "./pages/sine/SinePage"
import {RackPage} from "./pages/rack/RackPage"
import {MetronomePage} from "./pages/metronome/MetronomePage"

export const App = () => {
    const runtime = new Terminator()
    return (
        <Frag>
            <header className="nav">
                <strong>WASM Engine Tests</strong>
                <LocalLink href="/">Home</LocalLink>
                <LocalLink href="/sine">Sine</LocalLink>
                <LocalLink href="/rack">Rack</LocalLink>
                <LocalLink href="/metronome">Metronome</LocalLink>
            </header>
            <main>
                <Router
                    runtime={runtime}
                    service={env}
                    routes={[
                        {path: "/", factory: HomePage},
                        {path: "/sine", factory: SinePage},
                        {path: "/rack", factory: RackPage},
                        {path: "/metronome", factory: MetronomePage}
                    ]}
                    fallback={() => <div className="page"><h2>404</h2></div>}/>
            </main>
        </Frag>
    )
}
