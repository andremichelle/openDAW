import css from "./FooterItem.sass?inline"
import {createElement, JsxValue} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "footer-item")

export type FooterItemElements = { component: HTMLElement, title: HTMLElement, value: HTMLElement }

type Construct = {
    title: string
    minWidth?: string
    className?: string
    onInit?: (elements: FooterItemElements) => void
}

export const FooterItem = ({title, minWidth, className: extraClassName, onInit}: Construct,
                           children: ReadonlyArray<JsxValue>) => {
    const titleElem: HTMLElement = (
        <span className="label">{title}</span>
    )
    const valueElem: HTMLElement = (
        <span className="value" style={{minWidth}}>{children}</span>
    )
    const component: HTMLElement = (
        <div className={Html.buildClassList(className, extraClassName)}>
            {titleElem}{valueElem}
        </div>
    )
    onInit?.({component, title: titleElem, value: valueElem})
    return component
}
