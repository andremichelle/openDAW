import {AudioUnitBox, TrackBox} from "@moises-ai/studio-boxes"
import {InstrumentBox} from "./InstrumentBox"

export type InstrumentProduct<INST_BOX extends InstrumentBox> = {
    audioUnitBox: AudioUnitBox
    instrumentBox: INST_BOX
    trackBox: TrackBox
}