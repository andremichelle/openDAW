import {BoxGraph} from "@opendaw/lib-box"
import {int, isInstanceOf, Option, unitValue, UUID} from "@opendaw/lib-std"
import {AudioFileBox, InstrumentCompositeCellBox, NanoDeviceBox, PlayfieldDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdapters} from "../../../BoxAdapters"
import {InstrumentCompositeCellBoxAdapter} from "../InstrumentComposite/InstrumentCompositeCellBoxAdapter"
import {NanoDeviceBoxAdapter} from "../NanoDeviceBoxAdapter"

export type PlayfieldPadOptions = {
    sampleStart?: unitValue
    sampleEnd?: unitValue
    exclude?: boolean
}

export namespace PlayfieldPads {
    export const DefaultKey = 60

    export const isPad = (cell: InstrumentCompositeCellBox): boolean =>
        cell.composite.targetVertex.mapOr(({box}) => isInstanceOf(box, PlayfieldDeviceBox), false)

    // plays like the former slot: one-shot to the region end, mono, no transposition
    export const create = (boxGraph: BoxGraph, playfield: PlayfieldDeviceBox, file: AudioFileBox,
                           index: int, {sampleStart = 0.0, sampleEnd = 1.0, exclude = false}: PlayfieldPadOptions = {}
    ): InstrumentCompositeCellBox => {
        const cell = InstrumentCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(playfield.pads)
            box.index.setValue(index)
            box.key.setValue(DefaultKey)
            box.exclude.setValue(exclude)
        })
        createNano(boxGraph, cell, file, sampleStart, sampleEnd)
        return cell
    }

    // a pad playing another instrument gets a Nano instead
    export const playSample = (boxGraph: BoxGraph, cell: InstrumentCompositeCellBox, file: AudioFileBox): void => {
        cell.instrument.pointerHub.incoming().forEach(({box}) => box.delete())
        createNano(boxGraph, cell, file, 0.0, 1.0)
    }

    const createNano = (boxGraph: BoxGraph, cell: InstrumentCompositeCellBox, file: AudioFileBox,
                        sampleStart: unitValue, sampleEnd: unitValue): NanoDeviceBox =>
        NanoDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(cell.instrument)
            box.file.refer(file)
            box.label.setValue(file.fileName.getValue())
            applyDefaults(box, sampleStart, sampleEnd)
        })

    export const resetParameters = (cell: InstrumentCompositeCellBox, nano: Option<NanoDeviceBox>): void => {
        cell.key.setValue(DefaultKey)
        cell.gain.setValue(0.0)
        cell.pan.setValue(0.0)
        cell.mute.setValue(false)
        cell.solo.setValue(false)
        cell.exclude.setValue(false)
        nano.ifSome(box => applyDefaults(box, 0.0, 1.0))
    }

    // the part of a pad's Nano that makes it play like the former slot
    export const applyPadMode = (box: NanoDeviceBox): void => {
        box.volume.setValue(0.0)
        box.rootKey.setValue(DefaultKey)
        box.loopFade.setValue(0.001)
        box.loopStart.setValue(0.0)
        box.loopEnd.setValue(1.0)
        box.fixedPitch.setValue(true)
        box.tail.setValue(true)
    }

    const applyDefaults = (box: NanoDeviceBox, sampleStart: unitValue, sampleEnd: unitValue): void => {
        applyPadMode(box)
        box.octave.setValue(0)
        box.tune.setValue(0.0)
        box.attack.setValue(0.001)
        box.release.setValue(0.020)
        box.sampleStart.setValue(sampleStart)
        box.sampleEnd.setValue(sampleEnd)
        box.loop.setValue(false)
        box.loopStart.setValue(0.0)
        box.loopEnd.setValue(1.0)
        box.panning.setValue(0.0)
        box.polyphone.setValue(false)
        box.oneShot.setValue(true)
    }

    export const nanoBoxOf = (cell: InstrumentCompositeCellBox): Option<NanoDeviceBox> => {
        const instrument = cell.instrument.pointerHub.incoming().at(0)?.box
        return isInstanceOf(instrument, NanoDeviceBox) ? Option.wrap(instrument) : Option.None
    }

    export const nanoOf = (boxAdapters: BoxAdapters, pad: InstrumentCompositeCellBoxAdapter): Option<NanoDeviceBoxAdapter> =>
        nanoBoxOf(pad.box).map(box => boxAdapters.adapterFor(box, NanoDeviceBoxAdapter))
}
