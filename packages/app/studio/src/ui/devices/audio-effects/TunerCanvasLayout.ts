import {clamp} from "@opendaw/lib-std"

export const TunerLayout = Object.freeze({
    minWidth: 480, height: 210, meterInset: 12,
    historyTop: 4, historyBottom: 184, historyCenter: 94, historyHeight: 180,
    keyWidth: 44, keyGap: 6,
    meterY: 86, tickTop: 81, tickBottom: 91, zeroTop: 72, zeroBottom: 106, zeroWidth: 3,
    scaleLabelY: 133, labelPixels: 9, keyPixels: 8, readoutPixels: 9, minRowPixels: 14, rowTrimPixels: 2,
    triangleTip: 79, triangleTop: 59, triangleHalfWidth: 11,
    strobeTop: 53, strobeBottom: 66, strobeCount: 20, strobeWidth: 4,
    readoutY: 207, traceWidth: 2, edgeFade: 14,
    centsLimit: 50, tickStep: 10
})

export namespace TunerCanvasLayout {
    export type Frame = {
        scale: number, y: number, left: number, right: number, center: number,
        meterLeft: number, meterRight: number, historyRight: number, keyLeft: number, keyCenter: number,
        labelFont: number, keyFont: number, readoutFont: number, maxSpan: number, pixel: number
    }

    export const fit = (width: number, height: number, devicePixelRatio: number = 1): Frame => {
        const scale = Math.min(width / TunerLayout.minWidth, height / TunerLayout.height)
        const right = scale > 0 ? width / scale : TunerLayout.minWidth
        const keyLeft = right - TunerLayout.keyWidth
        const pixel = devicePixelRatio / (scale > 0 ? scale : 1)
        return {
            scale, y: (height - TunerLayout.height * scale) / 2, left: 0, right, center: right / 2,
            meterLeft: TunerLayout.meterInset, meterRight: right - TunerLayout.meterInset,
            historyRight: keyLeft - TunerLayout.keyGap, keyLeft, keyCenter: keyLeft + TunerLayout.keyWidth / 2,
            labelFont: TunerLayout.labelPixels * pixel,
            keyFont: TunerLayout.keyPixels * pixel,
            readoutFont: TunerLayout.readoutPixels * pixel,
            maxSpan: Math.max(2, TunerLayout.historyHeight / (TunerLayout.minRowPixels * pixel)),
            pixel
        }
    }

    export const visibleSpan = (frame: Frame, span: number): number => {
        const rowPixels = TunerLayout.historyHeight / Math.min(span, frame.maxSpan) / frame.pixel
        return TunerLayout.historyHeight / ((rowPixels - TunerLayout.rowTrimPixels) * frame.pixel)
    }

    export const meterX = (frame: Frame, cents: number) => frame.center
        + clamp(cents, -TunerLayout.centsLimit, TunerLayout.centsLimit)
        * (frame.meterRight - frame.meterLeft) / (2 * TunerLayout.centsLimit)
}
