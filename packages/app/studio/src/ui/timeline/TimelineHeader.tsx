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
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {ShortcutTooltip} from "@/ui/shortcuts/ShortcutTooltip"

const className = Html.adoptStyleSheet(css, "TimelineHeader")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TimelineHeader = ({lifecycle, service}: Construct) => {
    const {snapping, followCursor, primaryVisibility: {markers, tempo}, clips} = service.timeline
    return (
        <div className={className}>
            <SnapSelector lifecycle={lifecycle} snapping={snapping}/>
            <FlexSpacer/>
            <Checkbox lifecycle={lifecycle}
                      model={followCursor}
                      appearance={{
                          color: Colors.shadow,
                          activeColor: Colors.orange,
                          tooltip: ShortcutTooltip.create("Follow Cursor", GlobalShortcuts["toggle-follow-cursor"].keys)
                      }}>
                <Icon symbol={IconSymbol.Run}/>
            </Checkbox>
            <MenuButton
                style={{paddingLeft: "3px"}}
                appearance={{color: Colors.orange, tinyTriangle: true, tooltip: "Toggle Markers & Tempo visiblilty"}}
                root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.header({
                        label: "Primarily Tracks",
                        icon: IconSymbol.Primary,
                        color: Colors.orange
                    }),
                    MenuItem.default({
                        label: "Markers",
                        checked: markers.getValue(),
                        shortcut: GlobalShortcuts["toggle-markers-track"].keys.format()
                    }).setTriggerProcedure(() => markers.setValue(!markers.getValue())),
                    MenuItem.default({
                        label: "Tempo",
                        checked: tempo.getValue(),
                        shortcut: GlobalShortcuts["toggle-tempo-track"].keys.format()
                    }).setTriggerProcedure(() => tempo.setValue(!tempo.getValue()))
                ))}>
                <Icon symbol={IconSymbol.Primary}/>
            </MenuButton>
            <Checkbox lifecycle={lifecycle}
                      model={clips.visible}
                      appearance={{
                          activeColor: Colors.yellow,
                          tooltip: () => `Clips ${GlobalShortcuts["toggle-clips"].keys.format()}`
                      }}>
                <Icon symbol={IconSymbol.Clips}/>
            </Checkbox>
        </div>
    )
}