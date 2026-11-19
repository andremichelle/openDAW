import {DefaultObservableValue, Errors, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {PPQN} from "@opendaw/lib-dsp"
import {AnyRegionBoxAdapter} from "@opendaw/studio-adapters"
import {AudioBounce} from "@opendaw/studio-core"
import {Dialogs} from "@/ui/components/dialogs"
import {BounceOptionsSelector} from "@/ui/components/BounceOptionsSelector"
import {PreRollSelector} from "@/ui/components/PreRollSelector"
import {StudioService} from "@/service/StudioService"
import {TimeSelection} from "@/ui/timeline/TimeSelection"
import type {TimeSelectionActions} from "@/ui/timeline/TimeSelectionActions"

export namespace Bounces {
    const tap = new DefaultObservableValue<AudioBounce.Tap>(AudioBounce.DefaultOptions.tap)
    const tail = new DefaultObservableValue<boolean>(AudioBounce.DefaultOptions.tail)
    const merge = new DefaultObservableValue<boolean>(AudioBounce.DefaultOptions.merge)
    const loop = new DefaultObservableValue<boolean>(AudioBounce.DefaultOptions.loop)
    const preRollQuarters = new DefaultObservableValue<number>(0)

    export const bounceRegions = async (service: StudioService,
                                        regions: ReadonlyArray<AnyRegionBoxAdapter>): Promise<void> => {
        if (!AudioBounce.canBounce(regions)) {return}
        const canMerge = AudioBounce.canMerge(regions)
        const lifecycle = new Terminator()
        const {status, error} = await Promises.tryCatch(Dialogs.show({
            headline: "Bounce",
            content: BounceOptionsSelector({lifecycle, tap, loop, tail, merge, canMerge}),
            okText: "Bounce"
        }))
        lifecycle.terminate()
        if (status === "rejected") {
            if (Errors.isAbort(error)) {return}
            throw error
        }
        return AudioBounce.bounce(service.project, service.sampleService, regions, {
            tap: tap.getValue(),
            tail: tail.getValue(),
            merge: canMerge && merge.getValue(),
            loop: loop.getValue()
        })
    }

    export const bounceRange = async (service: StudioService, {position, complete}: TimeSelection,
                                      {tracks, units}: TimeSelectionActions.Scope): Promise<void> => {
        if (!AudioBounce.canBounceRange(units)) {return}
        const lifecycle = new Terminator()
        const {status, error} = await Promises.tryCatch(Dialogs.show({
            headline: "Bounce Time Selection",
            content: PreRollSelector({lifecycle, quarters: preRollQuarters}),
            okText: "Bounce"
        }))
        lifecycle.terminate()
        if (status === "rejected") {
            if (Errors.isAbort(error)) {return}
            throw error
        }
        const {project, sampleService, timeline} = service
        const range = {units, tracks, start: position, end: complete, preRoll: preRollQuarters.getValue() * PPQN.Quarter}
        const created = await AudioBounce.bounceRange(project, sampleService, range)
        created.ifSome(box => timeline.revealAudioUnit.notify(box.address.uuid))
    }
}
