import {TunerLayout} from "./TunerCanvasLayout"

export namespace TunerHistoryAxis {
    export type Key = {note: number, y: number, top: number, height: number}

    export const keys = (center: number, span: number): Array<Key> => {
        const step = TunerLayout.historyHeight / span
        const result: Array<Key> = []
        for (let note = Math.ceil(center - span / 2 - 0.5); note <= Math.floor(center + span / 2 + 0.5); note++) {
            const y = TunerLayout.historyCenter - (note - center) * step
            const top = y - step / 2
            if (top < TunerLayout.historyBottom && top + step > TunerLayout.historyTop) {
                result.push({note, y, top, height: step})
            }
        }
        return result
    }
}
