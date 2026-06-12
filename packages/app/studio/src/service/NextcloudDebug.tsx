import {Arrays, panic, RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {NextcloudHandler} from "@opendaw/studio-core"
import {NextcloudDialogs} from "@/project/NextcloudDialogs"

export namespace NextcloudDebug {
    export const validateAccess = async (): Promise<void> => {
        const credentials = await Promises.tryCatch(NextcloudDialogs.showCredentialsDialog("Validate Nextcloud Access"))
        if (credentials.status === "rejected") {return}
        const handler = new NextcloudHandler(credentials.value)
        const probeFolder = "openDAW/opendaw-connection-test"
        const probePath = `${probeFolder}/probe.bin`
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
            await handler.delete(probeFolder)
            return entries
        })())
        notifier.terminate()
        if (result.status === "resolved") {
            await RuntimeNotifier.info({
                headline: "Nextcloud access OK",
                message: `Round-trip succeeded: connect, upload, download (verified), list, delete.\nRoot contains ${result.value.length} item(s).`
            })
        } else {
            console.warn(result.error)
            RuntimeNotifier.notify({message: "Nextcloud access failed.", icon: "Warning"})
        }
    }
}
