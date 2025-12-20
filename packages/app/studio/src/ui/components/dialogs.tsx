import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Button, Dialog, DialogHandler} from "@/ui/components/Dialog.tsx"
import {
    Arrays,
    EmptyExec,
    Errors,
    Exec,
    isDefined,
    Option,
    Provider,
    RuntimeNotification,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {Surface} from "@/ui/surface/Surface.tsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Box, BoxGraph} from "@opendaw/lib-box"
import {BoxDebugView} from "./BoxDebugView"
import {BoxesDebugView} from "@/ui/components/BoxesDebugView.tsx"
import {ProgressBar} from "@/ui/components/ProgressBar.tsx"
import {Browser} from "@opendaw/lib-dom"

export namespace Dialogs {
    type Default = {
        headline?: string,
        content: JsxValue,
        okText?: string,
        buttons?: ReadonlyArray<Button>
        origin?: Element
        abortSignal?: AbortSignal
        excludeOk?: boolean
        cancelable?: boolean
        growWidth?: boolean
    }

    type Info = {
        headline?: string,
        message: string,
        okText?: string,
        buttons?: ReadonlyArray<Button>
        origin?: Element
        abortSignal?: AbortSignal
        cancelable?: boolean
    }

    export const show = async (
        {
            headline, content, okText, buttons, origin,
            abortSignal, excludeOk, cancelable, growWidth
        }: Default): Promise<void> => {
        const actualButtons: Array<Button> = isDefined(buttons) ? [...buttons] : []
        if (excludeOk !== true) {
            actualButtons.push({
                text: okText ?? "Ok",
                primary: true,
                onClick: handler => {
                    resolved = true
                    handler.close()
                    resolve()
                }
            })
        }
        let resolved = false
        const {resolve, reject, promise} = Promise.withResolvers<void>()
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline ?? "Dialog"}
                    icon={IconSymbol.System}
                    cancelable={cancelable !== false}
                    buttons={actualButtons}
                    growWidth={growWidth}>
                <div style={{padding: "1em 0", color: Colors.dark.toString()}}>{content}</div>
            </Dialog>
        )
        Surface.get(origin).body.appendChild(dialog)
        dialog.showModal()
        dialog.addEventListener("close", () => {if (!resolved) {reject(Errors.AbortError)}}, {once: true})
        abortSignal?.addEventListener("abort", () => {
            if (!resolved) {
                resolved = true
                dialog.close()
                reject(abortSignal?.reason ?? Errors.AbortError)
            }
        }, {once: true})
        return promise
    }

    // Never rejects
    export const info = async ({
                                   headline, message, okText, buttons,
                                   origin, abortSignal, cancelable
                               }: Info): Promise<void> =>
        show({
            headline, content: (<p style={{whiteSpace: "pre-line"}}>{message}</p>),
            okText, buttons, origin, abortSignal, cancelable
        }).catch(EmptyExec)

    export type ApproveCreation = {
        headline?: string
        approveText?: string
        cancelText?: string
        reverse?: boolean
        message: string
        origin?: Element
        maxWidth?: string
    }

    // Never rejects
    export const approve =
        ({
             headline, message, approveText, cancelText, reverse, origin, maxWidth
         }: ApproveCreation): Promise<boolean> => {
            reverse ??= false
            const {resolve, promise} = Promise.withResolvers<boolean>()
            const buttons: Array<Button> = [{
                text: approveText ?? "Yes",
                primary: reverse,
                onClick: handler => {
                    handler.close()
                    resolve(true)
                }
            }, {
                text: cancelText ?? "Cancel",
                primary: !reverse,
                onClick: handler => {
                    handler.close()
                    resolve(false)
                }
            }]
            if (reverse) {buttons.reverse()}
            const dialog: HTMLDialogElement = (
                <Dialog headline={headline ?? "Approve"}
                        icon={IconSymbol.System}
                        cancelable={true}
                        buttons={buttons}>
                    <div style={{padding: "1em 0", position: "relative", maxWidth}}>
                        <p style={{
                            whiteSpace: "pre-line",
                            width: "100%",
                            overflow: "hidden",
                            textOverflow: "ellipsis"
                        }}>{message}</p>
                    </div>
                </Dialog>
            )
            Surface.get(origin).body.appendChild(dialog)
            dialog.showModal()
            return promise
        }

    export const progress = ({
                                 headline, message, progress, cancel, origin
                             }: RuntimeNotification.ProgressRequest): RuntimeNotification.ProgressUpdater => {
        const lifecycle = new Terminator()
        const buttons: ReadonlyArray<Button> = isDefined(cancel)
            ? [{
                text: "Cancel",
                primary: true,
                onClick: handler => {
                    cancel()
                    handler.close()
                }
            }] : Arrays.empty()
        const messageElement: HTMLParagraphElement = (<p style={{
            margin: "1em 0 0.5em 0",
            width: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
        }}>{message}</p>)
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline}
                    icon={IconSymbol.System}
                    cancelable={isDefined(cancel)}
                    buttons={buttons}>
                {messageElement}
                {progress && (
                    <ProgressBar lifecycle={lifecycle} progress={progress}/>
                )}
            </Dialog>
        )
        Surface.get(origin).flyout.appendChild(dialog)
        dialog.addEventListener("close", () => lifecycle.terminate(), {once: true})
        dialog.showModal()
        lifecycle.own(Terminable.create(() => dialog.close()))
        return new class implements RuntimeNotification.ProgressUpdater {
            set message(value: string) {messageElement.textContent = value}
            terminate(): void {lifecycle.terminate()}
        }
    }

    export const processMonolog = (headline: string,
                                   content?: HTMLElement,
                                   cancel?: Exec,
                                   origin?: Element): DialogHandler => {
        const lifecycle = new Terminator()
        const buttons: ReadonlyArray<Button> = isDefined(cancel)
            ? [{
                text: "Cancel",
                primary: true,
                onClick: handler => {
                    cancel()
                    handler.close()
                }
            }] : Arrays.empty()
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline}
                    icon={IconSymbol.System}
                    cancelable={true}
                    buttons={buttons}>
                {content}
            </Dialog>
        )
        Surface.get(origin).flyout.appendChild(dialog)
        dialog.addEventListener("close", () => lifecycle.terminate(), {once: true})
        dialog.showModal()
        return {close: () => {dialog.close()}}
    }

    export const debugBoxes = (boxGraph: BoxGraph, origin?: Element): void => {
        const dialog: HTMLDialogElement = (
            <Dialog headline="Debug Box"
                    icon={IconSymbol.System}
                    cancelable={true}
                    style={{minWidth: "24rem", minHeight: "24rem"}}
                    buttons={[{
                        text: "Ok",
                        primary: true,
                        onClick: handler => handler.close()
                    }]}>
                <div style={{padding: "1em 0"}}>
                    <BoxesDebugView boxGraph={boxGraph}/>
                </div>
            </Dialog>
        )
        Surface.get(origin).body.appendChild(dialog)
        dialog.showModal()
    }

    export const debugBox = (box: Box, origin?: Element): void => {
        const dialog: HTMLDialogElement = (
            <Dialog headline="Debug Box"
                    icon={IconSymbol.System}
                    cancelable={true}
                    style={{minWidth: "32rem", minHeight: "32rem"}}
                    buttons={[{
                        text: "Ok",
                        primary: true,
                        onClick: handler => handler.close()
                    }]}>
                <div style={{padding: "1em 0"}}>
                    <BoxDebugView box={box}/>
                </div>
            </Dialog>
        )
        Surface.get(origin).body.appendChild(dialog)
        dialog.showModal()
    }

    export const error = ({name, message, probablyHasExtension, foreignOrigin, backupCommand = Option.None}: {
        scope: string,
        name: string,
        message: string,
        probablyHasExtension: boolean,
        foreignOrigin: string | null,
        backupCommand: Option<Provider<Promise<void>>>
    }): void => {
        console.debug(`Recovery enabled: ${backupCommand}`)
        const foreignHostname = foreignOrigin !== null ? new URL(foreignOrigin).hostname : null
        const dialog: HTMLDialogElement = (
            <Dialog headline="You Found A Bug ❤️"
                    icon={IconSymbol.Bug}
                    buttons={backupCommand.nonEmpty() ? [{
                        text: "Recover",
                        onClick: () => {
                            const command = backupCommand.unwrap()
                            command().then(() => location.reload())
                        }
                    }, {
                        text: "Dismiss",
                        onClick: () => {
                            if (Browser.isLocalHost()) {
                                dialog.close()
                            } else {
                                location.reload()
                            }
                        }
                    }, {
                        text: "Report",
                        primary: true,
                        onClick: () => window.open("https://github.com/andremichelle/openDAW/issues/new", "github")
                    }] : Arrays.empty()}
                    cancelable={false}
                    error>
                <div style={{padding: "1em 0", maxWidth: "50vw"}}>
                    <h3>{name}</h3>
                    <p>{message}</p>
                    {foreignHostname !== null ? (
                        <p style={{color: Colors.red.toString()}}>
                            This error originated from external code ({foreignHostname}), not openDAW.
                            If you are using a proxy or have browser extensions installed, please disable them.
                        </p>
                    ) : probablyHasExtension && (
                        <p style={{color: Colors.red.toString()}}>
                            Something extra is running! A browser extension might be causing issues. Disable
                            extensions for this site.
                        </p>
                    )}
                    <p style={{
                        color: Colors.shadow.toString(),
                        fontWeight: "bolder"
                    }}>Please report (opens in new tab) and then recover. Thanks!</p>
                </div>
            </Dialog>
        )
        document.body.appendChild(dialog)
        dialog.showModal()
    }

    export const cache = (): void => {
        const dialog: HTMLDialogElement = (
            <Dialog headline="Psst, There Is A New Version"
                    icon={IconSymbol.Robot}
                    buttons={[{
                        text: "Reload",
                        onClick: () => location.reload()
                    }]}
                    cancelable={false}
                    error>
                <div style={{padding: "1em 0", maxWidth: "50vw"}}>
                    <p>Please reload. If this message reappears clear your browsers cache.</p>
                    {document.scripts.length > 1 &&
                        <p style={{color: Colors.red.toString(), fontWeight: "bolder"}}>Browser extensions detected!
                            Please disable
                            before reload!</p>}
                </div>
            </Dialog>
        )
        document.body.appendChild(dialog)
        dialog.showModal()
    }
}