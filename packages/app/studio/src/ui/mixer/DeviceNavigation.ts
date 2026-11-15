import {AudioUnitBoxAdapter, DeviceBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {PanelType} from "@/ui/workspace/PanelType"

export namespace DeviceNavigation {
    export const reveal = (service: StudioService, unit: AudioUnitBoxAdapter, device: DeviceBoxAdapter): void => {
        const {userEditingManager, deviceSelection} = service.project
        userEditingManager.audioUnit.editIfDifferent(unit.box.editing)
        deviceSelection.deselectAll()
        deviceSelection.select(device)
        service.panelLayout.showIfAvailable(PanelType.DevicePanel)
        service.revealDevice(device.uuid)
    }
}
