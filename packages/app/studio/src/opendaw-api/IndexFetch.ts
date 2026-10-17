import {panic, TimeSpan} from "@opendaw/lib-std"
import {network, Promises, RetryOption} from "@opendaw/lib-runtime"
import {OpenDAWCloud} from "./OpenDAWCloud"

const AttemptTimeout = TimeSpan.seconds(10)
// a host that follows the network (desktop) tries once: offline the webview may still claim to be online
const SingleAttemptTimeout = TimeSpan.seconds(5)
const RetryInterval = TimeSpan.seconds(1)

const IndefiniteRetry = (url: string): RetryOption => ({
    retry: (reason: unknown, exec: () => void): boolean => {
        console.debug(`[ProjectLoad] index '${url}' failed: ${reason} > will retry in ${RetryInterval.toString()}`)
        setTimeout(exec, RetryInterval.millis())
        return true
    }
})

// The published index is the catalogue and project loading waits for it, so in the browser this never rejects: a
// silent request is aborted after AttemptTimeout and a fresh one is sent, indefinitely, until one resolves.
export const fetchIndex = (url: string, headers: RequestInit): Promise<unknown> => {
    const attempt = (timeout: TimeSpan) => network
        .limitFetch(`${url}?v=${Date.now()}`, {...headers, cache: "no-cache", signal: AbortSignal.timeout(timeout.millis())})
        .then(response => response.ok ? response.json() : panic(`${response.status} ${response.statusText}`))
    return OpenDAWCloud.followsNetwork()
        ? attempt(SingleAttemptTimeout)
        : Promises.retry(() => attempt(AttemptTimeout), IndefiniteRetry(url))
}
