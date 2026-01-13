import {isAbsent, Lifecycle, StringMapping, ValueMapping} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {AudioData} from "@moises-ai/lib-dsp"
import {ContextMenu, FilePickerAcceptTypes, MenuItem} from "@moises-ai/studio-core"
import {EnginePreferences, EngineSettings} from "@moises-ai/studio-adapters"
import {Colors, IconSymbol} from "@moises-ai/studio-enums"
import {ShortcutTooltip} from "@/ui/shortcuts/ShortcutTooltip"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {Files} from "@moises-ai/lib-dom"
import {Promises} from "@moises-ai/lib-runtime"
import {StudioService} from "@/service/StudioService"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    preferences: EnginePreferences
}

export const MetronomeControl = ({lifecycle, service, preferences}: Construct) => {
    const {metronome, recording} = preferences.settings
    const gainModel = lifecycle.own(preferences.createMutableObservableValue("metronome", "gain"))
    const loadClickSound = async (index: 0 | 1) => {
        const fileResult = await Promises.tryCatch(Files.open(FilePickerAcceptTypes.WavFiles))
        if (fileResult.status === "rejected") {return}
        const file = fileResult.value.at(0)
        if (isAbsent(file)) {return}
        const arrayBuffer = await file.arrayBuffer()
        const decodingResult = await Promises.tryCatch(service.audioContext.decodeAudioData(arrayBuffer))
        if (decodingResult.status === "rejected") {return}
        const audioBuffer = decodingResult.value
        const data = AudioData.create(audioBuffer.sampleRate, audioBuffer.length, audioBuffer.numberOfChannels)
        for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
            data.frames[i].set(audioBuffer.getChannelData(i))
        }
        service.engine.loadClickSound(index, data)
    }
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
                      MenuItem.default({
                          label: "Monophonic",
                          checked: metronome.monophonic
                      }).setTriggerProcedure(() => metronome.monophonic = !metronome.monophonic),
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
                                  }).setTriggerProcedure(() => recording.countInBars = count)))),
                      MenuItem.default({label: "Browse click sound for"})
                          .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                              MenuItem.default({label: "Numerator..."})
                                  .setTriggerProcedure(() => loadClickSound(0)),
                              MenuItem.default({label: "Denominator..."})
                                  .setTriggerProcedure(() => loadClickSound(1))
                          ))
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