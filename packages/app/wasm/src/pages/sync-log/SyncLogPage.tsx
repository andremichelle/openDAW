import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {DefaultObservableValue, int, MutableObservableOption, Terminator} from "@opendaw/lib-std"
import {Update} from "@opendaw/lib-box"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"
import {COMMIT_INIT, decodeSteps, readCommits, stepBackward, stepForward} from "./sync-log"

// Walk through a recorded Sync Log (.odsl) transaction by transaction, with rewind / fast-forward, driving
// the wasm engine live. A Sync Log is a commit stream: the first commit (Init) carries the serialized
// project (decoded like a .od file), each later Updates commit a single box-graph transaction. We decode the
// Init into a box graph, stream it to the engine through the unchanged `SyncSource` (via `createEngineHost`),
// then step the box graph forward / backward (see `./sync-log`) — every step is a real transaction, so the
// engine stays in sync and the project builds up (or down) before your eyes. This is the READ side of
// `studio-core`'s `SyncLogReader`, adapted to a scrubbable stepper.

const FILES = import.meta.glob("/public/odsl/*.odsl", {query: "?url", import: "default"})
const LOGS = Object.keys(FILES)
    .map(path => ({name: path.slice(path.lastIndexOf("/") + 1).replace(/\.odsl$/, ""), url: path.replace(/^\/public/, "")}))
    .sort((left, right) => left.name.localeCompare(right.name))

export const SyncLogPage: PageFactory<Env> = ({lifecycle}) => {
    const status: HTMLParagraphElement = <p/>
    const controls: HTMLDivElement = <div className="metro-controls step-controls"/>
    const host: HTMLDivElement = <div/>
    const logs: HTMLDivElement = <div/>
    const current = new MutableObservableOption<Terminator>()
    const load = async (url: string): Promise<void> => {
        current.ifSome(terminator => terminator.terminate())
        controls.replaceChildren()
        host.replaceChildren()
        logs.replaceChildren()
        const terminator = lifecycle.spawn()
        current.wrap(terminator)
        status.textContent = "Loading…"
        const arrayBuffer = await fetch(url).then(response => response.arrayBuffer())
        const commits = readCommits(arrayBuffer)
        // First commit is the project (Init); the rest, the per-transaction update lists (decoded once,
        // applied live). A malformed log without an Init head is unusable.
        if (commits.length === 0 || commits[0].type !== COMMIT_INIT) {
            status.textContent = "Invalid Sync Log: first commit must be Init"
            return
        }
        const {boxGraph} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)
        const engine = createEngineHost(boxGraph, terminator, {channel: `sync-log-${url}`})
        host.append(engine.element)
        logs.append(engine.log)
        // `step` is the transaction the project is currently AT (0 = just the Init project); `target` is where
        // the user wants to be. A single async driver moves `step` toward `target` one transaction at a time,
        // YIELDING after each — because the engine sync is a real async pipeline (`createEngineHost`'s
        // SyncSource ships each transaction over a channel and serializes it against this graph on the other
        // side). Applying a burst synchronously would race that pipeline against the box graph (it would
        // serialize tasks for boxes a later transaction already deleted); yielding lets each transaction
        // settle before the next, exactly as the canonical `SyncLogReader` yields during replay. The driver
        // re-reads `target` each step, so a click or a slider scrub mid-flight just redirects it.
        const step = new DefaultObservableValue(0)
        const target = new DefaultObservableValue(0)
        const driver = {running: false}
        const alive = {value: true} // cleared on teardown so the async driver stops touching a disposed graph
        terminator.own({terminate: () => {alive.value = false}})
        // The COMPLETE applied-update list captured per forward step (recorded updates + the graph's deferred
        // pointer resolutions), so a backward step inverts exactly what was applied — see `./sync-log`.
        const applied: Array<ReadonlyArray<Update>> = []
        const drive = async (): Promise<void> => {
            while (step.getValue() !== target.getValue() && alive.value) {
                const at = step.getValue()
                if (at < target.getValue()) {
                    applied[at] = stepForward(boxGraph, steps[at])
                    step.setValue(at + 1)
                } else {
                    stepBackward(boxGraph, applied[at - 1])
                    step.setValue(at - 1)
                }
                await new Promise(resolve => setTimeout(resolve)) // let the async engine-sync pipeline drain
            }
        }
        const request = (to: int): void => {
            target.setValue(Math.max(0, Math.min(steps.length, to)))
            if (driver.running) {return} // a driver is already pumping toward `target`; it will pick up the change
            driver.running = true
            void drive().finally(() => {driver.running = false})
        }
        const slider: HTMLInputElement = <input type="range" min="0" max={String(steps.length)} value="0"
            oninput={(event: Event) => request(parseInt((event.target as HTMLInputElement).value, 10))}/>
        const label: HTMLSpanElement = <span className="value"/>
        const first: HTMLButtonElement = <button onclick={() => request(0)} title="rewind to start">⏮</button>
        const prev: HTMLButtonElement = <button onclick={() => request(target.getValue() - 1)} title="step back">◀</button>
        const next: HTMLButtonElement = <button onclick={() => request(target.getValue() + 1)} title="step forward">▶</button>
        const last: HTMLButtonElement = <button onclick={() => request(steps.length)} title="fast-forward to end">⏭</button>
        terminator.own(step.catchupAndSubscribe(owner => {
            const at = owner.getValue()
            label.textContent = `step ${at} / ${steps.length}`
            slider.value = String(at)
            first.disabled = prev.disabled = at === 0
            next.disabled = last.disabled = at === steps.length
        }))
        controls.append(first, prev, slider, next, last, label)
        status.textContent = `Loaded ${LOGS.find(log => log.url === url)?.name ?? url}: ${steps.length} transactions`
    }
    const select: HTMLSelectElement = (
        <select onchange={(event: Event) => void load((event.target as HTMLSelectElement).value)}>
            {LOGS.map(log => <option value={log.url}>{log.name}</option>)}
        </select>
    )
    if (LOGS.length > 0) {void load(LOGS[0].url)}
    return (
        <div className="page">
            <h2>Sync Log</h2>
            <p>Walks through a recorded Sync Log (an <code>.odsl</code> from <code>public/odsl</code>) one
                transaction at a time. The first commit loads the project; each step applies / inverts one
                transaction on the box graph, streamed live to the engine. Rewind, scrub, or fast-forward —
                then press Play to hear the project at that step.</p>
            <div className="metro-controls">
                <label>Sync Log </label>
                {select}
            </div>
            {controls}
            {host}
            {status}
            {logs}
        </div>
    )
}