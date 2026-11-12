import {Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, SamplerDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {FloatingWindow, FloatingWindowHandle} from "@/ui/components/FloatingWindow"
import {SamplerZoneEditor} from "./SamplerZoneEditor"

// The floating window that edits a Sampler's sample zones, one per device.
export namespace SamplerZoneWindow {
    const Width = 1040
    const Height = 556
    const windows = UUID.newSet<{ uuid: UUID.Bytes, handle: FloatingWindowHandle }>(entry => entry.uuid)

    export const open = (service: StudioService, adapter: SamplerDeviceBoxAdapter, deviceHost: DeviceHost): void => {
        const existing = windows.opt(adapter.uuid)
        if (existing.nonEmpty()) {
            existing.unwrap().handle.toFront()
            return
        }
        const session = new Terminator()
        const handle = FloatingWindow({
            title: "Sample Zones", icon: InstrumentFactories.Sampler.defaultIcon,
            width: Width, height: Height, resizable: false,
            onClose: () => session.terminate()
        }, <SamplerZoneEditor lifecycle={session} service={service} adapter={adapter} deviceHost={deviceHost}/>)
        session.ownAll(
            adapter.box.subscribeDeletion(() => handle.close()),
            service.projectProfileService.subscribe(() => handle.close()),
            {terminate: () => windows.removeByKey(adapter.uuid)}
        )
        windows.add({uuid: adapter.uuid, handle})
    }
}
