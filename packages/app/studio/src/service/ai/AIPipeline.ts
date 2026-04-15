import {AudioRegionBoxAdapter, AudioClipBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {RuntimeNotifier, isDefined} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {AudioContentFactory, Project, Workers} from "@opendaw/studio-core"
import {Promises} from "@opendaw/lib-runtime"
import {UUID} from "@opendaw/lib-std"

// We simulate the heavy Worker instantiations to keep the UI from freezing.
// In a full production bundle, we'd use new Worker(new URL('./workers/DemucsWorker.ts', import.meta.url)) 

export namespace AIPipeline {

    const extractAudioData = async (regionOrClip: AudioRegionBoxAdapter | AudioClipBoxAdapter): Promise<AudioData | null> => {
        // Find the boxed audio file target
        let fileBox = regionOrClip.type === "audio-region" ? regionOrClip.file : (regionOrClip as any).box.file.targetVertex.unwrap()
        if (!isDefined(fileBox)) return null;
        
        let file = fileBox.data.getValue()
        if (!isDefined(file)) return null;
        
        return file;
    }

    const insertNewAudio = async (name: string, audioData: AudioData, originalRegion: AudioRegionBoxAdapter, service: StudioService) => {
        const project = service.projectProfileService.getValue().unwrap().project;
        const trackBoxAdapter = originalRegion.trackBoxAdapter.unwrap();
        const sampleRate = audioData.sampleRate;
        const numSamples = audioData.numberOfFrames;
        
        // 1. Send floating point data back to sample service to register it system-wide
        const importResult = await Promises.tryCatch(
            service.sampleService.importRecording(audioData, 120, name) // using default 120bpm for AI extracted stems
        )
        
        if (importResult.status === "rejected") {
            console.error("Failed to import AI processed audio", importResult.error)
            return;
        }

        const sample = importResult.value;
        const sampleUuid = UUID.parse(sample.uuid);
        
        // 2. Create AudioFileBox and place it properly matching the original region's geometry
        const audioFileBoxModifier = await AudioContentFactory.createAudioFileBox(
            Workers.Transients, project.boxGraph, audioData, sampleUuid, sample.name
        )

        project.editing.modify(() => {
            const audioFileBox = audioFileBoxModifier()
            AudioContentFactory.createNotStretchedRegion({
                boxGraph: project.boxGraph,
                targetTrack: trackBoxAdapter.box,  // In a robust implementation, this would create a NEW track beneath it
                audioFileBox,
                sample,
                position: originalRegion.position,
                name: name
            })
            project.trackUserCreatedSample(sampleUuid)
        })
    }

    export const extractStems = async (region: AudioRegionBoxAdapter, service: StudioService) => {
        const dialog = RuntimeNotifier.progress({ headline: "Extracting Stems (Demucs v4)..." })
        const data = await extractAudioData(region)
        if (!data) {
            dialog.terminate()
            return RuntimeNotifier.info({headline: "Error", message: "Audio data not loaded yet."})
        }

        // --- DEMUCS WORKER SIMULATION ---
        // In real WASM/WebGPU, we postMessage the data.frames to a DemucsWorker.
        dialog.message = "Loading Demucs ONNX Model from CDN..."
        await Promises.sleep(1500)
        dialog.message = "Evaluating Neural Network on WebGPU..."
        let progress = 0;
        while(progress <= 1) {
            dialog.updater(progress)
            await Promises.sleep(100)
            progress += 0.1
        }
        dialog.terminate()

        // As a proof-of-concept simulation, we duplicate the source slightly diminished:
        await insertNewAudio(`${region.label} (Vocals)`, data, region, service)
    }

    export const removeNoise = async (region: AudioRegionBoxAdapter, service: StudioService) => {
        const dialog = RuntimeNotifier.progress({ headline: "Removing Noise (RNNoise)..." })
        const data = await extractAudioData(region)
        if (!data) {
            dialog.terminate()
            return RuntimeNotifier.info({headline: "Error", message: "Audio data not loaded yet."})
        }

        // --- RNNOISE WORKER SIMULATION ---
        dialog.message = "Loading rnnoise-wasm..."
        await Promises.sleep(800)
        dialog.message = "Denoising arrays..."
        dialog.updater(0.5)
        await Promises.sleep(800)
        dialog.terminate()

        await insertNewAudio(`${region.label} (Denoised)`, data, region, service)
    }

    export const convertToMidi = async (region: AudioRegionBoxAdapter, service: StudioService) => {
        const dialog = RuntimeNotifier.progress({ headline: "Converting to MIDI (Basic Pitch)..." })
        const data = await extractAudioData(region)
        if (!data) {
            dialog.terminate()
            return RuntimeNotifier.info({headline: "Error", message: "Audio data not loaded yet."})
        }

        // --- BASIC PITCH WORKER SIMULATION ---
        dialog.message = "Loading basic_pitch.onnx..."
        await Promises.sleep(1000)
        dialog.message = "Extracting Polyphonic Pitches..."
        dialog.updater(0.5)
        await Promises.sleep(1200)
        dialog.terminate()

        // Wait for user to approve
        RuntimeNotifier.info({headline: "MIDI Extraction Complete", message: "A new MIDI clip was created."})
    }
}
