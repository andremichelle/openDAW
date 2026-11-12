import {Color, Func, int, isDefined, Option, Optional} from "@opendaw/lib-std"
import {MidiKeys} from "@opendaw/lib-dsp"
import {PeaksPainter} from "@opendaw/lib-fusion"
import {SamplerDeviceBoxAdapter, SamplerZoneBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"

// Painting and hit testing of the key × velocity map, its keyboard and the waveform of a sample zone.
export namespace SamplerZoneMap {
    export const NumKeys: int = 128
    export const MinVelocity: int = 1
    export const MaxVelocity: int = 127
    export type Edge = "move" | "left" | "right" | "top" | "bottom"
    export type Range = { readonly keyLow: int, readonly keyHigh: int, readonly velocityLow: int, readonly velocityHigh: int }
    export type Entry = Range & {
        readonly zone: SamplerZoneBoxAdapter
        readonly group: int // the index of the zone's group, -1 without one
        readonly rootKey: int
        readonly keyFade: int
        readonly velocityFade: int
    }
    export type Hit = { readonly zones: ReadonlyArray<SamplerZoneBoxAdapter>, readonly edge: Edge }
    export type State = {
        readonly entries: ReadonlyArray<Entry>
        readonly selection: ReadonlySet<SamplerZoneBoxAdapter>
        readonly group: int // the group that is shown, -1 for all
        readonly pressed: int
        readonly rect: Optional<Range>
        // whether a key sounds right now, played here or coming in
        readonly isNoteOn: Func<int, boolean>
    }

    const GroupColors: ReadonlyArray<Color> = [Colors.blue, Colors.green, Colors.yellow, Colors.purple, Colors.orange, Colors.cream]
    const WhiteKeys: ReadonlyArray<int> = [0, 2, 4, 5, 7, 9, 11]
    const WhiteEdges: ReadonlyArray<number> = [0, 1.5, 3.5, 5, 6.5, 8.5, 10.5, 12]
    const BlackKeyHeight = 0.58

    export const groupColor = (index: int): Color => index < 0 ? Colors.shadow : GroupColors[index % GroupColors.length]

    // the zones that are on the map, read from their boxes
    export const entries = (adapter: SamplerDeviceBoxAdapter): ReadonlyArray<Entry> => adapter.zones.adapters()
        .filter(zone => zone.box.enabled.getValue())
        .map(zone => {
            const {keyLow, keyHigh, velocityLow, velocityHigh, rootKey, keyFade, velocityFade} = zone.box
            return {
                zone,
                group: zone.group().mapOr(group => group.indexField.getValue(), -1),
                keyLow: keyLow.getValue(), keyHigh: keyHigh.getValue(),
                velocityLow: velocityLow.getValue(), velocityHigh: velocityHigh.getValue(),
                rootKey: rootKey.getValue(), keyFade: keyFade.getValue(), velocityFade: velocityFade.getValue()
            }
        })

    const sameRange = (entry: Entry, other: Entry): boolean => entry.group === other.group && entry.keyLow === other.keyLow
        && entry.keyHigh === other.keyHigh && entry.velocityLow === other.velocityLow && entry.velocityHigh === other.velocityHigh
    const visible = ({group}: State, entry: Entry): boolean => group === -1 || entry.group === group

    export const paint = (context: CanvasRenderingContext2D, width: number, height: number, scale: number,
                          state: State): void => {
        const {entries, selection, pressed, rect} = state
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
        // zones on the same range are painted once, with their number
        const rangeOf = (entry: Entry): string =>
            `${entry.group}/${entry.keyLow}/${entry.keyHigh}/${entry.velocityLow}/${entry.velocityHigh}`
        const counts = new Map<string, int>()
        entries.forEach(entry => counts.set(rangeOf(entry), (counts.get(rangeOf(entry)) ?? 0) + 1))
        const painted = new Set<string>()
        const paintEntry = (entry: Entry, selected: boolean): void => {
            const range = rangeOf(entry)
            if (painted.has(range)) {return}
            painted.add(range)
            const color = groupColor(entry.group)
            const x0 = Math.round(entry.keyLow * keyWidth) + scale
            const x1 = Math.round((entry.keyHigh + 1) * keyWidth)
            const y0 = Math.round(yOf(entry.velocityHigh)) + scale
            const y1 = Math.round(yOf(entry.velocityLow - 1))
            const dimmed = !visible(state, entry)
            context.fillStyle = color.opacity(dimmed ? 0.05 : selected ? 0.7 : 0.22).toString()
            context.fillRect(x0, y0, x1 - x0, y1 - y0)
            if (dimmed) {return}
            // an edge fades only where a zone of the same group overlaps it
            const fades = entry.keyFade > 0 || entry.velocityFade > 0
            const others = fades ? entries.filter(other => other.group === entry.group && !sameRange(other, entry)) : []
            const beside = others.filter(other => other.velocityLow <= entry.velocityHigh && other.velocityHigh >= entry.velocityLow)
            const stacked = others.filter(other => other.keyLow <= entry.keyHigh && other.keyHigh >= entry.keyLow)
            const shade = (fromX: number, fromY: number, toX: number, toY: number): void => {
                const gradient = context.createLinearGradient(fromX, fromY, toX, toY)
                gradient.addColorStop(0.0, Colors.background.opacity(0.9).toString())
                gradient.addColorStop(1.0, Colors.background.opacity(0.0).toString())
                context.fillStyle = gradient
                context.fillRect(Math.min(fromX, toX), Math.min(fromY, toY),
                    fromX === toX ? x1 - x0 : Math.abs(toX - fromX), fromY === toY ? y1 - y0 : Math.abs(toY - fromY))
            }
            const keyFade = Math.min(entry.keyFade * keyWidth, x1 - x0)
            const velocityFade = Math.min(entry.velocityFade / MaxVelocity * height, y1 - y0)
            if (keyFade > 0 && beside.some(other => other.keyLow < entry.keyLow && other.keyHigh >= entry.keyLow)) {
                shade(x0, y0, x0 + keyFade, y0)
            }
            if (keyFade > 0 && beside.some(other => other.keyHigh > entry.keyHigh && other.keyLow <= entry.keyHigh)) {
                shade(x1, y0, x1 - keyFade, y0)
            }
            if (velocityFade > 0 && stacked.some(other => other.velocityHigh > entry.velocityHigh && other.velocityLow <= entry.velocityHigh)) {
                shade(x0, y0, x0, y0 + velocityFade)
            }
            if (velocityFade > 0 && stacked.some(other => other.velocityLow < entry.velocityLow && other.velocityHigh >= entry.velocityLow)) {
                shade(x0, y1, x0, y1 - velocityFade)
            }
            context.strokeStyle = (selected ? Colors.white : color.opacity(0.6)).toString()
            context.lineWidth = scale
            context.strokeRect(x0 + scale * 0.5, y0 + scale * 0.5, x1 - x0 - scale, y1 - y0 - scale)
            const robins = counts.get(range) ?? 1
            if (robins > 1 && x1 - x0 >= 14 * scale && y1 - y0 >= 12 * scale) {
                context.fillStyle = (selected ? Colors.black : color).toString()
                context.font = `${8 * scale}px sans-serif`
                context.textAlign = "center"
                context.textBaseline = "middle"
                context.fillText(`×${robins}`, (x0 + x1) * 0.5, (y0 + y1) * 0.5)
            }
        }
        entries.filter(entry => !selection.has(entry.zone)).forEach(entry => paintEntry(entry, false))
        entries.filter(entry => selection.has(entry.zone)).forEach(entry => paintEntry(entry, true))
        if (pressed >= 0) {
            context.fillStyle = Colors.orange.opacity(0.35).toString()
            context.fillRect(Math.round(pressed * keyWidth), 0, Math.round(keyWidth), height)
        }
        if (isDefined(rect)) {
            const x0 = Math.round(rect.keyLow * keyWidth), x1 = Math.round((rect.keyHigh + 1) * keyWidth)
            const y0 = Math.round(yOf(rect.velocityHigh)), y1 = Math.round(yOf(rect.velocityLow - 1))
            context.fillStyle = Colors.white.opacity(0.06).toString()
            context.fillRect(x0, y0, x1 - x0, y1 - y0)
            context.strokeStyle = Colors.white.opacity(0.5).toString()
            context.lineWidth = scale
            context.strokeRect(x0 + scale * 0.5, y0 + scale * 0.5, x1 - x0 - scale, y1 - y0 - scale)
        }
    }

    export const within = (state: State, {keyLow, keyHigh, velocityLow, velocityHigh}: Range): ReadonlyArray<SamplerZoneBoxAdapter> =>
        state.entries.filter(entry => visible(state, entry) && entry.keyLow <= keyHigh && entry.keyHigh >= keyLow
            && entry.velocityLow <= velocityHigh && entry.velocityHigh >= velocityLow).map(({zone}) => zone)

    // the zones that answer a key and velocity, those of the first matching group
    export const answering = (state: State, key: int, velocity: int): ReadonlyArray<SamplerZoneBoxAdapter> => {
        const matches = state.entries.filter(entry => visible(state, entry) && key >= entry.keyLow && key <= entry.keyHigh
            && velocity >= entry.velocityLow && velocity <= entry.velocityHigh)
        return matches.filter(entry => entry.group === matches[0].group).map(({zone}) => zone)
    }

    export const robinsOf = (state: State, zone: SamplerZoneBoxAdapter): ReadonlyArray<SamplerZoneBoxAdapter> => {
        const entry = state.entries.find(other => other.zone === zone)
        return isDefined(entry) ? state.entries.filter(other => sameRange(other, entry)).map(other => other.zone) : [zone]
    }

    export const keyAt = (x: number, width: number): int =>
        Math.max(0, Math.min(NumKeys - 1, Math.floor(x / width * NumKeys)))
    export const velocityAt = (y: number, height: number): int =>
        Math.max(MinVelocity, Math.min(MaxVelocity, Math.ceil((1.0 - y / height) * MaxVelocity)))

    // the round robins sharing the range under the pointer and the edge within reach
    export const hit = (state: State, x: number, y: number, width: number, height: number, reach: number): Option<Hit> => {
        const {entries, selection} = state
        const keyWidth = width / NumKeys
        const yOf = (velocity: number): number => height * (1.0 - velocity / MaxVelocity)
        const inside = (entry: Entry): boolean => visible(state, entry)
            && x >= entry.keyLow * keyWidth && x < (entry.keyHigh + 1) * keyWidth
            && y >= yOf(entry.velocityHigh) && y < yOf(entry.velocityLow - 1)
        const target = entries.find(entry => selection.has(entry.zone) && inside(entry)) ?? entries.find(inside)
        return Option.wrap(target).map(entry => {
            const left = entry.keyLow * keyWidth, right = (entry.keyHigh + 1) * keyWidth
            const top = yOf(entry.velocityHigh), bottom = yOf(entry.velocityLow - 1)
            const horizontal = Math.min(reach, (right - left) / 3), vertical = Math.min(reach, (bottom - top) / 3)
            const edge: Edge = x - left < horizontal ? "left" : right - x < horizontal ? "right"
                : y - top < vertical ? "top" : bottom - y < vertical ? "bottom" : "move"
            return {zones: entries.filter(other => sameRange(other, entry)).map(({zone}) => zone), edge}
        })
    }

    // black keys sit on their semitone column to line up with the map, white keys split below their centres
    export const paintKeyboard = (context: CanvasRenderingContext2D, width: number, height: number, scale: number,
                                  state: State): void => {
        const {entries, selection, isNoteOn} = state
        const keyWidth = width / NumKeys
        const roots = new Set<int>(entries.filter(entry => selection.has(entry.zone)).map(entry => entry.rootKey))
        const fill = (key: int, black: boolean): string => (roots.has(key) ? Colors.blue : black ? Colors.black : Colors.gray).toString()
        // a sounding key gets a dot, so the colours of the selection stay readable
        const dot = (key: int, centerX: number, centerY: number): void => {
            if (!isNoteOn(key)) {return}
            context.fillStyle = Colors.orange.toString()
            context.beginPath()
            context.arc(centerX, centerY, 2.5 * scale, 0.0, Math.PI * 2.0)
            context.fill()
        }
        context.clearRect(0, 0, width, height)
        for (let key = 0; key < NumKeys; key++) {
            if (MidiKeys.isBlackKey(key)) {continue}
            const octave = Math.floor(key / 12)
            const white = WhiteKeys.indexOf(key % 12)
            const x0 = Math.round((octave * 12 + WhiteEdges[white]) * keyWidth)
            const x1 = Math.round((octave * 12 + WhiteEdges[white + 1]) * keyWidth)
            const centerX = (x0 + x1 + scale) * 0.5
            context.fillStyle = fill(key, false)
            context.fillRect(x0 + scale, 0, x1 - x0 - scale, height - scale)
            if (key % 12 === 0 && key >= 24) {
                context.fillStyle = Colors.black.toString()
                context.font = `${7 * scale}px sans-serif`
                context.textAlign = "center"
                context.textBaseline = "alphabetic"
                context.fillText(MidiKeys.toFullString(key), centerX, height - 3 * scale)
            }
            dot(key, centerX, height - 5.5 * scale)
        }
        for (let key = 0; key < NumKeys; key++) {
            if (!MidiKeys.isBlackKey(key)) {continue}
            context.fillStyle = fill(key, true)
            context.fillRect(Math.round(key * keyWidth), 0, Math.round(keyWidth), Math.round(height * BlackKeyHeight))
            dot(key, (key + 0.5) * keyWidth, height * BlackKeyHeight * 0.72)
        }
    }

    // the read head of every voice that plays the zone: `positions` holds row and frame pairs, a row of -1 ends them
    export const paintPlayheads = (context: CanvasRenderingContext2D, width: number, height: number, scale: number,
                                   positions: Float32Array, row: int, numberOfFrames: int): void => {
        context.clearRect(0, 0, width, height)
        if (row < 0 || numberOfFrames <= 0) {return}
        context.fillStyle = Colors.bright.toString()
        for (let index = 0; index + 1 < positions.length; index += 2) {
            if (positions[index] < 0) {break}
            if (positions[index] !== row) {continue}
            context.fillRect(Math.round(positions[index + 1] / numberOfFrames * (width - scale)), 0, scale, height)
        }
    }

    export const keyboardKeyAt = (x: number, y: number, width: number, height: number): int => {
        const column = keyAt(x, width)
        if (MidiKeys.isBlackKey(column) && y < height * BlackKeyHeight) {return column}
        const position = x / width * NumKeys
        const octave = Math.floor(position / 12)
        const white = Math.max(0, WhiteEdges.findIndex(edge => edge > position - octave * 12) - 1)
        return Math.max(0, Math.min(NumKeys - 1, octave * 12 + WhiteKeys[Math.min(white, 6)]))
    }

    // the zone's sample with its start, end and loop, as far as the sample is loaded
    export const paintWaveform = (context: CanvasRenderingContext2D, width: number, height: number, scale: number,
                                  optZone: Optional<SamplerZoneBoxAdapter>): void => {
        context.clearRect(0, 0, width, height)
        if (!isDefined(optZone)) {return}
        const {box} = optZone
        optZone.file().ifSome(file => file.getOrCreateLoader().peaks.ifSome(peaks => {
            const {numFrames, numChannels} = peaks
            if (numFrames === 0) {return}
            const unit = (frames: int): number => Math.min(frames, numFrames) / numFrames
            const start = unit(box.sampleStart.getValue())
            const end = Math.max(start, unit(box.sampleEnd.getValue()))
            const rowHeight = height / numChannels
            const layout: PeaksPainter.Layout = {u0: 0.0, u1: 0.0, x0: 0.0, x1: 0.0, v0: +1.1, v1: -1.1, y0: 0.0, y1: 0.0}
            const render = (from: number, to: number): void => {
                for (let channel = 0; channel < numChannels; channel++) {
                    layout.u0 = from * numFrames
                    layout.u1 = to * numFrames
                    layout.x0 = from * (width - scale)
                    layout.x1 = to * (width - scale)
                    layout.y0 = rowHeight * channel
                    layout.y1 = rowHeight * (channel + 1)
                    PeaksPainter.renderPixelStrips(context, peaks, channel, layout)
                }
            }
            context.fillStyle = Colors.blue.toString()
            if (end > start) {render(start, end)}
            context.fillRect(Math.round(start * (width - scale)), 0, scale, height)
            context.fillRect(Math.round(end * (width - scale)), 0, scale, height)
            context.globalAlpha = 0.25
            if (start > 0.0) {render(0.0, start)}
            if (end < 1.0) {render(end, 1.0)}
            context.globalAlpha = 1.0
            if (box.loopMode.getValue() === 0) {return}
            const lo = Math.max(unit(box.loopStart.getValue()), start)
            const hi = Math.min(Math.max(unit(box.loopEnd.getValue()), lo), end)
            const xLo = Math.round(lo * (width - scale)), xHi = Math.round(hi * (width - scale))
            context.fillStyle = Colors.green.toString()
            context.globalAlpha = 0.2
            context.fillRect(xLo, 0, xHi - xLo, height)
            context.globalAlpha = 1.0
            context.fillRect(xLo, 0, scale, height)
            context.fillRect(xHi, 0, scale, height)
        }))
    }
}
