import {bpm, ppqn, seconds} from "./ppqn"
import {Observable} from "@moises-ai/lib-std"

/**
 * Interface for tempo map conversions between musical time (PPQN) and absolute time (seconds/samples).
 * Handles both point conversions and interval conversions (which require integration over a tempo curve).
 */
export interface TempoMap extends Observable<TempoMap> {
    /**
     * Get the tempo at a specific musical position.
     * @param ppqn Position in PPQN
     * @returns Tempo in BPM at that position
     */
    getTempoAt(ppqn: ppqn): bpm

    /**
     * Convert a musical position to absolute time.
     * @param position Position in PPQN
     * @returns Absolute time in seconds
     */
    ppqnToSeconds(position: ppqn): seconds

    /**
     * Convert an absolute time position to musical time.
     * @param time Absolute time in seconds
     * @returns Position in PPQN
     */
    secondsToPPQN(time: seconds): ppqn

    /**
     * Convert a musical time interval to absolute time duration.
     * Integrates over the tempo curve between the two positions.
     * @param fromPPQN Start position in PPQN
     * @param toPPQN End position in PPQN
     * @returns Duration in seconds
     */
    intervalToSeconds(fromPPQN: ppqn, toPPQN: ppqn): seconds

    /**
     * Convert an absolute time interval to musical time duration.
     * Inverse integration over the tempo curve.
     * @param fromSeconds Start time in seconds
     * @param toSeconds End time in seconds
     * @returns Duration in PPQN
     */
    intervalToPPQN(fromSeconds: seconds, toSeconds: seconds): ppqn
}

