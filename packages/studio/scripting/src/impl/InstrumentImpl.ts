import {Procedure} from "@moises-ai/lib-std"
import {Instrument, InstrumentAudioUnit, Instruments} from "../Api"
import {InstrumentFactories} from "@moises-ai/studio-adapters"

type AnyInstrumentConstructor = Procedure<Instruments[keyof Instruments]>

export class InstrumentImpl implements Instrument {
    readonly audioUnit: InstrumentAudioUnit
    readonly name: InstrumentFactories.Keys

    readonly constructorFn?: AnyInstrumentConstructor

    constructor(audioUnit: InstrumentAudioUnit, name: keyof Instruments, constructorFn?: AnyInstrumentConstructor) {
        this.audioUnit = audioUnit
        this.name = name
        this.constructorFn = constructorFn
    }
}
