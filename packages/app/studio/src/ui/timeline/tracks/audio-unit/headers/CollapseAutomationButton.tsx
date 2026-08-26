import {EmptyExec, Lifecycle, ObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events} from "@opendaw/lib-dom"
import {AudioUnitBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon.tsx"
import {StudioService} from "@/service/StudioService"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    audioUnitBoxAdapter: AudioUnitBoxAdapter
    head: ObservableValue<boolean>
}

// Sits below the head lane's type icon. Toggles the unit's automation-collapsed flag (hides its automation
// lanes). Shown only on the head lane of a unit that actually has automation tracks.
export const CollapseAutomationButton = ({lifecycle, service, audioUnitBoxAdapter, head}: Construct) => {
    const collapsed = audioUnitBoxAdapter.automationCollapsed
    const button: HTMLElement = <Icon symbol={IconSymbol.Dropdown} className="collapse-automation"/>
    const hasAutomation = () => audioUnitBoxAdapter.tracks.values()
        .some(track => track.type === TrackType.Value)
    const updateVisibility = () => button.classList.toggle("visible", head.getValue() && hasAutomation())
    lifecycle.ownAll(
        Events.subscribe(button, "pointerdown", (event: PointerEvent) => {
            event.stopPropagation()
            service.project.editing.modify(() => collapsed.setValue(!collapsed.getValue()))
        }),
        collapsed.catchupAndSubscribe(owner => button.classList.toggle("collapsed", owner.getValue())),
        head.catchupAndSubscribe(updateVisibility),
        audioUnitBoxAdapter.tracks.catchupAndSubscribe({
            onAdd: updateVisibility,
            onRemove: updateVisibility,
            onReorder: EmptyExec
        })
    )
    return button
}
