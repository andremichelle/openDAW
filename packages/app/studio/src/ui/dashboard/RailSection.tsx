import css from "./RailSection.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {SectionLabel} from "@/ui/dashboard/SectionLabel"

const className = Html.adoptStyleSheet(css, "RailSection")

type Construct = {
    title: JsxValue
    vertical?: boolean
}

// A compact labeled block in the rail. Keeps the rail visually consistent and dense (one-pager, no scroll).
// `vertical` stacks the body items in a column (links) instead of a wrapping row (chips).
export const RailSection = ({title, vertical}: Construct, children: JsxValue) => (
    <div className={className}>
        <SectionLabel title={title}/>
        <div className={Html.buildClassList("body", vertical === true && "vertical")}>{children}</div>
    </div>
)
