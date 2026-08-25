import css from "./SampleDropZone.sass?inline"
import {asInstanceOf, Lifecycle, Terminable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {PointerField} from "@opendaw/lib-box"
import {IconSymbol, Pointers} from "@opendaw/studio-enums"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Icon} from "@/ui/components/Icon"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "SampleDropZone")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    file: PointerField<Pointers.AudioFile>
}

export const SampleDropZone = ({lifecycle, service, file}: Construct): HTMLElement => {
    const element: HTMLElement = (
        <div className={className}>
            <Icon symbol={IconSymbol.Waveform}/>
        </div>
    )
    const sampleSelector = new SampleSelector(service, SampleSelectStrategy.forDeviceFile(file))
    let loaderSubscription: Terminable = Terminable.Empty
    lifecycle.ownAll(
        Terminable.create(() => loaderSubscription.terminate()),
        file.catchupAndSubscribe(pointer => {
            loaderSubscription.terminate()
            loaderSubscription = Terminable.Empty
            element.classList.remove("error")
            pointer.targetVertex.match({
                none: () => element.removeAttribute("sample"),
                some: ({box}) => {
                    const fileBox = asInstanceOf(box, AudioFileBox)
                    element.setAttribute("sample", fileBox.fileName.getValue())
                    loaderSubscription = service.project.sampleManager.getOrCreate(fileBox.address.uuid)
                        .subscribe(state => element.classList.toggle("error", state.type === "error"))
                }
            })
        }),
        sampleSelector.configureBrowseClick(element),
        sampleSelector.configureContextMenu(element),
        sampleSelector.configureDrop(element)
    )
    return element
}
