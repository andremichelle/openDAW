import {Attempt, Attempts} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, InstrumentCompositeCellBox} from "@opendaw/studio-boxes"
import {InstrumentFactory} from "../../../factories/InstrumentFactory"
import {InstrumentFactories} from "../../../factories/InstrumentFactories"
import {InstrumentBox} from "../../../factories/InstrumentBox"
import {PlayfieldPads} from "../Playfield/PlayfieldPads"

export namespace CellInstrument {
    // a new instrument in a layer or pad, a Nano on a pad starts like a sample pad
    export const create = <A, INST extends InstrumentBox>(boxGraph: BoxGraph<BoxIO.TypeMap>, cell: InstrumentCompositeCellBox,
                                                          factory: InstrumentFactory<A, INST>, name: string = factory.defaultName,
                                                          attachment?: A): Attempt<INST, string> => {
        if (!InstrumentFactories.fitsCell(cell, factory)) {return refusal(cell, factory)}
        const instrument = factory.create(boxGraph, cell.instrument, name, factory.defaultIcon, attachment)
        if (PlayfieldPads.isPad(cell)) {PlayfieldPads.preparePadInstrument(instrument)}
        return Attempts.ok(instrument)
    }

    export const replace = <A, INST extends InstrumentBox>(boxGraph: BoxGraph<BoxIO.TypeMap>, cell: InstrumentCompositeCellBox,
                                                           factory: InstrumentFactory<A, INST>, name: string = factory.defaultName,
                                                           attachment?: A): Attempt<INST, string> => {
        if (!InstrumentFactories.fitsCell(cell, factory)) {return refusal(cell, factory)}
        cell.instrument.pointerHub.incoming().forEach(({box}) => box.delete())
        return create(boxGraph, cell, factory, name, attachment)
    }

    const refusal = <INST>(cell: InstrumentCompositeCellBox, factory: InstrumentFactory): Attempt<INST, string> =>
        Attempts.err(`${factory.defaultName} cannot be used as a ${PlayfieldPads.isPad(cell) ? "pad" : "layer"}`)
}
