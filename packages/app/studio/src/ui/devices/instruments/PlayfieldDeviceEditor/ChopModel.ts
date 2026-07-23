import {clamp, int, unitValue} from "@opendaw/lib-std"
import {PlayfieldChopSlice} from "@opendaw/studio-adapters"

export const MAX_KEY = 128

export type ChopMode = "transients" | "grid"

export const GridDivisions = [1 / 4, 1 / 8, 1 / 16, 1 / 32] as const
export type GridDivision = (typeof GridDivisions)[number]

export namespace ChopMath {
    export const fitBpmPow2 = (durationInSeconds: number): number => {
        if (durationInSeconds <= 0.0) {return 120}
        let bpm = 60 / durationInSeconds
        while (bpm < 90) {bpm *= 2}
        while (bpm > 180) {bpm /= 2}
        return bpm
    }

    export const sliceSecondsForGrid = (bpm: number, division: GridDivision): number => (60 / bpm) * (4 * division)
}

export class ChopModel {
    readonly #boundaries: Array<unitValue> = [0.0, 1.0]

    get boundaries(): ReadonlyArray<unitValue> {return this.#boundaries}

    #set(normalized: ReadonlyArray<unitValue>): void {
        const sorted = Array.from(new Set(normalized.map(value => clamp(value, 0.0, 1.0)))).sort((a, b) => a - b)
        if (sorted.length === 0 || sorted[0] > 0.0) {sorted.unshift(0.0)}
        if (sorted.length < 2) {sorted.push(1.0)}
        this.#boundaries.length = 0
        this.#boundaries.push(...sorted)
    }

    #setCapped(normalized: ReadonlyArray<unitValue>, maxSlices: int): void {
        this.#set(normalized)
        if (maxSlices > 0 && this.#boundaries.length - 1 > maxSlices) {this.#boundaries.length = maxSlices + 1}
    }

    fromTransients(transientSeconds: ReadonlyArray<number>, durationInSeconds: number, maxSlices: int): void {
        if (durationInSeconds <= 0.0) {this.#set([0.0, 1.0]); return}
        this.#setCapped(transientSeconds.map(seconds => seconds / durationInSeconds), maxSlices)
    }

    fromGrid(bpm: number, division: GridDivision, durationInSeconds: number, maxSlices: int): void {
        if (durationInSeconds <= 0.0 || bpm <= 0.0) {this.#set([0.0, 1.0]); return}
        const sliceSeconds = ChopMath.sliceSecondsForGrid(bpm, division)
        if (sliceSeconds <= 0.0) {this.#set([0.0, 1.0]); return}
        const boundaries: Array<unitValue> = []
        for (let seconds = 0.0; seconds < durationInSeconds; seconds += sliceSeconds) {
            boundaries.push(seconds / durationInSeconds)
        }
        boundaries.push(1.0)
        this.#setCapped(boundaries, maxSlices)
    }

    dragBoundary(index: int, position: unitValue): void {
        if (index <= 0 || index >= this.#boundaries.length - 1) {return}
        const lower = this.#boundaries[index - 1]
        const upper = this.#boundaries[index + 1]
        this.#boundaries[index] = clamp(position, lower, upper)
    }

    splitAt(position: unitValue): void {
        const value = clamp(position, 0.0, 1.0)
        if (value <= 0.0 || value >= 1.0) {return}
        const insertIndex = this.#boundaries.findIndex(boundary => boundary > value)
        if (insertIndex <= 0) {return}
        if (this.#boundaries[insertIndex - 1] === value) {return}
        this.#boundaries.splice(insertIndex, 0, value)
    }

    removeBoundary(index: int): void {
        if (index <= 0 || index >= this.#boundaries.length - 1) {return}
        this.#boundaries.splice(index, 1)
    }

    slices(startKey: int): ReadonlyArray<PlayfieldChopSlice> {
        const count = Math.min(this.#boundaries.length - 1, MAX_KEY - startKey)
        const slices: Array<PlayfieldChopSlice> = []
        for (let index = 0; index < count; index++) {
            slices.push({start: this.#boundaries[index], end: this.#boundaries[index + 1]})
        }
        return slices
    }
}
