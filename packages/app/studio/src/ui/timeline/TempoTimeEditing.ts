import {clamp, Curve, int, isDefined, Optional, unitValue, ValueMapping} from "@opendaw/lib-std"
import {bpm, Interpolation, ppqn} from "@opendaw/lib-dsp"
import {TempoRange, TimelineBoxAdapter, ValueEventBoxAdapter, ValueEventCollectionBoxAdapter} from "@opendaw/studio-adapters"

export namespace TempoTimeEditing {
    type Point = { position: ppqn, value: bpm, interpolation: Interpolation }

    export const mappingOf = ({box: {tempoTrack: {minBpm, maxBpm}}}: TimelineBoxAdapter): ValueMapping<bpm> => {
        const min = minBpm.getValue()
        const max = maxBpm.getValue()
        return {
            x: (value: bpm): unitValue => Math.log(value / min) / Math.log(max / min),
            y: (normalized: unitValue): bpm => clamp(Math.exp(normalized * Math.log(max / min)) * min, TempoRange.min, TempoRange.max),
            clamp: (value: bpm): bpm => clamp(value, min, max),
            floating: (): boolean => true
        }
    }

    const valueAt = (mapping: ValueMapping<bpm>, low: Point, high: Point, position: ppqn): bpm => {
        const {interpolation} = low
        if (interpolation.type === "none") {return low.value}
        const offset = position - low.position
        const steps = high.position - low.position
        const y0 = mapping.x(low.value)
        const y1 = mapping.x(high.value)
        if (interpolation.type === "linear") {return mapping.y(y0 + offset / steps * (y1 - y0))}
        return mapping.y(Curve.valueAt({slope: interpolation.slope, steps, y0, y1}, offset))
    }

    const split = (mapping: ValueMapping<bpm>, low: Point, high: Point,
                   position: ppqn): Readonly<{ left: Interpolation, right: Point }> => {
        const {interpolation} = low
        if (interpolation.type !== "curve") {
            return {left: interpolation, right: {position, value: valueAt(mapping, low, high, position), interpolation}}
        }
        const steps = high.position - low.position
        const offset = position - low.position
        const y0 = mapping.x(low.value)
        const y1 = mapping.x(high.value)
        const curve = Curve.byHalf(steps, y0, Curve.valueAt({slope: interpolation.slope, steps, y0, y1}, steps * 0.5), y1)
        const cut = Curve.valueAt(curve, offset)
        return {
            left: Interpolation.Curve(Curve.slopeByHalf(y0, Curve.valueAt(curve, offset * 0.5), cut)),
            right: {
                position, value: mapping.y(cut),
                interpolation: Interpolation.Curve(Curve.slopeByHalf(cut, Curve.valueAt(curve, (offset + steps) * 0.5), y1))
            }
        }
    }

    const write = (collection: ValueEventCollectionBoxAdapter, events: ReadonlyArray<ValueEventBoxAdapter>,
                   points: ReadonlyArray<Point>): void => {
        const counts = new Map<ppqn, int>()
        const indexed = points.map(point => {
            const index = counts.get(point.position) ?? 0
            counts.set(point.position, index + 1)
            return {...point, index}
        })
        const parking = events.length + events.reduce((max, event) => Math.max(max, event.index), 0)
        events.forEach((event, index) => event.box.index.setValue(parking + index))
        events.forEach((event, index) => {
            const point = indexed.at(index)
            if (isDefined(point)) {
                event.copyFrom(point)
            } else {
                event.box.delete()
            }
        })
        indexed.slice(events.length).forEach(point => events[0].copyTo({...point, events: collection.box.events}))
    }

    const snapshot = (events: ReadonlyArray<ValueEventBoxAdapter>): Array<Point> =>
        events.map(({position, value, interpolation}) => ({position, value, interpolation}))

    export const deleteTime = (collection: ValueEventCollectionBoxAdapter, mapping: ValueMapping<bpm>,
                               position: ppqn, complete: ppqn): void => {
        const events = collection.events.asArray().slice()
        if (events.length === 0) {return}
        const points = snapshot(events)
        const length = complete - position
        const left = points.filter(point => point.position < position)
        const lastLeft: Optional<Point> = left.at(-1)
        const firstFromStart = points.find(point => point.position >= position)
        const result: Array<Point> = [...left]
        const right = points.filter(point => point.position >= complete)
            .map(point => ({...point, position: point.position - length}))
        if (isDefined(lastLeft) && isDefined(firstFromStart) && right.at(0)?.position !== position) {
            const {left: interpolation, right: cut} = split(mapping, lastLeft, firstFromStart, position)
            result[result.length - 1] = {...lastLeft, interpolation}
            result.push(cut)
        }
        result.push(...right)
        write(collection, events, result)
    }

    export const insertTime = (collection: ValueEventCollectionBoxAdapter, mapping: ValueMapping<bpm>,
                               position: ppqn, length: ppqn): void => {
        const events = collection.events.asArray().slice()
        if (events.length === 0) {return}
        const points = snapshot(events)
        const left = points.filter(point => point.position < position)
        const lastLeft: Optional<Point> = left.at(-1)
        const firstFromStart = points.find(point => point.position >= position)
        const result: Array<Point> = [...left]
        const shifted = points.filter(point => point.position >= position)
            .map(point => ({...point, position: point.position + length}))
        if (isDefined(lastLeft) && isDefined(firstFromStart)) {
            const value = valueAt(mapping, lastLeft, firstFromStart, position)
            if (firstFromStart.position > position) {
                const {left: interpolation, right} = split(mapping, lastLeft, firstFromStart, position)
                result[result.length - 1] = {...lastLeft, interpolation}
                shifted.unshift({...right, position: position + length})
            }
            result.push({position, value, interpolation: Interpolation.None})
        }
        write(collection, events, [...result, ...shifted])
    }
}
