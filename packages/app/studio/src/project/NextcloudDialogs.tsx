import {createElement} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Errors, Option, RuntimeNotifier, Terminator, unitValue, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {
    NextcloudCredentials,
    NextcloudHandler,
    ProjectMeta,
    ProjectProfile,
    ProjectStorage,
    SharedFolderSync
} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {Dialogs} from "@/ui/components/dialogs"
import {NextcloudBrowser} from "@/project/NextcloudBrowser"
import {ProjectDialogs} from "@/project/ProjectDialogs"
import type {StudioService} from "@/service/StudioService"

type Conflict = "override" | "copy" | "cancel"
type BrowseResult = { type: "select", listing: SharedFolderSync.Listing } | { type: "reopen" }

export namespace NextcloudDialogs {
    // Only the server URL is remembered across reloads to pre-fill the dialog; username and app
    // password are never stored. The dialog is always shown so a different Nextcloud user can be
    // chosen each time.
    const ServerUrlKey = "nextcloud.server-url"

    export const browse = async (service: StudioService): Promise<void> => {
        const credentials = await ensureConnection()
        if (credentials.isEmpty()) {return}
        const handler = new NextcloudHandler(credentials.unwrap())
        const {username} = credentials.unwrap()
        // Deleting a project tears down the browse dialog (the delete-progress dialog clears the
        // flyout), so the browser asks us to recreate it. Loop until the user selects or cancels.
        const loop = async (): Promise<void> => {
            const result = await Promises.tryCatch(showBrowseDialog(handler, username))
            if (result.status === "rejected") {return}
            if (result.value.type === "reopen") {return loop()}
            await openProject(service, credentials.unwrap(), result.value.listing)
        }
        return loop()
    }

    export const save = async (service: StudioService): Promise<void> => {
        if (!service.hasProfile) {
            await RuntimeNotifier.info({headline: "Nextcloud", message: "Open or create a project first."})
            return
        }
        const credentials = await ensureConnection()
        if (credentials.isEmpty()) {return}
        const abort = new AbortController()
        const handler = new NextcloudHandler(credentials.unwrap(), abort.signal)
        const profile = service.profile
        const progressValue = new DefaultObservableValue<unitValue>(0.0)
        const notifier = RuntimeNotifier.progress({
            headline: "Nextcloud Upload",
            message: `Uploading "${profile.meta.name}"...`,
            progress: progressValue,
            cancel: () => abort.abort()
        })
        const result = await Promises.tryCatch(SharedFolderSync.saveProject(handler, profile, ({value, label}) => {
            progressValue.setValue(value)
            notifier.message = label
        }, abort.signal))
        notifier.terminate()
        if (result.status === "resolved") {
            await RuntimeNotifier.info({
                headline: "Uploaded to Nextcloud",
                message: result.value > 0
                    ? `Uploaded "${profile.meta.name}".\nWARNING: ${result.value} asset(s) could not be uploaded;`
                    + " the shared project is incomplete. See console for details."
                    : `Uploaded "${profile.meta.name}" and its assets.`
            })
        } else if (!Errors.isAbort(result.error)) {
            console.warn(result.error)
            RuntimeNotifier.notify({message: "Upload failed.", icon: "Warning"})
        }
    }

    // Always prompts for and validates credentials so a different Nextcloud user can be chosen each
    // time. None = the user cancelled or the connection failed.
    const ensureConnection = async (): Promise<Option<NextcloudCredentials>> => {
        const credentials = await Promises.tryCatch(showCredentialsDialog("Connect to Nextcloud"))
        if (credentials.status === "rejected") {return Option.None}
        if (!await connect(new NextcloudHandler(credentials.value))) {return Option.None}
        return Option.wrap(credentials.value)
    }

    const connect = async (handler: NextcloudHandler): Promise<boolean> => {
        const notifier = RuntimeNotifier.progress({headline: "Nextcloud", message: "Connecting..."})
        const result = await Promises.tryCatch(handler.alive())
        notifier.terminate()
        if (result.status === "rejected") {
            const reason = result.error instanceof Error ? result.error.message : String(result.error)
            console.warn(reason)
            RuntimeNotifier.notify({message: "Could not connect.", icon: "Warning"})
            return false
        }
        return true
    }

    const openProject = async (service: StudioService, credentials: NextcloudCredentials,
                               {uuid, entry}: SharedFolderSync.Listing): Promise<void> => {
        const abort = new AbortController()
        const handler = new NextcloudHandler(credentials, abort.signal)
        const progressValue = new DefaultObservableValue<unitValue>(0.0)
        const notifier = RuntimeNotifier.progress({
            headline: "Nextcloud",
            message: `Opening "${entry.meta.name}"...`,
            progress: progressValue,
            cancel: () => abort.abort()
        })
        const result = await Promises.tryCatch(SharedFolderSync.openProject(service, handler, uuid,
            value => progressValue.setValue(value), abort.signal))
        notifier.terminate()
        if (result.status === "rejected") {
            if (!Errors.isAbort(result.error)) {
                console.warn(result.error)
                RuntimeNotifier.notify({message: "Open failed.", icon: "Warning"})
            }
            return
        }
        await store(service, result.value)
    }

    // Persists the freshly loaded project into local OPFS and makes it the active project. If a project
    // with the same UUID already exists locally, asks whether to override it or save a separate copy.
    const store = async (service: StudioService, profile: ProjectProfile): Promise<void> => {
        if (await ProjectStorage.exists(profile.uuid)) {
            const choice = await askConflict(profile.meta.name)
            if (choice === "cancel") {return}
            if (choice === "copy") {
                const meta = await Promises.tryCatch(ProjectDialogs.showSaveDialog({
                    headline: "Copy Project",
                    meta: profile.meta
                }))
                if (meta.status === "rejected") {return}
                // The constructor reads meta back from the copied graph's ProjectMetaBox (old name), so we
                // apply the new name afterwards via saveAs, which writes it to the box and to OPFS.
                const copy = new ProjectProfile(UUID.generate(), profile.project.copy(), ProjectMeta.copy(profile.meta), profile.cover)
                await copy.saveAs(meta.value)
                service.projectProfileService.setValue(Option.wrap(copy))
                return
            }
        }
        // No conflict, or "override": write at the project's own UUID and mark it saved.
        await profile.saveAs(profile.meta)
        service.projectProfileService.setValue(Option.wrap(profile))
    }

    const askConflict = (name: string): Promise<Conflict> => {
        const {resolve, promise} = Promise.withResolvers<Conflict>()
        const dialog: HTMLDialogElement = (
            <Dialog headline="Project already exists"
                    icon={IconSymbol.System}
                    cancelable={true}
                    onCancel={() => resolve("cancel")}
                    buttons={[
                        {
                            text: "Copy", onClick: handler => {
                                resolve("copy")
                                handler.close()
                            }
                        },
                        {
                            text: "Override", primary: true, onClick: handler => {
                                resolve("override")
                                handler.close()
                            }
                        }
                    ]}>
                <div style={{padding: "1em 0", maxWidth: "28em"}}>
                    {`A project "${name}" already exists in your local storage. Override it with the Nextcloud`
                        + ` version, or keep both by saving the Nextcloud version as a copy?`}
                </div>
            </Dialog>
        )
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return promise
    }

    const showBrowseDialog = async (cloudHandler: NextcloudHandler, username: string): Promise<BrowseResult> => {
        const {resolve, reject, promise} = Promise.withResolvers<BrowseResult>()
        const lifecycle = new Terminator()
        const dialog: HTMLDialogElement = (
            <Dialog headline="Open from Nextcloud"
                    icon={IconSymbol.Nextcloud}
                    onCancel={() => reject(Errors.AbortError)}
                    buttons={[{text: "Close", onClick: dialogHandler => dialogHandler.close()}]}
                    cancelable={true} style={{height: "30em"}}>
                <div style={{height: "2em"}}/>
                <NextcloudBrowser lifecycle={lifecycle} handler={cloudHandler} username={username}
                                  select={listing => {resolve({type: "select", listing}); dialog.close()}}
                                  reopen={() => {resolve({type: "reopen"}); dialog.close()}}/>
            </Dialog>
        )
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return promise.finally(() => lifecycle.terminate())
    }

    export const showCredentialsDialog = async (headline: string): Promise<NextcloudCredentials> => {
        const {resolve, reject, promise} = Promise.withResolvers<NextcloudCredentials>()
        const inputUrl: HTMLInputElement =
            <input className="default" type="text" autocomplete="url" value={localStorage.getItem(ServerUrlKey) ?? ""}
                   placeholder="https://your-nextcloud"/>
        const inputUser: HTMLInputElement =
            <input className="default" type="text" autocomplete="username" placeholder="Username"/>
        const inputPassword: HTMLInputElement =
            <input className="default" type="password" autocomplete="current-password" placeholder="Password"/>
        const approve = () => {
            const baseUrl = inputUrl.value.trim()
            const username = inputUser.value.trim()
            const appPassword = inputPassword.value
            if (baseUrl.length === 0 || username.length === 0 || appPassword.length === 0) {
                Dialogs.info({
                    headline: "Missing input",
                    message: "Server URL, username and password are required."
                }).finally()
                return false
            }
            localStorage.setItem(ServerUrlKey, baseUrl)
            resolve({baseUrl, username, appPassword})
            return true
        }
        // The form wrapper exists, so the password field is contained in a form (browser/password-manager
        // requirement); submit is handled manually.
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline}
                    icon={IconSymbol.Nextcloud}
                    cancelable={true}
                    onCancel={() => reject(Errors.AbortError)}
                    buttons={[
                        {text: "Close", onClick: handler => handler.close()},
                        {text: "Connect", primary: true, onClick: handler => {if (approve()) {handler.close()}}}
                    ]}>
                <form style={{
                    padding: "1em 0", display: "grid", gridTemplateColumns: "auto 1fr",
                    columnGap: "1em", rowGap: "0.5em"
                }} onsubmit={event => {
                    event.preventDefault()
                    if (approve()) {dialog.close()}
                }}>
                    <div>Server URL:</div>
                    {inputUrl}
                    <div>Username:</div>
                    {inputUser}
                    <div>Password:</div>
                    {inputPassword}
                </form>
            </Dialog>
        )
        dialog.onkeydown = event => {if (event.code === "Enter") {if (approve()) {dialog.close()}}}
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        const focusTarget = inputUrl.value.length === 0 ? inputUrl
            : inputUser.value.length === 0 ? inputUser : inputPassword
        focusTarget.focus()
        return promise
    }
}
