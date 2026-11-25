import {DefaultObservableValue, Errors, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AnyRegionBoxAdapter} from "@opendaw/studio-adapters"
import {AudioBounce} from "@opendaw/studio-core"
import {Dialogs} from "@/ui/components/dialogs"
import {BounceOptionsSelector} from "@/ui/components/BounceOptionsSelector"
import {StudioService} from "@/service/StudioService"

export namespace Bounces {
    const tap = new DefaultObservableValue<AudioBounce.Tap>(AudioBounce.DefaultOptions.tap)
    const tail = new DefaultObservableValue<boolean>(AudioBounce.DefaultOptions.tail)
    const merge = new DefaultObservableValue<boolean>(AudioBounce.DefaultOptions.merge)
    const loop = new DefaultObservableValue<boolean>(AudioBounce.DefaultOptions.loop)

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
}
