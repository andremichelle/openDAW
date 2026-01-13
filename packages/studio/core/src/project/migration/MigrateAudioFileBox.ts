import {BoxGraph} from "@moises-ai/lib-box"
import {AudioData} from "@moises-ai/lib-dsp"
import {AudioFileBox, BoxIO} from "@moises-ai/studio-boxes"

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
}
