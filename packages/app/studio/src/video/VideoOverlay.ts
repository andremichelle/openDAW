import {Terminable} from "@opendaw/lib-std"
import {PPQN, ppqn} from "@opendaw/lib-dsp"

export interface VideoOverlayConfig {
    readonly width: number
    readonly height: number
    readonly projectName: string
}

export class VideoOverlay implements Terminable {
    static async create(config: VideoOverlayConfig): Promise<VideoOverlay> {
        const canvas = new OffscreenCanvas(config.width, config.height)
        const ctx = canvas.getContext("2d")!
        const logo = await VideoOverlay.#loadImage("/cover.png")
        return new VideoOverlay(config, canvas, ctx, logo)
    }

    static async #loadImage(src: string): Promise<ImageBitmap> {
        const response = await fetch(src)
        const blob = await response.blob()
        return createImageBitmap(blob)
    }

    readonly #config: VideoOverlayConfig
    readonly #canvas: OffscreenCanvas
    readonly #ctx: OffscreenCanvasRenderingContext2D
    readonly #logo: ImageBitmap
    readonly #logoSize: number

    private constructor(config: VideoOverlayConfig,
                        canvas: OffscreenCanvas,
                        ctx: OffscreenCanvasRenderingContext2D,
                        logo: ImageBitmap) {
        this.#config = config
        this.#canvas = canvas
        this.#ctx = ctx
        this.#logo = logo
        this.#logoSize = Math.round(config.height * 0.25)
    }

    get canvas(): OffscreenCanvas {return this.#canvas}

    render(position: ppqn): void {
        const {width, height} = this.#config
        const context = this.#ctx
        context.globalAlpha = 0.4
        const fontSize = Math.round(height * 0.033)
        context.clearRect(0, 0, width, height)
        context.save()
        context.translate(0, -height * 0.07)
        this.#renderProjectName(fontSize)
        this.#renderLogo()
        context.restore()
        this.#renderPosition(position, fontSize)
    }

    #renderProjectName(fontSize: number): void {
        const ctx = this.#ctx
        const {width, height, projectName} = this.#config
        ctx.font = `${fontSize}px Rubik`
        ctx.textBaseline = "bottom"
        ctx.textAlign = "left"
        ctx.shadowColor = "rgba(255, 255, 255, 0.9)"
        ctx.shadowBlur = 12
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)"
        ctx.fillText(projectName, width * 0.02, height * 0.144)
        ctx.shadowBlur = 0
    }

    #renderLogo(): void {
        const ctx = this.#ctx
        const size = this.#logoSize
        const x = this.#config.width - size
        const y = 0
        ctx.shadowColor = "rgba(255, 255, 255, 0.8)"
        ctx.shadowBlur = 15
        ctx.drawImage(this.#logo, x, y, size, size)
        ctx.shadowBlur = 0
    }

    #renderPosition(position: ppqn, fontSize: number): void {
        const ctx = this.#ctx
        const {width, height} = this.#config
        const {bars, beats, semiquavers, ticks} = PPQN.toParts(Math.abs(position) | 0)
        const positionFontSize = Math.round(fontSize * 0.7)
        const charWidth = positionFontSize * 0.65
        const separatorWidth = positionFontSize * 0.4
        const margin = height * 0.01
        const chars = [
            ...String(bars + 1).padStart(3, "0").split(""),
            ".",
            ...String(beats + 1).padStart(1, "0").split(""),
            ".",
            ...String(semiquavers + 1).padStart(1, "0").split(""),
            ":",
            ...String(ticks).padStart(3, "0").split("")
        ]
        const totalWidth = chars.reduce((sum, char) =>
            sum + (char === "." || char === ":" ? separatorWidth : charWidth), 0)
        let x = (width - totalWidth) / 2
        const y = height - margin
        ctx.font = `300 ${positionFontSize}px Rubik`
        ctx.textBaseline = "bottom"
        ctx.textAlign = "center"
        ctx.shadowColor = "rgba(255, 255, 255, 1)"
        ctx.shadowBlur = 12
        ctx.fillStyle = "rgba(255, 255, 255, 0.95)"
        for (const char of chars) {
            const w = char === "." || char === ":" ? separatorWidth : charWidth
            ctx.fillText(char, x + w / 2, y)
            x += w
        }
        ctx.shadowBlur = 0
    }

    terminate(): void {this.#logo.close()}
}
