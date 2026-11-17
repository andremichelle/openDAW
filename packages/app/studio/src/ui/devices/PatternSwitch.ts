import {Option} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {Project} from "@opendaw/studio-core"

export namespace PatternSwitch {
    /** Where a pattern sequencer takes over a requested pattern, for its parameter's setValueAt: the next bar while playing. */
    export const at = ({engine, timelineBoxAdapter: {signatureTrack}}: Project): Option<ppqn> =>
        engine.isPlaying.getValue() ? Option.wrap(signatureTrack.ceilToBar(engine.position.getValue())) : Option.None
}
