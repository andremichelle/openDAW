import css from "./FolderDialogs.sass?inline"
import {Dialog} from "@/ui/components/Dialog"
import {IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {createElement} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Errors, RuntimeNotifier, Terminator} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {TextInput} from "@/ui/components/TextInput"

const className = Html.adoptStyleSheet(css, "FolderDialog")

export namespace FolderDialogs {
    export const showNameDialog = async (headline: string,
                                         approveText: string,
                                         initial: string): Promise<string> => {
        const lifecycle = new Terminator()
        const {resolve, reject, promise} = Promise.withResolvers<string>()
        promise.finally(() => lifecycle.terminate())
        const model = new DefaultObservableValue(initial)
        const input = <TextInput lifecycle={lifecycle} model={model} maxChars={64}/>
        const approve = () => {
            const name = model.getValue().trim()
            if (name.length === 0) {
                RuntimeNotifier.notify({message: "A folder needs a name.", icon: "Info"})
                return false
            }
            if (name.includes("/")) {
                RuntimeNotifier.notify({message: "A folder name cannot contain '/'.", icon: "Info"})
                return false
            }
            resolve(name)
            return true
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline}
                    icon={IconSymbol.Folder}
                    cancelable={true}
                    onCancel={() => reject(Errors.AbortError)}
                    buttons={[{
                        text: "Cancel",
                        onClick: handler => handler.close()
                    }, {
                        text: approveText,
                        primary: true,
                        onClick: handler => {
                            if (approve()) {handler.close()}
                        }
                    }]}>
                <div className={className}>
                    <div>Name:</div>
                    {input}
                </div>
            </Dialog>
        )
        dialog.onkeydown = event => {
            if (event.code === "Enter" && approve()) {dialog.close()}
        }
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        input.focus()
        return promise
    }
}
