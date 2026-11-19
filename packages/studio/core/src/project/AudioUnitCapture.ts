import {Box, BoxGraph} from "@opendaw/lib-box"
import {isDefined, UUID} from "@opendaw/lib-std"
import {AudioUnitBox, CaptureAudioBox, CaptureMidiBox, TapeDeviceBox} from "@opendaw/studio-boxes"

export namespace AudioUnitCapture {
    export const deriveUUID = (unitUUID: UUID.Bytes): UUID.Bytes => {
        const bytes = unitUUID.map(value => value ^ 0x5a)
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return bytes
    }

    export const restore = (boxGraph: BoxGraph, unit: AudioUnitBox): boolean => {
        const instrument = unit.input.pointerHub.incoming().at(0)?.box
        if (!isDefined(instrument)) {return false}
        const uuid = deriveUUID(unit.address.uuid)
        const capture: Box = boxGraph.findBox(uuid).unwrapOrElse(() => instrument instanceof TapeDeviceBox
            ? CaptureAudioBox.create(boxGraph, uuid)
            : CaptureMidiBox.create(boxGraph, uuid))
        unit.capture.refer(capture)
        return true
    }
}
