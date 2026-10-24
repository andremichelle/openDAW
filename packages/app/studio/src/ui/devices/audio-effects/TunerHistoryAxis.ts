import {TunerLayout} from "./TunerCanvasLayout"

export const tunerHistoryKeys = (center: number, span: number) => {
    const step = TunerLayout.historyHeight / span
    const keys = []
    for (let note = Math.ceil(center - span / 2 - 0.5); note <= Math.floor(center + span / 2 + 0.5); note++) {
        const y = TunerLayout.historyCenter - (note - center) * step
        const top = Math.max(TunerLayout.historyTop, y - step / 2)
        const bottom = Math.min(TunerLayout.historyBottom, y + step / 2)
        if (bottom > top) {keys.push({note, y, top, height: bottom - top})}
    }
    return keys
}
