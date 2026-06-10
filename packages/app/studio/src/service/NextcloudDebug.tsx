import {Arrays, DefaultObservableValue, Errors, panic, RuntimeNotifier, unitValue} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {NextcloudHandler, SharedFolderSync} from "@opendaw/studio-core"
import {NextcloudDialogs} from "@/project/NextcloudDialogs"
import type {StudioService} from "@/service/StudioService"

export namespace NextcloudDebug {
    export const validateAccess = async (): Promise<void> => {
        const credentials = await Promises.tryCatch(NextcloudDialogs.showCredentialsDialog("Validate Nextcloud Access"))
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
            if (!Arrays.equals(downloaded, payload)) {return panic("Downloaded bytes differ from uploaded bytes")}
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
        const credentials = await Promises.tryCatch(NextcloudDialogs.showCredentialsDialog("Validate Nextcloud Access"))
        if (credentials.status === "rejected") {return}
        const abort = new AbortController()
        const handler = new NextcloudHandler(credentials.value, abort.signal)
        const profile = service.profile
        const progressValue = new DefaultObservableValue<unitValue>(0.0)
        const notifier = RuntimeNotifier.progress({
            headline: "Nextcloud Shared Folder",
            message: "Saving project...",
            progress: progressValue,
            cancel: () => abort.abort()
        })
        const result = await Promises.tryCatch((async () => {
            const failed = await SharedFolderSync.saveProject(handler, profile, ({value, label}) => {
                progressValue.setValue(value)
                notifier.message = label
            }, abort.signal)
            notifier.message = "Listing shared projects..."
            const listing = await SharedFolderSync.listProjects(handler)
            notifier.message = "Re-opening project..."
            const reopened = await SharedFolderSync.openProject(service, handler, profile.uuid,
                value => progressValue.setValue(value), abort.signal)
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
        } else if (Errors.isAbort(result.error)) {
            await RuntimeNotifier.info({headline: "Nextcloud", message: "Sync cancelled."})
        } else {
            await RuntimeNotifier.info({headline: "Shared folder failed", message: String(result.error)})
        }
    }
}
