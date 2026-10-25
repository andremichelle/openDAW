import {WclapDeviceBoxAdapter, WclapInstrumentBoxAdapter} from "@opendaw/studio-adapters"
import {Notifier, Procedure, RuntimeNotifier, Subscription, Terminator, UUID} from "@opendaw/lib-std"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioPreferences, WclapBundles, WclapGuis, WclapZoomOptions} from "@opendaw/studio-core"
import {FloatingWindow, FloatingWindowHandle} from "@/ui/components/FloatingWindow.tsx"
import {StudioService} from "@/service/StudioService"
import {WclapFrame} from "@/service/WclapFrame"

export type WclapAdapter = WclapDeviceBoxAdapter | WclapInstrumentBoxAdapter

const DEFAULT_SIZE = {width: 640, height: 480}

// The open plugin windows, one per device, living as long as the device and the project, not the editor
export namespace WclapWindows {
    type Entry = { handle: FloatingWindowHandle, session: Terminator }
    const windows = new Map<string, Entry>()
    const opening = new Set<string>()
    const changes = new Notifier<string>()

    export const isOpen = (uuid: string): boolean => windows.has(uuid)

    export const subscribe = (uuid: string, listener: Procedure<boolean>): Subscription =>
        changes.subscribe(changed => {if (changed === uuid) {listener(windows.has(uuid))}})

    export const close = (uuid: string): void => windows.get(uuid)?.handle.close()

    export const toggle = (service: StudioService, adapter: WclapAdapter, title: string): void => {
        const uuid = UUID.toString(adapter.uuid)
        if (windows.has(uuid)) {
            close(uuid)
            return
        }
        show(service, adapter, title)
    }

    export const show = (service: StudioService, adapter: WclapAdapter, title: string): void => {
        const uuid = UUID.toString(adapter.uuid)
        if (windows.has(uuid) || opening.has(uuid)) {return}
        opening.add(uuid)
        open(service, adapter, title)
            .catch(error => RuntimeNotifier.notify({message: `Could not open the plugin window: ${error}`, icon: "Warning"}))
            .finally(() => opening.delete(uuid))
    }

    const open = async (service: StudioService, adapter: WclapAdapter, title: string): Promise<void> => {
        const {engine} = service
        const uuid = adapter.uuid
        const uuidString = UUID.toString(uuid)
        const gui = await engine.wclapOpenGui(uuid)
        if (gui.uri.length === 0) {
            RuntimeNotifier.notify({message: `${title} has not loaded yet or has no window of its own`, icon: "Warning"})
            return
        }
        const bundle = await WclapBundles.fetch(adapter.urlField.getValue()).catch(error => {
            engine.wclapCloseGui(uuid)
            throw error
        })
        const guiSession = {held: true}
        const release = (): void => {
            if (!guiSession.held) {return}
            guiSession.held = false
            engine.wclapCloseGui(uuid)
        }
        const width = gui.width > 0 ? gui.width : DEFAULT_SIZE.width
        const height = gui.height > 0 ? gui.height : DEFAULT_SIZE.height
        const session = new Terminator()
        session.ownAll(
            {
                terminate: () => {
                    windows.delete(uuidString)
                    changes.notify(uuidString)
                }
            },
            adapter.urlField.subscribe(() => close(uuidString)),
            adapter.clapIdField.subscribe(() => close(uuidString)),
            adapter.box.subscribeDeletion(() => close(uuidString)),
            service.projectProfileService.subscribe(() => close(uuidString))
        )
        const frame = session.own(WclapFrame({
            service, adapter, bundle, uri: gui.uri,
            reload: async () => {
                release()
                const {uri} = await engine.wclapOpenGui(uuid)
                guiSession.held = uri.length > 0
                return uri
            },
            // sized to the window the reloaded page now lives in
            reloaded: async () => {
                const {width, height} = handle.size.getValue()
                const accepted = await engine.wclapResizeGui(uuid, width, height)
                if (!frame.isTerminated && (accepted.width !== width || accepted.height !== height)) {
                    handle.requestSize(accepted.width, accepted.height)
                }
            },
            release,
            lost: () => close(uuidString),
            scroll: (deltaX, deltaY, deltaMode) => {
                // WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages
                const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? handle.size.getValue().height : 1
                handle.scrollBy(deltaX * unit, deltaY * unit)
            }
        }))
        const handle = FloatingWindow({
            title, icon: IconSymbol.WebClap, width, height,
            // a plugin of a fixed size draws at that size, the default zoom only reaches one that resizes
            scale: gui.resizable ? StudioPreferences.settings.webclap["default-zoom"] / 100 : 1, resizable: false,
            zoomLevels: gui.resizable ? WclapZoomOptions.map(value => value / 100) : undefined,
            adjust: ({width, height}) => engine.wclapResizeGui(uuid, width, height), onClose: () => session.terminate()
        }, frame.iframe)
        session.ownAll(
            WclapGuis.subscribeResize(uuidString, ({width, height}) => handle.requestSize(width, height)),
            WclapGuis.subscribeShow(uuidString, visible => {if (!visible) {close(uuidString)}})
        )
        const listener = session.own(new Terminator())
        session.own(handle.owner.catchupAndSubscribe(owner => {
            listener.terminate()
            listener.own(frame.listen(owner.getValue()))
        }))
        windows.set(uuidString, {handle, session})
        changes.notify(uuidString)
    }
}
