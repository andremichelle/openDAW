import {asInstanceOf, isDefined, Lifecycle, Procedure, Provider, RuntimeNotifier, Size, Terminator, tryCatch, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {DeviceBoxAdapter, NoteSignal, ParameterAdapterSet, ScriptCompiler, ScriptDeclaration} from "@opendaw/studio-adapters"
import {WerkstattParameterBox} from "@opendaw/studio-boxes"
import {StudioService} from "@/service/StudioService"
import {FloatingWindow, FloatingWindowHandle} from "@/ui/components/FloatingWindow"
import {ScriptViewFrame, ScriptViewMode, ScriptViewParam} from "@/ui/devices/script-view/ScriptViewFrame"
import {parameterContextItems} from "@/ui/menu/automation.ts"

export type ScriptViewDevice = DeviceBoxAdapter & {
    readonly box: ScriptCompiler.ScriptDeviceBox
    readonly parameters: ParameterAdapterSet
}

type FrameConstruct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ScriptViewDevice
    userCode: Provider<string>
    className: string
    mode: ScriptViewMode
    onError: Procedure<string>
}

const parsed = <T, >(parse: () => ReadonlyArray<T>): ReadonlyArray<T> => {
    const result = tryCatch(parse)
    return result.status === "success" ? result.value : []
}

export namespace ScriptViews {
    // Everything a view needs, read fresh from the device box, so a window that outlives the editor stays correct.
    export const createFrame = ({lifecycle, service, adapter, userCode, className, mode, onError}: FrameConstruct): HTMLIFrameElement => {
        const {project} = service
        const {box} = adapter
        const code = box.code.getValue()
        const params: ReadonlyArray<ScriptViewParam> = box.parameters.pointerHub.incoming().flatMap(({box: paramBox}) => {
            const werkstattParam = asInstanceOf(paramBox, WerkstattParameterBox)
            const parameter = adapter.parameters.parameters().find(param => param.address.equals(werkstattParam.value.address))
            return isDefined(parameter) ? [{name: werkstattParam.label.getValue(), parameter}] : []
        })
        return ScriptViewFrame({
            lifecycle, editing: project.editing, userCode: userCode(), className, mode,
            sampleRate: service.audioContext.sampleRate, params,
            records: box.records, collections: parsed(() => ScriptDeclaration.parseCollections(code)),
            buffers: box.buffers, bufferDeclarations: parsed(() => ScriptDeclaration.parseBuffers(code)),
            streams: parsed(() => ScriptDeclaration.parseStreams(code)),
            receiver: project.liveStreamReceiver, address: adapter.address,
            onPreview: (on, pitch, velocity) => {
                const uuid = adapter.deviceHost().audioUnitBoxAdapter().box.address.uuid
                project.engine.noteSignal(on ? NoteSignal.on(uuid, pitch, velocity) : NoteSignal.off(uuid, pitch))
            },
            onSend: message => project.engine.scriptMessage(box.address.uuid, message),
            onError,
            onWindow: (action, windowClass) => action === "open"
                ? ScriptWindows.open(service, adapter, userCode, windowClass)
                : ScriptWindows.close(adapter, windowClass),
            parameterMenu: parameter => parameterContextItems(project.editing, project.midiLearning,
                adapter.deviceHost().audioUnitBoxAdapter().tracks, parameter)
        })
    }
}

// The open script windows, one per device and @window class, living as long as the device and the project,
// not the editor. A recompile rebuilds the view inside, a @window line removed closes it.
export namespace ScriptWindows {
    const windows = new Map<string, FloatingWindowHandle>()
    const sizes = new Map<string, Size>()

    const keyOf = (adapter: ScriptViewDevice, className: string): string => `${UUID.toString(adapter.uuid)}:${className}`

    const declaration = (adapter: ScriptViewDevice, className: string) =>
        parsed(() => ScriptDeclaration.parseWindows(adapter.box.code.getValue())).find(window => window.className === className)

    export const isOpen = (adapter: ScriptViewDevice, className: string): boolean => windows.has(keyOf(adapter, className))

    export const close = (adapter: ScriptViewDevice, className: string): void => windows.get(keyOf(adapter, className))?.close()

    export const open = (service: StudioService, adapter: ScriptViewDevice, userCode: Provider<string>, className: string): void => {
        const key = keyOf(adapter, className)
        const existing = windows.get(key)
        if (isDefined(existing)) {
            existing.toFront()
            return
        }
        const window = declaration(adapter, className)
        if (!isDefined(window)) {
            RuntimeNotifier.notify({message: `No '// @window ${className}' declared`, icon: "Warning"})
            return
        }
        const session = new Terminator()
        const frameLifecycle = session.own(new Terminator())
        const content: HTMLElement = (<div style={{width: "100%", height: "100%"}}/>)
        const mount = (): void => {
            frameLifecycle.terminate()
            const frame = ScriptViews.createFrame({
                lifecycle: frameLifecycle, service, adapter, userCode, className, mode: "window",
                onError: message => RuntimeNotifier.notify({message: `${className}: ${message}`, icon: "Warning"})
            })
            frame.style.cssText = "border: none; width: 100%; height: 100%; display: block"
            content.replaceChildren(frame)
        }
        const remount = {pending: false}
        const size = sizes.get(key) ?? {width: window.width, height: window.height}
        const handle = FloatingWindow({
            title: `${adapter.labelField.getValue()} ${className}`, icon: IconSymbol.Code,
            width: size.width, height: size.height, resizable: true,
            onClose: () => session.terminate()
        }, content)
        session.ownAll(
            handle.size.subscribe(owner => sizes.set(key, owner.getValue())),
            adapter.box.code.subscribe(() => {
                if (remount.pending) {return}
                remount.pending = true
                queueMicrotask(() => {
                    remount.pending = false
                    if (!windows.has(key)) {return}
                    if (isDefined(declaration(adapter, className))) {mount()} else {handle.close()}
                })
            }),
            adapter.box.subscribeDeletion(() => handle.close()),
            service.projectProfileService.subscribe(() => handle.close()),
            {terminate: () => windows.delete(key)}
        )
        windows.set(key, handle)
        mount()
    }
}
