import {AudioFileBox, TransientMarkerBox} from "@moises-ai/studio-boxes"
import {Option, Provider, UUID} from "@moises-ai/lib-std"
import {AudioData, TransientProtocol} from "@moises-ai/lib-dsp"
import {BoxGraph} from "@moises-ai/lib-box"

export namespace AudioFileBoxFactory {
    const applyTransients = (audioFileBox: AudioFileBox, transients: ReadonlyArray<number>) =>
        transients.forEach(position => TransientMarkerBox.create(audioFileBox.graph, UUID.generate(), box => {
            box.owner.refer(audioFileBox.transientMarkers)
            box.position.setValue(position)
        }))

    export const createModifier = async (transientProtocol: TransientProtocol,
                                         boxGraph: BoxGraph,
                                         audioData: AudioData,
                                         uuid: UUID.Bytes,
                                         name: string): Promise<Provider<AudioFileBox>> => {
        const optAudioFileBox: Option<AudioFileBox> = boxGraph.findBox<AudioFileBox>(uuid)
        if (optAudioFileBox.nonEmpty()) {
            const audioFileBox = optAudioFileBox.unwrap()
            if (audioFileBox.transientMarkers.pointerHub.isEmpty()) {
                const transients = await transientProtocol.detect(audioData)
                return () => {
                    applyTransients(audioFileBox, transients)
                    return audioFileBox
                }
            }
            return () => audioFileBox
        } else {
            const transients = await transientProtocol.detect(audioData)
            const durationInSeconds = audioData.numberOfFrames / audioData.sampleRate
            return () => {
                // Re-check in case another drop created it between createModifier and now
                const existingBox = boxGraph.findBox<AudioFileBox>(uuid)
                if (existingBox.nonEmpty()) {
                    return existingBox.unwrap()
                }
                const audioFileBox = AudioFileBox.create(boxGraph, uuid, box => {
                    box.fileName.setValue(name)
                    box.startInSeconds.setValue(0)
                    box.endInSeconds.setValue(durationInSeconds)
                })
                applyTransients(audioFileBox, transients)
                return audioFileBox
            }
        }
    }
}