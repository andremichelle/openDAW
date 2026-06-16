import {createElement, LocalLink, PageFactory} from "@opendaw/lib-jsx"
import {Env} from "../../Env"

export const HomePage: PageFactory<Env> = () => (
    <div className="page">
        <h2>WASM Audio Engine — test pages</h2>
        <ul>
            <li><LocalLink href="/sine">Sine (440 Hz)</LocalLink> — step 1: build → worklet → output</li>
        </ul>
    </div>
)
