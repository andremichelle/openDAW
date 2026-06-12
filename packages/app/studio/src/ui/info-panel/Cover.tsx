import css from "./Cover.sass?inline"
import {Errors, isDefined, Lifecycle, MutableObservableOption, panic, RuntimeNotifier} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Icon} from "../components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {Events, Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {encodeCover} from "./CoverImage"

const className = Html.adoptStyleSheet(css, "Cover")

type Construct = {
    lifecycle: Lifecycle
    model: MutableObservableOption<ArrayBuffer>
}

export const Cover = ({lifecycle, model}: Construct) => {
    const placeholder = "/cover.png"
    const editIcon: Element = <Icon symbol={IconSymbol.EditBox} className="edit-icon"/>
    const image: HTMLImageElement = (<img src={placeholder} alt="Cover"/>)
    lifecycle.ownAll(
        model.catchupAndSubscribe(owner => {
            image.src = owner.match({
                none: () => placeholder,
                some: buffer => buffer.byteLength === 0 ? placeholder : URL.createObjectURL(new Blob([buffer]))
            })
        }),
        Events.subscribe(editIcon, "click", async () => {
            const {status, value, error} = await Promises.tryCatch(Files.open())
            if (status === "rejected") {
                if (!Errors.isAbort(error)) {return panic(String(error))}
                return
            }
            const file = value?.at(0)
            if (!isDefined(file)) {return}
            // Large uploads are shrunk (fit within CoverMaxSize and re-encoded as WebP), not rejected.
            const {status: encodeStatus, value: encoded} =
                await Promises.tryCatch(encodeCover(await file.arrayBuffer()))
            if (encodeStatus === "rejected") {
                RuntimeNotifier.notify({message: `Unknown image format (${file.type}).`, icon: "Info"})
                return
            }
            model.wrap(encoded)
        })
    )
    return (
        <div className={className}>
            {editIcon}
            {image}
        </div>
    )
}