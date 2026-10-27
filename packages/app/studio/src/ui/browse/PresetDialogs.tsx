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
        suggestedTags?: ReadonlyArray<string>
        showTimelineToggle?: boolean
    }

    export type SaveResult = {
        name: string
        description: string
        tags: ReadonlyArray<string>
        includeTimeline: boolean
    }

    export const showSavePresetDialog = async ({
                                                   headline,
                                                   suggestedName = "",
                                                   suggestedDescription = "",
                                                   suggestedTags = [],
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
        const tagsField: HTMLInputElement = (
            <input className="default" type="text" placeholder="Optional, comma separated" value={suggestedTags.join(", ")}/>
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
                tags: Array.from(new Set(tagsField.value.split(",")
                    .map(tag => tag.trim().toLowerCase()).filter(tag => tag.length > 0))),
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
                    <div style={{paddingTop: "0.35em"}}>Tags:</div>
                    {tagsField}
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
                            text: "Overwrite",
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

    export type ConflictChoice = "override" | "copy"

    export const showPresetConflictDialog = async (name: string): Promise<ConflictChoice> => {
        const {resolve, reject, promise} = Promise.withResolvers<ConflictChoice>()
        const dialog: HTMLDialogElement = (
            <Dialog headline="Preset Already Exists"
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
                            text: "Override",
                            onClick: handler => {
                                resolve("override")
                                handler.close()
                            }
                        },
                        {
                            text: "Copy",
                            primary: true,
                            onClick: handler => {
                                resolve("copy")
                                handler.close()
                            }
                        }
                    ]}>
                <div style={{padding: "1em 0", minWidth: "20em", color: Colors.dark.toString()}}>
                    A preset with the same id as '{name}' already exists. Override it, or import as a copy?
                </div>
            </Dialog>
        )
        dialog.oncancel = () => reject(Errors.AbortError)
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return promise
    }
}
