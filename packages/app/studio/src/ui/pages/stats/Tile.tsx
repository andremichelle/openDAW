import css from "./Tile.sass?inline"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "Tile")

type TileProps = {
    label: string
    value: JsxValue
}

export const Tile = ({label, value}: TileProps) => (
    <div className={className}>
        <div className="tile-text">
            <div className="tile-label">{label}</div>
            <div className="tile-value">{value}</div>
        </div>
        <div className="tile-frame"/>
    </div>
)
