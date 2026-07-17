import css from "./AudioEffectCompositeDeviceEditor.sass?inline"
import {AudioCompositeAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Lifecycle, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AudioEffectCompositeCellBox} from "@opendaw/studio-boxes"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {CompositeEntryList, CompositeEntryRow} from "@/ui/devices/CompositeEntryList"
import {CompositeEntryDrop} from "@/ui/devices/CompositeEntryDrop"
import {StudioService} from "@/service/StudioService"
import {IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "AudioEffectCompositeDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: AudioCompositeAdapter
    deviceHost: DeviceHost
    icon: IconSymbol
}

// The parallel FX stack (and, with a fixed entry set, the stereo split): the composite's dry / wet next to the
// list of its entries. An entry's own chain is reached by ENTERING it (the device panel then shows that
// chain), exactly as a Playfield slot is entered — so a stack of stacks needs no nested rendering here.
export const AudioEffectCompositeDeviceEditor = ({lifecycle, service, adapter, deviceHost, icon}: Construct) => {
    const {project} = service
    const {editing, midiLearning, userEditingManager} = project
    // A Provider, not a snapshot: the list re-evaluates it on every entry add / remove / reorder, so a new
    // entry actually appears (and its knob / drop target are rebuilt against the new adapter).
    const rows = (): ReadonlyArray<CompositeEntryRow> => adapter.entries.adapters().map(entry => ({
        label: entry.label.length === 0 ? `Entry ${entry.indexField.getValue() + 1}` : entry.label,
        // Built here (not in the list) so the gain goes through the normal knob: automation, midi-learn, menu.
        // The knob takes the COMPOSITE as its adapter: it uses it only to find the owning unit's automation
        // tracks, and an entry resolves to that same unit (an entry is not a DeviceBoxAdapter of its own).
        knob: ControlBuilder.createKnob({
            lifecycle, editing, midiLearning, adapter, parameter: entry.namedParameter.gain
        }),
        panKnob: ControlBuilder.createKnob({
            lifecycle, editing, midiLearning, adapter, parameter: entry.namedParameter.pan
        }),
        mute: entry.namedParameter.mute,
        solo: entry.namedParameter.solo,
        chainLength: entry.audioEffects.mapOr(chain => chain.adapters().length, 0),
        enter: () => userEditingManager.audioUnit.edit(entry.box),
        // Deleting the cell CASCADES to the effects it hosts (their `host` is mandatory), so a branch's
        // chain goes with it. The survivors are captured BEFORE the delete and reindexed to stay 0..n-1 —
        // the engine reads that index as the entry's order.
        remove: () => {
            const survivors = adapter.entries.adapters().filter(other => other !== entry)
            editing.modify(() => {
                entry.box.delete()
                survivors.forEach((other, index) => other.indexField.setValue(index))
            })
        },
        installDrop: element => CompositeEntryDrop.install({
            element, project, chainField: entry.box.audioEffects, accepts: "audio"
        })
    }))
    const addEntry = () => editing.modify(() =>
        AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
            box.composite.refer(adapter.box.entries)
            box.index.setValue(adapter.entries.adapters().length)
        }))
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="mix">
                                  {Object.values(adapter.namedParameter)
                                      .map(parameter => ControlBuilder.createKnob({
                                          lifecycle, editing, midiLearning, adapter, parameter
                                      }))}
                              </div>
                              <CompositeEntryList lifecycle={lifecycle}
                                                  service={service}
                                                  rows={rows}
                                                  watch={update => adapter.entries.subscribe({
                                                      onAdd: update, onRemove: update, onReorder: update
                                                  })}
                                                  fixed={adapter.entriesFixed}
                                                  addEntry={addEntry}/>
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={icon}/>
    )
}
