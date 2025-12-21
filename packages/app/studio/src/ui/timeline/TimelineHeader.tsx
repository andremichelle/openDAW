import css from "./TimelineHeader.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {SnapSelector} from "@/ui/timeline/SnapSelector.tsx"
import {createElement} from "@opendaw/lib-jsx"
import {FlexSpacer} from "@/ui/components/FlexSpacer.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Html} from "@opendaw/lib-dom"
import {MenuButton} from "@/ui/components/MenuButton"
import {MenuItem} from "@/ui/model/menu-item"

const className = Html.adoptStyleSheet(css, "TimelineHeader")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TimelineHeader = ({lifecycle, service}: Construct) => {
    const {snapping, followPlaybackCursor, primaryVisibility: {markers, tempo}, clips} = service.timeline
    return (
        <div className={className}>
            <SnapSelector lifecycle={lifecycle} snapping={snapping}/>
            <FlexSpacer/>
            <hr/>
            <Checkbox lifecycle={lifecycle}
                      model={followPlaybackCursor}
                      appearance={{activeColor: Colors.orange, tooltip: "Follow Playback Cursor"}}>
                <Icon symbol={IconSymbol.Run}/>
            </Checkbox>
            <hr/>
            <MenuButton
                appearance={{color: Colors.green, tinyTriangle: true, tooltip: "Toggle Markers & Tempo visiblilty"}}
                root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.header({
                        label: "Primarily Tracks",
                        icon: IconSymbol.Primary,
                        color: Colors.green
                    }),
                    MenuItem.default({label: "Markers", checked: markers.getValue()})
                        .setTriggerProcedure(() => markers.setValue(!markers.getValue())),
                    MenuItem.default({label: "Tempo", checked: tempo.getValue()})
                        .setTriggerProcedure(() => tempo.setValue(!tempo.getValue()))
                ))}>
                <Icon symbol={IconSymbol.Primary}/>
            </MenuButton>
            <Checkbox lifecycle={lifecycle}
                      model={clips.visible}
                      appearance={{activeColor: Colors.yellow, tooltip: "Clips"}}>
                <Icon symbol={IconSymbol.Clips}/>
            </Checkbox>
        </div>
    )
}