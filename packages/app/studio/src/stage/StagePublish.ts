import {int, Procedure, Progress, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {OpusEncoder, ProjectBundle, ProjectProfile} from "@opendaw/studio-core"
import {OpusMixdown} from "@/audio/OpusMixdown"
import {StageClient} from "@/stage/StageClient"
import {encodeCover} from "@/ui/info-panel/CoverImage"

export namespace StagePublish {
    export type Options = Readonly<{
        includeProject: boolean
        allowMixdownDownload: boolean
    }>

    export type Step = "Bundling project" | "Rendering mixdown" | "Encoding Opus" | "Uploading" | "Publishing"

    const HighQualityOpus: OpusEncoder.Settings = {
        numberOfChannels: 2, bitrate: 320, complexity: 10, frameDuration: 20_000, variable: true, application: "audio"
    }

    const PeakPairs = 2048
    const StageCoverSize = 1000
    const MaxTags = 16

    export const trackId = (profile: ProjectProfile): string => UUID.toString(profile.uuid)

    export const peaks = (audio: AudioData): ArrayBuffer => {
        const {numberOfFrames, frames} = audio
        const result = new Int8Array(PeakPairs * 2)
        const toByte = (value: number): int => Math.round(Math.max(-1.0, Math.min(1.0, value)) * 127)
        for (let pair = 0; pair < PeakPairs; pair++) {
            const from = Math.floor(pair * numberOfFrames / PeakPairs)
            const to = Math.max(from + 1, Math.floor((pair + 1) * numberOfFrames / PeakPairs))
            let min = 0.0
            let max = 0.0
            for (const channel of frames) {
                for (let index = from; index < to && index < numberOfFrames; index++) {
                    const value = channel[index]
                    if (value < min) {min = value}
                    if (value > max) {max = value}
                }
            }
            result[pair * 2] = toByte(min)
            result[pair * 2 + 1] = toByte(max)
        }
        return result.buffer
    }

    export const publish = async (credentials: StageClient.Credentials, profile: ProjectProfile, options: Options,
                                  onStep: Procedure<Step>, progress: Progress.Handler): Promise<StageClient.Published> => {
        const cover = profile.cover
        if (cover.isEmpty()) {throw new StageClient.Failure("Add a cover in the project info first.", 0)}
        const [bundleProgress, renderProgress, encodeProgress, uploadProgress] =
            Progress.splitWithWeights(progress, [options.includeProject ? 1 : 0.01, 3, 2, 4])
        const track = trackId(profile)
        let bundle: ArrayBuffer = new ArrayBuffer(0)
        if (options.includeProject) {
            onStep("Bundling project")
            bundle = await ProjectBundle.encode(profile.copyForUpload(), bundleProgress)
        }
        onStep("Rendering mixdown")
        const audio = await OpusMixdown.render(profile.project, renderProgress)
        onStep("Encoding Opus")
        const {bytes: mixdown} = await OpusMixdown.encode(audio, HighQualityOpus, encodeProgress)
        const {name, artist, description, tags} = profile.meta
        const meta = {
            title: name.trim().length > 0 ? name.trim() : "Untitled", artist, description,
            tags: tags.map(tag => tag.trim()).filter(tag => tag.length > 0).slice(0, MaxTags),
            bpm: profile.project.timelineBox.bpm.getValue(),
            duration: audio.numberOfFrames / audio.sampleRate,
            downloads: {mixdown: options.allowMixdownDownload}
        }
        const files: Array<[StageClient.FileName, ArrayBuffer]> = [
            ["meta.json", new TextEncoder().encode(JSON.stringify(meta)).buffer],
            ["cover", await encodeCover(cover.unwrap(), StageCoverSize)],
            ["peaks.bin", peaks(audio)],
            ["mixdown.opus", mixdown]
        ]
        if (options.includeProject) {files.push(["project.odb", bundle])}
        onStep("Uploading")
        const total = files.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0)
        let sent = 0
        await StageClient.begin(credentials, track)
        await Promise.all(files.map(([file, bytes]) => StageClient.sendFile(credentials, track, file, bytes, count => {
            sent += count
            uploadProgress(sent / total)
        })))
        onStep("Publishing")
        return StageClient.publish(credentials, track)
    }
}
