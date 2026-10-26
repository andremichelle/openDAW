import {DefaultObservableValue, Errors, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import {AudioMonoConversion} from "@opendaw/studio-core"
import {Dialogs} from "@/ui/components/dialogs"
import {MonoOptionsSelector} from "@/ui/components/MonoOptionsSelector"
import {StudioService} from "@/service/StudioService"

export namespace MonoConversions {
    export const convertRegion = async (service: StudioService, region: AudioRegionBoxAdapter): Promise<void> => {
        if (!AudioMonoConversion.canConvert(region.file)) {return}
        const mode = new DefaultObservableValue<AudioMonoConversion.Mode>("sum")
        const keepOriginal = new DefaultObservableValue<boolean>(false)
        const lifecycle = new Terminator()
        const {status, error} = await Promises.tryCatch(Dialogs.show({
            headline: "Convert to Mono",
            content: MonoOptionsSelector({lifecycle, mode, keepOriginal}),
            okText: "Convert",
            buttons: [{text: "Cancel", primary: false, onClick: handler => handler.close()}]
        }))
        lifecycle.terminate()
        if (status === "rejected") {
            if (Errors.isAbort(error)) {return}
            throw error
        }
        return AudioMonoConversion.convert(service.project, service.sampleService, region.file,
            mode.getValue(), keepOriginal.getValue())
    }
}
