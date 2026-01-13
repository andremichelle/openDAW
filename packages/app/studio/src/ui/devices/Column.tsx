import css from "./Column.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement, JsxValue} from "@moises-ai/lib-jsx"
import {Color} from "@moises-ai/lib-std"

const className = Html.adoptStyleSheet(css, "Column")

type Construct = {
    ems: ReadonlyArray<number>
    space?: number,
    color?: Color
    style?: Partial<CSSStyleDeclaration>
}

export const Column = ({ems, space, color, style}: Construct, children: JsxValue) => (
    <div className={className}
         style={{
             display: "grid",
             gridTemplateRows: ems.map(em => em === 0 ? "auto" : `${em}em`).join(" "),
             rowGap: `${space ?? 0}em`,
             height: "100%",
             margin: "0 1px",
             alignContent: "center",
             justifyItems: "center",
             color: color?.toString() ?? "inherit",
             ...style
         }}>
        {children}
    </div>
)