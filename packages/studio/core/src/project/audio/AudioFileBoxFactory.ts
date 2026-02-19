import {AudioFileBox, TransientMarkerBox} from "@opendaw/studio-boxes"
import {Option, Provider, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {AudioData, TransientProtocol} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"

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
                const handler = RuntimeNotifier.progress({headline: "Detecting Transients..."})
                const transients = await transientProtocol.detect(audioData)
                handler.terminate()
                return () => {
                    if (audioFileBox.transientMarkers.pointerHub.isEmpty()) {
                        applyTransients(audioFileBox, transients)
                    }
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
                    const box = existingBox.unwrap()
                    if (box.transientMarkers.pointerHub.isEmpty()) {
                        applyTransients(box, transients)
                    }
                    return box
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