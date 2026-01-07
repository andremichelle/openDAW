import css from "./OdiePage.sass?inline"
import { createElement } from "@opendaw/lib-jsx"
import { Html } from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "OdiePage")

interface OdiePageProps {
    path?: string
    children: any
}

export const OdiePage = (props: OdiePageProps) => {
    return (
        <div className={`${className}`}>
            <div className="content">
                {props.children}
            </div>
        </div>
    )
}
