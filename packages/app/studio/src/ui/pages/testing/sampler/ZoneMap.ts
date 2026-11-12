import {int, isDefined, Option, Optional} from "@opendaw/lib-std"
import {MidiKeys} from "@opendaw/lib-dsp"
import {Colors} from "@opendaw/studio-enums"
import {SamplerModel} from "./SamplerModel"

export namespace ZoneMap {
    export const NumKeys: int = 128
    export const MaxVelocity: int = 127
    export type Edge = "move" | "left" | "right" | "top" | "bottom"
    export type Hit = { readonly zones: ReadonlyArray<SamplerModel.Zone>, readonly edge: Edge }
    export type Range = { readonly keyLo: int, readonly keyHi: int, readonly velLo: int, readonly velHi: int }
    export type State = {
        readonly instrument: SamplerModel.Instrument
        readonly selection: ReadonlySet<SamplerModel.Zone>
        readonly group: int
        readonly pressed: int
        readonly rect: Optional<Range>
    }

    export const sameRange = (a: SamplerModel.Zone, b: SamplerModel.Zone): boolean => a.group === b.group
        && a.keyLo === b.keyLo && a.keyHi === b.keyHi && a.velLo === b.velLo && a.velHi === b.velHi
    const visible = ({group}: State, zone: SamplerModel.Zone): boolean => group === -1 || zone.group === group

    export const paint = (context: CanvasRenderingContext2D, width: number, height: number, scale: number,
                          state: State): void => {
        const {instrument: {zones, groups}, selection, pressed, rect} = state
        const keyWidth = width / NumKeys
        const yOf = (velocity: number): number => height * (1.0 - velocity / MaxVelocity)
        context.clearRect(0, 0, width, height)
        context.fillStyle = Colors.shadow.opacity(0.12).toString()
        for (let key = 12; key < NumKeys; key += 12) {context.fillRect(Math.round(key * keyWidth), 0, scale, height)}
        context.font = `${8 * scale}px sans-serif`
        context.textAlign = "left"
        context.textBaseline = "top"
        for (let velocity = 32; velocity < MaxVelocity; velocity += 32) {
            context.fillStyle = Colors.shadow.opacity(0.12).toString()
            context.fillRect(0, Math.round(yOf(velocity)), width, scale)
            context.fillStyle = Colors.shadow.toString()
            context.fillText(String(velocity), 3 * scale, Math.round(yOf(velocity)) + 3 * scale)
        }
        const painted: Array<SamplerModel.Zone> = []
        const paintZone = (zone: SamplerModel.Zone, selected: boolean): void => {
            if (painted.some(other => sameRange(other, zone))) {return}
            painted.push(zone)
            const color = groups[zone.group].color
            const x0 = Math.round(zone.keyLo * keyWidth) + scale
            const x1 = Math.round((zone.keyHi + 1) * keyWidth)
            const y0 = Math.round(yOf(zone.velHi)) + scale
            const y1 = Math.round(yOf(zone.velLo - 1))
            const dimmed = !visible(state, zone)
            context.fillStyle = color.opacity(dimmed ? 0.05 : selected ? 0.7 : 0.22).toString()
            context.fillRect(x0, y0, x1 - x0, y1 - y0)
            if (dimmed) {return}
            // an edge fades only where a zone of the same group overlaps it
            const others = zones.filter(other => other.group === zone.group && !sameRange(other, zone))
            const besides = others.filter(other => other.velLo <= zone.velHi && other.velHi >= zone.velLo)
            const stacked = others.filter(other => other.keyLo <= zone.keyHi && other.keyHi >= zone.keyLo)
            const shade = (fromX: number, fromY: number, toX: number, toY: number): void => {
                const gradient = context.createLinearGradient(fromX, fromY, toX, toY)
                gradient.addColorStop(0.0, Colors.background.opacity(0.9).toString())
                gradient.addColorStop(1.0, Colors.background.opacity(0.0).toString())
                context.fillStyle = gradient
                context.fillRect(Math.min(fromX, toX), Math.min(fromY, toY),
                    fromX === toX ? x1 - x0 : Math.abs(toX - fromX), fromY === toY ? y1 - y0 : Math.abs(toY - fromY))
            }
            const keyFade = Math.min(zone.keyFade * keyWidth, x1 - x0)
            const velFade = Math.min(zone.velFade / MaxVelocity * height, y1 - y0)
            if (keyFade > 0 && besides.some(other => other.keyLo < zone.keyLo && other.keyHi >= zone.keyLo)) {
                shade(x0, y0, x0 + keyFade, y0)
            }
            if (keyFade > 0 && besides.some(other => other.keyHi > zone.keyHi && other.keyLo <= zone.keyHi)) {
                shade(x1, y0, x1 - keyFade, y0)
            }
            if (velFade > 0 && stacked.some(other => other.velHi > zone.velHi && other.velLo <= zone.velHi)) {
                shade(x0, y0, x0, y0 + velFade)
            }
            if (velFade > 0 && stacked.some(other => other.velLo < zone.velLo && other.velHi >= zone.velLo)) {
                shade(x0, y1, x0, y1 - velFade)
            }
            context.strokeStyle = (selected ? Colors.white : color.opacity(0.6)).toString()
            context.lineWidth = scale
            context.strokeRect(x0 + scale * 0.5, y0 + scale * 0.5, x1 - x0 - scale, y1 - y0 - scale)
            const robins = zones.filter(other => sameRange(other, zone)).length
            if (robins > 1 && x1 - x0 >= 14 * scale && y1 - y0 >= 12 * scale) {
                context.fillStyle = (selected ? Colors.black : color).toString()
                context.font = `${8 * scale}px sans-serif`
                context.textAlign = "center"
                context.textBaseline = "middle"
                context.fillText(`×${robins}`, (x0 + x1) * 0.5, (y0 + y1) * 0.5)
            }
        }
        zones.filter(zone => !selection.has(zone)).forEach(zone => paintZone(zone, false))
        zones.filter(zone => selection.has(zone)).forEach(zone => paintZone(zone, true))
        if (pressed >= 0) {
            context.fillStyle = Colors.orange.opacity(0.35).toString()
            context.fillRect(Math.round(pressed * keyWidth), 0, Math.round(keyWidth), height)
        }
        if (isDefined(rect)) {
            const x0 = Math.round(rect.keyLo * keyWidth), x1 = Math.round((rect.keyHi + 1) * keyWidth)
            const y0 = Math.round(yOf(rect.velHi)), y1 = Math.round(yOf(rect.velLo - 1))
            context.fillStyle = Colors.white.opacity(0.06).toString()
            context.fillRect(x0, y0, x1 - x0, y1 - y0)
            context.strokeStyle = Colors.white.opacity(0.5).toString()
            context.lineWidth = scale
            context.strokeRect(x0 + scale * 0.5, y0 + scale * 0.5, x1 - x0 - scale, y1 - y0 - scale)
        }
    }

    export const within = (state: State, {keyLo, keyHi, velLo, velHi}: Range): ReadonlyArray<SamplerModel.Zone> =>
        state.instrument.zones.filter(zone => visible(state, zone)
            && zone.keyLo <= keyHi && zone.keyHi >= keyLo && zone.velLo <= velHi && zone.velHi >= velLo)

    export const keyAt = (x: number, width: number): int =>
        Math.max(0, Math.min(NumKeys - 1, Math.floor(x / width * NumKeys)))
    export const velocityAt = (y: number, height: number): int =>
        Math.max(1, Math.min(MaxVelocity, Math.ceil((1.0 - y / height) * MaxVelocity)))

    // the round robins sharing the range under the pointer and the edge within reach
    export const hit = (state: State, x: number, y: number, width: number, height: number, reach: number): Option<Hit> => {
        const {instrument: {zones}, selection} = state
        const keyWidth = width / NumKeys
        const yOf = (velocity: number): number => height * (1.0 - velocity / MaxVelocity)
        const inside = (zone: SamplerModel.Zone): boolean => visible(state, zone)
            && x >= zone.keyLo * keyWidth && x < (zone.keyHi + 1) * keyWidth && y >= yOf(zone.velHi) && y < yOf(zone.velLo - 1)
        const target = zones.find(zone => selection.has(zone) && inside(zone)) ?? zones.find(inside)
        return Option.wrap(target).map(zone => {
            const left = zone.keyLo * keyWidth, right = (zone.keyHi + 1) * keyWidth
            const top = yOf(zone.velHi), bottom = yOf(zone.velLo - 1)
            const horizontal = Math.min(reach, (right - left) / 3), vertical = Math.min(reach, (bottom - top) / 3)
            const edge: Edge = x - left < horizontal ? "left" : right - x < horizontal ? "right"
                : y - top < vertical ? "top" : bottom - y < vertical ? "bottom" : "move"
            return {zones: zones.filter(other => sameRange(other, zone)), edge}
        })
    }

    const WhiteKeys: ReadonlyArray<int> = [0, 2, 4, 5, 7, 9, 11]
    const WhiteEdges: ReadonlyArray<number> = [0, 1.5, 3.5, 5, 6.5, 8.5, 10.5, 12]

    // black keys sit on their semitone column to line up with the map, white keys split below their centres
    export const paintKeyboard = (context: CanvasRenderingContext2D, width: number, height: number, scale: number,
                                  labels: boolean, state: State): void => {
        const {selection, pressed} = state
        const keyWidth = width / NumKeys
        const roots = new Set<int>(Array.from(selection, zone => zone.rootKey))
        const fill = (key: int, black: boolean): string => (key === pressed ? Colors.orange : roots.has(key) ? Colors.blue
            : black ? Colors.black : Colors.gray).toString()
        context.clearRect(0, 0, width, height)
        for (let key = 0; key < NumKeys; key++) {
            if (MidiKeys.isBlackKey(key)) {continue}
            const octave = Math.floor(key / 12)
            const white = WhiteKeys.indexOf(key % 12)
            const x0 = Math.round((octave * 12 + WhiteEdges[white]) * keyWidth)
            const x1 = Math.round((octave * 12 + WhiteEdges[white + 1]) * keyWidth)
            context.fillStyle = fill(key, false)
            context.fillRect(x0 + scale, 0, x1 - x0 - scale, height - scale)
            if (labels && key % 12 === 0 && key >= 24) {
                context.fillStyle = Colors.black.toString()
                context.font = `${7 * scale}px sans-serif`
                context.textAlign = "center"
                context.textBaseline = "alphabetic"
                context.fillText(MidiKeys.toFullString(key), x0 + keyWidth * 0.75 + scale, height - 3 * scale)
            }
        }
        for (let key = 0; key < NumKeys; key++) {
            if (!MidiKeys.isBlackKey(key)) {continue}
            context.fillStyle = fill(key, true)
            context.fillRect(Math.round(key * keyWidth), 0, Math.round(keyWidth), Math.round(height * 0.58))
        }
    }

    export const keyboardKeyAt = (x: number, y: number, width: number, height: number): int => {
        const column = keyAt(x, width)
        if (MidiKeys.isBlackKey(column) && y < height * 0.58) {return column}
        const position = x / width * NumKeys
        const octave = Math.floor(position / 12)
        const white = Math.max(0, WhiteEdges.findIndex(edge => edge > position - octave * 12) - 1)
        return Math.max(0, Math.min(NumKeys - 1, octave * 12 + WhiteKeys[Math.min(white, 6)]))
    }

    export const paintWaveform = (context: CanvasRenderingContext2D, width: number, height: number, scale: number,
                                  optZone: Optional<SamplerModel.Zone>): void => {
        context.clearRect(0, 0, width, height)
        if (!isDefined(optZone)) {return}
        const zone = optZone
        const start = Math.min(zone.start, zone.end), end = Math.max(zone.start, zone.end)
        const center = height * 0.5
        let seed = zone.rootKey * 7919 + zone.velLo * 104729 + zone.sequence * 1299709
        const random = (): number => {
            seed = (seed * 1664525 + 1013904223) >>> 0
            return seed / 0xFFFFFFFF
        }
        context.fillStyle = Colors.blue.toString()
        for (let x = 0; x < width; x += scale) {
            const position = x / width
            const shaped = zone.reverse === 1 ? 1.0 - position : position
            const envelope = Math.min(1.0, shaped * 200.0) * Math.exp(-shaped * zone.decay)
            const amplitude = Math.max(scale * 0.5, envelope * (0.55 + 0.45 * random()) * center * 0.92)
            context.globalAlpha = position >= start && position <= end ? 1.0 : 0.25
            context.fillRect(x, center - amplitude, scale, amplitude * 2.0)
        }
        context.globalAlpha = 1.0
        context.fillRect(Math.round(start * (width - scale)), 0, scale, height)
        context.fillRect(Math.round(end * (width - scale)), 0, scale, height)
        if (zone.loopMode === 0) {return}
        const lo = Math.max(Math.min(zone.loopStart, zone.loopEnd), start)
        const hi = Math.min(Math.max(zone.loopStart, zone.loopEnd), end)
        const fade = Math.min(zone.loopFade, (hi - lo) * 0.5)
        const xLo = Math.round(lo * (width - scale)), xHi = Math.round(hi * (width - scale))
        context.fillStyle = Colors.green.toString()
        context.globalAlpha = 0.2
        context.fillRect(xLo, 0, Math.round(fade * width), height)
        context.fillRect(xHi - Math.round(fade * width), 0, Math.round(fade * width), height)
        context.globalAlpha = 1.0
        context.fillRect(xLo, 0, scale, height)
        context.fillRect(xHi, 0, scale, height)
    }
}
