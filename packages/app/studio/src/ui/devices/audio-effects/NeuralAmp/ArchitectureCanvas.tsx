import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"
import {NamModel} from "@opendaw/nam-wasm"
import {isNull, Lifecycle} from "@moises-ai/lib-std"

type Construct = {
    lifecycle: Lifecycle
    model: NamModel
}

export const ArchitectureCanvas = ({lifecycle, model}: Construct) => {
    const layers = model.config.layers
    if (layers.length === 0) return <div className="empty">No layers</div>
    const canvas: HTMLCanvasElement = <canvas/>
    lifecycle.own(Html.watchResize(canvas, () => {
        if (!canvas.isConnected) return
        const width = canvas.clientWidth
        if (width === 0) return
        const dpr = window.devicePixelRatio
        const height = 72
        canvas.width = width * dpr
        canvas.height = height * dpr
        canvas.style.height = `${height}px`
        const ctx = canvas.getContext("2d")
        if (isNull(ctx)) return
        ctx.scale(dpr, dpr)
        const maxChannels = Math.max(...layers.map(layer => layer.channels))
        const layerCount = layers.length
        const layerWidth = 24
        const spacing = 6
        const maxHeight = 50
        const minHeight = 12
        const blue = Colors.blue.toString()
        const green = Colors.green.toString()
        const orange = Colors.orange.toString()
        const shadow = Colors.shadow.toString()
        ctx.clearRect(0, 0, width, height)
        ctx.font = "9px Rubik"
        ctx.textAlign = "center"
        ctx.textBaseline = "top"
        const ioWidth = 10
        const ioHeight = 20
        const centerY = height / 2
        ctx.fillStyle = blue
        ctx.beginPath()
        ctx.roundRect(0, centerY - ioHeight / 2, ioWidth, ioHeight, 2)
        ctx.fill()
        ctx.fillStyle = shadow
        ctx.fillText("In", ioWidth / 2, centerY + ioHeight / 2 + 2)
        for (let index = 0; index < layerCount; index++) {
            const layer = layers[index]
            const x = ioWidth + spacing + index * (layerWidth + spacing)
            const layerHeight = Math.max(minHeight, (layer.channels / maxChannels) * maxHeight)
            const y = centerY - layerHeight / 2
            const prevX = index === 0
                ? ioWidth
                : ioWidth + spacing + (index - 1) * (layerWidth + spacing) + layerWidth
            ctx.strokeStyle = shadow
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(prevX, centerY)
            ctx.lineTo(x, centerY)
            ctx.stroke()
            ctx.fillStyle = layer.gated ? orange : green
            ctx.beginPath()
            ctx.roundRect(x, y, layerWidth, layerHeight, 2)
            ctx.fill()
            ctx.fillStyle = shadow
            ctx.fillText(String(layer.channels), x + layerWidth / 2, y + layerHeight + 2)
        }
        const lastLayerX = ioWidth + spacing + (layerCount - 1) * (layerWidth + spacing) + layerWidth
        const outX = ioWidth + spacing + layerCount * (layerWidth + spacing)
        ctx.strokeStyle = shadow
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(lastLayerX, centerY)
        ctx.lineTo(outX, centerY)
        ctx.stroke()
        ctx.fillStyle = blue
        ctx.beginPath()
        ctx.roundRect(outX, centerY - ioHeight / 2, ioWidth, ioHeight, 2)
        ctx.fill()
        ctx.fillStyle = shadow
        ctx.fillText("Out", outX + ioWidth / 2, centerY + ioHeight / 2 + 2)
    }))
    return canvas
}
