import {isDefined, isRecord, Option, Optional, tryCatch} from "@opendaw/lib-std"

export namespace ClipboardPayload {
    export const write = (content: string, value: unknown): string => JSON.stringify({app: "openDAW", content, value})

    export const read = (data: Optional<string>, content: string): Option<unknown> => {
        if (!isDefined(data) || data.length === 0) {return Option.None}
        const {status, value} = tryCatch((): unknown => JSON.parse(data))
        if (status === "failure" || !isRecord(value)) {return Option.None}
        return value.app === "openDAW" && value.content === content ? Option.wrap(value.value) : Option.None
    }
}
