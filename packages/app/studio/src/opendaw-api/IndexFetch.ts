import {panic, TimeSpan} from "@opendaw/lib-std"
import {network, Promises, RetryOption} from "@opendaw/lib-runtime"

const AttemptTimeout = TimeSpan.seconds(10)
const RetryInterval = TimeSpan.seconds(1)

const IndefiniteRetry: RetryOption = {
    retry: (reason: unknown, exec: () => void): boolean => {
        console.debug(`${reason} > will retry in ${RetryInterval.toString()}`)
        setTimeout(exec, RetryInterval.millis())
        return true
    }
}

// The published index is the catalogue and project loading waits for it, so this never rejects: a silent
// request is aborted after AttemptTimeout and a fresh one is sent, indefinitely, until one resolves.
export const fetchIndex = (url: string, headers: RequestInit): Promise<unknown> =>
    Promises.retry(() => network
        .limitFetch(`${url}?v=${Date.now()}`, {
            ...headers, cache: "no-cache", signal: AbortSignal.timeout(AttemptTimeout.millis())
        })
        .then(response => response.ok ? response.json() : panic(`${response.status} ${response.statusText}`)),
        IndefiniteRetry)
