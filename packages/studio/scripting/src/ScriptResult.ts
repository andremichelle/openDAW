import {isDefined, Nullable, tryCatch} from "@opendaw/lib-std"

export namespace ScriptResult {
    export const toText = (value: unknown): Nullable<string> => {
        if (!isDefined(value)) {return null}
        if (typeof value === "string") {return value}
        const json = tryCatch(() => JSON.stringify(value, null, 2))
        return json.status === "success" && isDefined(json.value) ? json.value : String(value)
    }
}
