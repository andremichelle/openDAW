import {BoxGraph} from "@opendaw/lib-box"
import {isDefined, UUID} from "@opendaw/lib-std"
import {AudioRegionBox, BoxIO} from "@opendaw/studio-boxes"
import {PPQN, ppqn, seconds, TimeBase} from "@opendaw/lib-dsp"

// A region's `position` is an Int32 (integer ppqn), but a seconds-based region's ppqn `complete`
// is fractional (its duration is derived from seconds through the tempo). When an edit placed a
// region to start exactly where a seconds-based region ends, that fractional complete was truncated
// to an integer position, leaving a sub-ppqn (< 1 ppqn ≈ < 1 ms) overlap. The runtime float
// boundaryTolerance is ~1e-3 ppqn and cannot absorb a ~1 ppqn truncation, so heal it at load:
// trim the earlier region so it ends exactly at the next region's position. (#287)
export const migrateAudioRegionOverlaps = (boxGraph: BoxGraph<BoxIO.TypeMap>, bpm: number): void => {
    const groups = new Map<string, Array<AudioRegionBox>>()
    for (const box of boxGraph.boxes()) {
        if (!(box instanceof AudioRegionBox)) {continue}
        const track = box.regions.targetVertex
        if (track.isEmpty()) {continue}
        const key = UUID.toString(track.unwrap().box.address.uuid)
        const list = groups.get(key)
        if (isDefined(list)) {list.push(box)} else {groups.set(key, [box])}
    }
    const isSeconds = (region: AudioRegionBox): boolean => region.timeBase.getValue() === TimeBase.Seconds
    const durationPPQN = (region: AudioRegionBox): ppqn => isSeconds(region)
        ? PPQN.secondsToPulses(region.duration.getValue(), bpm)
        : region.duration.getValue()
    // Largest float32 seconds whose re-derived ppqn stays <= targetPPQN. The duration field is float32,
    // so storing the exact seconds can round the derived ppqn back up past the boundary; step down ulps.
    const secondsWithin = (targetPPQN: ppqn): seconds => {
        let value = Math.fround(PPQN.pulsesToSeconds(targetPPQN, bpm))
        while (value > 0 && PPQN.secondsToPulses(value, bpm) > targetPPQN) {
            value = Math.fround(value - Math.abs(value) * 2 ** -23)
        }
        return value
    }
    const fixes: Array<() => void> = []
    for (const list of groups.values()) {
        list.sort((left, right) => left.position.getValue() - right.position.getValue())
        for (let index = 1; index < list.length; index++) {
            const prev = list[index - 1]
            const next = list[index]
            const overlap = prev.position.getValue() + durationPPQN(prev) - next.position.getValue()
            if (overlap <= 0 || overlap >= 1) {continue}
            const trimmed = next.position.getValue() - prev.position.getValue()
            fixes.push(() => prev.duration.setValue(isSeconds(prev) ? secondsWithin(trimmed) : trimmed))
        }
    }
    if (fixes.length === 0) {return}
    console.debug(`Migrate heal ${fixes.length} sub-ppqn audio region overlap(s)`)
    boxGraph.beginTransaction()
    fixes.forEach(fix => fix())
    boxGraph.endTransaction()
}
