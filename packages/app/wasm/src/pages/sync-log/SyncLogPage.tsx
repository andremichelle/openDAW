import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {DefaultObservableValue, MutableObservableOption, Terminator} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"
import {COMMIT_INIT, createStepper, decodeSteps, readCommits} from "./sync-log"

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
        // `step` mirrors the transaction the project is currently AT (0 = just the Init project) for the UI.
        // The stepper queues each request onto a promise chain, traversing toward one target at a time and
        // draining the engine-sync pipeline between each transaction, so a scrub follows the drag one position
        // at a time without racing the async engine sync (see `createStepper` in `./sync-log`).
        const step = new DefaultObservableValue(0)
        const stepper = createStepper(boxGraph, steps, at => step.setValue(at))
        terminator.own({terminate: () => stepper.dispose()})
        const slider: HTMLInputElement = <input type="range" min="0" max={String(steps.length)} value="0"
            oninput={(event: Event) => stepper.request(parseInt((event.target as HTMLInputElement).value, 10))}/>
        const label: HTMLSpanElement = <span className="value"/>
        const first: HTMLButtonElement = <button onclick={() => stepper.request(0)} title="rewind to start">⏮</button>
        const prev: HTMLButtonElement = <button onclick={() => stepper.request(step.getValue() - 1)} title="step back">◀</button>
        const next: HTMLButtonElement = <button onclick={() => stepper.request(step.getValue() + 1)} title="step forward">▶</button>
        const last: HTMLButtonElement = <button onclick={() => stepper.request(steps.length)} title="fast-forward to end">⏭</button>
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
                transaction at a time. Each step applies / inverts one
                transaction on the box graph, streamed live to the engine. Rewind, scrub, or fast-forward —
                then press Play to hear the project at that step.</p>
            <div className="metro-controls">
                <label>Sync Log </label>
                {select}
            </div>
            {host}
            {controls}
            {status}
            {logs}
        </div>
    )
}