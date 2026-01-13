import {TransientMarkerBoxAdapter} from "./TransientMarkerBoxAdapter"
import {int, panic} from "@moises-ai/lib-std"
import {WarpMarkerBoxAdapter} from "./WarpMarkerBoxAdapter"

export type Marker = WarpMarkerBoxAdapter | TransientMarkerBoxAdapter

export const MarkerComparator = <M extends Marker>(a: M, b: M): int => {
    const difference = a.position - b.position
    if (difference === 0) {
        console.warn(a, b)
        return panic("Events at the same position: " + a.position + ", " + b.position)
    }
    return difference
}