import {DefaultObservableValue, int, Lifecycle, ObservableValue, Option, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {
    InstrumentCompositeCellBoxAdapter,
    NoteStreamReceiver,
    PlayfieldDeviceBoxAdapter,
    PlayfieldPads
} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {EmptySlot} from "@/ui/devices/instruments/PlayfieldDeviceEditor/EmptySlot"
import {BusySlot} from "./BusySlot"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    noteReceiver: NoteStreamReceiver
    adapter: PlayfieldDeviceBoxAdapter
    pad: DefaultObservableValue<Option<InstrumentCompositeCellBoxAdapter>>
    octave: ObservableValue<int>
    semitone: int
}

export const Slot = (
    {lifecycle, service, noteReceiver, adapter, pad, octave, semitone}: Construct) => {
    const {boxGraph, boxAdapters} = service.project
    const sampleSelector = new SampleSelector(service, {
        isAttached: (): boolean => pad.getValue().match({
            none: () => adapter.box.isAttached(),
            some: ({box}) => box.isAttached()
        }),
        hasSample: (): boolean => pad.getValue()
            .flatMap(cell => PlayfieldPads.nanoOf(boxAdapters, cell)).mapOr(nano => nano.box.file.nonEmpty(), false),
        replace: (replacement: Option<AudioFileBox>) => pad.getValue().match<unknown>({
            none: () => replacement.ifSome(file =>
                PlayfieldPads.create(boxGraph, adapter.box, file, octave.getValue() * 12 + semitone)),
            some: cell => {
                const nano = PlayfieldPads.nanoOf(boxAdapters, cell)
                if (replacement.isEmpty()) {
                    nano.ifSome(({box}) => SampleSelectStrategy.clearPointer(box.file))
                    cell.box.delete()
                } else {
                    nano.match({
                        none: () => replacement.ifSome(file => PlayfieldPads.playSample(boxGraph, cell.box, file)),
                        some: ({box}) => SampleSelectStrategy.changePointer(box.file, replacement)
                    })
                }
            }
        })
    })
    const sampleLifecycle = lifecycle.own(new Terminator())
    const group = <div style={{
        display: "content",
        gridRow: String(3 - Math.floor(semitone / 4)),
        gridColumn: String(semitone % 4 + 1)
    }}/>
    lifecycle.ownAll(
        pad.catchupAndSubscribe(owner => {
            sampleLifecycle.terminate()
            replaceChildren(group, owner.getValue().match({
                none: () => (
                    <EmptySlot lifecycle={sampleLifecycle}
                               service={service}
                               adapter={adapter}
                               noteReceiver={noteReceiver}
                               sampleSelector={sampleSelector}
                               octave={octave}
                               semitone={semitone}/>
                ),
                some: cell => (
                    <BusySlot lifecycle={sampleLifecycle}
                              service={service}
                              adapter={adapter}
                              sampleSelector={sampleSelector}
                              pad={cell}
                              octave={octave}
                              semitone={semitone}/>
                )
            }))
        })
    )
    return group
}