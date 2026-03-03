import {Terminable} from "@opendaw/lib-std"
import {Scale} from "../../../../../../../studio/core/src/ui/canvas/scale.ts"
import {createElement} from "@opendaw/lib-jsx"
import {horizontalUnits, verticalUnits} from "./constants.ts"
import {Html} from "@opendaw/lib-dom"

export const createDisplay = (xAxis: Scale, yAxis: Scale, svg: SVGSVGElement): Terminable => {
    return Html.watchResize(svg, () => {
        if (!svg.isConnected) {return}
        const paddingInPixels = parseFloat(getComputedStyle(svg).fontSize)
        const width = svg.clientWidth - paddingInPixels * 2
        const height = svg.clientHeight - paddingInPixels * 2
        Html.empty(svg)
        svg.appendChild(
            <g transform={`translate(${paddingInPixels}, ${paddingInPixels})`}
               stroke="none"
               fill="rgba(255, 255, 255, 0.125)"
               font-size="7px">
                {verticalUnits.map((hz, index, labels) =>
                    <text text-anchor={index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}
                          alignment-baseline="baseline"
                          x={`${(Math.floor(xAxis.unitToNorm(hz) * width))}`}
                          y={`${-4.5}`}>{hz >= 1000 ? `${Math.floor(hz / 1000)}k` : hz}</text>
                )}
                {horizontalUnits.map(db =>
                    <text text-anchor="end"
                          alignment-baseline="middle"
                          x="-3"
                          y={`${(Math.floor((1.0 - yAxis.unitToNorm(db)) * height))}`}>{db}</text>
                )}
            </g>
        )
    })
}