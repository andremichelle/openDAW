import {int} from "@opendaw/lib-std"
import {EuclidRhythm} from "./EuclidRhythm"

/** The notes a pattern plays, as the engine places them without groove and with every hit played. */
export namespace EuclidNotes {
    export type Lane = {
        readonly note: int
        readonly velocity: number
        readonly gate: int
        readonly audible: boolean
        readonly steps: ReadonlyArray<EuclidRhythm.Step>
        // a step in pulses at the global rate
        readonly step: number
        readonly repeats: int
        readonly fade: number
    }
    export type Note = { readonly position: number, readonly duration: number, readonly pitch: int, readonly velocity: number }

    // the distance from the hit at `index` to the lane's next hit, at most `left`
    const distanceToNext = (steps: ReadonlyArray<EuclidRhythm.Step>, index: int, left: number, step: number): number => {
        for (let ahead = 1; ahead <= steps.length; ahead++) {
            if (ahead * step >= left) {return left}
            if (steps[(index + ahead) % steps.length].hit) {return ahead * step}
        }
        return Math.min(steps.length * step, left)
    }

    /** Every note in `[0, duration)`, the lanes restarting every `period` pulses (Infinity never). */
    export const of = (lanes: ReadonlyArray<Lane>, duration: number, period: number): ReadonlyArray<Note> => {
        const notes: Array<Note> = []
        lanes.filter(lane => lane.audible && lane.steps.length > 0).forEach(lane => {
            const {steps, step, repeats, fade} = lane
            for (let periodStart = 0; periodStart < duration; periodStart += period) {
                const periodEnd = Math.min(periodStart + period, duration)
                for (let index = 0; periodStart + index * step < periodEnd; index++) {
                    const start = periodStart + index * step
                    const {hit, accent, burst} = steps[index % steps.length]
                    if (!hit) {continue}
                    const triggers = burst ? repeats : 1
                    const spacing = step / triggers
                    const base = accent ? 1.0 : lane.velocity
                    for (let trigger = 0; trigger < triggers; trigger++) {
                        const at = start + trigger * spacing
                        if (at >= periodEnd) {continue}
                        const along = fade < 0.0 ? triggers - 1 - trigger : trigger
                        const velocity = base * (triggers < 2 ? 1.0 : 1.0 - Math.abs(fade) * along / (triggers - 1))
                        if (velocity <= 0.0) {continue}
                        const length = lane.gate === 1 && trigger === triggers - 1
                            ? distanceToNext(steps, index, periodEnd - start, step) - trigger * spacing
                            : spacing
                        notes.push({position: at, duration: Math.max(1, Math.min(length, periodEnd - at)), pitch: lane.note, velocity})
                    }
                }
                if (!Number.isFinite(period)) {break}
            }
        })
        // one note per moment and pitch, the louder one
        const sorted = notes.sort((left, right) => left.position - right.position || left.pitch - right.pitch
            || right.velocity - left.velocity)
        return sorted.filter((note, index) => index === 0
            || sorted[index - 1].position !== note.position || sorted[index - 1].pitch !== note.pitch)
    }
}
