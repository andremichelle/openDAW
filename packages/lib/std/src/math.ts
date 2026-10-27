// noinspection JSUnusedGlobalSymbols

import {int, unitValue} from "./lang"

export const TAU = Math.PI * 2.0
export const PI_HALF = Math.PI / 2.0
export const PI_QUART = Math.PI / 4.0
export const INVERSE_SQRT_2 = 1.0 / Math.sqrt(2.0)

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max))
export const clampUnit = (value: number): unitValue => Math.max(0.0, Math.min(value, 1.0))
export const squashUnit = (value: unitValue, margin: unitValue): unitValue =>
    margin + (1.0 - 2.0 * margin) * Math.max(0.0, Math.min(value, 1.0))
export const quantizeFloor = (value: number, interval: number): number => Math.floor(value / interval) * interval
export const quantizeCeil = (value: number, interval: number): number => Math.ceil(value / interval) * interval
export const quantizeRound = (value: number, interval: number): number => Math.round(value / interval) * interval
export const linear = (y1: number, y2: number, mu: number): number => y1 + (y2 - y1) * mu
export const exponential = (y1: number, y2: number, mu: number): number => y1 * Math.pow(y2 / y1, mu)
export const cosine = (y1: number, y2: number, mu: number): number => {
    const mu2 = (1.0 - Math.cos(mu * Math.PI)) * 0.5
    return y1 * (1.0 - mu2) + y2 * mu2
}
export const mod = (value: number, range: number): number => ((value % range) + range) % range
export const fract = (value: number): number => value - Math.floor(value)
export const nextPowOf2 = (n: int): int => Math.pow(2, Math.ceil(Math.log(n) / Math.log(2)))
export const radToDeg = (rad: number): number => rad * 180.0 / Math.PI
export const degToRad = (deg: number): number => deg / 180.0 * Math.PI

// Möbius-Ease Curve
// Only produces valid values between 0 and 1 (unitValues)
// https://www.desmos.com/calculator/ht8cytaxsz
// The inverse is h`=1-h
export const moebiusEase = (x: unitValue, h: unitValue): unitValue => (x * h) / ((2.0 * h - 1.0) * (x - 1.0) + h)
