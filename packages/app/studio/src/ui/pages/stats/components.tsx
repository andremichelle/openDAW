import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {isDefined} from "@opendaw/lib-std"

type CardProps = {
    title?: string
    accent?: JsxValue
    className?: string
}

export const Card = ({title, accent, className}: CardProps, children: ReadonlyArray<JsxValue>) => (
    <div className={`card${isDefined(className) ? ` ${className}` : ""}`}>
        {(isDefined(title) || isDefined(accent)) && (
            <div className="card-head">
                {isDefined(title) && <h2>{title}</h2>}
                {isDefined(accent) && <div className="card-accent">{accent}</div>}
            </div>
        )}
        <div className="card-body">{children}</div>
    </div>
)
