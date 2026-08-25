import css from "./SampleDropZone.sass?inline"
import {asInstanceOf, Lifecycle} from "@opendaw/lib-std"
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
    lifecycle.ownAll(
        file.catchupAndSubscribe(pointer => pointer.targetVertex.match({
            none: () => element.removeAttribute("sample"),
            some: ({box}) => element.setAttribute("sample", asInstanceOf(box, AudioFileBox).fileName.getValue())
        })),
        sampleSelector.configureBrowseClick(element),
        sampleSelector.configureContextMenu(element),
        sampleSelector.configureDrop(element)
    )
    return element
}
