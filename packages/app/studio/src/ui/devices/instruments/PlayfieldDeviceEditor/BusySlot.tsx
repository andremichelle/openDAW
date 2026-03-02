import css from "./BusySlot.sass?inline"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {
    asDefined,
    DefaultObservableValue,
    int,
    Lifecycle,
    MutableObservableValue,
    ObservableValue,
    Option,
    Terminable
} from "@opendaw/lib-std"
import {createElement, DomElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {NoteLifeCycle, PlayfieldDeviceBoxAdapter, PlayfieldSampleBoxAdapter} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {SampleSelector} from "@/ui/devices/SampleSelector"
import {CanvasPainter} from "../../../../../../../studio/core/src/ui/canvas/painter"
import {SlotUtils} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotUtils"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {BoxEditing} from "@opendaw/lib-box"
import {ContextMenu, MenuItem} from "@opendaw/studio-core"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {SlotDragAndDrop} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotDragAndDrop"
import {NoteLabel} from "@/ui/devices/instruments/PlayfieldDeviceEditor/NoteLabel"
import {DebugMenus} from "@/ui/menu/debug"
import {TextTooltip} from "@/ui/surface/TextTooltip"

const className = Html.adoptStyleSheet(css, "BusySlot")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldDeviceBoxAdapter
    sampleSelector: SampleSelector
    sample: PlayfieldSampleBoxAdapter
    octave: ObservableValue<int>
    semitone: int
}

export const BusySlot = ({
                             lifecycle, service, adapter, sampleSelector, sample, octave, semitone
                         }: Construct) => {
    const {editing, engine, userEditingManager} = service.project
    const labelName: HTMLElement = (<div className="label"/>)
    const muteValue = new DefaultObservableValue(false)
    const soloValue = new DefaultObservableValue(false)
    const excludeValue = new DefaultObservableValue(false)
    const waveform: HTMLCanvasElement = (<canvas/>)
    const waveformPainter = lifecycle.own(new CanvasPainter(waveform, painter => SlotUtils.waveform(painter, sample, semitone)))
    const playbackCanvas: HTMLCanvasElement = (<canvas/>)
    const playbackContext: CanvasRenderingContext2D = asDefined(playbackCanvas.getContext("2d"))
    const header: HTMLElement = (
        <header>
            <Icon symbol={IconSymbol.Play} className="icon-play"/>
            {labelName}
        </header>
    )
    const {mute, solo, exclude} = sample.namedParameter
    const muteWrapper = EditWrapper.forAutomatableParameter(editing, mute)
    const soloWrapper = EditWrapper.forAutomatableParameter(editing, solo)
    const excludeWrapper = EditWrapper.forAutomatableParameter(editing, exclude)
    const exclusionGroup: HTMLElement = (
        <div className="checkboxes">
            <Checkbox lifecycle={lifecycle}
                      model={muteValue}
                      appearance={{activeColor: Colors.red, framed: true, tooltip: "Mute sample"}}>
                <Icon symbol={IconSymbol.Mute}/>
            </Checkbox>
            <Checkbox lifecycle={lifecycle}
                      model={soloValue}
                      appearance={{activeColor: Colors.yellow, framed: true, tooltip: "Solo sample"}}>
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
    const audioEffectsField = sample.audioEffectsField.pointerHub
    lifecycle.ownAll(
        connectBoolean(muteValue, muteWrapper),
        connectBoolean(soloValue, soloWrapper),
        connectBoolean(excludeValue, excludeWrapper),
        TextTooltip.default(iconEdit, () => "Edit Sample"),
        audioEffectsField.catchupAndSubscribe({
            onAdded: () => iconEdit.classList.toggle("has-effects", audioEffectsField.nonEmpty()),
            onRemoved: () => iconEdit.classList.toggle("has-effects", audioEffectsField.nonEmpty())
        }),
        sample.box.file.catchupAndSubscribe((pointer) => {
            fileHandlerSubscription.terminate()
            if (pointer.isEmpty()) {return}
            sample.file().ifSome(file => {
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
        }),
        service.project.liveStreamReceiver.subscribeFloats(sample.address, array => sample.file().flatMap(file => file.data)
            .match({
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
            })),
        octave.catchupAndSubscribe(owner => {
            const slotIndex = owner.getValue() * 12 + semitone
            element.setAttribute("data-slot-index", String(slotIndex))
        }),
        SlotDragAndDrop.installSource({
            element,
            sample,
            getSlotIndex: () => octave.getValue() * 12 + semitone
        }),
        SlotDragAndDrop.installTarget({
            element,
            project: service.project,
            getSlotIndex: () => octave.getValue() * 12 + semitone
        }),
        Events.subscribe(iconEdit, "click", () => userEditingManager.audioUnit.edit(sample.box)),
        Events.subscribe(header, "pointerdown", (event: PointerEvent) => {
            if (event.ctrlKey) {return}
            noteLifeTime = NoteLifeCycle.start(signal =>
                engine.noteSignal(signal), adapter.audioUnitBoxAdapter().uuid, sample.indexField.getValue())
        }),
        Events.subscribe(header, "pointerup", () => noteLifeTime.terminate()),
        Events.subscribe(element, "keydown", (event) => {
            if (Keyboard.isDelete(event)) {
                sampleSelector.replaceSample(Option.None)
            }
        }),
        ContextMenu.subscribe(element, collector => {
            collector.addItems(
                MenuItem.default({label: "Browse Sample..."})
                    .setTriggerProcedure(() => sampleSelector.browse()),
                MenuItem.default({label: "Remove Sample"})
                    .setTriggerProcedure(() => sampleSelector.replaceSample(Option.None)),
                MenuItem.default({label: "Reset Parameters"})
                    .setTriggerProcedure(() => editing.modify(() => sample.resetParameters())),
                resetBooleanItem(editing, adapter, "mute", "Reset Mute"),
                resetBooleanItem(editing, adapter, "solo", "Reset Solo"),
                resetBooleanItem(editing, adapter, "exclude", "Reset Exclude"),
                DebugMenus.debugBox(sample.box)
            )
        }),
        sampleSelector.configureDrop(element),
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

const resetBooleanItem = (editing: BoxEditing,
                          adapter: PlayfieldDeviceBoxAdapter,
                          key: Extract<keyof PlayfieldSampleBoxAdapter["namedParameter"], "mute" | "solo" | "exclude">,
                          label: string) =>
    MenuItem.default({
        label,
        selectable: adapter.samples.adapters().some(adapter => adapter.namedParameter[key].getValue())
    }).setTriggerProcedure(() => editing.modify(() => adapter.samples.adapters()
        .filter(adapter => adapter.namedParameter[key].getValue())
        .forEach(adapter => adapter.namedParameter[key].setValue(false))))

