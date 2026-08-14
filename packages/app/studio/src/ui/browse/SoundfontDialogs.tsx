import css from "./SoundfontDialogs.sass?inline"
import {Dialog} from "@/ui/components/Dialog"
import {Soundfont} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {createElement} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Errors, isInstanceOf, RuntimeNotifier, Terminator} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {TextInput} from "@/ui/components/TextInput"

const className = Html.adoptStyleSheet(css, "SoundfontDialog")

export namespace SoundfontDialogs {
    export const showEditSoundfontDialog = async (soundfont: Soundfont): Promise<Soundfont> => {
        if (soundfont.origin === "openDAW") {
            return Promise.reject("Cannot change soundfont from the cloud")
        }
        const lifecycle = new Terminator()
        const {resolve, reject, promise} = Promise.withResolvers<Soundfont>()
        promise.finally(() => lifecycle.terminate())
        const name = new DefaultObservableValue(soundfont.name)
        const approve = () => {
            if (isInstanceOf(document.activeElement, HTMLElement)) {document.activeElement.blur()}
            const trimmed = name.getValue().trim()
            if (trimmed.length < 3) {
                RuntimeNotifier.notify({message: "Name must be at least 3 letters long.", icon: "Info"})
                return false
            }
            resolve({...soundfont, name: trimmed})
            return true
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline="Edit Soundfont"
                    icon={IconSymbol.SoundFont}
                    cancelable={true}
                    onCancel={() => reject(Errors.AbortError)}
                    buttons={[{
                        text: "Cancel",
                        onClick: handler => handler.close()
                    }, {
                        text: "Save",
                        primary: true,
                        onClick: handler => {
                            if (approve()) {handler.close()}
                        }
                    }]}>
                <div className={className}>
                    <div>Name:</div>
                    <TextInput lifecycle={lifecycle} model={name} maxChars={64}/>
                </div>
            </Dialog>
        )
        dialog.onkeydown = event => {
            if (event.code === "Enter" && approve()) {dialog.close()}
        }
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return promise
    }
}
