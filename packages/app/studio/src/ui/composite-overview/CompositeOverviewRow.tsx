import css from "./CompositeOverviewRow.sass?inline"
import {Lifecycle, MutableObservableOption, ObservableOption, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {deferNextFrame, Events, Html} from "@opendaw/lib-dom"
import {
    AudioEffectCompositeCellBoxAdapter,
    AudioEffectDeviceAdapter,
    AudioUnitInputAdapter,
    CompositeCell,
    InstrumentCompositeCellBoxAdapter,
    MidiEffectDeviceAdapter
} from "@opendaw/studio-adapters"
import {DeviceMount} from "@/ui/devices/panel/DeviceMount"
import {ChildReconciler} from "@/ui/devices/panel/ChildReconciler"
import {CompositeCellControls} from "@/ui/devices/CompositeCellControls"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "CompositeOverviewRow")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    cell: CompositeCell
}

export const CompositeOverviewRow = ({lifecycle, service, cell}: Construct) => {
    const {project} = service
    const isLayer = cell instanceof InstrumentCompositeCellBoxAdapter
    const labelOf = (): string => cell instanceof InstrumentCompositeCellBoxAdapter ? cell.label
        : cell instanceof AudioEffectCompositeCellBoxAdapter && cell.compositeDevice().entriesFixed ? cell.label
            : String(cell.indexField.getValue() + 1)
    const instrument: ObservableOption<AudioUnitInputAdapter> = cell instanceof InstrumentCompositeCellBoxAdapter
        ? cell.input.adapter() : new MutableObservableOption<AudioUnitInputAdapter>()
    const label: HTMLElement = <h1/>
    const midiContainer: HTMLElement = <div className="midi-container"/>
    const sourceContainer: HTMLElement = <div className="source-container"/>
    const audioContainer: HTMLElement = <div className="audio-container"/>
    const containers: HTMLElement = (
        <div className="containers">
            {isLayer ? midiContainer : null}
            {isLayer ? sourceContainer : null}
            {audioContainer}
        </div>
    )
    const element: HTMLElement = (
        <div className={className}>
            <div className="head">
                {label}
                <CompositeCellControls lifecycle={lifecycle} project={project} cell={cell}/>
            </div>
            <div className="chain">{containers}</div>
        </div>
    )
    const mounts = UUID.newSet<DeviceMount>(({uuid}) => uuid)
    const updateDom = lifecycle.own(deferNextFrame(() => {
        if (!cell.box.isAttached()) {return}
        label.textContent = labelOf()
        ChildReconciler.reconcile(midiContainer, cell.midiEffects
            .mapOr(chain => chain.adapters().map(adapter => mounts.get(adapter.uuid).editor()), []))
        ChildReconciler.reconcile(sourceContainer, instrument.mapOr(adapter => mounts.get(adapter.uuid).editor(), []))
        ChildReconciler.reconcile(audioContainer, cell.audioEffects
            .mapOr(chain => chain.adapters().map(adapter => mounts.get(adapter.uuid).editor()), []))
    }))
    const instrumentLifecycle = lifecycle.own(new Terminator())
    const updateFrozen = (): void => {
        if (!cell.box.isAttached()) {return}
        containers.classList.toggle("frozen", project.audioUnitFreeze.isFrozen(cell.audioUnitBoxAdapter()))
    }
    updateFrozen()
    lifecycle.ownAll(
        cell.indexField.subscribe(updateDom.request),
        cell.subscribeSiblings(updateDom.request),
        project.audioUnitFreeze.subscribe(updateFrozen),
        Events.subscribe(label, "click", () => project.userEditingManager.audioUnit.edit(cell.box)),
        instrument.catchupAndSubscribe(owner => {
            instrumentLifecycle.terminate()
            owner.ifSome(adapter => {
                mounts.add(DeviceMount.forInstrument(service, adapter, cell, updateDom.request))
                instrumentLifecycle.own({terminate: () => mounts.removeByKeyIfExist(adapter.uuid)?.terminate()})
            })
            updateDom.request()
        }),
        {
            terminate: () => {
                mounts.forEach(mount => mount.terminate())
                mounts.clear()
            }
        }
    )
    if (cell instanceof InstrumentCompositeCellBoxAdapter) {
        lifecycle.own(cell.input.catchupAndSubscribeLabelChange(updateDom.request))
    }
    cell.midiEffects.ifSome(chain => lifecycle.own(chain.catchupAndSubscribe({
        onAdd: (adapter: MidiEffectDeviceAdapter) => {
            mounts.add(DeviceMount.forMidiEffect(service, adapter, cell, updateDom.request))
            updateDom.request()
        },
        onRemove: (adapter: MidiEffectDeviceAdapter) => {
            mounts.removeByKey(adapter.uuid).terminate()
            updateDom.request()
        },
        onReorder: () => updateDom.request()
    })))
    cell.audioEffects.ifSome(chain => lifecycle.own(chain.catchupAndSubscribe({
        onAdd: (adapter: AudioEffectDeviceAdapter) => {
            mounts.add(DeviceMount.forAudioEffect(service, adapter, cell, updateDom.request))
            updateDom.request()
        },
        onRemove: (adapter: AudioEffectDeviceAdapter) => {
            mounts.removeByKey(adapter.uuid).terminate()
            updateDom.request()
        },
        onReorder: () => updateDom.request()
    })))
    updateDom.request()
    return element
}
