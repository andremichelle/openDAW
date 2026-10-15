import {Errors, RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"
import {Box, BoxGraph} from "@opendaw/lib-box"
import {WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"
import {FilePickerAcceptTypes, WclapStorage} from "@opendaw/studio-core"
import {OpenWclapAPI} from "@/opendaw-api"

type WclapBox = WclapDeviceBox | WclapInstrumentBox

const isWclapBox = (box: Box): box is WclapBox => box instanceof WclapDeviceBox || box instanceof WclapInstrumentBox

// A project's locally stored bundles that are gone: restored from the cloud by id, or browsed for like a missing sample
export namespace WclapMissing {
    export const resolve = async (boxGraph: BoxGraph): Promise<void> => {
        const boxes = boxGraph.boxes().filter(isWclapBox)
        const urls = Array.from(new Set(boxes.map(box => box.url.getValue()).filter(WclapStorage.isLocal)))
        for (const url of urls) {
            const id = WclapStorage.idOf(url)
            if (await WclapStorage.exists(id)) {continue}
            const users = boxes.filter(box => box.url.getValue() === url)
            const name = `'${users[0].label.getValue()}' (${users[0].clapId.getValue()})`
            if (await restoreFromCloud(url)) {
                RuntimeNotifier.notify({message: `WebCLAP plugin ${name} has been restored from the cloud`, icon: "Checkbox"})
                continue
            }
            const approved = await RuntimeNotifier.approve({
                headline: "Missing Plugin",
                message: `Could not find WebCLAP plugin ${name}`,
                cancelText: "Ignore",
                approveText: "Browse"
            })
            if (!approved) {continue}
            const {error, status, value: files} =
                await Promises.tryCatch(Files.open({...FilePickerAcceptTypes.WclapFiles, multiple: false}))
            if (status === "rejected") {
                if (Errors.isAbort(error) || Errors.isNotAllowed(error)) {return}
                console.warn(`File browse failed: ${error}`)
                RuntimeNotifier.notify({message: "File access error.", icon: "Warning"})
                return
            }
            if (files.length === 0) {return}
            const stored = await Promises.tryCatch(files[0].arrayBuffer().then(archive => WclapStorage.store(archive)))
            if (stored.status === "rejected") {
                await RuntimeNotifier.info({
                    headline: "Plugin Import Failed",
                    message: `'${files[0].name}' could not be imported: ${String(stored.error)}`
                })
                continue
            }
            if (stored.value !== url) {
                boxGraph.beginTransaction()
                users.forEach(box => box.url.setValue(stored.value))
                boxGraph.endTransaction()
            }
            RuntimeNotifier.notify({message: `WebCLAP plugin ${name} has been replaced`, icon: "Checkbox"})
        }
    }

    // a cloud id is the archive's hash, so a catalogue entry is this very build
    const restoreFromCloud = async (url: string): Promise<boolean> => {
        const id = WclapStorage.idOf(url)
        const entry = await OpenWclapAPI.get().find(id)
        if (entry.isEmpty()) {return false}
        const {status, value: archive, error} = await Promises.tryCatch(OpenWclapAPI.get().load(id))
        if (status === "rejected") {
            console.warn(`WebCLAP ${id} could not be downloaded:`, error)
            return false
        }
        if (await WclapStorage.urlFor(archive) !== url) {return false}
        await WclapStorage.store(archive)
        return true
    }
}
