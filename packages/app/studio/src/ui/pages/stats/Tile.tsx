import css from "./Tile.sass?inline"
import {createElement, JsxValue} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "Tile")

type TileProps = {
    label: string
    value: JsxValue
    icon: JsxValue
}

export const Tile = ({label, value, icon}: TileProps) => (
    <div className={className}>
        <div className="tile-text">
            <div className="tile-label">{label}</div>
            <div className="tile-value">{value}</div>
        </div>
        <div className="tile-icon">
            <span className="tile-icon-glyph">{icon}</span>
        </div>
    </div>
)
