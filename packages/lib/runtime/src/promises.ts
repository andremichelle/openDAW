import {
    assert,
    Exec,
    Func,
    InaccessibleProperty,
    int,
    isDefined,
    isNull,
    Nullable,
    Option,
    Provider,
    RuntimeNotification,
    RuntimeNotifier,
    safeExecute,
    Terminable,
    TerminableOwner,
    TimeSpan
} from "@opendaw/lib-std"
import {Wait} from "./wait"

export type Resolve<T> = (value: T) => void
export type Reject = (reason?: unknown) => void
export type ExecutorTuple<T> = { resolve: Resolve<T>; reject: Reject }
export type PromiseExecutor<T> = (resolve: Resolve<T>, reject: Reject) => void
export type RetryOption = { retry(reason: unknown, exec: Exec): boolean }

export class IntervalRetryOption implements RetryOption {
    #count: int = 0 | 0
    constructor(readonly maxRetry: int, readonly timeSpan: TimeSpan) {}
    retry(reason: unknown, exec: Exec): boolean {
        if (++this.#count === this.maxRetry) {return false}
        console.debug(`${reason} > will retry in ${this.timeSpan.toString()}`)
        setTimeout(exec, this.timeSpan.millis())
        return true
    }
}

export namespace Promises {
    export class ResolveResult<T> {
        readonly status = "resolved"
        constructor(readonly value: T) {}
        error = InaccessibleProperty("Cannot access error when promise is resolved")
    }

    export class RejectedResult {
        readonly status = "rejected"
        constructor(readonly error: unknown) {}
        value = InaccessibleProperty("Cannot access value when promise is rejected")
    }

    export const makeAbortable = async <T>(owner: TerminableOwner, promise: Promise<T>): Promise<T> => {
        let running = true
        owner.own(Terminable.create(() => running = false))
        return new Promise<T>((resolve, reject) =>
            promise.then(value => {if (running) {resolve(value)}}, reason => {if (running) {reject(reason)}}))
    }

    export const tryCatch = <T>(promise: Promise<T>): Promise<ResolveResult<T> | RejectedResult> =>
        promise.then(value => new ResolveResult(value), error => new RejectedResult(error))

    const DefaultRetryOption = new IntervalRetryOption(3, TimeSpan.seconds(3))

    export const retry = <T>(factory: Provider<Promise<T>>,
                             retryOption: RetryOption = DefaultRetryOption): Promise<T> =>
        factory().catch(reason => new Promise<T>((resolve, reject) => {
            const onFailure = (reason: unknown) => {
                if (!retryOption.retry(reason, () => factory().then((value: T) => resolve(value), onFailure))) {
                    reject(reason)
                }
            }
            onFailure(reason)
        }))

    export const guardedRetry = <T>(factory: Provider<Promise<T>>,
                                    retryIf: (error: unknown, count: int) => boolean): Promise<T> => {
        const attempt = async (count: int = 0): Promise<T> => {
            try {
                return await factory()
            } catch (reason) {
                if (retryIf(reason, ++count)) {
                    console.debug(`retry after failure (online: ${navigator.onLine}):`, reason)
                    await Wait.timeSpan(TimeSpan.seconds(1))
                    return attempt(count)
                }
                throw new Error(`Failed after ${count} retries: ${reason}`)
            }
        }
        return attempt()
    }

    export const approvedRetry = <T>(factory: Provider<Promise<T>>,
                                     approve: Func<unknown, RuntimeNotification.ApproveRequest>): Promise<T> => {
        const attempt = async (): Promise<T> => {
            try {
                return await factory()
            } catch (reason) {
                if (await RuntimeNotifier.approve(approve(reason))) {
                    return attempt()
                }
                throw reason
            }
        }
        return attempt()
    }

    // this is for testing the catch branch
    export const fail = <T>(after: TimeSpan, thenUse: Provider<Promise<T>>): Provider<Promise<T>> => {
        let use: Provider<Promise<T>> = () =>
            new Promise<T>((_, reject) => setTimeout(() => reject("fails first"), after.millis()))
        return () => {
            const promise: Promise<T> = use()
            use = thenUse
            return promise
        }
    }

    export const timeout = <T>(promise: Promise<T>, timeSpan: TimeSpan, fail?: string): Promise<T> => {
        return new Promise<T>((resolve, reject) => {
            let running: boolean = true
            const timeout = setTimeout(() => {
                running = false
                reject(new Error(fail ?? "timeout"))
            }, timeSpan.millis())
            promise
                .then((value) => {if (running) {resolve(value)}}, reason => {if (running) {reject(reason)}})
                .finally(() => clearTimeout(timeout))
        })
    }

    export const sequentialAll = <T, R>(factories: Array<Provider<Promise<R>>>): Promise<Array<R>> =>
        factories.reduce((promise, factory) => promise
            .then(async results => [...results, await factory()]), Promise.resolve([] as Array<R>)
        )

    export const sequentialize = <A, T>(handler: Func<A, Promise<T>>): Func<A, Promise<T>> => {
        let lastPromise: Promise<unknown> = Promise.resolve()
        return (arg: A): Promise<T> => {
            const execute = () => handler(arg)
            const currentPromise = lastPromise.then(execute, execute)
            lastPromise = currentPromise.catch(() => {})
            return currentPromise
        }
    }

    export const memoizeAsync = <T>(factory: Provider<Promise<T>>, timeout?: TimeSpan): Provider<Promise<T>> => {
        let resolving: Nullable<Promise<T>> = null
        let lastCall: number = Date.now()
        return () => {
            const now = Date.now()
            if (isNull(resolving) || (isDefined(timeout) && now - lastCall > timeout.millis())) {
                lastCall = now
                resolving = factory()
                resolving.catch(error => {
                    resolving = null
                    return error
                })
            }
            return resolving
        }
    }

    export const allWithLimit = async <T, U>(tasks: ReadonlyArray<Provider<Promise<T | U>>>, limit = 1)
        : Promise<Array<T | U>> => {
        const results: Array<T | U> = new Array(tasks.length)
        let index = 0
        let hasError = false
        const run = async () => {
            while (index < tasks.length && !hasError) {
                const i = index++
                try {
                    const value = await tasks[i]()
                    if (!hasError) {
                        results[i] = value
                    }
                } catch (reason) {
                    hasError = true
                    throw reason
                }
            }
        }

        await Promise.all(Array.from({length: Math.min(limit, tasks.length)}, run))
        return results
    }

    export const allSettledWithLimit = async <T, U>(tasks: ReadonlyArray<Provider<Promise<T | U>>>, limit = 1)
        : Promise<PromiseSettledResult<T | U>[]> => {
        const results: PromiseSettledResult<T | U>[] = new Array(tasks.length)
        let index = 0
        const run = async () => {
            while (index < tasks.length) {
                const i = index++
                try {
                    const value = await tasks[i]()
                    results[i] = {status: "fulfilled", value}
                } catch (reason) {
                    results[i] = {status: "rejected", reason}
                }
            }
        }
        await Promise.all(Array.from({length: Math.min(limit, tasks.length)}, run))
        return results
    }

    export class Limit<T> {
        readonly #waiting: Array<[Provider<Promise<T>>, PromiseWithResolvers<T>]>

        #running: int = 0 | 0

        constructor(readonly max: int = 1) {
            this.#waiting = []
        }

        async add(provider: Provider<Promise<T>>): Promise<T> {
            if (this.#running < this.max) {
                this.#running++
                return provider().finally(() => this.#continue())
            } else {
                const resolvers: PromiseWithResolvers<T> = Promise.withResolvers<T>()
                this.#waiting.push([provider, resolvers])
                return resolvers.promise.finally(() => this.#continue())
            }
        }

        #continue(): void {
            assert(this.#running > 0, "Internal Error in Promises.Limit")
            if (--this.#running < this.max) {
                if (this.#waiting.length > 0) {
                    const [provider, {resolve, reject}] = this.#waiting.shift()!
                    this.#running++
                    provider().then(resolve, reject)
                }
            }
        }
    }

    export class Latest<T> implements Terminable {
        readonly #onResolve: Resolve<T>
        readonly #onReject: Reject
        readonly #onFinally?: Exec

        #latest: Option<Promise<T>> = Option.None

        constructor(onResolve: Resolve<T>, onReject: Reject, onFinally?: Exec) {
            this.#onResolve = onResolve
            this.#onReject = onReject
            this.#onFinally = onFinally
        }

        update(promise: Promise<T>): void {
            this.#latest = Option.wrap(promise)
            promise
                .then(value => {if (this.#latest.contains(promise)) {this.#onResolve(value)}})
                .catch(reason => {if (this.#latest.contains(promise)) {this.#onReject(reason)}})
                .finally(() => {
                    if (this.#latest.contains(promise)) {
                        this.terminate()
                        safeExecute(this.#onFinally)
                    }
                })
        }

        terminate(): void {this.#latest = Option.None}
    }
}