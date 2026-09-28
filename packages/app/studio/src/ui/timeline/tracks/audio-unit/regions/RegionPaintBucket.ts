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
        const normSat = 75 * saturationFactor
        const lessSat = 60 * saturationFactor
        const labelColor = selected ? `hsl(${hue}, ${normSat}%, 10%)` : `hsl(${hue}, ${normSat}%, 68%)`
        const labelBackground = selected ? `hsla(${hue}, ${fullSat}%, 60%, 0.85)` : `hsla(${hue}, ${lessSat}%, 60%, 0.28)`
        const contentColor = `hsl(${hue}, ${normSat}%, 55%)`
        const contentBackground = selected ? `hsla(${hue}, ${normSat}%, 60%, 0.12)` : `hsla(${hue}, ${normSat}%, 60%, 0.07)`
        const loopStrokeColor = `hsl(${hue}, ${normSat}%, 58%)`
        return {labelColor, labelBackground, contentColor, contentBackground, loopStrokeColor}
    }
}