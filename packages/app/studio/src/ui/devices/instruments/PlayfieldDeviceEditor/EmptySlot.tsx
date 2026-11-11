import css from "./EmptySlot.sass?inline"
import {Events, Html} from "@opendaw/lib-dom"
import {int, Lifecycle, ObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {SampleSelector} from "@/ui/devices/SampleSelector"
import {SlotDragAndDrop} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotDragAndDrop"
import {ChopTrigger} from "@/ui/devices/instruments/PlayfieldDeviceEditor/ChopTrigger"
import {NoteLabel} from "@/ui/devices/instruments/PlayfieldDeviceEditor/NoteLabel"
import {Icon} from "@/ui/components/Icon"
import {NoteStreamReceiver, PlayfieldDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {ContextMenu} from "@opendaw/studio-core"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {DeviceDialog} from "@/ui/browse/DeviceDialog"

const className = Html.adoptStyleSheet(css, "EmptySlot")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldDeviceBoxAdapter
    noteReceiver: NoteStreamReceiver
    sampleSelector: SampleSelector
    octave: ObservableValue<int>
    semitone: int
}

export const EmptySlot = (
    {lifecycle, service, adapter, noteReceiver, sampleSelector, octave, semitone}: Construct) => {
    const {project} = service
    const browseButton: HTMLElement = (
        <div>
            <Icon symbol={IconSymbol.AudioFile}/>
        </div>
    )
    const instrumentButton: HTMLElement = (
        <div>
            <Icon symbol={IconSymbol.Piano}/>
        </div>
    )
    const buttons: HTMLElement = <div className="buttons">{browseButton}{instrumentButton}</div>
    const element: HTMLElement = (
        <div className={className} data-slot-index={octave.getValue() * 12 + semitone}>
            <header/>
            {buttons}
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
            playfield: adapter,
            getSlotIndex: () => octave.getValue() * 12 + semitone
        }),
        sampleSelector.configureDrop(element, sample =>
            ChopTrigger.forSample(service, adapter, sample, octave.getValue() * 12 + semitone)),
        sampleSelector.configureBrowseClick(browseButton),
        TextTooltip.default(browseButton, () => "Browse sample"),
        TextTooltip.default(instrumentButton, () => "Choose instrument"),
        Events.subscribe(instrumentButton, "click", () => DeviceDialog.open(service, {
            type: "new-pad", host: adapter.deviceHost(), playfield: adapter.box, key: octave.getValue() * 12 + semitone
        })),
        noteReceiver.subscribe((receiver) => buttons.classList
            .toggle("playing", receiver.isNoteOn(octave.getValue() * 12 + semitone))),
        ContextMenu.subscribe(element, collector => collector.addItems(sampleSelector.createBrowseMenuData()))
    )
    return element
}