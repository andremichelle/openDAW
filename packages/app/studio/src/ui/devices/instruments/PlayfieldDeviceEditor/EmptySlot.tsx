import css from "./EmptySlot.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {int, Lifecycle, ObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {SampleSelector} from "@/ui/devices/SampleSelector"
import {SlotDragAndDrop} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotDragAndDrop"
import {NoteLabel} from "@/ui/devices/instruments/PlayfieldDeviceEditor/NoteLabel"
import {Icon} from "@/ui/components/Icon"
import {NoteStreamReceiver} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {ContextMenu} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "EmptySlot")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    noteReceiver: NoteStreamReceiver
    sampleSelector: SampleSelector
    octave: ObservableValue<int>
    semitone: int
}

export const EmptySlot = (
    {lifecycle, service: {project}, noteReceiver, sampleSelector, octave, semitone}: Construct) => {
    const browseButton: HTMLElement = (
        <div className="audio-file">
            <Icon symbol={IconSymbol.AudioFile}/>
        </div>
    )
    const element: HTMLElement = (
        <div className={className} data-slot-index={octave.getValue() * 12 + semitone}>
            <header/>
            {browseButton}
            <footer>
                <NoteLabel lifecycle={lifecycle} octave={octave} semitone={semitone}/>
            </footer>
        </div>
    )
    lifecycle.ownAll(
        octave.catchupAndSubscribe(owner => {
            const slotIndex = owner.getValue() * 12 + semitone
            element.setAttribute("data-slot-index", String(slotIndex))
        }),
        SlotDragAndDrop.installTarget({
            element,
            project,
            getSlotIndex: () => octave.getValue() * 12 + semitone
        }),
        sampleSelector.configureDrop(element),
        sampleSelector.configureBrowseClick(browseButton),
        noteReceiver.subscribe((receiver) => browseButton.classList
            .toggle("playing", receiver.isNoteOn(octave.getValue() * 12 + semitone))),
        ContextMenu.subscribe(element, collector => collector.addItems(sampleSelector.createBrowseMenuData()))
    )
    return element
}