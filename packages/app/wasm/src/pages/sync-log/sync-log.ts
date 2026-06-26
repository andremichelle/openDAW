// The READ side of a Sync Log (.odsl), navigation-only: parse the commit stream and step a box graph
// forward / backward one transaction at a time. Extracted from the page so it can be tested headlessly.
// (This is the studio-core `SyncLogReader` model, adapted to a reversible stepper.)

import {ByteArrayInput, int} from "@opendaw/lib-std"
import {BoxGraph, Update, Updates} from "@opendaw/lib-box"

// WASM CONTRACT: commit ordinals + layout mirror studio-core `Commit` (Init=0, Updates=2).
export const COMMIT_INIT = 0
export const COMMIT_UPDATES = 2

export type Commit = {type: int, payload: ArrayBuffer}

// Parse the commit stream: each commit is type, version, 32-byte prevHash, 32-byte thisHash, payload, date.
export const readCommits = (buffer: ArrayBuffer): ReadonlyArray<Commit> => {
    const input = new ByteArrayInput(buffer)
    const commits: Array<Commit> = []
    while (input.position < buffer.byteLength) {
        const type = input.readInt()
        input.readInt() // version
        input.readBytes(new Int8Array(32)) // prevHash
        input.readBytes(new Int8Array(32)) // thisHash
        const payload = new Int8Array(input.readInt())
        input.readBytes(payload)
        input.readDouble() // date
        commits.push({type, payload: payload.buffer})
    }
    return commits
}

// The per-transaction update lists after the Init commit (each one a single transaction's updates).
export const decodeSteps = (commits: ReadonlyArray<Commit>): ReadonlyArray<ReadonlyArray<Update>> =>
    commits.slice(1)
        .filter(commit => commit.type === COMMIT_UPDATES)
        .map(commit => Updates.decode(new ByteArrayInput(commit.payload)))

// Apply one transaction's recorded updates forward, and RETURN the COMPLETE list of updates the graph
// actually applied. That list includes the deferred pointer resolutions the graph generates at
// `endTransaction` — forward-references within the transaction (a box created earlier pointing at a box
// created later) are deferred and resolved there, and the recorded commit does NOT contain them. The inverse
// must mirror THIS list, exactly as the graph's own rollback inverses its internal transaction-update list.
export const stepForward = (graph: BoxGraph, updates: ReadonlyArray<Update>): ReadonlyArray<Update> => {
    const applied: Array<Update> = []
    const subscription = graph.subscribeToAllUpdates({onUpdate: (update: Update) => {applied.push(update)}})
    graph.beginTransaction()
    updates.forEach(update => update.forward(graph))
    graph.endTransaction()
    subscription.terminate()
    return applied
}

// Undo a step by inverting its APPLIED updates (from `stepForward`) in reverse order — the graph's own
// rollback strategy. Because the applied list includes the deferred pointer resolutions, inverting in reverse
// clears each forward-reference pointer before its box is deleted; no per-update special-casing is needed.
export const stepBackward = (graph: BoxGraph, applied: ReadonlyArray<Update>): void => {
    graph.beginTransaction()
    for (let index = applied.length - 1; index >= 0; index--) {applied[index].inverse(graph)}
    graph.endTransaction()
}

export type SyncLogStepper = {
    request(target: int): void     // queue a traversal toward transaction `target` (clamped)
    whenIdle(): Promise<void>      // resolves once every queued traversal so far has fully settled
    dispose(): void                // stop the driver so it no longer touches a disposed graph
}

// Move the project to a target one transaction at a time, draining the async engine-sync pipeline between
// each (a forward/backward step is a real transaction that `createEngineHost` ships over a channel and
// serialises against the graph on the other side; running ahead would race it). Each `request` APPENDS its
// traversal to a promise chain, so the traversals run strictly sequentially — every one is monotonic (it
// only steps toward its own captured target) and fully settles before the next begins. A scrub therefore
// follows the drag one position per `oninput` without ever placing a forward and a backward back to back
// mid-flight, which is the race. (A jump is one long monotonic traversal, equally safe.)
export const createStepper = (graph: BoxGraph, steps: ReadonlyArray<ReadonlyArray<Update>>,
                              onStep: (at: int) => void): SyncLogStepper => {
    const applied: Array<ReadonlyArray<Update>> = []
    const state = {at: 0, alive: true}
    const advanceTo = async (target: int): Promise<void> => {
        while (state.at !== target && state.alive) {
            if (state.at < target) {
                applied[state.at] = stepForward(graph, steps[state.at])
                state.at += 1
            } else {
                stepBackward(graph, applied[state.at - 1])
                state.at -= 1
            }
            onStep(state.at)
            await new Promise(resolve => setTimeout(resolve)) // drain this transaction before the next
        }
    }
    let chain: Promise<void> = Promise.resolve()
    return {
        request: (target: int): void => {
            const to = Math.max(0, Math.min(steps.length, target))
            chain = chain.then(() => advanceTo(to))
        },
        whenIdle: (): Promise<void> => chain,
        dispose: (): void => {state.alive = false}
    }
}
