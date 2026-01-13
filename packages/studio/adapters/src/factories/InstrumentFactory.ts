import {BoxGraph, Field} from "@moises-ai/lib-box"
import {IconSymbol, Pointers} from "@moises-ai/studio-enums"
import {BoxIO} from "@moises-ai/studio-boxes"
import {InstrumentBox} from "./InstrumentBox"
import {TrackType} from "../timeline/TrackType"
import {DeviceFactory} from "./DeviceFactory"

export interface InstrumentFactory<A = any, INST extends InstrumentBox = InstrumentBox> extends DeviceFactory {
    trackType: TrackType
    create: (boxGraph: BoxGraph<BoxIO.TypeMap>,
             host: Field<Pointers.InstrumentHost | Pointers.AudioOutput>,
             name: string,
             icon: IconSymbol,
             attachment?: A) => INST
}