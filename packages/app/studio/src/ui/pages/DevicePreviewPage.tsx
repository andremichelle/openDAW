import css from "./DevicePreviewPage.sass?inline"
import {asInstanceOf, Errors, Nullable, Option, TimeSpan} from "@opendaw/lib-std"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Promises, Wait} from "@opendaw/lib-runtime"
import {ApparatDeviceBox, SpielwerkDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, InstrumentFactories, InstrumentFactory, ScriptCompiler} from "@opendaw/studio-adapters"
import {EffectFactories, Project} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {DevicePanel} from "@/ui/devices/panel/DevicePanel"
import {ScriptCompilers} from "@/ui/devices/ScriptCompilers"

const className = Html.adoptStyleSheet(css, "DevicePreviewPage")

const SettleTimeout = TimeSpan.seconds(10)

export type DevicePreviewTarget = "apparat" | "werkstatt" | "spielwerk"

export type DevicePreviewResult =
    | { readonly status: "ready", readonly selector: string }
    | { readonly status: "error", readonly message: string }

declare global {
    interface Window {
        openDAWDevicePreview?: (target: DevicePreviewTarget, source: string) => Promise<DevicePreviewResult>
    }
}

const containerOf: Record<DevicePreviewTarget, string> = {
    apparat: "div.source-container", werkstatt: "div.audio-container", spielwerk: "div.midi-container"
}

const createDevice = (project: Project, target: DevicePreviewTarget): ScriptCompiler.ScriptDeviceBox => {
    const {api, boxAdapters, userEditingManager} = project
    const factory: InstrumentFactory = target === "apparat" ? InstrumentFactories.Apparat
        : target === "spielwerk" ? InstrumentFactories.Vaporisateur : InstrumentFactories.Tape
    const {audioUnitBox, instrumentBox} = api.createInstrument(factory)
    userEditingManager.audioUnit.edit(audioUnitBox.editing)
    if (target === "apparat") {return asInstanceOf(instrumentBox, ApparatDeviceBox)}
    const host = boxAdapters.adapterFor(audioUnitBox, Devices.isHost)
    const field = DeviceHost.chainFieldOf(host, target === "spielwerk" ? "midi" : "audio").unwrap("no effect chain")
    return target === "spielwerk"
        ? asInstanceOf(EffectFactories.MidiNamed.Spielwerk.create(project, field, 0), SpielwerkDeviceBox)
        : asInstanceOf(EffectFactories.AudioNamed.Werkstatt.create(project, field, 0), WerkstattDeviceBox)
}

const configOf: Record<DevicePreviewTarget, ScriptCompiler.Config> = {
    apparat: ScriptCompilers.Apparat, werkstatt: ScriptCompilers.Werkstatt, spielwerk: ScriptCompilers.Spielwerk
}

// renders one script device for the community screenshots, driven by a headless browser through window.openDAWDevicePreview
export const DevicePreviewPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const element: HTMLElement = <div className={className}/>
    const settle = async (selector: string): Promise<Option<HTMLElement>> => {
        const deadline = performance.now() + SettleTimeout.millis()
        while (performance.now() < deadline) {
            const device: Nullable<HTMLElement> = element.querySelector<HTMLElement>(selector)
            const frames = device === null ? [] : Array.from(device.querySelectorAll("iframe"))
            if (device !== null && frames.every(frame => frame.dataset.ready === "true")) {
                await Wait.frames(2)
                return Option.wrap(device)
            }
            await Wait.timeSpan(TimeSpan.millis(50))
        }
        return Option.None
    }
    window.openDAWDevicePreview = async (target: DevicePreviewTarget, source: string): Promise<DevicePreviewResult> => {
        if (service.hasProfile) {return {status: "error", message: "A preview page renders one device only"}}
        await service.newProject()
        const {project} = service
        element.appendChild(<DevicePanel lifecycle={lifecycle} service={service}/>)
        const compiler = ScriptCompiler.create(configOf[target])
        const userCode = compiler.stripHeader(source)
        const box = project.editing.modify(() => {
            const device = createDevice(project, target)
            device.code.setValue(userCode)
            return device
        }).unwrap("no device created")
        const compiled = await Promises.tryCatch(compiler.compile(service.audioContext, project.editing, box, userCode, true))
        if (compiled.status === "rejected") {return {status: "error", message: Errors.toString(compiled.error)}}
        const selector = `.${className} ${containerOf[target]} > div:has(> header)`
        return (await settle(selector)).match<DevicePreviewResult>({
            none: () => ({status: "error", message: "The device did not finish drawing"}),
            some: device => device.querySelector(".header-tools > .error:not(.hidden)") === null
                ? {status: "ready", selector}
                : {status: "error", message: "The script reports an error"}
        })
    }
    lifecycle.own({terminate: () => delete window.openDAWDevicePreview})
    return element
}
