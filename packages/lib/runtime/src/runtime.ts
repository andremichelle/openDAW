import {Exec, Subscription} from "@moises-ai/lib-std"

export namespace Runtime {
    // Debounce execution by delaying the call until after the timeout has passed without new invocations.
    export const debounce = (() => {
        let id: any = undefined
        return (exec: Exec, timeout: number = 1000) => {
            clearTimeout(id)
            id = setTimeout(exec, timeout)
        }
    })()

    export const scheduleInterval = (exec: Exec, time: number, ...args: Array<any>): Subscription => {
        const id = setInterval(exec, time, ...args)
        return {terminate: () => clearInterval(id)}
    }

    export const scheduleTimeout = (exec: Exec, time: number, ...args: Array<any>): Subscription => {
        const id = setTimeout(exec, time, ...args)
        return {terminate: () => clearTimeout(id)}
    }
}