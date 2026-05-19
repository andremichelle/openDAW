import {isDefined, Optional, Provider} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

const UrlPattern = /https?:\/\/\S+/

export const dynamicImportWithRetry = <T>(staticImport: Provider<Promise<T>>,
                                          maxAttempts: number = 10): Provider<Promise<T>> => {
    let poisonedUrl: Optional<string>
    return () => Promises.guardedRetry(() => {
        if (!isDefined(poisonedUrl)) {return staticImport()}
        return import(/* @vite-ignore */ `${poisonedUrl}?t=${Date.now()}`) as Promise<T>
    }, (error, count) => {
        if (!isDefined(poisonedUrl)) {
            const message = error instanceof Error ? error.message : String(error)
            const match = message.match(UrlPattern)
            if (match !== null) {poisonedUrl = match[0].split(/[?#]/)[0]}
        }
        return count < maxAttempts
    })
}
