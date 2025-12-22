import {int} from "@opendaw/lib-std"
import {ppqn} from "./ppqn"

export class Fragmentor {
    static* iterate(p0: ppqn, p1: ppqn, stepSize: ppqn): IterableIterator<ppqn> {
        let index = Math.ceil(p0 / stepSize)
        let position = index * stepSize
        while (position < p1) {
            yield position
            position = ++index * stepSize
        }
    }

    static* iterateWithIndex(p0: ppqn, p1: ppqn, stepSize: ppqn): IterableIterator<{ position: ppqn, index: int }> {
        let index = Math.ceil(p0 / stepSize)
        let position = index * stepSize
        while (position < p1) {
            yield {position, index}
            position = ++index * stepSize
        }
    }
}