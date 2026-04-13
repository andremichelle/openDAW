import css from "./ChatOverlayBackground.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "ChatOverlayBackground")

const TabWidth = 30
const WindowWidth = 320
const CornerRadius = 8
const FilletRadius = 4
const BumpCornerRadius = 10
const BumpHalfHeight = 16
const Padding = 8
const InnerRadius = 4

const buildOuterPath = (height: number): string => {
    const midY = height / 2
    const right = TabWidth + WindowWidth
    const cr = CornerRadius
    const fr = FilletRadius
    const br = BumpCornerRadius
    const bumpTop = midY - BumpHalfHeight
    const bumpBot = midY + BumpHalfHeight
    return [
        `M ${TabWidth + cr} 0`,
        `H ${right}`,
        `V ${height}`,
        `H ${TabWidth + cr}`,
        `A ${cr} ${cr} 0 0 1 ${TabWidth} ${height - cr}`,
        `V ${bumpBot + fr}`,
        `A ${fr} ${fr} 0 0 0 ${TabWidth - fr} ${bumpBot}`,
        `H ${br}`,
        `A ${br} ${br} 0 0 1 0 ${bumpBot - br}`,
        `V ${bumpTop + br}`,
        `A ${br} ${br} 0 0 1 ${br} ${bumpTop}`,
        `H ${TabWidth - fr}`,
        `A ${fr} ${fr} 0 0 0 ${TabWidth} ${bumpTop - fr}`,
        `V ${cr}`,
        `A ${cr} ${cr} 0 0 1 ${TabWidth + cr} 0`,
        `Z`
    ].join(" ")
}

const buildInnerPath = (height: number): string => {
    const left = TabWidth + Padding
    const top = Padding
    const right = TabWidth + WindowWidth
    const bottom = height - Padding
    const r = InnerRadius
    return [
        `M ${left + r} ${top}`,
        `H ${right}`,
        `V ${bottom}`,
        `H ${left + r}`,
        `A ${r} ${r} 0 0 1 ${left} ${bottom - r}`,
        `V ${top + r}`,
        `A ${r} ${r} 0 0 1 ${left + r} ${top}`,
        `Z`
    ].join(" ")
}

export {TabWidth, WindowWidth, Padding}

type Construct = { lifecycle: Lifecycle, element: HTMLElement }

export const ChatOverlayBackground = ({lifecycle, element}: Construct) => {
    let svgElement: SVGSVGElement
    let outerPath: SVGPathElement
    let innerPath: SVGPathElement
    const svg = (
        <svg classList={className} onInit={(svg: SVGSVGElement) => { svgElement = svg }}>
            <path classList="outer" onInit={(path: SVGPathElement) => { outerPath = path }}/>
            <path classList="inner" onInit={(path: SVGPathElement) => { innerPath = path }}/>
        </svg>
    )
    lifecycle.own(Html.watchResize(element, entry => {
        const {height} = entry.contentRect
        svgElement.setAttribute("viewBox", `0 0 ${TabWidth + WindowWidth} ${height}`)
        outerPath.setAttribute("d", buildOuterPath(height))
        innerPath.setAttribute("d", buildInnerPath(height))
    }))
    return svg
}