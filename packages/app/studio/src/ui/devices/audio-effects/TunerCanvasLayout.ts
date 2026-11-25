import {clamp} from "@opendaw/lib-std"

export const TunerLayout = Object.freeze({
    minWidth: 480, height: 240, meterInset: 12,
    historyTop: 15, historyBottom: 165, historyCenter: 90, historyHeight: 150,
    keyWidth: 58, keyGap: 6, keyLabelOffset: 5,
    meterY: 90, tickTop: 85, tickBottom: 95, zeroTop: 76, zeroBottom: 110, zeroWidth: 3,
    scaleLabelY: 137, zeroFont: 17, scaleFont: 16,
    triangleTip: 83, triangleTop: 63, triangleHalfWidth: 11,
    strobeTop: 57, strobeBottom: 70, strobeCount: 20, strobeWidth: 4,
    readoutY: 205, readoutFont: 36, traceWidth: 2,
    maxKeyFont: 18, keyFontRatio: 0.65, centsLimit: 50, tickStep: 10
})

export namespace TunerCanvasLayout {
    export type Frame = {
        scale: number, y: number, left: number, right: number, center: number,
        meterLeft: number, meterRight: number, historyRight: number, keyLeft: number, keyCenter: number
    }

    export const fit = (width: number, height: number): Frame => {
        const scale = Math.min(width / TunerLayout.minWidth, height / TunerLayout.height)
        const right = scale > 0 ? width / scale : TunerLayout.minWidth
        const keyLeft = right - TunerLayout.keyWidth
        return {
            scale, y: (height - TunerLayout.height * scale) / 2, left: 0, right, center: right / 2,
            meterLeft: TunerLayout.meterInset, meterRight: right - TunerLayout.meterInset,
            historyRight: keyLeft - TunerLayout.keyGap, keyLeft, keyCenter: keyLeft + TunerLayout.keyWidth / 2
        }
    }

    export const meterX = (frame: Frame, cents: number) => frame.center
        + clamp(cents, -TunerLayout.centsLimit, TunerLayout.centsLimit)
        * (frame.meterRight - frame.meterLeft) / (2 * TunerLayout.centsLimit)
}
