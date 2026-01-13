import {BoxGraph} from "@moises-ai/lib-box"
import {asDefined} from "@moises-ai/lib-std"
import {AudioUnitBox, BoxIO, BoxVisitor, CaptureAudioBox, CaptureMidiBox} from "@moises-ai/studio-boxes"
import {AudioUnitType} from "@moises-ai/studio-enums"
import {UUID} from "@moises-ai/lib-std"

export const migrateAudioUnitBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: AudioUnitBox): void => {
    if (box.type.getValue() !== AudioUnitType.Instrument || box.capture.nonEmpty()) {return}
    boxGraph.beginTransaction()
    const captureBox = asDefined(box.input.pointerHub.incoming().at(0)?.box
        .accept<BoxVisitor<CaptureAudioBox | CaptureMidiBox>>({
            visitVaporisateurDeviceBox: () => CaptureMidiBox.create(boxGraph, UUID.generate()),
            visitNanoDeviceBox: () => CaptureMidiBox.create(boxGraph, UUID.generate()),
            visitPlayfieldDeviceBox: () => CaptureMidiBox.create(boxGraph, UUID.generate()),
            visitTapeDeviceBox: () => CaptureAudioBox.create(boxGraph, UUID.generate())
        }))
    box.capture.refer(captureBox)
    boxGraph.endTransaction()
}
