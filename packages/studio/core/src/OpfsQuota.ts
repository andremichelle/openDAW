import {EmptyExec, Option, Provider, Terminable} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

export namespace OpfsQuota {
    export type Exceeded = { readonly path: string, readonly error: DOMException, readonly cached: boolean }
    export type Handler = (event: Exceeded) => Promise<boolean>

    let handler: Option<Handler> = Option.None
    let pendingCached: Option<Promise<boolean>> = Option.None
    let pendingOther: Option<Promise<boolean>> = Option.None
    let queue: Promise<unknown> = Promise.resolve()
    const QueueTimeoutMillis = 300_000

    export const install = (value: Handler): Terminable => {
        if (handler.nonEmpty()) {console.warn("[OpfsQuota] a handler was already installed, it is replaced")}
        handler = Option.wrap(value)
        return {terminate: () => {if (handler.contains(value)) {handler = Option.None}}}
    }

    export const isExceeded = (error: unknown): error is DOMException =>
        error instanceof DOMException && error.name === "QuotaExceededError"

    export type Options = { readonly cached?: boolean, readonly serial?: boolean }

    export const retry = async <T>(path: string,
                                   operation: Provider<Promise<T>>,
                                   rollback: Provider<Promise<void>>,
                                   {cached = false, serial = false}: Options = {}): Promise<T> => {
        const once = async (): Promise<Promises.ResolveResult<T> | Promises.RejectedResult> => {
            const outcome = await Promises.tryCatch(operation())
            if (outcome.status === "rejected") {
                const rolledBack = await Promises.tryCatch(rollback())
                if (rolledBack.status === "rejected") {console.warn(`[OpfsQuota] could not roll back '${path}'`, rolledBack.error)}
            }
            return outcome
        }
        const attempt = (): Promise<Promises.ResolveResult<T> | Promises.RejectedResult> => {
            if (!serial) {return once()}
            const result = queue.then(once)
            const {promise: deadline, resolve: release} = Promise.withResolvers<void>()
            const timer = setTimeout(() => {
                console.warn(`[OpfsQuota] '${path}' has not finished after ${QueueTimeoutMillis / 1000}s, the next save starts`)
                release()
            }, QueueTimeoutMillis)
            const settled = result.then(EmptyExec, EmptyExec).finally(() => clearTimeout(timer))
            queue = Promise.race([settled, deadline])
            return result
        }
        const first = await attempt()
        if (first.status === "resolved") {return first.value}
        const {error} = first
        if (!isExceeded(error) || handler.isEmpty()) {throw error}
        console.warn(`[OpfsQuota] '${path}' did not fit, asking the host to make room`)
        if (!await ask({path, error, cached})) {throw error}
        const second = await attempt()
        if (second.status === "resolved") {return second.value}
        throw second.error
    }

    const ask = (event: Exceeded): Promise<boolean> => {
        const pending = event.cached ? pendingCached : pendingOther
        if (pending.nonEmpty()) {return pending.unwrap()}
        const call = handler.unwrap()
        const before: Promise<boolean> = event.cached ? Promise.resolve(false) : pendingCached.unwrapOrElse(Promise.resolve(false))
        const promise = Promises.tryCatch(before.then(madeRoom => madeRoom || call(event))).then(result => {
            if (event.cached) {pendingCached = Option.None} else {pendingOther = Option.None}
            if (result.status === "rejected") {
                console.warn("[OpfsQuota] the handler failed", result.error)
                return false
            }
            return result.value === true
        })
        if (event.cached) {pendingCached = Option.wrap(promise)} else {pendingOther = Option.wrap(promise)}
        return promise
    }
}
