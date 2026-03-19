import css from "./Dialog.sass?inline"
import {Exec, Procedure, safeExecute, Terminator} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Button} from "@/ui/components/Button.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Events, Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "Dialog")

export interface DialogHandler {
    close(): void
}

export type Button = {
    text: string
    onClick: Procedure<DialogHandler>
    primary?: boolean
}

type Construct = {
    headline: string
    icon: IconSymbol
    onCancel?: Exec
    cancelable?: boolean
    buttons?: ReadonlyArray<Button>
    style?: Partial<CSSStyleDeclaration>
    growWidth?: boolean
    error?: boolean
}

export const Dialog = (
    {headline, icon, onCancel, buttons, cancelable, style, growWidth, error}: Construct, children: JsxValue) => {
    const lifecycle = new Terminator()
    const dialog: HTMLDialogElement = (
        <dialog className={Html.buildClassList(className, error && "error", growWidth && "grow-width")} style={style}>
            <h1><Icon symbol={icon}/> <span>{headline}</span></h1>
            {children}
            <footer>
                {buttons?.map(({onClick, primary, text}) => (
                    <Button lifecycle={lifecycle}
                            onClick={() => onClick({close: () => dialog.close()})}
                            appearance={primary === true ? {
                                framed: true,
                                color: Colors.blue
                            } : {
                                color: Colors.gray
                            }}><span>{text}</span></Button>
                ))}
            </footer>
        </dialog>
    )
    if (cancelable === false) {
        dialog.oncancel = (event) => event.preventDefault()
    }
    dialog.onkeydown = (event) => {
        if (!(cancelable !== false && event.key === "Escape") && !Events.isTextInput(event.target)) {
            if (event.code !== "F12") {
                event.preventDefault()
            }
            event.stopPropagation()
        }
    }
    dialog.onclose = () => {
        lifecycle.terminate()
        if (dialog.returnValue === "") {
            safeExecute(onCancel)
        }
        dialog.remove()
    }
    return dialog
}