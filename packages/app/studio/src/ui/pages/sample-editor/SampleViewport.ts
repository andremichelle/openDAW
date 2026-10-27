import {clamp, int, Notifier, Observer, Subscription} from "@opendaw/lib-std"

const MinFramesPerPixel = 1.0 / 32.0

export class SampleViewport {
    readonly #notifier: Notifier<SampleViewport>

    #numberOfFrames: int
    #width: number
    #start: number
    #framesPerPixel: number

    constructor() {
        this.#notifier = new Notifier<SampleViewport>()
        this.#numberOfFrames = 0
        this.#width = 1
        this.#start = 0.0
        this.#framesPerPixel = 1.0
    }

    get start(): number {return this.#start}
    get end(): number {return this.#start + this.#width * this.#framesPerPixel}
    get framesPerPixel(): number {return this.#framesPerPixel}
    get width(): number {return this.#width}
    get numberOfFrames(): int {return this.#numberOfFrames}

    subscribe(observer: Observer<SampleViewport>): Subscription {return this.#notifier.subscribe(observer)}

    frameAt(x: number): number {return this.#start + x * this.#framesPerPixel}
    xOf(frame: number): number {return (frame - this.#start) / this.#framesPerPixel}

    resize(width: number): void {
        const fitted = this.#isFitted()
        this.#width = Math.max(1, width)
        if (fitted) {this.fit()} else {this.#update(this.#start, this.#framesPerPixel)}
    }

    setLength(numberOfFrames: int): void {
        const fitted = this.#isFitted()
        this.#numberOfFrames = numberOfFrames
        if (fitted) {this.fit()} else {this.#update(this.#start, this.#framesPerPixel)}
    }

    fit(): void {this.#update(0.0, this.#maxFramesPerPixel())}

    zoom(factor: number, anchorX: number = this.#width * 0.5): void {
        const anchor = this.frameAt(anchorX)
        const framesPerPixel = clamp(this.#framesPerPixel * factor, MinFramesPerPixel, this.#maxFramesPerPixel())
        this.#update(anchor - anchorX * framesPerPixel, framesPerPixel)
    }

    zoomTo(from: number, to: number): void {
        if (to <= from) {return}
        this.#update(from, clamp((to - from) / this.#width, MinFramesPerPixel, this.#maxFramesPerPixel()))
    }

    scrollBy(pixels: number): void {this.#update(this.#start + pixels * this.#framesPerPixel, this.#framesPerPixel)}

    scrollTo(frame: number): void {this.#update(frame, this.#framesPerPixel)}

    #maxFramesPerPixel(): number {return Math.max(MinFramesPerPixel, this.#numberOfFrames / this.#width)}

    #isFitted(): boolean {return this.#start === 0.0 && this.#framesPerPixel >= this.#maxFramesPerPixel()}

    #update(start: number, framesPerPixel: number): void {
        this.#framesPerPixel = framesPerPixel
        this.#start = clamp(start, 0.0, Math.max(0.0, this.#numberOfFrames - this.#width * framesPerPixel))
        this.#notifier.notify(this)
    }
}
