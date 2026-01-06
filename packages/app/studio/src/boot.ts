import "./main.sass"
import { App } from "@/ui/App.tsx"
import { panic, Progress, RuntimeNotification, RuntimeNotifier, UUID } from "@opendaw/lib-std"
import { StudioService } from "@/service/StudioService"
import { SampleMetaData, SoundfontMetaData } from "@opendaw/studio-adapters"
import { Dialogs } from "@/ui/components/dialogs.tsx"
import { installCursors } from "@/ui/Cursors.ts"
import { BuildInfo } from "./BuildInfo"
import { Surface } from "@/ui/surface/Surface.tsx"
import { replaceChildren } from "@opendaw/lib-jsx"
import { ContextMenu } from "@/ui/ContextMenu.ts"
import { testFeatures } from "@/features.ts"
import { MissingFeature } from "@/ui/MissingFeature.tsx"
import { UpdateMessage } from "@/ui/UpdateMessage.tsx"
import { showStoragePersistDialog } from "@/AppDialogs"
import { Promises } from "@opendaw/lib-runtime"
import { AnimationFrame, Browser, ShortcutManager } from "@opendaw/lib-dom"
import { AudioOutputDevice } from "@/audio/AudioOutputDevice"
import { FontLoader } from "@/ui/FontLoader"
import { ErrorHandler } from "@/errors/ErrorHandler.ts"
import {
    AudioWorklets,
    CloudAuthManager,
    DefaultSampleLoaderManager,
    DefaultSoundfontLoaderManager,
    OpenSampleAPI,
    OpenSoundfontAPI,
    Workers
} from "@opendaw/studio-core"
import { AudioData } from "@opendaw/lib-dsp"
import { StudioShortcutManager } from "@/service/StudioShortcutManager"

const loadBuildInfo = async () => fetch(`/build-info.json?v=${Date.now()}`)
    .then(x => x.json())
    .then(x => BuildInfo.parse(x))

export const boot = async ({ workersUrl, workletsUrl }: { workersUrl: string, workletsUrl: string }) => {
    console.debug("booting...")
    console.debug(location.origin)
    console.debug("boot: step 1 - load build info")
    const { status, value: buildInfo } = await Promises.tryCatch(loadBuildInfo())
    if (status === "rejected") {
        alert("Error loading build info. Please reload the page.")
        return
    }
    console.debug("buildInfo", buildInfo)
    console.debug("boot: step 2 - load fonts")
    await FontLoader.load()
    console.debug("boot: step 3 - install workers")
    await Workers.install(workersUrl)
    console.debug("boot: step 4 - install audio worklets")
    AudioWorklets.install(workletsUrl)
    console.debug("boot: step 5 - test features")
    const testFeaturesResult = await Promises.tryCatch(testFeatures())
    if (testFeaturesResult.status === "rejected") {
        document.querySelector("#preloader")?.remove()
        replaceChildren(document.body, MissingFeature({ error: testFeaturesResult.error }))
        return
    }
    console.debug("isLocalHost", Browser.isLocalHost())
    console.debug("agent", Browser.userAgent)
    const sampleRate = Browser.isFirefox() ? undefined : 48000
    console.debug("requesting custom sampleRate", sampleRate ?? "'No (Firefox)'")
    const context = new AudioContext({ sampleRate, latencyHint: 0 })
    console.debug(`AudioContext state: ${context.state}, sampleRate: ${context.sampleRate}`)
    console.debug("boot: step 6 - create audio worklets (context)")
    const audioWorklets = await Promises.tryCatch(AudioWorklets.createFor(context))
    if (audioWorklets.status === "rejected") {
        return panic(audioWorklets.error)
    }
    console.debug("boot: step 7 - wait for resume if suspended")
    if (context.state === "suspended") {
        window.addEventListener("click",
            async () => await context.resume().then(() =>
                console.debug(`AudioContext resumed (${context.state})`)), { capture: true, once: true })
    }
    console.debug("boot: step 8 - audio devices")
    const audioDevices = await AudioOutputDevice.create(context)
    console.debug("boot: step 9 - loading managers")
    const sampleManager = new DefaultSampleLoaderManager({
        fetch: async (uuid: UUID.Bytes, progress: Progress.Handler): Promise<[AudioData, SampleMetaData]> =>
            OpenSampleAPI.get().load(context, uuid, progress)
    })
    const soundfontManager = new DefaultSoundfontLoaderManager({
        fetch: async (uuid: UUID.Bytes, progress: Progress.Handler): Promise<[ArrayBuffer, SoundfontMetaData]> =>
            OpenSoundfontAPI.get().load(uuid, progress)
    })
    const cloudAuthManager = CloudAuthManager.create({
        Dropbox: "jtehjzxaxf3bf1l",
        GoogleDrive: "628747153367-gt1oqcn3trr9l9a7jhigja6l1t3f1oik.apps.googleusercontent.com"
    })
    const service: StudioService = new StudioService(context, audioWorklets.value, audioDevices,
        sampleManager, soundfontManager, cloudAuthManager, buildInfo)
    StudioShortcutManager.install(service)

    const errorHandler = new ErrorHandler(buildInfo, () => service.recovery.createBackupCommand())
    const surface = Surface.main({
        config: (surface: Surface) => surface.own(ContextMenu.install(surface.owner))
    }, errorHandler)
    Surface.subscribeKeyboard("keydown", event => ShortcutManager.get().handleEvent(event), Number.MAX_SAFE_INTEGER)
    document.querySelector("#preloader")?.remove()
    replaceChildren(surface.ground, App(service))
    AnimationFrame.start(window)
    installCursors()
    RuntimeNotifier.install({
        info: (request) => Dialogs.info(request),
        approve: (request) => Dialogs.approve({ ...request, reverse: true }),
        progress: (request): RuntimeNotification.ProgressUpdater => Dialogs.progress(request)
    })
    if (buildInfo.env === "production" && !Browser.isLocalHost()) {
        const uuid = buildInfo.uuid
        const sourceCss = document.querySelector<HTMLLinkElement>("link[rel='stylesheet']")?.href ?? ""
        const sourceCode = document.querySelector<HTMLScriptElement>("script[src]")?.src ?? ""
        if (!sourceCss.includes(uuid) || !sourceCode.includes(uuid)) {
            console.warn("Cache issue:")
            console.warn("expected uuid", uuid)
            console.warn("sourceCss", sourceCss)
            console.warn("sourceCode", sourceCode)
            Dialogs.cache()
            return
        }
        const checkExtensions = setInterval(() => {
            if (document.scripts.length > 1) {
                Dialogs.info({
                    headline: "Warning",
                    message: "Please disable extensions to avoid undefined behavior.",
                    okText: "Ignore"
                }).finally()
                clearInterval(checkExtensions)
            }
        }, 5_000)
        const checkUpdates = setInterval(async () => {
            if (!navigator.onLine) { return }
            const { status, value: newBuildInfo } = await Promises.tryCatch(loadBuildInfo())
            if (status === "resolved" && newBuildInfo.uuid !== undefined && newBuildInfo.uuid !== buildInfo.uuid) {
                document.body.prepend(UpdateMessage())
                console.warn("A new version is online.")
                clearInterval(checkUpdates)
            }
        }, 5_000)
    } else {
        console.debug("No production checks (build version & updates).")
    }
    if (Browser.isFirefox()) {
        const persisted = await Promises.tryCatch(navigator.storage.persisted())
        console.debug("Firefox.isPersisted", persisted.value)
        if (persisted.status === "resolved" && !persisted.value) {
            await Promises.tryCatch(showStoragePersistDialog())
        }
    }
}