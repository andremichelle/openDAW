// A synchronous in-process Messenger pair: `send` on one side delivers to the other side's subscribers
// within the SAME call stack. SyncSource's update tasks must be serialized AT emission time — a
// MessageChannel loopback defers by a macrotask, letting a later transaction delete boxes before the
// earlier batch resolves its primitive-field codecs against the live source graph.
import {Notifier, Observer, panic, Subscription, Terminable} from "@opendaw/lib-std"
import {Messenger} from "@opendaw/lib-runtime"

export type SyncLoopback = {source: Messenger, target: Messenger} & Terminable

export const createSyncLoopback = (): SyncLoopback => {
    const toTarget = new Notifier<any>()
    const toSource = new Notifier<any>()
    const port = (outgoing: Notifier<any>, incoming: Notifier<any>): Messenger => ({
        send: (message: any): void => outgoing.notify(message),
        channel: (): Messenger => panic("the sync loopback has no channels"),
        subscribe: (observer: Observer<any>): Subscription => incoming.subscribe(observer),
        terminate: (): void => {}
    })
    return {
        source: port(toTarget, toSource),
        target: port(toSource, toTarget),
        terminate: (): void => {
            toTarget.terminate()
            toSource.terminate()
        }
    }
}
