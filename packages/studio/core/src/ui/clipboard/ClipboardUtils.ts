import {ByteArrayInput} from "@opendaw/lib-std"
import {BoxGraphCopy} from "../../BoxGraphCopy"

export namespace ClipboardUtils {
    export const extractMetadata = (data: ArrayBufferLike): ArrayBufferLike => {
        const input = new ByteArrayInput(data)
        const metadataLength = input.readInt()
        const metadataBytes = new Int8Array(metadataLength)
        input.readBytes(metadataBytes)
        return metadataBytes.buffer
    }

    // serializeBoxes/deserializeBoxes moved to BoxGraphCopy (they touch no clipboard). Re-exported
    // here so the existing copy/paste handlers keep using ClipboardUtils unchanged.
    export const serializeBoxes = BoxGraphCopy.serializeBoxes
    export const deserializeBoxes = BoxGraphCopy.deserializeBoxes
}