import {Exec, int, Observable, TimeSpan, tryCatch} from "@moises-ai/lib-std"

export namespace Wait {
    export const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()))
    export const frames = (numFrames: int): Promise<void> => new Promise(resolve => {
        let count = numFrames
        const callback = () => {if (--count <= 0) {resolve()} else {requestAnimationFrame(callback)}}
        requestAnimationFrame(callback)
    })
    export const timeSpan = <T>(time: TimeSpan, ...args: any[]): Promise<T> =>
        new Promise(resolve => setTimeout(resolve, time.millis(), ...args))
    export const event = (target: EventTarget, type: string): Promise<void> =>
        new Promise<void>(resolve => target.addEventListener(type, resolve as Exec, {once: true}))
    export const observable = (observable: Observable<unknown>) => new Promise<void>(resolve => {
        const terminable = observable.subscribe(() => {
            terminable.terminate()
            resolve()
        })
    })
    export const complete = <R>(generator: Generator<unknown, R>): Promise<R> =>
        new Promise<R>((resolve, reject) => {
            const interval = setInterval(() => {
                const {status, value: next, error} = tryCatch(() => generator.next())
                if (status === "success") {
                    const {done, value} = next
                    if (done) {
                        clearInterval(interval)
                        resolve(value)
                    }
                } else {
                    clearInterval(interval)
                    reject(error)
                }
            }, 0)
        })
}