import {createElement} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Errors, panic, RuntimeNotifier, unitValue} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {NextcloudCredentials, NextcloudHandler, SharedFolderSync} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {Dialogs} from "@/ui/components/dialogs"
import type {StudioService} from "@/service/StudioService"

export namespace NextcloudDebug {
    export const validateAccess = async (): Promise<void> => {
        const credentials = await Promises.tryCatch(showCredentialsDialog())
        if (credentials.status === "rejected") {return}
        const handler = new NextcloudHandler(credentials.value)
        const probePath = "openDAW/.opendaw-connection-test/probe.bin"
        const payload = new TextEncoder().encode(`openDAW Nextcloud probe ${new Date().toISOString()}`)
        const notifier = RuntimeNotifier.progress({headline: "Nextcloud", message: "Connecting..."})
        const result = await Promises.tryCatch((async () => {
            await handler.alive()
            notifier.message = "Uploading test file..."
            await handler.upload(probePath, payload.buffer)
            notifier.message = "Downloading test file..."
            const downloaded = new Uint8Array(await handler.download(probePath))
            if (!equals(downloaded, payload)) {return panic("Downloaded bytes differ from uploaded bytes")}
            notifier.message = "Listing root..."
            const entries = await handler.list("")
            notifier.message = "Cleaning up..."
            await handler.delete(probePath)
            return entries
        })())
        notifier.terminate()
        if (result.status === "resolved") {
            await RuntimeNotifier.info({
                headline: "Nextcloud access OK",
                message: `Round-trip succeeded: connect, upload, download (verified), list, delete.\nRoot contains ${result.value.length} item(s).`
            })
        } else {
            await RuntimeNotifier.info({headline: "Nextcloud access failed", message: String(result.error)})
        }
    }

    export const validateSharedFolder = async (service: StudioService): Promise<void> => {
        if (!service.hasProfile) {
            await RuntimeNotifier.info({headline: "Nextcloud", message: "Open or create a project first."})
            return
        }
        const credentials = await Promises.tryCatch(showCredentialsDialog())
        if (credentials.status === "rejected") {return}
        const handler = new NextcloudHandler(credentials.value)
        const profile = service.profile
        const progressValue = new DefaultObservableValue<unitValue>(0.0)
        const notifier = RuntimeNotifier.progress({
            headline: "Nextcloud Shared Folder", message: "Saving project...", progress: progressValue
        })
        const result = await Promises.tryCatch((async () => {
            const failed = await SharedFolderSync.saveProject(handler, profile, ({value, label}) => {
                progressValue.setValue(value)
                notifier.message = label
            })
            notifier.message = "Listing shared projects..."
            const listing = await SharedFolderSync.listProjects(handler)
            notifier.message = "Re-opening project..."
            const reopened = await SharedFolderSync.openProject(service, handler, profile.uuid,
                value => progressValue.setValue(value))
            return {count: listing.length, name: reopened.meta.name, failed}
        })())
        notifier.terminate()
        if (result.status === "resolved") {
            const failedNote = result.value.failed > 0
                ? `\nWARNING: ${result.value.failed} asset(s) could not be uploaded; the shared project is incomplete. See console for details.`
                : ""
            await RuntimeNotifier.info({
                headline: "Shared folder OK",
                message: `Saved project + deduplicated assets.\nCatalog holds ${result.value.count} project(s); re-opened "${result.value.name}".${failedNote}`
            })
        } else {
            await RuntimeNotifier.info({headline: "Shared folder failed", message: String(result.error)})
        }
    }

    const showCredentialsDialog = async (): Promise<NextcloudCredentials> => {
        const {resolve, reject, promise} = Promise.withResolvers<NextcloudCredentials>()
        const inputUrl: HTMLInputElement =
            <input className="default" type="text" value="https://nextcloud.opendaw.studio" placeholder="https://your-nextcloud"/>
        const inputUser: HTMLInputElement = <input className="default" type="text" placeholder="username"/>
        const inputPassword: HTMLInputElement = <input className="default" type="password" placeholder="app password"/>
        const approve = () => {
            const baseUrl = inputUrl.value.trim()
            const username = inputUser.value.trim()
            const appPassword = inputPassword.value
            if (baseUrl.length === 0 || username.length === 0 || appPassword.length === 0) {
                Dialogs.info({headline: "Missing input", message: "Server URL, username and app password are required."}).finally()
                return false
            }
            resolve({baseUrl, username, appPassword})
            return true
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline="Validate Nextcloud Access"
                    icon={IconSymbol.System}
                    cancelable={true}
                    buttons={[{text: "Validate", primary: true, onClick: handler => {if (approve()) {handler.close()}}}]}>
                <div style={{padding: "1em 0", display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "1em", rowGap: "0.5em"}}>
                    <div>Server URL:</div>{inputUrl}
                    <div>Username:</div>{inputUser}
                    <div>App password:</div>{inputPassword}
                </div>
            </Dialog>
        )
        dialog.oncancel = () => reject(Errors.AbortError)
        dialog.onkeydown = event => {if (event.code === "Enter") {if (approve()) {dialog.close()}}}
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        inputUser.focus()
        return promise
    }

    const equals = (left: Uint8Array, right: Uint8Array): boolean => {
        if (left.length !== right.length) {return false}
        for (let index = 0; index < left.length; index++) {if (left[index] !== right[index]) {return false}}
        return true
    }
}
