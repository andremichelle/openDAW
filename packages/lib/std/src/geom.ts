import {int, Unhandled} from "./lang"
import {clamp} from "./math"

export type Point = { x: number, y: number }
export type Circle = Point & { r: number }
export type Size = { width: number, height: number }
export type Rect = Point & Size
export type Padding = [number, number, number, number]
export type Client = { clientX: number, clientY: number }

export const enum Axis {T, R, B, L}

export const enum Corner {TL, TR, BR, BL}

export namespace Geom {
    export const outerTangentPoints = (a: Circle, b: Circle): [Point, Point] => {
        const dx = b.x - a.x
        const dy = b.y - a.y
        const angle = Math.atan2(dy, dx) + Math.acos((a.r - b.r) / Math.sqrt(dx * dx + dy * dy))
        const cs = Math.cos(angle)
        const sn = Math.sin(angle)
        return [
            {x: a.x + a.r * cs, y: a.y + a.r * sn},
            {x: b.x + b.r * cs, y: b.y + b.r * sn}
        ]
    }
    export const isInsideCircle = (x: number, y: number, cx: number, cy: number, radius: number): boolean => {
        const dx = x - cx
        const dy = y - cy
        return dx * dx + dy * dy <= radius * radius
    }
}

export namespace Point {
    export const zero = (): Point => ({x: 0, y: 0})
    export const create = (x: number, y: number): Point => ({x, y})
    export const clone = (point: Point): Point => ({...point})
    export const floor = (point: Point): Point => ({x: Math.floor(point.x), y: Math.floor(point.y)})
    export const length = (point: Point): number => Math.sqrt(point.x * point.x + point.y * point.y)
    export const distance = (a: Point, b: Point): number => Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)
    export const add = (a: Point, b: Point): Point => ({x: a.x + b.x, y: a.y + b.y})
    export const subtract = (a: Point, b: Point): Point => ({x: a.x - b.x, y: a.y - b.y})
    export const scaleBy = (point: Point, scale: number): Point => ({x: point.x * scale, y: point.y * scale})
    export const scaleTo = (point: Point, scale: number): Point => {
        const multiplier = scale / length(point)
        return {x: point.x * multiplier, y: point.y * multiplier}
    }
    export const fromClient = (object: { clientX: number, clientY: number }): Point => ({
        x: object.clientX,
        y: object.clientY
    })
}

export namespace Rect {
    export const Empty: Readonly<Rect> = Object.freeze({x: 0, y: 0, width: 0, height: 0})

    export const corners = (rectangle: Rect): Array<Point> => {
        const x0 = rectangle.x
        const y0 = rectangle.y
        const x1 = x0 + rectangle.width
        const y1 = y0 + rectangle.height
        return [{x: x0, y: y0}, {x: x1, y: y0}, {x: x1, y: y1}, {x: x0, y: y1}]
    }

    export const inflate = (rect: Rect, amount: number): Rect => {
        return {
            x: rect.x - amount,
            y: rect.y - amount,
            width: rect.width + amount * 2.0,
            height: rect.height + amount * 2.0
        }
    }

    export const contains = (outer: Rect, inner: Rect): boolean => {
        const topLeftInside = inner.x >= outer.x && inner.y >= outer.y
        const bottomRightInside =
            (inner.x + inner.width) <= (outer.x + outer.width)
            && (inner.y + inner.height) <= (outer.y + outer.height)
        return topLeftInside && bottomRightInside
    }

    export const isPointInside = (point: Point, rect: Rect): boolean =>
        point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height

    export const intersect = (a: Rect, b: Rect): boolean => {
        const xMin = Math.max(a.x, b.x)
        const xMax = Math.min(a.x + a.width, b.x + b.width)
        const yMax = Math.min(a.y + a.height, b.y + b.height)
        const yMin = Math.max(a.y, b.y)
        return xMax > xMin && yMax > yMin
    }

    export const axis = (rectangle: Rect, axis: Axis): number => {
        switch (axis) {
            case Axis.T:
                return rectangle.y
            case Axis.R:
                return rectangle.x + rectangle.width
            case Axis.B:
                return rectangle.y + rectangle.height
            case Axis.L:
                return rectangle.x
            default:
                return Unhandled(axis)
        }
    }

    export const corner = (rectangle: Rect, corner: Corner): Point => {
        switch (corner) {
            case Corner.TL:
                return {x: rectangle.x, y: rectangle.y}
            case Corner.TR:
                return {x: rectangle.x + rectangle.width, y: rectangle.y}
            case Corner.BR:
                return {x: rectangle.x + rectangle.width, y: rectangle.y + rectangle.height}
            case Corner.BL:
                return {x: rectangle.x, y: rectangle.y + rectangle.height}
            default:
                return Unhandled(corner)
        }
    }

    export const center = (rectangle: Rect): Point => ({
        x: rectangle.x + rectangle.width * 0.5,
        y: rectangle.y + rectangle.height * 0.5
    })

    export const isEmpty = (rectangle: Rect): boolean => rectangle.width === 0 || rectangle.height === 0

    export const union = (a: Rect, b: Readonly<Rect>): void => {
        if (Rect.isEmpty(a)) {
            if (!Rect.isEmpty(b)) {
                a.x = b.x
                a.y = b.y
                a.width = b.width
                a.height = b.height
            }
        } else if (!Rect.isEmpty(b)) {
            const bx = b.x
            const by = b.y
            const ux = Math.min(a.x, bx)
            const uy = Math.min(a.y, by)
            a.width = Math.max(a.x + a.width, bx + b.width) - ux
            a.height = Math.max(a.y + a.height, by + b.height) - uy
            a.x = ux
            a.y = uy
        }
    }
}

export interface AABB {
    xMin: number
    xMax: number
    yMin: number
    yMax: number
}

export namespace AABB {
    export const width = (aabb: AABB): number => aabb.xMax - aabb.xMin
    export const height = (aabb: AABB): number => aabb.yMax - aabb.yMin

    export const from = (aabb: AABB, that: AABB): void => {
        aabb.xMin = that.xMin
        aabb.xMax = that.xMax
        aabb.yMin = that.yMin
        aabb.yMax = that.yMax
    }

    export const extend = (aabb: AABB, offset: number): void => {
        aabb.xMin -= offset
        aabb.yMin -= offset
        aabb.xMax += offset
        aabb.yMax += offset
    }

    export const padding = (aabb: AABB, [top, right, bottom, left]: Readonly<Padding>): AABB => {
        aabb.xMin += left
        aabb.yMin += top
        aabb.xMax -= right
        aabb.yMax -= bottom
        return aabb
    }

    export const intersectPoint = (aabb: AABB, point: Point): boolean =>
        aabb.xMin <= point.x && point.x < aabb.xMax && aabb.yMin <= point.y && point.y < aabb.yMax

    export const intersectThat = (aabb: AABB, that: AABB): boolean =>
        that.xMin < aabb.xMax && that.xMax > aabb.xMin && that.yMin < aabb.yMax && that.yMax > aabb.yMin

    export const center = (aabb: AABB): Point => ({x: (aabb.xMin + aabb.xMax) * 0.5, y: (aabb.yMin + aabb.yMax) * 0.5})
}

export namespace Padding {
    export const Identity: Readonly<Padding> = Object.freeze([0.0, 0.0, 0.0, 0.0])
}

export namespace CohenSutherland {
    export const intersects = (xMin: number, xMax: number, yMin: number, yMax: number,
                               x0: number, y0: number, x1: number, y1: number): boolean => {
        const c0 = code(xMin, xMax, yMin, yMax, x0, y0)
        const c1 = code(xMin, xMax, yMin, yMax, x1, y1)
        if ((c0 | c1) === 0) {return false}
        if ((c0 & c1) !== 0) {return false}
        const s = sign(x0, y0, x1, y1, xMin, yMin)
        return (
            s !== sign(x0, y0, x1, y1, xMax, yMin) ||
            s !== sign(x0, y0, x1, y1, xMax, yMax) ||
            s !== sign(x0, y0, x1, y1, xMin, yMax)
        )
    }

    const code = (xMin: number, xMax: number, yMin: number, yMax: number, x: number, y: number): int => {
        let code = 0
        if (x <= xMin) {code |= 1} else if (x >= xMax) {code |= 2}
        if (y <= yMin) {code |= 8} else if (y >= yMax) {code |= 4}
        return code
    }

    const sign = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): boolean =>
        (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0) >= 0
}

export interface ValueAxis {
    valueToAxis(value: number): number
    axisToValue(axis: number): number
}

export namespace ValueAxis {
    export const Identity: ValueAxis = {
        valueToAxis: (value: number): number => value,
        axisToValue: (axis: number): number => axis
    }

    export const toClamped = (valueAxis: ValueAxis, min: number, max: number): ValueAxis => ({
        valueToAxis: (value: number): number => valueAxis.valueToAxis(clamp(value, min, max)),
        axisToValue: (axis: number): number => clamp(valueAxis.axisToValue(axis), min, max)
    })

    export const createClamped = (min: number, max: number): ValueAxis => ({
        valueToAxis: (value: number): number => clamp(value, min, max),
        axisToValue: (axis: number): number => clamp(axis, min, max)
    })
}