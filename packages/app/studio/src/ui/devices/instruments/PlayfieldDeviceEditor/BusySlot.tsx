import css from "./BusySlot.sass?inline"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {
    asDefined,
    DefaultObservableValue,
    Editing,
    Func,
    int,
    Lifecycle,
    MutableObservableValue,
    ObservableValue,
    Option,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {createElement, DomElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {
    AutomatableParameterFieldAdapter,
    InstrumentCompositeCellBoxAdapter,
    NanoDeviceBoxAdapter,
    NoteLifeCycle,
    PlayfieldDeviceBoxAdapter,
    PlayfieldPads
} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {SampleSelector} from "@/ui/devices/SampleSelector"
import {CanvasPainter, ContextMenu, MenuItem} from "@opendaw/studio-core"
import {SlotUtils} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotUtils"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {SlotDragAndDrop} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotDragAndDrop"
import {ChopTrigger} from "@/ui/devices/instruments/PlayfieldDeviceEditor/ChopTrigger"
import {NoteLabel} from "@/ui/devices/instruments/PlayfieldDeviceEditor/NoteLabel"
import {DebugMenus} from "@/ui/menu/debug"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {DeviceDialog} from "@/ui/browse/DeviceDialog"
import {MenuItems} from "@/ui/devices/menu-items"

const className = Html.adoptStyleSheet(css, "BusySlot")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldDeviceBoxAdapter
    sampleSelector: SampleSelector
    pad: InstrumentCompositeCellBoxAdapter
    octave: ObservableValue<int>
    semitone: int
}

export const BusySlot = ({
                             lifecycle, service, adapter, sampleSelector, pad, octave, semitone
                         }: Construct) => {
    const {editing, engine, userEditingManager, boxAdapters} = service.project
    let nano: Option<NanoDeviceBoxAdapter> = Option.None
    const scope = new Float32Array(PlayfieldPads.ScopePoints)
    let scopePeak = 0.0
    const labelName: HTMLElement = (<div className="label"/>)
    const muteValue = new DefaultObservableValue(false)
    const soloValue = new DefaultObservableValue(false)
    const excludeValue = new DefaultObservableValue(false)
    const waveform: HTMLCanvasElement = (<canvas/>)
    const waveformPainter = lifecycle.own(new CanvasPainter(waveform, painter => nano.match({
        none: () => {if (pad.inputAdapter.nonEmpty()) {SlotUtils.scope(painter, scope, scopePeak, semitone)}},
        some: device => SlotUtils.waveform(painter, device, semitone)
    })))
    const playbackCanvas: HTMLCanvasElement = (<canvas/>)
    const playbackContext: CanvasRenderingContext2D = asDefined(playbackCanvas.getContext("2d"))
    const header: HTMLElement = (
        <header>
            <Icon symbol={IconSymbol.Play} className="icon-play"/>
            {labelName}
        </header>
    )
    const {mute, solo} = pad.namedParameter
    const muteWrapper = EditWrapper.forAutomatableParameter(editing, mute)
    const soloWrapper = EditWrapper.forAutomatableParameter(editing, solo)
    const exclusionGroup: HTMLElement = (
        <div className="checkboxes">
            <Checkbox lifecycle={lifecycle}
                      model={muteValue}
                      appearance={{activeColor: Colors.red, framed: true, tooltip: "Mute pad"}}>
                <Icon symbol={IconSymbol.Mute}/>
            </Checkbox>
            <Checkbox lifecycle={lifecycle}
                      model={soloValue}
                      appearance={{activeColor: Colors.yellow, framed: true, tooltip: "Solo pad"}}>
                <Icon symbol={IconSymbol.Solo}/>
            </Checkbox>
            <Checkbox lifecycle={lifecycle}
                      model={excludeValue}
                      className="exclude"
                      appearance={{activeColor: Colors.orange, framed: true, tooltip: "Exclude group"}}>
                <Icon symbol={IconSymbol.Exclude}/>
            </Checkbox>
        </div>
    )
    const iconEdit: DomElement = (
        <Icon symbol={IconSymbol.Focus} className="edit"/>
    )
    const element: HTMLElement = (
        <div className={className} tabIndex={-1} data-slot-index={octave.getValue() * 12 + semitone}>
            {header}
            <div className="waveform">
                {waveform}
                {playbackCanvas}
            </div>
            <footer>
                {iconEdit}
                <NoteLabel lifecycle={lifecycle} octave={octave} semitone={semitone}/>
                <div style={{flex: "1"}}/>
                {exclusionGroup}
            </footer>
        </div>
    )
    let noteLifeTime: Terminable = Terminable.Empty
    let fileHandlerSubscription: Terminable = Terminable.Empty
    const instrumentLifecycle = lifecycle.own(new Terminator())
    const audioEffectsField = pad.box.audioEffects.pointerHub
    const paintPlayheads = (array: Float32Array) => nano.flatMap(device => device.file()).flatMap(file => file.data).match({
        none: () => {
            playbackCanvas.width = playbackCanvas.clientWidth
            playbackCanvas.height = playbackCanvas.clientHeight
        },
        some: data => {
            playbackCanvas.width = playbackCanvas.clientWidth
            playbackCanvas.height = playbackCanvas.clientHeight
            playbackContext.fillStyle = "rgba(0, 0, 0, 0.25)"
            for (const position of array) {
                if (position === -1) {break}
                const x = position / data.numberOfFrames * playbackCanvas.width
                playbackContext.fillRect(x - 1, 0, 3, playbackCanvas.height)
            }
            playbackContext.fillStyle = SlotUtils.color(semitone)
            for (const position of array) {
                if (position === -1) {break}
                const x = position / data.numberOfFrames * playbackCanvas.width
                playbackContext.fillRect(x, 0, 1, playbackCanvas.height)
            }
        }
    })
    const observeFile = (device: NanoDeviceBoxAdapter) => device.box.file.catchupAndSubscribe(pointer => {
        fileHandlerSubscription.terminate()
        fileHandlerSubscription = Terminable.Empty
        waveformPainter.requestUpdate()
        if (pointer.isEmpty()) {
            labelName.textContent = device.labelField.getValue()
            return
        }
        device.file().ifSome(file => {
            fileHandlerSubscription = Terminable.many(
                file.getOrCreateLoader().subscribe(state => {
                    if (state.type === "loaded") {
                        labelName.textContent = file.box.fileName.getValue()
                        waveformPainter.requestUpdate()
                    } else if (state.type === "progress") {
                        labelName.textContent = `Loading... (${Math.round(state.progress * 100.0)}%)`
                    } else if (state.type === "error") {
                        labelName.textContent = state.reason
                    }
                }),
                file.box.fileName.subscribe(() => labelName.textContent = file.box.fileName.getValue())
            )
        })
    })
    lifecycle.ownAll(
        connectBoolean(muteValue, muteWrapper),
        connectBoolean(soloValue, soloWrapper),
        pad.excludeParameter.mapOr(exclude =>
            connectBoolean(excludeValue, EditWrapper.forAutomatableParameter(editing, exclude)), Terminable.Empty),
        TextTooltip.default(iconEdit, () => "Edit Pad"),
        audioEffectsField.catchupAndSubscribe({
            onAdded: () => iconEdit.classList.toggle("has-effects", audioEffectsField.nonEmpty()),
            onRemoved: () => iconEdit.classList.toggle("has-effects", audioEffectsField.nonEmpty())
        }),
        pad.input.adapter().catchupAndSubscribe(input => {
            instrumentLifecycle.terminate()
            fileHandlerSubscription.terminate()
            fileHandlerSubscription = Terminable.Empty
            nano = input.flatMap(() => PlayfieldPads.nanoOf(boxAdapters, pad))
            scope.fill(0.0)
            scopePeak = 0.0
            waveformPainter.requestUpdate()
            paintPlayheads(new Float32Array([-1]))
            nano.match({
                none: () => input.match({
                    none: () => {labelName.textContent = pad.label},
                    some: instrument => instrumentLifecycle.ownAll(
                        instrument.labelField.catchupAndSubscribe(() => labelName.textContent = pad.label),
                        service.project.liveStreamReceiver.subscribeFloats(pad.address.append(PlayfieldPads.ScopeKey), values => {
                            const peak = values[PlayfieldPads.ScopePoints] ?? 0.0
                            if (peak < SlotUtils.SilenceLevel && scopePeak < SlotUtils.SilenceLevel) {return}
                            scope.set(values.subarray(0, PlayfieldPads.ScopePoints))
                            scopePeak = peak
                            waveformPainter.requestUpdate()
                        })
                    )
                }),
                some: device => {
                    const {sampleStart, sampleEnd} = device.namedParameter
                    instrumentLifecycle.ownAll(
                        observeFile(device),
                        sampleStart.subscribe(() => waveformPainter.requestUpdate()),
                        sampleEnd.subscribe(() => waveformPainter.requestUpdate()),
                        service.project.liveStreamReceiver.subscribeFloats(device.positionsAddress, paintPlayheads)
                    )
                }
            })
        }),
        octave.catchupAndSubscribe(owner => {
            const slotIndex = owner.getValue() * 12 + semitone
            element.setAttribute("data-slot-index", String(slotIndex))
        }),
        SlotDragAndDrop.installSource({
            element,
            pad,
            getSlotIndex: () => octave.getValue() * 12 + semitone
        }),
        SlotDragAndDrop.installTarget({
            element,
            project: service.project,
            playfield: adapter,
            getSlotIndex: () => octave.getValue() * 12 + semitone
        }),
        Events.subscribe(iconEdit, "click", () => userEditingManager.audioUnit.edit(pad.box)),
        Events.subscribe(header, "pointerdown", (event: PointerEvent) => {
            if (event.ctrlKey) {return}
            noteLifeTime = NoteLifeCycle.start(signal =>
                engine.noteSignal(signal), adapter.audioUnitBoxAdapter().uuid, pad.indexField.getValue())
        }),
        Events.subscribe(header, "pointerup", () => noteLifeTime.terminate()),
        Events.subscribe(element, "keydown", (event) => {
            if (Keyboard.isDelete(event)) {
                sampleSelector.replaceSample(Option.None)
            }
        }),
        ContextMenu.subscribe(element, collector => {
            collector.addItems(
                MenuItem.default({label: "Replace Instrument..."})
                    .setTriggerProcedure(() => DeviceDialog.open(service, {type: "replace-instrument", host: pad})),
                MenuItems.movePadToUnit(service, pad),
                MenuItem.default({label: "Remove Pad"})
                    .setTriggerProcedure(() => sampleSelector.replaceSample(Option.None)),
                MenuItem.default({label: "Reset Parameters"})
                    .setTriggerProcedure(() => editing.modify(() =>
                        PlayfieldPads.resetParameters(pad.box, nano.map(device => device.box)))),
                resetBooleanItem(editing, adapter, cell => Option.wrap(cell.namedParameter.mute), "Reset Mute"),
                resetBooleanItem(editing, adapter, cell => Option.wrap(cell.namedParameter.solo), "Reset Solo"),
                resetBooleanItem(editing, adapter, cell => cell.excludeParameter, "Reset Exclude"),
                ...MenuItems.padClipboard(service, adapter, octave.getValue() * 12 + semitone, Option.wrap(pad.box)),
                DebugMenus.debugBox(pad.box)
            )
        }),
        sampleSelector.configureDrop(element, sample =>
            ChopTrigger.forSample(service, adapter, sample, octave.getValue() * 12 + semitone)),
        {
            terminate: () => {
                noteLifeTime.terminate()
                fileHandlerSubscription.terminate()
            }
        }
    )
    return element
}

const connectBoolean = (value: MutableObservableValue<boolean>,
                        wrapper: MutableObservableValue<boolean>): Terminable => {
    value.setValue(wrapper.getValue())
    return Terminable.many(
        value.subscribe(owner => wrapper.setValue(owner.getValue())),
        wrapper.subscribe(owner => value.setValue(owner.getValue()))
    )
}

const resetBooleanItem = (editing: Editing,
                          adapter: PlayfieldDeviceBoxAdapter,
                          parameterOf: Func<InstrumentCompositeCellBoxAdapter, Option<AutomatableParameterFieldAdapter<boolean>>>,
                          label: string) => {
    const active = () => adapter.cells.adapters().flatMap(pad => parameterOf(pad).match({
        none: () => [], some: parameter => parameter.getValue() ? [parameter] : []
    }))
    return MenuItem.default({label, selectable: active().length > 0})
        .setTriggerProcedure(() => editing.modify(() => active().forEach(parameter => parameter.setValue(false))))
}

