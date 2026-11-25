import {Errors} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

export class HttpStatus extends Error {
    constructor(readonly status: number) {super(`HTTP ${status}`)}
}

// network failures and 5xx are worth another attempt, a 4xx answer will not change
export const retryTransient = <T>(factory: () => Promise<T>, attempts: number): Promise<T> => {
    const aborted = {value: false}
    return Promises.guardedRetry(() => factory().catch(reason => {
        aborted.value = Errors.isAbort(reason)
        return Promise.reject(reason)
    }), (error, count) => count < attempts && !aborted.value && !(error instanceof HttpStatus && error.status < 500))
        .catch(reason => Promise.reject(aborted.value ? Errors.AbortError : reason))
}
