import {clamp} from "@opendaw/lib-std"

export const TunerLayout = Object.freeze({
    width: 480, height: 240, left: 18, right: 462, center: 240,
    historyTop: 15, historyBottom: 195, historyCenter: 105, historyHeight: 180,
    historyRight: 418, keyWidth: 58, keyCenter: 447, keyLabelOffset: 5,
    meterY: 90, tickTop: 85, tickBottom: 95, zeroTop: 76, zeroBottom: 110, zeroWidth: 3,
    scaleLabelY: 137, zeroFont: 17, scaleFont: 16,
    triangleTip: 83, triangleTop: 63, triangleHalfWidth: 11,
    strobeTop: 57, strobeBottom: 70, strobeCount: 20, strobeWidth: 4,
    noteX: 112, valueX: 305, readoutY: 205, readoutFont: 36, traceWidth: 2,
    maxKeyFont: 18, keyFontRatio: 0.65, centsLimit: 50, tickStep: 10
})

export const fitTunerCanvas = (width: number, height: number) => {
    const scale = Math.min(width / TunerLayout.width, height / TunerLayout.height)
    return {scale, x: (width - TunerLayout.width * scale) / 2, y: (height - TunerLayout.height * scale) / 2}
}

export const tunerMeterX = (cents: number) => TunerLayout.center
    + clamp(cents, -TunerLayout.centsLimit, TunerLayout.centsLimit)
    * (TunerLayout.right - TunerLayout.left) / (2 * TunerLayout.centsLimit)
