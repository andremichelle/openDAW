export interface RegionPaintBucket {
    labelColor: string
    labelBackground: string
    contentColor: string
    contentBackground: string
    loopStrokeColor: string
}

export namespace RegionPaintBucket {
    export const create = ({hue, mute}: {
        hue: number,
        mute: boolean
    }, selected: boolean, forceMute: boolean): RegionPaintBucket => {
        const saturationFactor = mute || forceMute ? 0.05 : 1.0
        const fullSat = 100 * saturationFactor
        const normSat = 60 * saturationFactor
        const lessSat = 45 * saturationFactor
        const labelColor = selected ? `hsl(${hue}, ${normSat}%, 10%)` : `hsl(${hue}, ${normSat}%, 60%)`
        const labelBackground = selected ? `hsla(${hue}, ${fullSat}%, 60%, 0.75)` : `hsla(${hue}, ${lessSat}%, 60%, 0.15)`
        const contentColor = `hsl(${hue}, ${normSat}%, 45%)`
        const contentBackground = selected ? `hsla(${hue}, ${normSat}%, 60%, 0.06)` : `hsla(${hue}, ${normSat}%, 60%, 0.03)`
        const loopStrokeColor = `hsl(${hue}, ${normSat}%, 50%)`
        return {labelColor, labelBackground, contentColor, contentBackground, loopStrokeColor}
    }
}