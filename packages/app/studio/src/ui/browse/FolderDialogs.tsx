import {Dialog} from "@/ui/components/Dialog"
import {IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {createElement} from "@opendaw/lib-jsx"
import {Errors, RuntimeNotifier} from "@opendaw/lib-std"

export namespace FolderDialogs {
    // Rejects with `AbortError` when cancelled, the same contract `SampleDialogs` uses, so a caller can treat
    // "no name" and "changed my mind" identically.
    export const showNameDialog = async (headline: string,
                                         approveText: string,
                                         initial: string): Promise<string> => {
        const {resolve, reject, promise} = Promise.withResolvers<string>()
        const input: HTMLInputElement = <input className="default"
                                               type="text"
                                               value={initial}
                                               placeholder="Enter a name"/>
        const approve = () => {
            const name = input.value.trim()
            if (name.length === 0) {
                RuntimeNotifier.notify({message: "A folder needs a name.", icon: "Info"})
                return false
            }
            // The path is what identifies a folder in the structure file and in the expansion state, so a
            // slash inside a name would silently create a level that does not exist.
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
                    buttons={[{
                        text: approveText,
                        primary: true,
                        onClick: handler => {
                            if (approve()) {handler.close()}
                        }
                    }]}>
                <div style={{padding: "1em 0", display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "1em"}}>
                    <div>Name:</div>
                    {input}
                </div>
            </Dialog>
        )
        dialog.oncancel = () => reject(Errors.AbortError)
        dialog.onkeydown = event => {
            if (event.code === "Enter" && approve()) {dialog.close()}
        }
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        input.select()
        input.focus()
        return promise
    }
}
