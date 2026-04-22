import {Dialog} from "@/ui/components/Dialog"
import {IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {createElement} from "@opendaw/lib-jsx"
import {Errors} from "@opendaw/lib-std"

export namespace PresetDialogs {
    export type SaveInput = {
        headline: string
        suggestedName?: string
        suggestedDescription?: string
    }

    export type SaveResult = {
        name: string
        description: string
    }

    export const showSavePresetDialog = async ({
                                                   headline,
                                                   suggestedName = "",
                                                   suggestedDescription = ""
                                               }: SaveInput): Promise<SaveResult> => {
        const {resolve, reject, promise} = Promise.withResolvers<SaveResult>()
        const nameField: HTMLInputElement = (
            <input className="default" type="text" placeholder="Preset name" value={suggestedName}/>
        )
        const descriptionField: HTMLTextAreaElement = (
            <textarea className="default"
                      rows={3}
                      placeholder="Optional description">{suggestedDescription}</textarea>
        )
        const approve = () => {
            const name = nameField.value.trim()
            if (name.length === 0) {
                nameField.focus()
                return false
            }
            resolve({name, description: descriptionField.value.trim()})
            return true
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline}
                    icon={IconSymbol.Box}
                    cancelable={true}
                    buttons={[{
                        text: "Save",
                        primary: true,
                        onClick: handler => {
                            if (approve()) {handler.close()}
                        }
                    }]}>
                <div style={{
                    padding: "1em 0",
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    columnGap: "1em",
                    rowGap: "0.5em",
                    alignItems: "start",
                    minWidth: "24em"
                }}>
                    <div>Name:</div>
                    {nameField}
                    <div style={{paddingTop: "0.35em"}}>Description:</div>
                    {descriptionField}
                </div>
            </Dialog>
        )
        dialog.oncancel = () => reject(Errors.AbortError)
        dialog.onkeydown = event => {
            if (event.code === "Enter" && !(event.target instanceof HTMLTextAreaElement)) {
                if (approve()) {dialog.close()}
            }
        }
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        nameField.select()
        nameField.focus()
        return promise
    }

    export type RackCompositionChoice = "entire-chain" | "only-instrument"

    export const showRackCompositionDialog = async (headline: string,
                                                    message: string): Promise<RackCompositionChoice> => {
        const {resolve, reject, promise} = Promise.withResolvers<RackCompositionChoice>()
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline}
                    icon={IconSymbol.Box}
                    cancelable={true}
                    buttons={[
                        {
                            text: "Cancel",
                            onClick: handler => {
                                reject(Errors.AbortError)
                                handler.close()
                            }
                        },
                        {
                            text: "Only Instrument",
                            onClick: handler => {
                                resolve("only-instrument")
                                handler.close()
                            }
                        },
                        {
                            text: "Entire Chain",
                            primary: true,
                            onClick: handler => {
                                resolve("entire-chain")
                                handler.close()
                            }
                        }
                    ]}>
                <div style={{padding: "1em 0", minWidth: "20em"}}>{message}</div>
            </Dialog>
        )
        dialog.oncancel = () => reject(Errors.AbortError)
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return promise
    }
}
