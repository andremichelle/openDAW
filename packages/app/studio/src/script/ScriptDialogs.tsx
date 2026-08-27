import {Errors, isDefined, Procedure, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {ScriptMeta} from "@opendaw/studio-core"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {ScriptBrowser} from "@/script/ScriptBrowser"

export namespace ScriptDialogs {
    export type MetaInput = {name: string, description: string}

    export const showMetaDialog = async ({headline, meta, buttonText}: {
        headline: string
        meta?: MetaInput
        buttonText?: string
    }): Promise<MetaInput> => {
        const {resolve, reject, promise} = Promise.withResolvers<MetaInput>()
        const nameField: HTMLInputElement = <input className="default" type="text" placeholder="Enter a name"/>
        const descriptionField: HTMLTextAreaElement = (
            <textarea className="default" rows={3} placeholder="What does the script do?" style={{resize: "none"}}/>
        )
        if (isDefined(meta)) {
            nameField.value = meta.name
            descriptionField.value = meta.description
        }
        const valid = () => nameField.value.trim().length > 0
        const approve = () => resolve({name: nameField.value.trim(), description: descriptionField.value.trim()})
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline}
                    icon={IconSymbol.Code}
                    cancelable={true}
                    buttons={[{
                        text: buttonText ?? "Save",
                        primary: true,
                        onClick: handler => {
                            if (!valid()) {return}
                            approve()
                            handler.close()
                        }
                    }]}>
                <div style={{
                    padding: "1em 0", display: "grid", gridTemplateColumns: "auto 1fr",
                    columnGap: "1em", rowGap: "0.5em", alignItems: "start", minWidth: "24em"
                }}>
                    <div>Name:</div>
                    {nameField}
                    <div>Description:</div>
                    {descriptionField}
                </div>
            </Dialog>
        )
        dialog.oncancel = () => reject(Errors.AbortError)
        dialog.onkeydown = event => {
            if (event.code === "Enter" && event.target === nameField && valid()) {
                event.preventDefault()
                approve()
                dialog.close()
            }
        }
        dialog.addEventListener("close", () => reject(Errors.AbortError))
        Surface.get().body.appendChild(dialog)
        dialog.showModal()
        nameField.select()
        nameField.focus()
        return promise
    }

    export const showBrowseDialog = async ({onMetaChanged, onDeleted}: {
        onMetaChanged: Procedure<[UUID.Bytes, ScriptMeta]>
        onDeleted: Procedure<UUID.Bytes>
    }): Promise<[UUID.Bytes, ScriptMeta]> => {
        const {resolve, reject, promise} = Promise.withResolvers<[UUID.Bytes, ScriptMeta]>()
        const lifecycle = new Terminator()
        const dialog: HTMLDialogElement = (
            <Dialog headline="Scripts"
                    icon={IconSymbol.Code}
                    buttons={[{text: "Close", onClick: () => dialog.close()}]}
                    cancelable={true} style={{height: "30em", minWidth: "40em"}}>
                <div style={{height: "1em"}}/>
                <ScriptBrowser lifecycle={lifecycle}
                               select={result => {
                                   resolve(result)
                                   dialog.close()
                               }}
                               onMetaChanged={onMetaChanged}
                               onDeleted={onDeleted}/>
            </Dialog>
        )
        dialog.addEventListener("close", () => reject(Errors.AbortError))
        Surface.get().body.appendChild(dialog)
        dialog.showModal()
        return promise.finally(() => lifecycle.terminate())
    }
}
