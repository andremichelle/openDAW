import css from "./EditorHeader.sass?inline"
import {Exec, Lifecycle} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "EditorHeader")

type Construct = {
    lifecycle: Lifecycle
    onClose: Exec
    closeTooltip: string
}

export const EditorHeader = ({lifecycle, onClose, closeTooltip}: Construct, children: JsxValue) => (
    <header className={className}>
        <Button lifecycle={lifecycle}
                onClick={onClose}
                appearance={{tooltip: closeTooltip, color: Colors.red, framed: true, cursor: "pointer"}}>
            <Icon symbol={IconSymbol.Close}/>
        </Button>
        {children}
    </header>
)
