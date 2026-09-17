import css from "./Icon.sass?inline"
import {Lifecycle, ObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Html} from "@opendaw/lib-dom"

const defaultClassName = Html.adoptStyleSheet(css, "Icon")

export const Icon = ({symbol, className, style, onInit}: {
    symbol: IconSymbol
    className?: string
    style?: Partial<CSSStyleDeclaration>
    onInit?: (element: SVGSVGElement) => void
}) => (
    <svg classList={Html.buildClassList(defaultClassName, className)} style={style} onInit={onInit}>
        <use href={`#${IconSymbol.toName(symbol)}`}/>
    </svg>
)

export const IconCartridge = ({lifecycle, symbol, className, style, onInit}: {
    lifecycle: Lifecycle,
    symbol: ObservableValue<IconSymbol>,
    className?: string,
    style?: Partial<CSSStyleDeclaration>
    onInit?: (element: SVGSVGElement) => void
}) => {
    const use: SVGUseElement = <use href=""/>
    const updater = () => use.href.baseVal = `#${IconSymbol.toName(symbol.getValue())}`
    updater()
    lifecycle.own(symbol.subscribe(updater))
    return (<svg classList={Html.buildClassList(defaultClassName, className)} style={style} onInit={onInit}>{use}</svg>)
}