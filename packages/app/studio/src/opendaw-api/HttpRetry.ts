import {Promises} from "@opendaw/lib-runtime"

export class HttpStatus extends Error {
    constructor(readonly status: number) {super(`HTTP ${status}`)}
}

// network failures and 5xx are worth another attempt, a 4xx answer will not change
export const retryTransient = <T>(factory: () => Promise<T>, attempts: number): Promise<T> =>
    Promises.guardedRetry(factory, (error, count) =>
        count < attempts && !(error instanceof HttpStatus && error.status < 500))
