import {Lifecycle, StringMapping, ValueMapping} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {ContextMenu, MenuItem} from "@opendaw/studio-core"
import {EnginePreferences, EngineSettings} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ShortcutTooltip} from "@/ui/shortcuts/ShortcutTooltip"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"

type Construct = {
    lifecycle: Lifecycle
    preferences: EnginePreferences
}

export const MetronomeControl = ({lifecycle, preferences}: Construct) => {
    const {metronome, recording} = preferences.settings
    const gainModel = lifecycle.own(preferences.createMutableObservableValue("metronome", "gain"))
    return (
        <Checkbox lifecycle={lifecycle}
                  onInit={element => lifecycle.own(ContextMenu.subscribe(element, collector => collector.addItems(
                      MenuItem.inputValue({
                          name: "Volume",
                          icon: IconSymbol.Metronome,
                          color: Colors.orange,
                          model: gainModel,
                          valueMapping: ValueMapping.linear(-48, 0),
                          stringMapping: StringMapping.decible,
                          minValueWidth: "2.5em"
                      }),
                      MenuItem.default({
                          label: "Enabled",
                          checked: metronome.enabled,
                          shortcut: GlobalShortcuts["toggle-metronome"].shortcut.format()
                      }).setTriggerProcedure(() => metronome.enabled = !metronome.enabled),
                      MenuItem.default({label: "Beat Divider"})
                          .setRuntimeChildrenProcedure(parent =>
                              parent.addMenuItem(...EngineSettings.BeatSubDivisionOptions
                                  .map(division => MenuItem.default({
                                      label: String(division),
                                      checked: metronome.beatSubDivision === division
                                  }).setTriggerProcedure(() => metronome.beatSubDivision = division)))),
                      MenuItem.default({label: "Set Count-In (Bars)"})
                          .setRuntimeChildrenProcedure(parent =>
                              parent.addMenuItem(...EngineSettings.RecordingCountInBars
                                  .map(count => MenuItem.default({
                                      label: String(count),
                                      checked: count === recording.countInBars
                                  }).setTriggerProcedure(() => recording.countInBars = count))))
                  )))}
                  model={preferences.createMutableObservableValue("metronome", "enabled")}
                  appearance={{
                      activeColor: Colors.orange,
                      tooltip: ShortcutTooltip.create("Metronome", GlobalShortcuts["toggle-metronome"].shortcut)
                  }}>
            <Icon symbol={IconSymbol.Metronome}/>
        </Checkbox>
    )
}