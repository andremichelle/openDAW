import {DefaultObservableValue, int, Lifecycle, ObservableValue, Option, Terminator, UUID} from "@moises-ai/lib-std"
import {createElement, replaceChildren} from "@moises-ai/lib-jsx"
import {NoteStreamReceiver, PlayfieldDeviceBoxAdapter, PlayfieldSampleBoxAdapter} from "@moises-ai/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {AudioFileBox, PlayfieldSampleBox} from "@moises-ai/studio-boxes"
import {EmptySlot} from "@/ui/devices/instruments/PlayfieldDeviceEditor/EmptySlot"
import {BusySlot} from "./BusySlot"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    noteReceiver: NoteStreamReceiver
    adapter: PlayfieldDeviceBoxAdapter
    sample: DefaultObservableValue<Option<PlayfieldSampleBoxAdapter>>
    octave: ObservableValue<int>
    semitone: int
}

export const Slot = (
    {lifecycle, service, noteReceiver, adapter, sample, octave, semitone}: Construct) => {
    const sampleSelector = new SampleSelector(service, {
        hasSample: (): boolean => sample.getValue().mapOr(sample => sample.box.file.nonEmpty(), false),
        replace: (replacement: Option<AudioFileBox>) => {
            sample.getValue().match<unknown>({
                none: () => replacement
                    .ifSome(file => PlayfieldSampleBox.create(service.project.boxGraph, UUID.generate(), box => {
                        box.file.refer(file)
                        box.device.refer(adapter.box.samples)
                        box.index.setValue(octave.getValue() * 12 + semitone)
                    })),
                some: ({box}) => SampleSelectStrategy.changePointer(box.file, replacement)
            })
        }
    })
    const sampleLifecycle = lifecycle.own(new Terminator())
    const group = <div style={{
        display: "content",
        gridRow: String(3 - Math.floor(semitone / 4)),
        gridColumn: String(semitone % 4 + 1)
    }}/>
    lifecycle.ownAll(
        sample.catchupAndSubscribe(owner => {
            sampleLifecycle.terminate()
            replaceChildren(group, owner.getValue().match({
                none: () => (
                    <EmptySlot lifecycle={sampleLifecycle}
                               service={service}
                               noteReceiver={noteReceiver}
                               sampleSelector={sampleSelector}
                               octave={octave}
                               semitone={semitone}/>
                ),
                some: sample => (
                    <BusySlot lifecycle={sampleLifecycle}
                              service={service}
                              adapter={adapter}
                              sampleSelector={sampleSelector}
                              sample={sample}
                              octave={octave}
                              semitone={semitone}/>
                )
            }))
        })
    )
    return group
}