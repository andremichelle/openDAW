import {Errors, int, isDefined, Option, panic, Progress, Terminator, TimeSpan} from "@moises-ai/lib-std"
import {AnimationFrame} from "@moises-ai/lib-dom"
import {Wait} from "@moises-ai/lib-runtime"
import {ExportStemsConfiguration} from "@moises-ai/studio-adapters"
import {Project} from "./project"
import {AudioWorklets} from "./AudioWorklets"

/** @deprecated */
export namespace AudioOfflineRenderer {
    /** @deprecated */
    export const start = async (source: Project,
                                optExportConfiguration: Option<ExportStemsConfiguration>,
                                progress: Progress.Handler,
                                abortSignal?: AbortSignal,
                                sampleRate: int = 48_000): Promise<AudioBuffer> => {
        const numStems = ExportStemsConfiguration.countStems(optExportConfiguration)
        if (numStems === 0) {return panic("Nothing to export")}
        const {promise, reject, resolve} = Promise.withResolvers<AudioBuffer>()
        const projectCopy = source.copy()
        const terminator = new Terminator()
        projectCopy.boxGraph.beginTransaction()
        projectCopy.timelineBox.loopArea.enabled.setValue(false)
        projectCopy.boxGraph.endTransaction()
        const durationInPulses = projectCopy.timelineBox.durationInPulses.getValue()
        const numSamples = Math.ceil(projectCopy.tempoMap.intervalToSeconds(0, durationInPulses) * sampleRate)
        const context = new OfflineAudioContext(numStems * 2, numSamples, sampleRate)
        const durationInSeconds = numSamples / sampleRate
        const worklets = await AudioWorklets.createFor(context)
        const engineWorklet = worklets.createEngine({
            project: projectCopy,
            exportConfiguration: optExportConfiguration.unwrapOrUndefined()
        })
        engineWorklet.play()
        engineWorklet.connect(context.destination)
        await engineWorklet.isReady()
        while (!await engineWorklet.queryLoadingComplete()) {await Wait.timeSpan(TimeSpan.seconds(1))}

        if (isDefined(abortSignal)) {
            abortSignal.onabort = () => {
                engineWorklet.stop(true)
                engineWorklet.sleep()
                terminator.terminate()
                cancelled = true
                reject(Errors.AbortError)
            }
        }

        // Start rendering...
        let cancelled = false
        terminator.ownAll(
            projectCopy,
            AnimationFrame.add(() => progress(context.currentTime / durationInSeconds))
        )
        context.startRendering().then(buffer => {
            console.debug(`rendering complete. cancelled: ${cancelled}`)
            if (!cancelled) {
                terminator.terminate()
                resolve(buffer)
            }
        }, reason => reject(reason))
        return promise
    }
}