import {int} from "@moises-ai/lib-std"

const ellipsis = "…"

export namespace Context2d {
    export const truncateText = (context: CanvasRenderingContext2D, text: string, maxWidth: number): {
        text: string,
        width: number
    } => {
        if (text.length === 0) {return {text: "", width: 0}}
        let width: number = context.measureText(text).width
        if (width <= maxWidth) {return {text, width}}
        const ellipseWidth = context.measureText(ellipsis).width
        let l: int = 0 | 0
        let r: int = text.length | 0
        while (l < r) {
            const mid: number = (r + l) >>> 1
            width = context.measureText(text.substring(0, mid + 1)).width + ellipseWidth
            if (width <= maxWidth) {
                l = mid + 1
            } else {
                r = mid
            }
        }
        if (l === 0) {return {text: "", width: 0}}
        const result = text.substring(0, l)
        return {text: result + ellipsis, width: context.measureText(result).width + ellipseWidth}
    }

    export const strokeRoundedRect = (context: CanvasRenderingContext2D,
                                      x: number, y: number, width: number, height: number, radius: number): void => {
        context.beginPath()
        context.moveTo(x + radius, y)
        context.lineTo(x + width - radius, y)
        context.arcTo(x + width, y, x + width, y + radius, radius)
        context.lineTo(x + width, y + height - radius)
        context.arcTo(x + width, y + height, x + width - radius, y + height, radius)
        context.lineTo(x + radius, y + height)
        context.arcTo(x, y + height, x, y + height - radius, radius)
        context.lineTo(x, y + radius)
        context.arcTo(x, y, x + radius, y, radius)
        context.closePath()
        context.stroke()
    }
}