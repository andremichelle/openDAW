import {EmptyExec, isDefined, Optional, Provider} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

const UrlPattern = /https?:\/\/\S+/

export const dynamicImportWithRetry = <T>(staticImport: Provider<Promise<T>>,
                                          maxAttempts: number = 10): Provider<Promise<T>> => {
    let poisonedUrl: Optional<string>
    return () => Promises.guardedRetry(() => {
        // Always run the real module import. The failing chunk may be a *dependency* of the requested
        // module (e.g. monaco's lazily split language chunk), so importing the failed URL directly would
        // resolve with the wrong module. Instead, warm the poisoned chunk with a cache-buster to bypass a
        // stale browser module cache, then re-run the real import.
        if (!isDefined(poisonedUrl)) {return staticImport()}
        return import(/* @vite-ignore */ `${poisonedUrl}?t=${Date.now()}`).catch(EmptyExec).then(staticImport)
    }, (error, count) => {
        const message = error instanceof Error ? error.message : String(error)
        const match = message.match(UrlPattern)
        if (match !== null) {poisonedUrl = match[0].split(/[?#]/)[0]}
        return count < maxAttempts
    })
}
