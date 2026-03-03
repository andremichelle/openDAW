import {asDefined, Exec, Procedure, Terminable, Terminator} from "@opendaw/lib-std"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Scale} from "./scale"

export class CanvasPainter implements Terminable {
    readonly #rendering: CanvasRenderer

    constructor(canvas: HTMLCanvasElement, render: Procedure<CanvasPainter>) {
        this.#rendering = new CanvasRenderer(canvas, () => render(this))
    }

    readonly requestUpdate = (): void => {this.#rendering.requestUpdate()}

    get isResized(): boolean {return this.#rendering.isResized}
    get devicePixelRatio(): number {return this.#rendering.devicePixelRatio}
    get width(): number {return this.#rendering.width}
    get height(): number {return this.#rendering.height}
    get actualWidth(): number {return this.#rendering.actualWidth}
    get actualHeight(): number {return this.#rendering.actualHeight}
    get context(): CanvasRenderingContext2D {return this.#rendering.context}
    terminate(): void {this.#rendering.terminate()}
}

export class CanvasUnitPainter implements Terminable {
    readonly #rendering: CanvasRenderer

    readonly #xAxis: Scale
    readonly #yAxis: Scale

    constructor(canvas: HTMLCanvasElement,
                xAxis: Scale,
                yAxis: Scale,
                render: Procedure<CanvasUnitPainter>) {
        this.#rendering = new CanvasRenderer(canvas, () => render(this))
        this.#xAxis = xAxis
        this.#yAxis = yAxis
    }

    readonly requestUpdate = (): void => {this.#rendering.requestUpdate()}

    xToUnit(x: number): number {return this.#xAxis.normToUnit(x / this.#rendering.actualWidth)}
    unitToX(value: number): number {return this.#xAxis.unitToNorm(value) * this.#rendering.actualWidth}
    yToUnit(y: number): number {return this.#yAxis.normToUnit(1.0 - y / this.#rendering.actualHeight)}
    unitToY(value: number): number {return (1.0 - this.#yAxis.unitToNorm(value)) * this.#rendering.actualHeight}
    get context(): CanvasRenderingContext2D {return this.#rendering.context}
    get isResized(): boolean {return this.#rendering.isResized}
    get width(): number {return this.#rendering.width}
    get height(): number {return this.#rendering.height}
    get actualWidth(): number {return this.#rendering.actualWidth}
    get actualHeight(): number {return this.#rendering.actualHeight}
    terminate(): void {this.#rendering.terminate()}
}

class CanvasRenderer implements Terminable {
    readonly #lifecycle = new Terminator()

    readonly #context: CanvasRenderingContext2D
    readonly #update: Exec

    #width: number = 0
    #height: number = 0
    #devicePixelRatio: number = 1
    #isResized: boolean = true
    #needsUpdate: boolean = true

    constructor(canvas: HTMLCanvasElement, update: Exec) {
        this.#context = asDefined(canvas.getContext("2d"))
        this.#update = update

        this.#lifecycle.ownAll(
            Html.watchResize(canvas, () => {
                this.#isResized = true
                this.#needsUpdate = true
            }),
            this.#lifecycle.own(AnimationFrame.add(() => {
                const width = canvas.clientWidth
                const height = canvas.clientHeight
                if (!this.#needsUpdate || width === 0 || height === 0) {return}
                this.#isResized = width !== this.#width || height !== this.#height || devicePixelRatio !== this.#devicePixelRatio
                this.#width = width
                this.#height = height
                this.#devicePixelRatio = devicePixelRatio
                canvas.width = width * devicePixelRatio
                canvas.height = height * devicePixelRatio
                this.#update()
                this.#isResized = false
                this.#needsUpdate = false
            }))
        )
    }

    get isResized(): boolean {return this.#isResized}
    get devicePixelRatio(): number {return this.#devicePixelRatio}
    get width(): number {return this.#width}
    get height(): number {return this.#height}
    get actualWidth(): number {return this.#width * this.#devicePixelRatio}
    get actualHeight(): number {return this.#height * this.#devicePixelRatio}
    get context(): CanvasRenderingContext2D {return this.#context}
    requestUpdate(): void {this.#needsUpdate = true}
    terminate(): void {this.#lifecycle.terminate()}
}