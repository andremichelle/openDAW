import {Color, Notifier, Nullable, Observer, Subscription, Terminable} from "@opendaw/lib-std"
import {CanvasUnitPainter} from "../../../../../../../studio/core/src/ui/canvas/painter.ts"
import {
    AutomatableParameterFieldAdapter,
    BellParameters,
    Parameters,
    PassParameters,
    ShelfParameters
} from "@opendaw/studio-adapters"
import {biquad} from "@/ui/devices/audio-effects/Revamp/constants.ts"
import {gainToDb} from "@opendaw/lib-dsp"

export type ColorSet = {
    full: Color
    line: Color
    min: Color
    max: Color
}

export abstract class CurveRenderer<PARAMETERS extends Parameters = Parameters> implements Terminable {
    readonly #subscriptions: Subscription
    readonly #notifier: Notifier<void>

    #needsUpdate = true
    #gradient: Nullable<CanvasGradient> = null

    protected curve: Nullable<Curve> = null

    protected constructor(readonly parameters: PARAMETERS,
                          readonly colorSet: ColorSet,
                          readonly sampleRate: number) {
        this.#notifier = new Notifier<void>()
        this.#subscriptions = this.listenParameters(() => {
            this.#needsUpdate = true
            this.#notifier.notify()
        })
    }

    onResize(): void {
        this.curve = null
        this.#gradient = null
        this.#needsUpdate = true
    }

    subscribe(observer: Observer<void>): Subscription {return this.#notifier.subscribe(observer)}

    update(painter: CanvasUnitPainter,
           frequencies: Float32Array,
           phaseResponse: Float32Array,
           totalResponse: Float32Array): void {
        if (this.parameters.enabled.getValue()) {
            const curve = this.curve === null || this.#needsUpdate
                ? this.getOrCreateCurve(painter, frequencies, phaseResponse)
                : this.curve
            this.#needsUpdate = false

            // include curve in total response
            curve.magResponse.forEach((value, index) => { totalResponse[index] += value })

            // select brushes
            const {line, max, min} = this.colorSet
            const context = painter.context
            context.strokeStyle = line.toString()

            if (this.#gradient === null) {
                const gradient: CanvasGradient = context.createLinearGradient(0, 0, 0, painter.actualHeight)
                gradient.addColorStop(0.0, max.toString())
                gradient.addColorStop(0.5, min.toString())
                gradient.addColorStop(1.0, max.toString())
                this.#gradient = gradient
            }

            context.fillStyle = this.#gradient

            // paint curve
            const {strokePath, fillPath} = curve
            context.stroke(strokePath)
            context.fill(fillPath)

            this.curve = curve
        } else {
            this.curve = null
        }
    }

    terminate(): void {
        this.#notifier.terminate()
        this.#subscriptions.terminate()
    }

    protected abstract listenParameters(observer: Observer<AutomatableParameterFieldAdapter>): Subscription

    protected abstract getOrCreateCurve(painter: CanvasUnitPainter,
                                        frequencies: Float32Array,
                                        phaseResponse: Float32Array): Curve

    protected getOrCreateResponseArray(frequencies: Float32Array): Float32Array {
        return this.curve === null || this.curve.magResponse.length !== frequencies.length
            ? new Float32Array(frequencies.length)
            : this.curve.magResponse
    }

    protected createPath(painter: CanvasUnitPainter, response: Float32Array): [Path2D, Path2D] {
        const strokePath = new Path2D()
        for (let x = 0; x < response.length; x++) {
            const y = painter.unitToY(response[x])
            if (x === 0) {strokePath.moveTo(x, y)} else {strokePath.lineTo(x, y)}
        }
        const fillPath = new Path2D()
        fillPath.addPath(strokePath)
        return [strokePath, fillPath]
    }
}

export class LowPass extends CurveRenderer<PassParameters> {
    constructor(parameters: PassParameters, colorSet: ColorSet, sampleRate: number) {
        super(parameters, colorSet, sampleRate)
    }

    protected getOrCreateCurve(painter: CanvasUnitPainter,
                               frequencies: Float32Array,
                               phaseResponse: Float32Array): Curve {
        const magResponse = this.getOrCreateResponseArray(frequencies)
        const {order, frequency, q} = this.parameters
        biquad.setLowpassParams(frequency.getControlledValue() / this.sampleRate, q.getControlledValue())
        biquad.getFrequencyResponse(frequencies, magResponse, phaseResponse)
        const orderExp = order.getControlledValue() + 1
        magResponse.forEach((value, index, array) => { array[index] = gainToDb(value) * orderExp })
        const [strokePath, fillPath] = this.createPath(painter, magResponse)
        fillPath.lineTo(painter.actualWidth, painter.unitToY(0.0))
        fillPath.lineTo(0, painter.unitToY(0.0))
        fillPath.closePath()
        return new Curve(magResponse, strokePath, fillPath)
    }

    protected listenParameters(observer: Observer<AutomatableParameterFieldAdapter>): Subscription {
        const {enabled, frequency, order, q} = this.parameters
        return Notifier.subscribeMany(observer, enabled, frequency, order, q)
    }
}

export class HighPass extends CurveRenderer<PassParameters> {
    constructor(parameters: PassParameters, colorSet: ColorSet, sampleRate: number) {
        super(parameters, colorSet, sampleRate)
    }

    getOrCreateCurve(painter: CanvasUnitPainter,
                     frequencies: Float32Array,
                     phaseResponse: Float32Array): Curve {
        const magResponse = this.getOrCreateResponseArray(frequencies)
        const {order, frequency, q} = this.parameters
        biquad.setHighpassParams(frequency.getControlledValue() / this.sampleRate, q.getControlledValue())
        biquad.getFrequencyResponse(frequencies, magResponse, phaseResponse)
        const orderExp = order.getControlledValue() + 1
        magResponse.forEach((value, index, array) => { array[index] = gainToDb(value) * orderExp })
        const [strokePath, fillPath] = this.createPath(painter, magResponse)
        fillPath.lineTo(painter.actualWidth, painter.unitToY(0.0))
        fillPath.lineTo(0, painter.unitToY(0.0))
        fillPath.closePath()
        return new Curve(magResponse, strokePath, fillPath)
    }

    protected listenParameters(observer: Observer<AutomatableParameterFieldAdapter>): Subscription {
        const {enabled, frequency, order, q} = this.parameters
        return Notifier.subscribeMany(observer, enabled, frequency, order, q)
    }
}

export class LowShelf extends CurveRenderer<ShelfParameters> {
    constructor(parameters: ShelfParameters, colorSet: ColorSet, sampleRate: number) {
        super(parameters, colorSet, sampleRate)
    }

    getOrCreateCurve(painter: CanvasUnitPainter,
                     frequencies: Float32Array,
                     phaseResponse: Float32Array): Curve {
        const magResponse = this.getOrCreateResponseArray(frequencies)
        const {frequency, gain} = this.parameters
        biquad.setLowShelfParams(frequency.getControlledValue() / this.sampleRate, gain.getControlledValue())
        biquad.getFrequencyResponse(frequencies, magResponse, phaseResponse)
        magResponse.forEach((value, index, array) => { array[index] = gainToDb(value) })
        const [strokePath, fillPath] = this.createPath(painter, magResponse)
        fillPath.lineTo(0, painter.unitToY(0.0))
        fillPath.closePath()
        return new Curve(magResponse, strokePath, fillPath)
    }

    protected listenParameters(observer: Observer<AutomatableParameterFieldAdapter>): Subscription {
        const {enabled, frequency, gain} = this.parameters
        return Notifier.subscribeMany(observer, enabled, frequency, gain)
    }
}

export class HighShelf extends CurveRenderer<ShelfParameters> {
    constructor(parameters: ShelfParameters, colorSet: ColorSet, sampleRate: number) {
        super(parameters, colorSet, sampleRate)
    }

    getOrCreateCurve(painter: CanvasUnitPainter,
                     frequencies: Float32Array,
                     phaseResponse: Float32Array): Curve {
        const magResponse = this.getOrCreateResponseArray(frequencies)
        const {frequency, gain} = this.parameters
        biquad.setHighShelfParams(frequency.getControlledValue() / this.sampleRate, gain.getControlledValue())
        biquad.getFrequencyResponse(frequencies, magResponse, phaseResponse)
        magResponse.forEach((value, index, array) => { array[index] = gainToDb(value) })
        const [strokePath, fillPath] = this.createPath(painter, magResponse)
        fillPath.lineTo(painter.actualWidth, painter.unitToY(0.0))
        fillPath.closePath()
        return new Curve(magResponse, strokePath, fillPath)
    }

    protected listenParameters(observer: Observer<AutomatableParameterFieldAdapter>): Subscription {
        const {enabled, frequency, gain} = this.parameters
        return Notifier.subscribeMany(observer, enabled, frequency, gain)
    }
}

export class Bell extends CurveRenderer<BellParameters> {
    constructor(parameters: BellParameters, colorSet: ColorSet, sampleRate: number) {
        super(parameters, colorSet, sampleRate)
    }

    getOrCreateCurve(painter: CanvasUnitPainter,
                     frequencies: Float32Array,
                     phaseResponse: Float32Array): Curve {
        const magResponse = this.getOrCreateResponseArray(frequencies)
        const {frequency, q, gain} = this.parameters
        biquad.setPeakingParams(frequency.getControlledValue() / this.sampleRate, q.getControlledValue(), gain.getControlledValue())
        biquad.getFrequencyResponse(frequencies, magResponse, phaseResponse)
        magResponse.forEach((value, index, array) => { array[index] = gainToDb(value) })
        const [strokePath, fillPath] = this.createPath(painter, magResponse)
        fillPath.lineTo(painter.actualWidth, painter.unitToY(0))
        fillPath.lineTo(0, painter.unitToY(0))
        fillPath.lineTo(0, painter.unitToY(magResponse[0]))
        fillPath.closePath()
        return new Curve(magResponse, strokePath, fillPath)
    }

    protected listenParameters(observer: Observer<AutomatableParameterFieldAdapter>): Subscription {
        const {enabled, frequency, q, gain} = this.parameters
        return Notifier.subscribeMany(observer, enabled, frequency, q, gain)
    }
}

class Curve {
    constructor(readonly magResponse: Float32Array,
                readonly strokePath: Path2D,
                readonly fillPath: Path2D) {}
}