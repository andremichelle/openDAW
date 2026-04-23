import {Dialog} from "@/ui/components/Dialog"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Errors, Terminator} from "@opendaw/lib-std"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"

export namespace PresetDialogs {
    export type SaveInput = {
        headline: string
        suggestedName?: string
        suggestedDescription?: string
        showTimelineToggle?: boolean
    }

    export type SaveResult = {
        name: string
        description: string
        includeTimeline: boolean
    }

    export const showSavePresetDialog = async ({
                                                   headline,
                                                   suggestedName = "",
                                                   suggestedDescription = "",
                                                   showTimelineToggle = true
                                               }: SaveInput): Promise<SaveResult> => {
        const lifecycle = new Terminator()
        const {resolve, reject, promise} = Promise.withResolvers<SaveResult>()
        promise.finally(() => lifecycle.terminate())
        const nameField: HTMLInputElement = (
            <input className="default" type="text" placeholder="Preset name" value={suggestedName}/>
        )
        const descriptionField: HTMLTextAreaElement = (
            <textarea className="default"
                      rows={3}
                      placeholder="Optional description">{suggestedDescription}</textarea>
        )
        const includeTimelineModel = new DefaultObservableValue(false)
        const approve = () => {
            const name = nameField.value.trim()
            if (name.length === 0) {
                nameField.focus()
                return false
            }
            resolve({
                name,
                description: descriptionField.value.trim(),
                includeTimeline: includeTimelineModel.getValue()
            })
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
                    minWidth: "24em",
                    color: Colors.dark.toString()
                }}>
                    <div>Name:</div>
                    {nameField}
                    <div style={{paddingTop: "0.35em"}}>Description:</div>
                    {descriptionField}
                    {showTimelineToggle && (
                        <Frag>
                            <div style={{paddingTop: "0.15em"}}>Include timeline:</div>
                            <Checkbox lifecycle={lifecycle}
                                      model={includeTimelineModel}
                                      appearance={{framed: true, color: Colors.black}}>
                                <Icon symbol={IconSymbol.Checkbox}/>
                            </Checkbox>
                        </Frag>
                    )}
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

    export type RackCompositionResult = {
        choice: RackCompositionChoice
        includeTimeline: boolean
    }

    export const showRackCompositionDialog = async (headline: string,
                                                    message: string,
                                                    showTimelineToggle: boolean = false,
                                                    initialIncludeTimeline: boolean = false): Promise<RackCompositionResult> => {
        const lifecycle = new Terminator()
        const {resolve, reject, promise} = Promise.withResolvers<RackCompositionResult>()
        promise.finally(() => lifecycle.terminate())
        const includeTimelineModel = new DefaultObservableValue(initialIncludeTimeline)
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
                                resolve({choice: "only-instrument", includeTimeline: includeTimelineModel.getValue()})
                                handler.close()
                            }
                        },
                        {
                            text: "Entire Chain",
                            primary: true,
                            onClick: handler => {
                                resolve({choice: "entire-chain", includeTimeline: includeTimelineModel.getValue()})
                                handler.close()
                            }
                        }
                    ]}>
                <div style={{padding: "1em 0", minWidth: "20em", display: "flex", color: Colors.dark.toString(),
                    flexDirection: "column", rowGap: "0.75em"}}>
                    <div>{message}</div>
                    {showTimelineToggle && (
                        <div style={{
                            display: "grid",
                            gridTemplateColumns: "auto 1fr",
                            columnGap: "1em",
                            alignItems: "center"
                        }}>
                            <div>Include timeline:</div>
                            <Checkbox lifecycle={lifecycle} model={includeTimelineModel}
                                      appearance={{framed: true, color: Colors.black}}>
                                <Icon symbol={IconSymbol.Checkbox}/>
                            </Checkbox>
                        </div>
                    )}
                </div>
            </Dialog>
        )
        dialog.oncancel = () => reject(Errors.AbortError)
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return promise
    }

    export type ReplaceInput = {
        headline: string
        message: string
        initialIncludeTimeline?: boolean
    }

    export type ReplaceResult = {
        includeTimeline: boolean
    }

    export const showReplacePresetDialog = async ({
                                                       headline,
                                                       message,
                                                       initialIncludeTimeline = false
                                                   }: ReplaceInput): Promise<ReplaceResult> => {
        const lifecycle = new Terminator()
        const {resolve, reject, promise} = Promise.withResolvers<ReplaceResult>()
        promise.finally(() => lifecycle.terminate())
        const includeTimelineModel = new DefaultObservableValue(initialIncludeTimeline)
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
                            text: "Replace",
                            primary: true,
                            onClick: handler => {
                                resolve({includeTimeline: includeTimelineModel.getValue()})
                                handler.close()
                            }
                        }
                    ]}>
                <div style={{padding: "1em 0", minWidth: "20em", display: "flex", color: Colors.dark.toString(),
                    flexDirection: "column", rowGap: "0.75em"}}>
                    <div>{message}</div>
                    <div style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr",
                        columnGap: "1em",
                        alignItems: "center"
                    }}>
                        <div>Include timeline:</div>
                        <Checkbox lifecycle={lifecycle} model={includeTimelineModel}
                                  appearance={{framed: true, color: Colors.black}}>
                            <Icon symbol={IconSymbol.Checkbox}/>
                        </Checkbox>
                    </div>
                </div>
            </Dialog>
        )
        dialog.oncancel = () => reject(Errors.AbortError)
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return promise
    }
}
