import css from "./TimelineHeader.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {SnapSelector} from "@/ui/timeline/SnapSelector.tsx"
import {createElement} from "@moises-ai/lib-jsx"
import {FlexSpacer} from "@/ui/components/FlexSpacer.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {Colors, IconSymbol} from "@moises-ai/studio-enums"
import {Html} from "@moises-ai/lib-dom"
import {MenuButton} from "@/ui/components/MenuButton"
import {MenuItem} from "@moises-ai/studio-core"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {ShortcutTooltip} from "@/ui/shortcuts/ShortcutTooltip"

const className = Html.adoptStyleSheet(css, "TimelineHeader")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TimelineHeader = ({lifecycle, service}: Construct) => {
    const {snapping, followCursor, primaryVisibility: {markers, tempo, signature}, clips} = service.timeline
    return (
        <div className={className}>
            <SnapSelector lifecycle={lifecycle} snapping={snapping}/>
            <FlexSpacer/>
            <Checkbox lifecycle={lifecycle}
                      model={followCursor}
                      appearance={{
                          color: Colors.shadow,
                          activeColor: Colors.orange,
                          tooltip: ShortcutTooltip.create("Follow Cursor", GlobalShortcuts["toggle-follow-cursor"].shortcut)
                      }}>
                <Icon symbol={IconSymbol.Run}/>
            </Checkbox>
            <MenuButton
                style={{paddingLeft: "3px"}}
                appearance={{color: Colors.orange, tinyTriangle: true, tooltip: "Primary Tracks"}}
                root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.header({
                        label: "Primarily Tracks",
                        icon: IconSymbol.Primary,
                        color: Colors.orange
                    }),
                    MenuItem.default({
                        label: "Markers",
                        checked: markers.getValue(),
                        shortcut: GlobalShortcuts["toggle-markers-track"].shortcut.format()
                    }).setTriggerProcedure(() => markers.setValue(!markers.getValue())),
                    MenuItem.default({
                        label: "Tempo",
                        checked: tempo.getValue(),
                        shortcut: GlobalShortcuts["toggle-tempo-track"].shortcut.format()
                    }).setTriggerProcedure(() => tempo.setValue(!tempo.getValue())),
                    MenuItem.default({
                        label: "Signature",
                        checked: signature.getValue(),
                        shortcut: GlobalShortcuts["toggle-signature-track"].shortcut.format()
                    }).setTriggerProcedure(() => signature.setValue(!signature.getValue()))
                ))}>
                <Icon symbol={IconSymbol.Primary}/>
            </MenuButton>
            <Checkbox lifecycle={lifecycle}
                      model={clips.visible}
                      appearance={{
                          activeColor: Colors.yellow,
                          tooltip: ShortcutTooltip.create("Clips", GlobalShortcuts["toggle-clips"].shortcut)
                      }}>
                <Icon symbol={IconSymbol.Clips}/>
            </Checkbox>
        </div>
    )
}