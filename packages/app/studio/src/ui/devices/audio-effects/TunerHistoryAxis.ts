import {TunerLayout} from "./TunerCanvasLayout"

export namespace TunerHistoryAxis {
    export type Key = {note: number, y: number, top: number, height: number}

    export const keys = (center: number, span: number): Array<Key> => {
        const step = TunerLayout.historyHeight / span
        const result: Array<Key> = []
        for (let note = Math.ceil(center - span / 2 - 0.5); note <= Math.floor(center + span / 2 + 0.5); note++) {
            const y = TunerLayout.historyCenter - (note - center) * step
            const top = Math.max(TunerLayout.historyTop, y - step / 2)
            const bottom = Math.min(TunerLayout.historyBottom, y + step / 2)
            if (bottom > top) {result.push({note, y, top, height: bottom - top})}
        }
        return result
    }
}
