import {
    DefaultObservableValue,
    EmptyExec,
    Errors,
    isInstanceOf,
    Progress,
    RuntimeNotifier,
    RuntimeSignal,
    TimeSpan,
    unitValue
} from "@opendaw/lib-std"
import {Browser} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {CloudService} from "./CloudService"
import {CloudHandler} from "./CloudHandler"
import {CloudAuthManager} from "./CloudAuthManager"
import {CloudBackupSamples} from "./CloudBackupSamples"
import {CloudBackupProjects} from "./CloudBackupProjects"
import {CloudBackupTemplates} from "./CloudBackupTemplates"
import {CloudBackupSoundfonts} from "./CloudBackupSoundfonts"
import {CloudBackupWclaps} from "./CloudBackupWclaps"
import {CloudBackupPresets} from "./CloudBackupPresets"
import {CloudBackupScripts} from "./CloudBackupScripts"
import {ProjectSignals} from "../project"

export namespace CloudBackup {
    export const labelOf = (service: CloudService): string => service === "CustomServer" ? "Custom Server" : service

    const messageOf = (service: CloudService): string => service === "CustomServer"
        ? `Keep a backup of your projects, samples, presets and more on your own webspace, the same way as with Dropbox or Google Drive.

            All you need is a hosting package with PHP and HTTPS, which most providers include. openDAW creates a small server file for you, you upload it once and you are ready.

            Your files go to your server and nowhere else. You run it, so its security, limits and costs are in your hands.`
        : `openDAW will never store or share your personal account details!
                                        
                                        Dropbox requires permission to read “basic account info” such as your name and email, but openDAW does not use or retain this information. We only access the files you choose to synchronize. 
                                        
                                        Clicking 'Sync' may open a new tab to authorize your dropbox.`

    export const backup = async (cloudAuthManager: CloudAuthManager, service: CloudService) => {
        const DialogMessage = messageOf(service)
        const approved = await RuntimeNotifier.approve({
            headline: service === "CustomServer" ? "Back up to your own server" : "openDAW and your data",
            message: DialogMessage,
            approveText: "Sync",
            cancelText: "Cancel"
        })
        if (!approved) {return}
        try {
            const handler = await cloudAuthManager.getHandler(service)
            while (true) {
                const {status, error} = await Promises.tryCatch(CloudBackup.backupWithHandler(handler, service))
                if (status === "resolved") {break}
                if (Errors.isAbort(error)) {return}
                if (!RuntimeNotifier.installed) {return Promise.reject(error)}
                console.warn(error)
                const retry = await RuntimeNotifier.approve({
                    headline: "Cloud sync failed",
                    message: `The sync did not finish. Data already synced is safe, the rest is missing.
                    
                    ${String(error)}`,
                    approveText: "Retry",
                    cancelText: "Cancel"
                })
                if (!retry) {return}
            }
            await RuntimeNotifier.info({
                headline: "Cloud Backup",
                message: "Everything is up to date."
            })
        } catch (reason: unknown) {
            if (Errors.isAbort(reason)) {return}
            console.warn(reason)
            await RuntimeNotifier.info({
                headline: "Cloud sync failed",
                message: `Could not connect to ${labelOf(service)}.
                    
                    ${String(reason)}`
            })
        } finally {
            RuntimeSignal.dispatch(ProjectSignals.StorageUpdated)
        }
    }

    export const backupWithHandler = async (cloudHandler: CloudHandler, service: CloudService) => {
        const progressValue = new DefaultObservableValue<unitValue>(0.0)
        const abortController = new AbortController()
        const {signal} = abortController
        const aborted = new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(Errors.AbortError), {once: true}))
        aborted.catch(EmptyExec)
        const untilAborted = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted])
        const notification = RuntimeNotifier.progress({
            headline: `Backup with ${labelOf(service)}`, progress: progressValue, cancel: () => abortController.abort()
        })
        const log = (text: string) => {
            if (signal.aborted) {throw Errors.AbortError}
            notification.message = text
        }
        const [progressSamples, progressProjects, progressTemplates, progressSoundfonts, progressPresets, progressScripts, progressWclaps] =
            Progress.split(progress => progressValue.setValue(progress), 7)
        const lockPath = "lock.json"
        type Lock = { id: string, created: string }
        let canReleaseLock = false
        try {
            const {status, error, value} = await Promises.tryCatch(cloudHandler.download(lockPath))
            console.debug("LOCK", status)
            if (status === "resolved") {
                const lock: Lock = JSON.parse(new TextDecoder().decode(value))
                if (lock.id !== Browser.id()) {
                    // another browser is currently doing a backup
                    const lockCreated = new Date(lock.created)
                    const timeString = TimeSpan.millis(lockCreated.getTime() - new Date().getTime()).toString()
                    const approved = await RuntimeNotifier.approve({
                        headline: "Cloud Locked!",
                        message: `There is a lock on the backup folder since ${timeString}. 
                        This means the account is currently busy with a backup or a previous backup did not finish properly. If you share this account, please coordinate with the other person or simply wait a few minutes and try again. Ignoring the lock while another backup is still running can cause the cloud data to become inconsistent.`,
                        approveText: "Wait",
                        cancelText: "Ignore"
                    })
                    if (approved) {
                        return Promise.reject(Errors.AbortError)
                    }
                }
            } else if (!isInstanceOf(error, Errors.FileNotFound)) {
                await RuntimeNotifier.info({
                    headline: "Error reading lock file",
                    message: "Abort backup."
                })
                throw error
            }
            canReleaseLock = true
            const json: Lock = {id: Browser.id(), created: new Date().toISOString()}
            await cloudHandler.upload(lockPath, new TextEncoder().encode(JSON.stringify(json)).buffer)
            await untilAborted(CloudBackupSamples.start(cloudHandler, progressSamples, log))
            await untilAborted(CloudBackupProjects.start(cloudHandler, progressProjects, log))
            await untilAborted(CloudBackupTemplates.start(cloudHandler, progressTemplates, log))
            await untilAborted(CloudBackupSoundfonts.start(cloudHandler, progressSoundfonts, log))
            await untilAborted(CloudBackupPresets.start(cloudHandler, progressPresets, log))
            await untilAborted(CloudBackupScripts.start(cloudHandler, progressScripts, log))
            await untilAborted(CloudBackupWclaps.start(cloudHandler, progressWclaps, log))
        } finally {
            if (canReleaseLock) {
                await cloudHandler.delete(lockPath)
            }
            progressValue.terminate()
            notification.terminate()
        }
    }
}