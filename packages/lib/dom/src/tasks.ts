import {Exec} from "@moises-ai/lib-std"

export const queueTask = (exec: Exec) => {
    let pendingBroadcast = false
    return () => {
        if (pendingBroadcast) {return}
        pendingBroadcast = true
        queueMicrotask(() => {
            pendingBroadcast = false
            exec()
        })
    }
}