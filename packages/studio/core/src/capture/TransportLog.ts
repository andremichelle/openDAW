import {int, Option} from "@opendaw/lib-std"
import {ppqn, TempoMap} from "@opendaw/lib-dsp"
import {TransportAnchor} from "@opendaw/studio-adapters"

export class TransportLog {
    readonly #tempoMap: TempoMap
    readonly #anchors: Array<TransportAnchor> = []

    constructor(tempoMap: TempoMap) {this.#tempoMap = tempoMap}

    get anchors(): ReadonlyArray<TransportAnchor> {return this.#anchors}

    append(anchor: TransportAnchor): void {
        let index = this.#anchors.length
        while (index > 0 && this.#anchors[index - 1].contextTime > anchor.contextTime) {index--}
        this.#anchors.splice(index, 0, anchor)
    }

    clear(): void {this.#anchors.length = 0}

    anchorAt(contextTime: number): Option<TransportAnchor> {
        const index = this.#indexAt(contextTime)
        return index < 0 ? Option.None : Option.wrap(this.#anchors[index])
    }

    positionAt(contextTime: number): Option<ppqn> {
        return this.anchorAt(contextTime).map(anchor => this.#extrapolate(anchor, contextTime))
    }

    // the musical time the transport moved forward between two context times, jumps excluded
    advance(from: number, to: number): ppqn {
        if (to <= from) {return 0.0}
        let sum = 0.0
        for (let index = Math.max(0, this.#indexAt(from)); index < this.#anchors.length; index++) {
            const anchor = this.#anchors[index]
            if (anchor.contextTime >= to) {break}
            const next = index + 1 < this.#anchors.length ? this.#anchors[index + 1].contextTime : Number.POSITIVE_INFINITY
            const begin = Math.max(from, anchor.contextTime)
            const end = Math.min(to, next)
            if (end > begin) {sum += this.#extrapolate(anchor, end) - this.#extrapolate(anchor, begin)}
        }
        return sum
    }

    #extrapolate(anchor: TransportAnchor, contextTime: number): ppqn {
        if (anchor.kind === "stop") {return anchor.position}
        const seconds = this.#tempoMap.ppqnToSeconds(anchor.position)
        return anchor.position + this.#tempoMap.intervalToPPQN(seconds, seconds + (contextTime - anchor.contextTime))
    }

    #indexAt(contextTime: number): int {
        for (let index = this.#anchors.length - 1; index >= 0; index--) {
            if (this.#anchors[index].contextTime <= contextTime) {return index}
        }
        return -1
    }
}
