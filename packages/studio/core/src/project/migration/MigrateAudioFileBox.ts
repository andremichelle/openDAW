import {BoxGraph} from "@opendaw/lib-box"
import {AudioData} from "@opendaw/lib-dsp"
import {AudioFileBox, BoxIO, TransientMarkerBox} from "@opendaw/studio-boxes"
import {asInstanceOf} from "@opendaw/lib-std"

const isIntEncodedAsFloat = (v: number) =>
    v > 0 && v < 1e-6 && Number.isFinite(v) && (v / 1.401298464324817e-45) % 1 === 0

export const migrateAudioFileBox = async (
    boxGraph: BoxGraph<BoxIO.TypeMap>,
    box: AudioFileBox,
    loadAudioData: (uuid: Uint8Array) => Promise<AudioData>
): Promise<void> => {
    const {startInSeconds, endInSeconds, fileName} = box
    if (isIntEncodedAsFloat(startInSeconds.getValue()) || isIntEncodedAsFloat(endInSeconds.getValue()) || endInSeconds.getValue() === 0) {
        const audioData = await loadAudioData(box.address.uuid)
        const seconds = audioData.numberOfFrames / audioData.sampleRate
        console.debug(`Migrate 'AudioFileBox' to float sec (${fileName.getValue()})`, seconds.toFixed(3))
        boxGraph.beginTransaction()
        startInSeconds.setValue(0)
        endInSeconds.setValue(seconds)
        boxGraph.endTransaction()
    }
    // Drop duplicate transient markers: position is the unique key per file.
    // Old project data can contain duplicates from prior bugs; the sorted
    // EventCollection panics on .asArray() and the file becomes unloadable.
    const markers = [...box.transientMarkers.pointerHub.incoming()]
        .map(pointer => asInstanceOf(pointer.box, TransientMarkerBox))
    const seen = new Set<number>()
    const duplicates: Array<TransientMarkerBox> = []
    for (const marker of markers) {
        const position = marker.position.getValue()
        if (seen.has(position)) {
            duplicates.push(marker)
        } else {
            seen.add(position)
        }
    }
    if (duplicates.length > 0) {
        console.debug(`Migrate 'AudioFileBox' (${fileName.getValue()}): drop ${duplicates.length} duplicate transient marker(s)`)
        boxGraph.beginTransaction()
        duplicates.forEach(duplicate => duplicate.delete())
        boxGraph.endTransaction()
    }
}
