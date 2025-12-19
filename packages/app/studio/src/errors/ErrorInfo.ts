import {isDefined} from "@opendaw/lib-std"

export type ErrorInfo = {
    name: string
    message?: string
    stack?: string
}

export namespace ErrorInfo {
    const MAX_STACK_SIZE = 1000

    const fromError = (error: Error, fallbackName: string = "Error"): ErrorInfo => ({
        name: error.name || fallbackName,
        message: error.message,
        stack: error.stack?.slice(0, MAX_STACK_SIZE)
    })

    const fromUnknown = (value: unknown, name: string): ErrorInfo => {
        if (value instanceof Error) {return fromError(value, name)}
        // Capture synthetic stack for non-Error rejections to help locate the source
        const syntheticStack = new Error().stack?.split("\n").slice(3).join("\n")
        const type = value === null ? "null" : typeof value
        let message: string
        if (value === undefined) {
            message = "(rejected with undefined)"
        } else if (value === null) {
            message = "(rejected with null)"
        } else if (typeof value === "string") {
            message = value
        } else {
            try {
                message = `(${type}) ${JSON.stringify(value)}`
            } catch {
                message = `(${type}) [unserializable]`
            }
        }
        return {name, message, stack: syntheticStack}
    }

    export const extract = (event: Event): ErrorInfo => {
        if (event instanceof ErrorEvent) {
            if (event.error instanceof Error) {return fromError(event.error)}
            return {
                name: "Error",
                message: event.message || undefined,
                stack: isDefined(event.filename) ? `at ${event.filename}:${event.lineno}:${event.colno}` : undefined
            }
        }
        if (event instanceof PromiseRejectionEvent) {return fromUnknown(event.reason, "UnhandledRejection")}
        if (event instanceof MessageEvent) {return fromUnknown(event.data, "MessageError")}
        if (event instanceof SecurityPolicyViolationEvent) {
            return {name: "SecurityPolicyViolation", message: `${event.violatedDirective} blocked ${event.blockedURI}`}
        }
        // Media element errors (audio/video)
        const target = event.target
        if (target instanceof HTMLMediaElement && isDefined(target.error)) {
            return {name: "MediaError", message: target.error.message || `code ${target.error.code}`}
        }
        // AudioWorklet processorerror - no error details exposed by spec
        if (event.type === "processorerror") {
            return {name: "ProcessorError", message: "AudioWorklet threw an exception (check console)"}
        }
        // Fallback: capture event type and target
        const tagName = target instanceof Element ? target.tagName.toLowerCase() : null
        return {
            name: "UnknownError",
            message: tagName !== null ? `${event.type} on <${tagName}>` : event.type
        }
    }
}