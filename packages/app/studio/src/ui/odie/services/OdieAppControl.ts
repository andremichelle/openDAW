import { StudioService } from "../../../service/StudioService"
import { OdieProjectController } from "./controllers/OdieProjectController"
import { OdieTransportController } from "./controllers/OdieTransportController"
import { OdieMixerController } from "./controllers/OdieMixerController"
import { OdieDeviceController } from "./controllers/OdieDeviceController"
import { OdieSequenceController } from "./controllers/OdieSequenceController"
import { OdieExportController } from "./controllers/OdieExportController"
import { OdieViewController } from "./controllers/OdieViewController"
import { AutomatableParameterFieldAdapter } from "@opendaw/studio-adapters"
import { MidiNoteDef, ToolResult, TrackDetails } from "../OdieTypes"

/**
 * OdieAppControl
 *
 * This class serves as a Facade for the Odie system, delegating specific
 * responsibilities to specialized sub-controllers.
 */
export class OdieAppControl {
    private readonly projectController: OdieProjectController
    private readonly transportController: OdieTransportController
    private readonly mixerController: OdieMixerController
    private readonly deviceController: OdieDeviceController
    private readonly sequenceController: OdieSequenceController
    private readonly exportController: OdieExportController
    private readonly viewController: OdieViewController

    constructor(private readonly studio: StudioService) {
        this.projectController = new OdieProjectController(studio)
        this.transportController = new OdieTransportController(studio)
        this.mixerController = new OdieMixerController(studio)
        this.deviceController = new OdieDeviceController(studio)
        this.sequenceController = new OdieSequenceController(studio)
        this.exportController = new OdieExportController(studio)
        this.viewController = new OdieViewController(studio)
    }

    // Facade Methods - Project
    listTracks(): string[] { return this.projectController.listTracks() }
    async addTrack(type: string, name?: string): Promise<ToolResult> { return this.projectController.addTrack(type as any, name) }
    async newProject(): Promise<ToolResult> { return this.projectController.resetProject() }
    async createProject(): Promise<ToolResult> { return this.projectController.resetProject() }
    async addAuxTrack(name: string = "Aux"): Promise<ToolResult> { return this.projectController.addAuxTrack(name) }
    async setTrackRouting(trackName: string, destinationName: string): Promise<ToolResult> { return this.projectController.setTrackRouting(trackName, destinationName) }
    async setRouting(sourceName: string, targetName: string): Promise<ToolResult> { return this.projectController.setTrackRouting(sourceName, targetName) }
    async deleteTrack(trackName: string): Promise<ToolResult> { return this.projectController.deleteTrack(trackName) }
    async loadProject(): Promise<boolean> { return this.projectController.loadProject() }
    async loadTemplate(name: string): Promise<boolean> { return this.projectController.loadTemplate(name) }
    async saveProject(): Promise<ToolResult> { return this.projectController.saveProject() }
    getProjectOverview(): string { return this.projectController.getProjectOverview() }

    async play(): Promise<boolean> { return this.transportController.play() }
    async stop(): Promise<boolean> { return this.transportController.stop() }
    async record(countIn: boolean = true): Promise<boolean> { return this.transportController.record(countIn) }
    async stopRecording(): Promise<boolean> { return this.transportController.stopRecording() }
    async setCountIn(bars: number): Promise<boolean> { return this.transportController.setCountIn(bars) }
    async selectTrack(name: string): Promise<boolean> { return this.transportController.selectTrack(name) }
    async setLoop(enabled: boolean): Promise<boolean> { return this.transportController.setLoop(enabled) }
    async setBpm(bpm: number): Promise<ToolResult> { return this.transportController.setBpm(bpm) }
    async setTimeSignature(numerator: number, denominator: number): Promise<ToolResult> { return this.transportController.setTimeSignature(numerator, denominator) }
    async setTimelinePosition(bar: number): Promise<boolean> { return this.transportController.setTimelinePosition(bar) }

    // Facade Methods - Mixer
    async setVolume(trackName: string, value: number): Promise<ToolResult> { return this.mixerController.setVolume(trackName, value) }
    async setPan(trackName: string, value: number): Promise<ToolResult> { return this.mixerController.setPan(trackName, value) }
    async setMute(trackName: string, enabled: boolean): Promise<ToolResult> { return this.mixerController.setMute(trackName, enabled) }
    async mute(trackName: string, enabled: boolean): Promise<ToolResult> { return this.mixerController.setMute(trackName, enabled) }
    async setSolo(trackName: string, enabled: boolean): Promise<ToolResult> { return this.mixerController.setSolo(trackName, enabled) }
    async solo(trackName: string, enabled: boolean): Promise<ToolResult> { return this.mixerController.setSolo(trackName, enabled) }
    async addSend(trackName: string, busName: string, db: number = -6.0): Promise<ToolResult> { return this.mixerController.addSend(trackName, busName, db) }

    // Facade Methods - Device
    async addEffect(trackName: string, effectName: string): Promise<ToolResult> { return this.deviceController.addEffect(trackName, effectName) }
    async addMidiEffect(trackName: string, effectName: string): Promise<ToolResult> { return this.deviceController.addEffect(trackName, effectName) }
    async setEffectParam(trackName: string, effectIndex: number, paramPath: string, value: number): Promise<ToolResult> { return this.deviceController.setEffectParam(trackName, effectIndex, paramPath, value) }
    async setInstrumentParam(trackName: string, paramPath: string, value: number): Promise<ToolResult> { return this.deviceController.setInstrumentParam(trackName, paramPath, value) }
    async setDeviceParam(trackName: string, deviceType: "effect" | "instrument" | "mixer" | "midiEffect", deviceIndex: number, paramPath: string, value: number): Promise<ToolResult> { return this.deviceController.setDeviceParam(trackName, deviceType, deviceIndex, paramPath, value) }
    async getTrackDetails(trackName: string): Promise<ToolResult<TrackDetails>> { return this.deviceController.getTrackDetails(trackName) }
    async listSamples(): Promise<{ uuid: string, name: string }[]> { return this.deviceController.listSamples() }
    async listSoundfonts(): Promise<{ uuid: string, name: string }[]> { return this.deviceController.listSoundfonts() }
    async setNanoSample(trackName: string, query: string): Promise<ToolResult> { return this.deviceController.setNanoSample(trackName, query) }
    async setPlayfieldPad(trackName: string, padIndex: number, query: string): Promise<ToolResult> { return this.deviceController.setPlayfieldPad(trackName, padIndex, query) }
    async setSoundfont(trackName: string, query: string): Promise<ToolResult> { return this.deviceController.setSoundfont(trackName, query) }

    // Facade Methods - Sequence
    async addNoteClip(trackName: string, label: string, notes: MidiNoteDef[]): Promise<ToolResult> { return this.sequenceController.addNoteClip(trackName, label, notes) }
    async addNote(trackName: string, pitch: number, bar: number, duration: number, velocity: number = 0.8): Promise<ToolResult> { return this.sequenceController.addNote(trackName, pitch, bar, duration, velocity) }
    async addMidiNotes(trackName: string, notes: MidiNoteDef[]): Promise<ToolResult> { return this.sequenceController.addMidiNotes(trackName, notes) }
    async getMidiNotes(trackName: string): Promise<{ notes: MidiNoteDef[], logs: string[] }> { return this.sequenceController.getMidiNotes(trackName) }
    async analyzeTrack(trackName: string): Promise<ToolResult> { return this.sequenceController.analyzeTrack(trackName) }
    async splitRegion(trackName: string, bar: number): Promise<ToolResult> { return this.sequenceController.splitRegion(trackName, bar) }
    async moveRegion(trackName: string, fromBar: number, toBar: number): Promise<ToolResult> { return this.sequenceController.moveRegion(trackName, fromBar, toBar) }
    async copyRegion(trackName: string, fromBar: number, toBar: number): Promise<ToolResult> { return this.sequenceController.copyRegion(trackName, fromBar, toBar) }
    async inspectSelection(): Promise<ToolResult> { return await this.sequenceController.inspectSelection() }
    async verifyAction(action: string, details?: any): Promise<ToolResult> { return this.sequenceController.verifyAction(action, details) }
    async projectInspectGraph(): Promise<ToolResult> { return this.sequenceController.projectInspectGraph() }

    // Facade Methods - Export
    async exportMixdown(): Promise<boolean> { return this.exportController.exportMixdown() }
    async exportStems(): Promise<boolean> { return this.exportController.exportStems() }
    async importAudio(trackName: string, durationSeconds?: number): Promise<ToolResult> { return this.exportController.importAudio(trackName, durationSeconds) }

    // Facade Methods - View
    async switchScreen(screen: string): Promise<boolean> { return this.viewController.switchScreen(screen) }
    async toggleKeyboard(): Promise<boolean> { return this.viewController.toggleKeyboard() }

    // Feedback helper
    // @ts-ignore - Used by OdieBot via OdieAppControl
    private emitFeedback(message: string, targetId?: string) {
        this.studio.odieEvents.notify({ type: "ui-feedback", message, targetId })
    }

    resolveParameter(path: string): AutomatableParameterFieldAdapter<number> | null {
        return this.deviceController.resolveParameter(path)
    }
}
