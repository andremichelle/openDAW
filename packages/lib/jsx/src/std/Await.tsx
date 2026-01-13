import {Exec, Func, Procedure, Provider, safeExecute} from "@moises-ai/lib-std"
import {createElement, replaceChildren} from "../create-element"
import {DomElement, JsxValue} from "../types"

export type AwaitProps<T> = {
    factory: Provider<Promise<T>>,
    loading: Provider<JsxValue>,
    success: Func<T, JsxValue>,
    failure: Func<{ reason: any, retry: Exec }, JsxValue>
    repeat?: Procedure<Exec>
}

export const Await = <T, >({factory, loading, success, failure, repeat}: AwaitProps<T>) => {
    const contents: DomElement = <div style={{display: "contents"}}/>
    const start = () => {
        replaceChildren(contents, loading())
        factory().then(
            result => replaceChildren(contents, success(result)),
            reason => replaceChildren(contents, failure({
                reason: reason instanceof Error ? `${reason.name} (${reason.message})` : reason,
                retry: () => start()
            })))
    }
    start()
    safeExecute(repeat, start)
    return contents
}