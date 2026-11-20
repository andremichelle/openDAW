import {DefaultObservableValue, Lifecycle, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol, Pointers} from "@opendaw/studio-enums"
import {CompositeCell, DeviceBoxAdapter, IndexedBoxAdapter, IndexedBoxAdapterCollection} from "@opendaw/studio-adapters"
import {Button} from "@/ui/components/Button"
import {IconCartridge} from "@/ui/components/Icon"
import {StudioService} from "@/service/StudioService"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    composite: DeviceBoxAdapter
    cells: IndexedBoxAdapterCollection<IndexedBoxAdapter & CompositeCell, Pointers>
}

export const CompositeOverviewButton = ({lifecycle, service, composite, cells}: Construct) => {
    const isActive = (): boolean => service.visibleCodeEditor
        .map(state => state.type === "composite" && UUID.equals(state.composite.uuid, composite.uuid)).unwrapOrElse(false)
    const icon = new DefaultObservableValue(IconSymbol.CompositeOverview)
    const updateIcon = () => icon.setValue(isActive() ? IconSymbol.CompositeOverviewClose : IconSymbol.CompositeOverview)
    lifecycle.ownAll(
        service.activeCodeEditor.catchupAndSubscribe(updateIcon),
        service.layout.screen.subscribe(updateIcon)
    )
    return (
        <Button lifecycle={lifecycle}
                onClick={() => {
                    if (isActive()) {
                        service.closeCodeEditor()
                    } else {
                        service.openCodeEditor({
                            type: "composite", composite, cells, previousScreen: service.layout.screen.getValue()
                        })
                    }
                }}
                appearance={{tooltip: "Show All Layers", cursor: "pointer"}}
                style={{fontSize: "14px"}}>
            <IconCartridge lifecycle={lifecycle} symbol={icon}/>
        </Button>
    )
}
