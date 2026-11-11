import css from "./SlotGrid.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Arrays, DefaultObservableValue, int, Lifecycle, Option} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {InstrumentCompositeCellBoxAdapter, NoteStreamReceiver, PlayfieldDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {SlotState} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotState"
import {Slot} from "@/ui/devices/instruments/PlayfieldDeviceEditor/Slot"
import {OctaveSelector} from "@/ui/devices/instruments/PlayfieldDeviceEditor/OctaveSelector"

const className = Html.adoptStyleSheet(css, "SlotGrid")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldDeviceBoxAdapter
    octave: DefaultObservableValue<int>
}

export const SlotGrid = ({lifecycle, service, adapter, octave}: Construct) => {
    const {project} = service
    const noteReceiver = lifecycle.own(new NoteStreamReceiver(project.liveStreamReceiver, adapter.audioUnitBoxAdapter().address))
    const slotStates = Arrays.create(() => new DefaultObservableValue<SlotState>(SlotState.Idle), 128)
    const slotValues = Arrays.create(() => new DefaultObservableValue<Option<InstrumentCompositeCellBoxAdapter>>(Option.None), 12)
    const slotViews: ReadonlyArray<HTMLElement> = slotValues.map((pad, semitone) => (
        <Slot lifecycle={lifecycle}
              service={service}
              noteReceiver={noteReceiver}
              adapter={adapter}
              pad={pad}
              octave={octave}
              semitone={semitone}/>
    ))
    const slotUpdater = () => {
        const offset = octave.getValue() * 12
        for (let semitone = 0; semitone < 12; semitone++) {
            const note = offset + semitone
            if (note < 128) {
                const pad = adapter.cells.getAdapterByIndex(note)
                const slotValue = slotValues[semitone]
                if (slotValue.getValue().unwrapOrNull()?.address.toString() !== pad.unwrapOrNull()?.address.toString()) {
                    slotValue.setValue(pad)
                }
                slotViews[semitone].classList.remove("hidden")
            } else {
                slotViews[semitone].classList.add("hidden")
            }
        }
    }
    const updateSlotState = () => {
        let index = 0 | 0
        adapter.cells.adapters().forEach(({indexField}) => {
            const toIndex = indexField.getValue()
            while (index < toIndex && index < 128) {
                slotStates[index].setValue(noteReceiver.isNoteOn(index) ? SlotState.Playing : SlotState.Idle)
                index++
            }
            if (index === toIndex && index < 128) {
                slotStates[index].setValue(noteReceiver.isNoteOn(index) ? SlotState.Playing : SlotState.Busy)
                index++
            }
        })
        while (index < 128) {
            slotStates[index].setValue(noteReceiver.isNoteOn(index) ? SlotState.Playing : SlotState.Idle)
            index++
        }
    }
    const updateSlots = () => {
        updateSlotState()
        slotUpdater()
    }
    lifecycle.ownAll(
        octave.subscribe(slotUpdater),
        adapter.cells.catchupAndSubscribe({
            onAdd: updateSlots,
            onRemove: updateSlots,
            onReorder: updateSlots
        }),
        noteReceiver.subscribe(updateSlotState)
    )
    const octaveSelectors = Arrays.create(index => (
        <OctaveSelector lifecycle={lifecycle}
                        states={slotStates.slice(index * 12, (index + 1) * 12)}
                        octave={octave}
                        octaveIndex={index}/>
    ), 11).reverse()
    return (
        <div className={className}>
            <div className="octave-selectors">
                {octaveSelectors}
            </div>
            <div className="slots">
                {slotViews}
            </div>
        </div>
    )
}