import css from "./StageDialog.sass?inline"
import {DefaultObservableValue, Lifecycle, MutableObservableValue, Option, RuntimeNotifier, Terminator, tryCatch} from "@opendaw/lib-std"
import {Clipboard, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ProjectProfile} from "@opendaw/studio-core"
import {Dialog} from "@/ui/components/Dialog"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {Surface} from "@/ui/surface/Surface"
import {openManual} from "@/ui/manuals"
import {CustomServerFile} from "@/custom-server/CustomServerFile"
import {StageClient} from "@/stage/StageClient"
import {StagePublish} from "@/stage/StagePublish"
import {StagePasswords} from "@/stage/StagePasswords"

const className = Html.adoptStyleSheet(css, "StageDialog")

export namespace StageDialog {
    const Toggle = ({lifecycle, model, text}: {
        lifecycle: Lifecycle, model: MutableObservableValue<boolean>, text: string
    }) => (
        <div className="toggle">
            <Checkbox lifecycle={lifecycle} model={model} appearance={{color: Colors.black}}>
                <Icon symbol={IconSymbol.Checkbox}/>
            </Checkbox>
            <span onclick={() => model.setValue(!model.getValue())}>{text}</span>
        </div>
    )

    const run = async (credentials: StageClient.Credentials, profile: ProjectProfile,
                       options: StagePublish.Options): Promise<void> => {
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline: "Publishing to Your Stage", progress})
        const {status, value, error} = await Promises.tryCatch(StagePublish.publish(credentials, profile, options,
            step => dialog.message = `${step}...`, value => progress.setValue(value)))
        dialog.terminate()
        if (status === "rejected") {
            return RuntimeNotifier.info({
                headline: "Could Not Publish",
                message: error instanceof Error ? error.message : String(error)
            })
        }
        const open = await RuntimeNotifier.approve({
            headline: value.replaced ? "Republished" : "Published",
            message: value.replaced
                ? `Your track is updated on your stage:\n${value.url}`
                : `Your track is live on your stage:\n${value.url}`,
            approveText: "Open",
            cancelText: "Close"
        })
        const link = tryCatch(() => new URL(value.url))
        if (open && link.status === "success" && link.value.origin === new URL(credentials.url).origin) {
            window.open(link.value.href, "_blank", "noopener")
        }
    }

    export const open = (profile: ProjectProfile): void => {
        const stored = StageClient.readUrl()
        const lifecycle = new Terminator()
        const includeProject = new DefaultObservableValue(true)
        const allowMixdownDownload = new DefaultObservableValue(false)
        let busy = false
        // with the credential API the fields must not look like a login, or Chrome lists every opendaw login
        const managed = StagePasswords.isSupported()
        const inputUrl: HTMLInputElement = (
            <input className="default input" type="url" autocomplete={managed ? "off" : "username"} spellcheck={false}
                   placeholder="https://example.com/stage/" value={stored.unwrapOrElse("")}/>
        )
        const inputToken: HTMLInputElement = (
            <input className={managed ? "default input masked" : "default input"} type={managed ? "text" : "password"}
                   autocomplete={managed ? "off" : "current-password"} spellcheck={false} placeholder="Paste or create"/>
        )
        const status: HTMLElement = <div className="status"/>
        const setStatus = (text: string, isError: boolean) => {
            status.textContent = text
            status.title = text
            status.classList.toggle("error", isError)
        }
        const credentials = (): Option<StageClient.Credentials> => {
            const url = StageClient.normalizeUrl(inputUrl.value)
            if (url.isEmpty()) {
                setStatus("Enter the address of your stage, starting with https://", true)
                return Option.None
            }
            const token = inputToken.value.trim()
            if (token.length === 0) {
                setStatus("Enter the token of your stage, or create one.", true)
                return Option.None
            }
            return Option.wrap({url: url.unwrap(), token})
        }
        const createToken = async (origin: Element) => {
            inputToken.value = CustomServerFile.createToken()
            const {status} = await Promises.tryCatch(Clipboard.writeText(inputToken.value))
            if (status === "resolved") {Surface.get(origin).toast("Token copied to clipboard", IconSymbol.Copy)}
            setStatus("Enter this token on the setup page of your stage.", false)
        }
        const copyToken = async (origin: Element) => {
            if (inputToken.value.length === 0) {
                setStatus("There is no token yet.", true)
                return
            }
            const {status} = await Promises.tryCatch(Clipboard.writeText(inputToken.value))
            if (status === "resolved") {Surface.get(origin).toast("Token copied to clipboard", IconSymbol.Copy)}
        }
        const check = async () => {
            const connection = credentials()
            if (connection.isEmpty()) {return}
            setStatus("Connecting...", false)
            const result = await Promises.tryCatch(Promise.all([
                StageClient.alive(connection.unwrap()),
                StageClient.status(connection.unwrap(), StagePublish.trackId(profile))]))
            if (result.status === "rejected") {
                setStatus(result.error instanceof Error ? result.error.message : String(result.error), true)
                return
            }
            const [{title}, {published}] = result.value
            setStatus(published ? `Connected to ${title}. Publishing replaces this track.` : `Connected to ${title}.`, false)
        }
        const approve = async (close: () => void) => {
            if (busy) {return}
            const connection = credentials()
            if (connection.isEmpty()) {return}
            if (profile.cover.isEmpty()) {
                setStatus("Add a cover in the project info first.", true)
                return
            }
            busy = true
            setStatus("Connecting...", false)
            const alive = await Promises.tryCatch(StageClient.alive(connection.unwrap()))
            busy = false
            if (alive.status === "rejected") {
                setStatus(alive.error instanceof Error ? alive.error.message : String(alive.error), true)
                return
            }
            StageClient.writeUrl(connection.unwrap().url)
            StagePasswords.remember(connection.unwrap()).finally()
            close()
            await run(connection.unwrap(), profile, {
                includeProject: includeProject.getValue(),
                allowMixdownDownload: allowMixdownDownload.getValue()
            })
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline="Publish to Your Stage"
                    icon={IconSymbol.Share}
                    cancelable={true}
                    leading={
                        <Button lifecycle={lifecycle} onClick={() => openManual("/manuals/stage-website")}
                                appearance={{color: Colors.gray, tooltip: "Open the manual"}}>
                            <Icon symbol={IconSymbol.Help}/><span>Manual</span>
                        </Button>
                    }
                    buttons={[
                        ...(stored.nonEmpty() ? [{
                            text: "Forget", onClick: (handler: { close: () => void }) => {
                                StageClient.forget()
                                handler.close()
                            }
                        }] : []),
                        {text: "Close", onClick: handler => handler.close()},
                        {text: "Publish", primary: true, onClick: handler => {approve(handler.close).finally()}}
                    ]}>
                <form className={className} onsubmit={event => {
                    event.preventDefault()
                    approve(() => dialog.close()).finally()
                }}>
                    <p>Publish the mixdown, the cover and the project info to your own openDAW Stage website.
                        Publishing this project again replaces its track and keeps likes and comments.</p>
                    <p className="note">Make sure all samples, soundfonts and images are cleared of copyright.
                        You are responsible for everything you publish.</p>
                    <div className="fields">
                        <label>Address:</label>
                        {inputUrl}
                        <label>Token:</label>
                        <div className="row">
                            {inputToken}
                            <Button lifecycle={lifecycle} onClick={() => createToken(status).finally()}
                                    appearance={{framed: true, tooltip: "Creates a new token for the setup of your stage"}}>
                                <span>Create</span>
                            </Button>
                            <Button lifecycle={lifecycle} onClick={() => copyToken(status).finally()}
                                    appearance={{framed: true, tooltip: "Keep the token in your password manager"}}>
                                <span>Copy</span>
                            </Button>
                        </div>
                        <label/>
                        <Toggle lifecycle={lifecycle} model={includeProject} text="Allow opening in openDAW"/>
                        <label/>
                        <Toggle lifecycle={lifecycle} model={allowMixdownDownload} text="Allow downloading the mixdown"/>
                    </div>
                    {status}
                    <input type="submit" className="hidden"/>
                </form>
            </Dialog>
        )
        dialog.addEventListener("close", () => lifecycle.terminate())
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        const restore = async () => {
            const recalled = await StagePasswords.recall()
            if (recalled.nonEmpty()) {
                const {url, token} = recalled.unwrap()
                inputUrl.value = url
                inputToken.value = token
                return check()
            }
            setStatus(stored.nonEmpty()
                ? "Enter the token of your stage."
                : "Create a token, set up your stage, then enter its address.", false)
        }
        restore().finally()
    }
}
