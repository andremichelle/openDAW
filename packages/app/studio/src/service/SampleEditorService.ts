import {
    Arrays,
    DefaultObservableValue,
    Errors,
    isDefined,
    MutableObservableOption,
    Objects,
    Option,
    RuntimeNotifier,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {Files} from "@opendaw/lib-dom"
import {RouteLocation} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {AudioData, AudioSplice, SampleEffect, WavFile} from "@opendaw/lib-dsp"
import {AudioFileBoxAdapter, Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {AudioMonoConversion, FilePickerAcceptTypes, Workers} from "@opendaw/studio-core"
import {SampleDocument, SampleSource} from "@/ui/pages/sample-editor/SampleDocument"
import {SampleEditorDialogs} from "@/ui/pages/sample-editor/SampleEditorDialogs"
import type {StudioService} from "@/service/StudioService"

export const SampleEditorRoute = "/sample-editor"

export class SampleEditorService {
    static #setDuration(box: AudioFileBox, {numberOfFrames, sampleRate}: AudioData): void {
        box.endInSeconds.setValue(box.startInSeconds.getValue() + numberOfFrames / sampleRate)
    }

    readonly document: MutableObservableOption<SampleDocument>
    readonly clipboard: MutableObservableOption<AudioData>
    readonly #service: StudioService
    readonly #effectValues: Map<string, ReadonlyArray<number>>

    #fileBox: Option<AudioFileBox>

    constructor(service: StudioService) {
        this.#service = service
        this.document = new MutableObservableOption<SampleDocument>()
        this.clipboard = new MutableObservableOption<AudioData>()
        this.#effectValues = new Map()
        this.#fileBox = Option.None
    }

    get hasUnsavedChanges(): boolean {return this.document.mapOr(document => document.hasUnsavedChanges, false)}

    canSave(document: SampleDocument): boolean {
        return document.source.mapOr(({meta}) => meta.origin !== "openDAW", false) && document.audio.numberOfFrames > 0
    }

    navigate(): void {RouteLocation.get().navigateTo(SampleEditorRoute)}

    async openSample(sample: Sample): Promise<void> {
        if (!await this.#approveDiscard()) {return}
        const uuid = UUID.parse(sample.uuid)
        const audio = await this.#load(sample.name, this.#service.sampleManager.getAudioData(uuid))
        audio.ifSome(audio => this.#open(new SampleDocument(audio, sample.name,
            Option.wrap({uuid, meta: Objects.exclude(sample, "uuid")})), Option.None))
    }

    async openFile(file: AudioFileBoxAdapter): Promise<void> {
        if (!await this.#approveDiscard()) {return}
        const audio = await this.#load(file.fileName, file.audioData)
        audio.ifSome(audio => {
            const meta: SampleMetaData = file.getOrCreateLoader().meta.unwrapOrElse(() => ({
                name: file.fileName, bpm: 0, duration: audio.numberOfFrames / audio.sampleRate,
                sample_rate: audio.sampleRate, origin: "import"
            }))
            this.#open(new SampleDocument(audio, file.fileName, Option.wrap({uuid: file.uuid, meta})),
                Option.wrap(file.box))
        })
    }

    async importFile(): Promise<void> {
        if (!await this.#approveDiscard()) {return}
        const {status, value: files, error} = await Promises.tryCatch(Files.open(FilePickerAcceptTypes.WavFiles))
        if (status === "rejected") {
            if (Errors.isAbort(error)) {return}
            throw error
        }
        const file = files.at(0)
        if (!isDefined(file)) {return}
        const name = file.name.replace(/\.[^.]+$/, "")
        const audio = await this.#load(name, file.arrayBuffer().then(buffer => this.#decode(buffer)))
        audio.ifSome(audio => this.#open(new SampleDocument(audio, name, Option.None), Option.None))
    }

    async openPicker(): Promise<void> {
        const {status, value: sample} = await Promises.tryCatch(
            SampleEditorDialogs.pickSample(await this.#service.sampleService.list()))
        if (status === "rejected") {return}
        return this.openSample(sample)
    }

    async openRecording(audio: AudioData): Promise<void> {
        if (!await this.#approveDiscard()) {return}
        this.#open(new SampleDocument(audio, "Recording", Option.None), Option.None)
    }

    async close(): Promise<void> {
        if (!await this.#approveDiscard()) {return}
        this.#fileBox = Option.None
        this.document.clear()
    }

    async save(document: SampleDocument): Promise<void> {
        if (!this.canSave(document)) {return}
        const {uuid, meta} = document.source.unwrap()
        const approved = await RuntimeNotifier.approve({
            headline: "Overwrite Sample",
            message: `'${document.name}' is replaced in storage. Every project using it plays the edited version.`,
            approveText: "Overwrite",
            cancelText: "Cancel"
        })
        if (!approved) {return}
        await this.#store(document, uuid, document.name, meta.bpm).then(source => source.ifSome(source => {
            this.#service.sampleManager.invalidate(uuid)
            this.#service.optProject.ifSome(project => project.boxGraph.findBox<AudioFileBox>(uuid).ifSome(box =>
                project.editing.modify(() => SampleEditorService.#setDuration(box, document.audio))))
            document.markSaved(source, document.name)
        }))
    }

    async saveAs(document: SampleDocument): Promise<void> {
        if (document.audio.numberOfFrames === 0) {
            return RuntimeNotifier.info({headline: "Empty Sample", message: "There is no audio to save."})
        }
        const name = document.source.isEmpty() ? document.name : `${document.name} (edited)`
        const bpm = document.source.mapOr(({meta}) => meta.bpm, 0)
        const source = await this.#store(document, UUID.generate(), name, bpm)
        if (source.isEmpty()) {return}
        document.markSaved(source.unwrap(), name)
        await this.#offerProjectReplacement(source.unwrap().uuid)
    }

    async exportFile(document: SampleDocument): Promise<void> {
        if (document.audio.numberOfFrames === 0) {return}
        const {status, value} = await Promises.tryCatch(SampleEditorDialogs.chooseFormat())
        if (status === "rejected") {return}
        const buffer = await value.encode(document.audio)
        return Files.saveWithApproval({buffer, headline: `Save ${value.label}`, suggestedName: `${document.name}.${value.extension}`})
    }

    async applyEffect(document: SampleDocument, effect: SampleEffect): Promise<void> {
        const values = await this.#valuesFor(effect)
        if (values.isEmpty()) {return}
        const audio = document.audio
        const {from, to} = effect.wholeSample || !document.hasSelection
            ? {from: 0, to: audio.numberOfFrames}
            : document.selection.getValue()
        if (to <= from) {return}
        const progress = new DefaultObservableValue(0.0)
        let cancelled = false
        const dialog = RuntimeNotifier.progress({headline: effect.name, progress, cancel: () => cancelled = true})
        const result = await Promises.tryCatch(Workers.SampleEffect.process(
            value => progress.setValue(value), effect.id, AudioSplice.slice(audio, from, to), values.unwrap()))
        dialog.terminate()
        if (cancelled || document.audio !== audio) {return}
        if (result.status === "rejected") {
            console.warn(result.error)
            return RuntimeNotifier.info({headline: effect.name, message: `The effect failed: ${String(result.error)}`})
        }
        const selection = document.selection.getValue()
        document.replace(from, to - from, result.value, effect.wholeSample ? {from: 0, to: 0} : selection)
    }

    async #valuesFor(effect: SampleEffect): Promise<Option<ReadonlyArray<number>>> {
        if (effect.parameters.length === 0) {return Option.wrap([])}
        const previous = this.#effectValues.get(effect.id) ?? SampleEffect.defaultsOf(effect)
        const {status, value} = await Promises.tryCatch(SampleEditorDialogs.editParameters(effect, previous))
        if (status === "rejected") {return Option.None}
        this.#effectValues.set(effect.id, value)
        return Option.wrap(value)
    }

    async #store(document: SampleDocument, uuid: UUID.Bytes, name: string, bpm: number): Promise<Option<SampleSource>> {
        const progress = RuntimeNotifier.progress({headline: "Saving Sample...", message: name})
        const {status, value: sample, error} = await Promises.tryCatch(this.#service.sampleService.importFile({
            uuid, name, bpm, arrayBuffer: WavFile.encodeFloats(document.audio)
        }))
        progress.terminate()
        if (status === "rejected") {
            console.warn(error)
            await RuntimeNotifier.info({headline: "Could not save", message: String(error)})
            return Option.None
        }
        return Option.wrap({uuid, meta: Objects.exclude(sample, "uuid")})
    }

    async #offerProjectReplacement(uuid: UUID.Bytes): Promise<void> {
        if (this.#fileBox.isEmpty()) {return}
        const original = this.#fileBox.unwrap()
        const project = this.#service.optProject
        if (project.isEmpty() || project.unwrap().boxGraph.findBox(original.address.uuid).isEmpty()) {
            this.#fileBox = Option.None
            return
        }
        const approved = await RuntimeNotifier.approve({
            headline: "Use in Project",
            message: `Replace '${original.fileName.getValue()}' in the project with the edited sample? The original stays in storage.`,
            approveText: "Replace",
            cancelText: "Keep"
        })
        if (!approved) {return}
        const target = project.unwrap()
        const audio = this.document.unwrap().audio
        this.#fileBox = target.editing.modify(() => {
            const box = AudioMonoConversion.replace(target, original, uuid, true)
            SampleEditorService.#setDuration(box, audio)
            return box
        })
    }

    async #approveDiscard(): Promise<boolean> {
        if (!this.hasUnsavedChanges) {return true}
        return RuntimeNotifier.approve({
            headline: "Unsaved Changes",
            message: `'${this.document.unwrap().name}' has unsaved changes.`,
            approveText: "Discard",
            cancelText: "Cancel"
        })
    }

    async #load(name: string, audio: Promise<AudioData>): Promise<Option<AudioData>> {
        const progress = RuntimeNotifier.progress({headline: "Loading Sample...", message: name})
        const {status, value, error} = await Promises.tryCatch(audio)
        progress.terminate()
        if (status === "rejected") {
            await RuntimeNotifier.info({headline: "Could not load", message: String(error)})
            return Option.None
        }
        return Option.wrap(value)
    }

    async #decode(buffer: ArrayBuffer): Promise<AudioData> {
        const wav = tryCatch(() => WavFile.decodeFloats(buffer))
        const decoded = wav.status === "success"
            ? {sampleRate: wav.value.sampleRate, frames: wav.value.frames}
            : await this.#service.audioContext.decodeAudioData(buffer).then(audioBuffer => ({
                sampleRate: audioBuffer.sampleRate,
                frames: Arrays.create(index => audioBuffer.getChannelData(index), audioBuffer.numberOfChannels)
            }))
        const numberOfFrames = decoded.frames[0]?.length ?? 0
        const audio = AudioData.create(decoded.sampleRate, numberOfFrames, decoded.frames.length)
        decoded.frames.forEach((channel, index) => audio.frames[index].set(channel))
        return audio
    }

    #open(document: SampleDocument, fileBox: Option<AudioFileBox>): void {
        this.#fileBox = fileBox
        this.document.wrap(document)
        this.navigate()
    }
}
