/** Note-centered key bands clipped to the history plot's vertical bounds. */
export const tunerHistoryKeys = (center: number, span: number) => {
    const step = 180 / span
    const keys = []
    for (let note = Math.ceil(center - span / 2 - 0.5); note <= Math.floor(center + span / 2 + 0.5); note++) {
        const y = 105 - (note - center) * step
        const top = Math.max(15, y - step / 2)
        const bottom = Math.min(195, y + step / 2)
        if (bottom > top) {keys.push({note, y, top, height: bottom - top})}
    }
    return keys
}
