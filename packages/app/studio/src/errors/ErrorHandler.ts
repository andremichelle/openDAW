import {EmptyExec, Errors, Option, Provider, Terminable, Terminator} from "@opendaw/lib-std"
import {AnimationFrame, Browser, Events} from "@opendaw/lib-dom"
import {LogBuffer} from "@/errors/LogBuffer.ts"
import {ErrorLog} from "@/errors/ErrorLog.ts"
import {ErrorInfo} from "@/errors/ErrorInfo.ts"
import {Surface} from "@/ui/surface/Surface.tsx"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {BuildInfo} from "@/BuildInfo"

const ExtensionPatterns = ["script-src blocked eval", "extension", "chrome-extension://", "blocked by CSP", "Zotero Connector"]
const IgnoredErrors = [
    "ResizeObserver loop completed with undelivered notifications.",
    "Request timeout appSettingsDistributor.getValue"
]
const BrowserInternalPatterns = ["feature named"]
const MonacoPatterns = ["monaco-editor", "vs/base/common/errors"]
const UrlPattern = /https?:\/\/[^\s)]+/g

export class ErrorHandler {
    readonly #terminator = new Terminator()
    readonly #buildInfo: BuildInfo
    readonly #recover: Provider<Option<Provider<Promise<void>>>>
    #errorThrown: boolean = false

    constructor(buildInfo: BuildInfo, recover: Provider<Option<Provider<Promise<void>>>>) {
        this.#buildInfo = buildInfo
        this.#recover = recover
    }

    #looksLikeExtension(error: ErrorInfo): boolean {
        return document.scripts.length > 1
            || ExtensionPatterns.some(pattern =>
                error.message?.includes(pattern) || error.stack?.includes(pattern))
    }

    #extractForeignOrigin(error: ErrorInfo): string | null {
        const stack = error.stack
        if (stack === undefined) {return null}
        const urls = stack.match(UrlPattern) ?? []
        const expectedOrigin = window.location.origin
        for (const url of urls) {
            try {
                const origin = new URL(url).origin
                if (origin !== expectedOrigin) {return origin}
            } catch { /* invalid URL */ }
        }
        return null
    }

    #looksLikeMonacoError(message?: string, stack?: string, filename?: string): boolean {
        const sources = [message, stack, filename].filter(Boolean).join(" ")
        return MonacoPatterns.some(pattern => sources.includes(pattern))
    }

    #tryIgnore(event: Event): boolean {
        if (event instanceof ErrorEvent && IgnoredErrors.includes(event.message)) {
            console.warn(event.message)
            event.preventDefault()
            return true
        }
        // Handle Monaco editor errors from error events
        // Monaco rethrows worker error Event objects through its error pipeline,
        // arriving as ErrorEvent where event.error is a raw Event (not an Error).
        if (event instanceof ErrorEvent
            && (this.#looksLikeMonacoError(event.message, event.error?.stack, event.filename)
                || event.error instanceof Event)) {
            console.warn("Monaco editor error:", event.message, event.filename)
            event.preventDefault()
            return true
        }
        if (event instanceof SecurityPolicyViolationEvent) {
            // Log CSP violations but don't crash - often caused by browser extensions or specific browser configs
            console.warn(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI}`)
            event.preventDefault()
            return true
        }
        if (!(event instanceof PromiseRejectionEvent)) {return false}
        const {reason} = event
        if (Errors.isAbort(reason)) {
            console.debug(`Abort '${reason.message}'`)
            event.preventDefault()
            return true
        }
        if (reason instanceof Errors.Warning) {
            console.debug(`Warning '${reason.message}'`)
            event.preventDefault()
            Dialogs.info({headline: "Warning", message: reason.message}).then(EmptyExec)
            return true
        }
        // Handle SecurityError from File System Access API (e.g., showDirectoryPicker denied)
        if (reason instanceof DOMException && reason.name === "SecurityError") {
            console.warn(`SecurityError: ${reason.message}`)
            event.preventDefault()
            Dialogs.info({
                headline: "Access Denied",
                message: "The browser blocked access to the file system."
            }).then(EmptyExec)
            return true
        }
        // Handle Monaco editor worker errors (throws Event objects when workers fail to load)
        if (reason instanceof Event || (reason instanceof Error && this.#looksLikeMonacoError(reason.message, reason.stack))) {
            console.warn("Monaco editor error (web workers may be unavailable):", reason)
            event.preventDefault()
            return true
        }
        // Handle browser-internal errors (e.g., DuckDuckGo feature detection)
        if (reason instanceof Error
            && BrowserInternalPatterns.some(pattern => reason.message.includes(pattern))) {
            console.debug(`Browser internal error: ${reason.message}`)
            event.preventDefault()
            return true
        }
        return false
    }

    processError(scope: string, event: Event): boolean {
        if (this.#tryIgnore(event)) {return false}
        const error = ErrorInfo.extract(event)
        const foreignOrigin = this.#extractForeignOrigin(error)
        const looksLikeExtension = this.#looksLikeExtension(error) || foreignOrigin !== null
        console.warn("[ErrorHandler]", {
            scope,
            error,
            foreignOrigin,
            looksLikeExtension,
            scriptsCount: document.scripts.length,
            locationOrigin: window.location.origin
        })
        // Warn about extension errors but don't crash
        if (looksLikeExtension && !this.#errorThrown) {
            event.preventDefault()
            const originInfo = foreignOrigin !== null
                ? `This error originated from external code (${new URL(foreignOrigin).hostname}).`
                : "A browser extension may have caused an error."
            Dialogs.info({
                headline: "Warning",
                message: `${originInfo} Consider disabling extensions for a more stable experience.`
            }).then(EmptyExec)
            return false
        }
        console.debug("processError", scope, event)
        if (this.#errorThrown) {return false}
        this.#errorThrown = true
        AnimationFrame.terminate()
        this.#report(scope, error)
        this.#showDialog(scope, error, looksLikeExtension, foreignOrigin)
        return true
    }

    #report(scope: string, error: ErrorInfo): void {
        console.error(scope, error.name, error.message, error.stack)
        if (!import.meta.env.PROD) {return}
        const maxStackSize = 2000
        const body = JSON.stringify({
            date: new Date().toISOString(),
            agent: Browser.userAgent,
            build: this.#buildInfo,
            scripts: document.scripts.length,
            error: {...error, stack: error.stack?.slice(0, maxStackSize)},
            logs: LogBuffer.get()
        } satisfies ErrorLog)
        fetch("https://logs.opendaw.studio/log.php", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body
        }).then(console.info, console.warn)
    }

    #showDialog(scope: string, error: ErrorInfo, probablyHasExtension: boolean, foreignOrigin: string | null): void {
        if (Surface.isAvailable()) {
            Dialogs.error({
                scope,
                name: error.name,
                message: error.message ?? "no message",
                probablyHasExtension,
                foreignOrigin,
                backupCommand: this.#recover()
            })
        } else {
            alert(`Boot Error in '${scope}': ${error.name}`)
        }
    }

    install(owner: WindowProxy | Worker | AudioWorkletNode, scope: string): Terminable {
        if (this.#errorThrown) {return Terminable.Empty}
        const lifetime = this.#terminator.own(new Terminator())
        const handler = (event: Event) => {
            if (this.processError(scope, event)) {lifetime.terminate()}
        }
        lifetime.ownAll(
            Events.subscribe(owner, "error", handler),
            Events.subscribe(owner, "unhandledrejection", handler),
            Events.subscribe(owner, "messageerror", handler),
            Events.subscribe(owner, "processorerror" as any, handler),
            Events.subscribe(owner, "securitypolicyviolation", handler)
        )
        return lifetime
    }
}