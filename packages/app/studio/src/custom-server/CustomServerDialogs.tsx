import css from "./CustomServerDialogs.sass?inline"
import template from "./opendaw-server.php?raw"
import {Errors, isDefined, Option, RuntimeNotifier, Terminator, tryCatch} from "@opendaw/lib-std"
import {Clipboard, Files, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {CloudHandler, CustomServerCredentials, CustomServerHandler} from "@opendaw/studio-core"
import {Dialog} from "@/ui/components/Dialog"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {Surface} from "@/ui/surface/Surface"
import {openManual} from "@/ui/manuals"
import {CustomServerFile} from "@/custom-server/CustomServerFile"

const className = Html.adoptStyleSheet(css, "CustomServerDialogs")

export namespace CustomServerDialogs {
    const StorageKey = "custom-server"

    const isCredentials = (value: unknown): value is CustomServerCredentials =>
        typeof value === "object" && isDefined(value)
        && typeof Reflect.get(value, "url") === "string" && typeof Reflect.get(value, "token") === "string"

    const read = (): Option<CustomServerCredentials> => {
        const result = tryCatch(() => JSON.parse(localStorage.getItem(StorageKey) ?? "null") as unknown)
        return result.status === "success" && isCredentials(result.value) ? Option.wrap(result.value) : Option.None
    }

    const write = (credentials: CustomServerCredentials): void => {
        tryCatch(() => localStorage.setItem(StorageKey, JSON.stringify(credentials)))
    }

    const remove = (): void => {tryCatch(() => localStorage.removeItem(StorageKey))}

    const withFileName = (value: string): string => {
        const result = tryCatch(() => new URL(value))
        if (result.status === "failure" || result.value.pathname.endsWith(".php")) {return value}
        const url = result.value
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/${CustomServerFile.FileName}`
        return url.toString()
    }

    const validateUrl = (value: string): Option<string> => {
        const result = tryCatch(() => new URL(value))
        if (result.status === "failure") {return Option.wrap("Enter the full address of opendaw.php.")}
        const {protocol, hostname} = result.value
        const local = hostname === "localhost" || hostname === "127.0.0.1"
        if (protocol !== "https:" && !(protocol === "http:" && local)) {
            return Option.wrap("The address must start with https://")
        }
        return Option.None
    }

    const download = async (token: string): Promise<boolean> => {
        const source = await CustomServerFile.generate(template, token, CustomServerFile.originsFor(location.origin))
        const {status, error} = await Promises.tryCatch(Files.save(new TextEncoder().encode(source).buffer, {
            suggestedName: CustomServerFile.FileName,
            types: [{description: "PHP file", accept: {"text/x-php": [".php"]}}]
        }))
        if (status === "rejected" && !Errors.isAbort(error)) {console.warn(error)}
        return status === "resolved"
    }

    const offerUpdate = async (credentials: CustomServerCredentials): Promise<void> => {
        const approved = await RuntimeNotifier.approve({
            headline: "Server File Outdated",
            message: "A newer server file is available. Download it and replace opendaw.php on your webspace. Your backup stays where it is.",
            approveText: "Download",
            cancelText: "Later"
        })
        if (approved) {await download(credentials.token)}
    }

    export const connect = (): Promise<CloudHandler> => {
        const stored = read()
        const {promise, resolve, reject} = Promise.withResolvers<CloudHandler>()
        const lifecycle = new Terminator()
        let connecting = false
        const inputUrl: HTMLInputElement = (
            <input className="default input" type="url" autocomplete="username" spellcheck={false}
                   placeholder="https://example.com/opendaw.php" value={stored.mapOr(({url}) => url, "")}/>
        )
        const inputToken: HTMLInputElement = (
            <input className="default input" type="password" autocomplete="current-password"
                   placeholder="Paste or create" value={stored.mapOr(({token}) => token, "")}/>
        )
        const status: HTMLElement = <div className="status"/>
        const setStatus = (text: string, isError: boolean) => {
            status.textContent = text
            status.title = text
            status.classList.toggle("error", isError)
        }
        setStatus(stored.nonEmpty() ? "Connect to start the backup." : "Not connected.", false)
        const createFile = async () => {
            const token = CustomServerFile.createToken()
            if (await download(token)) {
                inputToken.value = token
                setStatus("Upload opendaw.php, then enter its address.", false)
            }
        }
        const copyToken = async (origin: Element) => {
            if (inputToken.value.length === 0) {
                setStatus("There is no token yet.", true)
                return
            }
            const {status} = await Promises.tryCatch(Clipboard.writeText(inputToken.value))
            if (status === "resolved") {Surface.get(origin).toast("Token copied to clipboard", IconSymbol.Copy)}
        }
        const approve = async (close: () => void) => {
            if (connecting) {return}
            const credentials: CustomServerCredentials = {url: withFileName(inputUrl.value.trim()), token: inputToken.value.trim()}
            const invalid = validateUrl(credentials.url)
            if (invalid.nonEmpty()) {
                setStatus(invalid.unwrap(), true)
                return
            }
            if (credentials.token.length === 0) {
                setStatus("Enter the token of this server file.", true)
                return
            }
            connecting = true
            setStatus("Connecting...", false)
            const handler = new CustomServerHandler(credentials)
            const result = await Promises.tryCatch(handler.version())
            connecting = false
            if (result.status === "rejected") {
                setStatus(result.error instanceof Error ? result.error.message : String(result.error), true)
                return
            }
            write(credentials)
            if (result.value < CustomServerHandler.Version) {await offerUpdate(credentials)}
            resolve(handler)
            close()
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline="Custom Server"
                    icon={IconSymbol.Server}
                    cancelable={true}
                    onCancel={() => reject(Errors.AbortError)}
                    leading={
                        <Button lifecycle={lifecycle} onClick={() => openManual("/manuals/custom-server")}
                                appearance={{color: Colors.gray, tooltip: "Open the manual"}}>
                            <Icon symbol={IconSymbol.Help}/><span>Manual</span>
                        </Button>
                    }
                    buttons={[
                        ...(stored.nonEmpty() ? [{
                            text: "Forget", onClick: (handler: { close: () => void }) => {
                                remove()
                                handler.close()
                            }
                        }] : []),
                        {text: "Close", onClick: handler => handler.close()},
                        {text: "Connect", primary: true, onClick: handler => {approve(handler.close).finally()}}
                    ]}>
                <form className={className} onsubmit={event => {
                    event.preventDefault()
                    approve(() => dialog.close()).finally()
                }}>
                    <p>openDAW creates a PHP file with your personal token. Upload it to any webspace with PHP
                        and HTTPS.</p>
                    <p className="note">You run the file on your own server and are responsible for its security,
                        backups, limits and costs. openDAW accepts no liability for data loss or misuse.
                        Anyone with the token can read and delete your backup.</p>
                    <div className="fields">
                        <label>Server File:</label>
                        <div className="row">
                            <Button lifecycle={lifecycle} onClick={() => createFile().finally()}
                                    appearance={{framed: true, tooltip: "Creates a new token and its server file"}}>
                                <span>Accept and Download</span>
                            </Button>
                        </div>
                        <label>Address:</label>
                        {inputUrl}
                        <label>Token:</label>
                        <div className="row">
                            {inputToken}
                            <Button lifecycle={lifecycle} onClick={() => copyToken(status).finally()}
                                    appearance={{framed: true, tooltip: "Keep the token in your password manager"}}>
                                <span>Copy</span>
                            </Button>
                        </div>
                    </div>
                    {status}
                    <input type="submit" className="hidden"/>
                </form>
            </Dialog>
        )
        dialog.addEventListener("close", () => {
            lifecycle.terminate()
            reject(Errors.AbortError)
        })
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return promise
    }
}
