import {CaptureAudio, MenuItem, Project} from "@opendaw/studio-core"
import {MonitoringDialog} from "@/ui/monitoring/MonitoringDialog"
import {Browser} from "@opendaw/lib-dom"
import {isInstanceOf, Option, Procedure} from "@opendaw/lib-std"
import {
    AudioUnitBoxAdapter,
    DeviceAccepts,
    TrackBoxAdapter,
    TrackType,
    TransferAudioUnits
} from "@opendaw/studio-adapters"
import {DebugMenus} from "@/ui/menu/debug"
import {MidiImport} from "@/ui/timeline/MidiImport.ts"
import {CaptureMidiBox} from "@opendaw/studio-boxes"
import {StudioService} from "@/service/StudioService"
import {MenuCapture} from "@/ui/timeline/tracks/audio-unit/menu/capture"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"

// The unit's menu. `optTrackBoxAdapter` is empty on the synthetic unit lane (a unit without a notes/audio
// track), where only the track-scoped entries drop out — everything else acts on the unit and stays reachable.
export const installTrackHeaderMenu = (service: StudioService,
                                       audioUnitBoxAdapter: AudioUnitBoxAdapter,
                                       optTrackBoxAdapter: Option<TrackBoxAdapter>): Procedure<MenuItem> => parent => {
    const inputAdapter = audioUnitBoxAdapter.input.adapter()
    if (inputAdapter.isEmpty()) {return parent}
    const accepts: DeviceAccepts = inputAdapter.unwrap("Cannot unwrap input adapter").accepts
    const acceptMidi = audioUnitBoxAdapter.captureBox.mapOr(box => isInstanceOf(box, CaptureMidiBox), false)
    // An input that accepts neither (a Playfield slot) has no track type to offer.
    const optTrackType = accepts === false ? Option.None : Option.wrap(DeviceAccepts.toTrackType(accepts))
    const {project} = service
    const {audioUnitFreeze, captureDevices, editing, userEditingManager, selection} = project
    const isFrozen = audioUnitFreeze.isFrozen(audioUnitBoxAdapter)
    return parent.addMenuItem(
        MenuItem.default({
            label: "Enabled",
            checked: optTrackBoxAdapter.mapOr(track => track.enabled.getValue(), false),
            hidden: optTrackBoxAdapter.isEmpty()
        }).setTriggerProcedure(() => optTrackBoxAdapter.ifSome(track =>
            editing.modify(() => track.enabled.toggle()))),
        MenuItem.default({
            label: optTrackType.mapOr(type => `New ${TrackType.toLabelString(type)} Track`, "New Track"),
            hidden: optTrackType.isEmpty()
        }).setTriggerProcedure(() => optTrackType.ifSome(type => editing.modify(() =>
            type === TrackType.Notes
                ? project.api.createNoteTrack(audioUnitBoxAdapter.box)
                : project.api.createAudioTrack(audioUnitBoxAdapter.box)))),
        MenuCapture.createItem(service, audioUnitBoxAdapter,
            optTrackBoxAdapter, editing, captureDevices.get(audioUnitBoxAdapter.uuid)),
        MenuItem.default({
            label: "Monitoring",
            hidden: captureDevices.get(audioUnitBoxAdapter.uuid)
                .mapOr(capture => !isInstanceOf(capture, CaptureAudio), true)
        }).setTriggerProcedure(() => {
            const optCapture = captureDevices.get(audioUnitBoxAdapter.uuid)
            if (optCapture.isEmpty()) {return}
            const capture = optCapture.unwrap()
            if (!isInstanceOf(capture, CaptureAudio)) {return}
            capture.armed.setValue(true)
            MonitoringDialog.open(service, capture).finally()
        }),
        MenuItem.default({
            label: "Force Mono",
            checked: captureDevices.get(audioUnitBoxAdapter.uuid)
                .mapOr(capture => isInstanceOf(capture, CaptureAudio)
                    ? capture.requestChannels.mapOr(channels => channels === 1, false)
                    : false, false),
            hidden: captureDevices.get(audioUnitBoxAdapter.uuid)
                .mapOr(capture => !isInstanceOf(capture, CaptureAudio), true)
        }).setTriggerProcedure(() => captureDevices.get(audioUnitBoxAdapter.uuid)
            .ifSome(capture => {
                if (isInstanceOf(capture, CaptureAudio)) {
                    const currentMono = capture.requestChannels.mapOr(channels => channels === 1, false)
                    editing.modify(() => capture.requestChannels = currentMono ? 2 : 1)
                }
            })),
        MenuItem.default({
            label: "Duplicate AudioUnit",
            shortcut: GlobalShortcuts["copy-device"].shortcut.format(),
            separatorBefore: true,
            hidden: audioUnitBoxAdapter.isOutput
        }).setTriggerProcedure(() => {
            const copies = editing.modify(() => TransferAudioUnits
                .transfer([audioUnitBoxAdapter.box], project.skeleton, {
                    insertIndex: audioUnitBoxAdapter.indexField.getValue() + 1
                }), false).unwrap("copyUnit")
            Option.wrap(copies.at(0)).ifSome(copy => userEditingManager.audioUnit.edit(copy.editing))
        }),
        MenuItem.default({
            label: "Freeze AudioUnit",
            hidden: !audioUnitBoxAdapter.isInstrument || isFrozen
        }).setTriggerProcedure(() => project.audioUnitFreeze.freeze(audioUnitBoxAdapter)),
        MenuItem.default({
            label: "Unfreeze AudioUnit",
            hidden: !audioUnitBoxAdapter.isInstrument || !isFrozen
        }).setTriggerProcedure(() => project.audioUnitFreeze.unfreeze(audioUnitBoxAdapter)),
        MenuItem.default({
            label: "Extract AudioUnit Into New Project",
            hidden: audioUnitBoxAdapter.isOutput
        }).setTriggerProcedure(async () => {
            if (!await service.projectProfileService.approveLosingChanges()) {return}
            const newProject = Project.new(service)
            editing.modify(() => {
                const {boxGraph, skeleton} = newProject
                boxGraph.beginTransaction()
                TransferAudioUnits.transfer([audioUnitBoxAdapter.box], skeleton)
                boxGraph.endTransaction()
            })
            service.projectProfileService.setProject(newProject, "NEW")
        }),
        MenuItem.default({
            label: "Select Clips",
            selectable: optTrackBoxAdapter.mapOr(track => !track.clips.collection.isEmpty(), false) && !isFrozen,
            hidden: optTrackBoxAdapter.isEmpty()
        }).setTriggerProcedure(() => optTrackBoxAdapter.ifSome(track => track.clips.collection.adapters()
            .forEach(clip => selection.select(clip.box)))),
        MenuItem.default({
            label: "Select Regions",
            selectable: optTrackBoxAdapter.mapOr(track => !track.regions.collection.isEmpty(), false) && !isFrozen,
            hidden: optTrackBoxAdapter.isEmpty()
        }).setTriggerProcedure(() => optTrackBoxAdapter.ifSome(track => track.regions.collection.asArray()
            .forEach(region => selection.select(region.box)))),
        MenuItem.default({
            label: "Compact Tracks",
            hidden: !Browser.isLocalHost(),
            selectable: !isFrozen,
            separatorBefore: true
        }).setTriggerProcedure(() => editing.modify(() =>
            project.api.compactTracks(audioUnitBoxAdapter.box))),
        MenuItem.default({
            label: "Import MIDI File...",
            hidden: !acceptMidi,
            selectable: !isFrozen,
            separatorBefore: true
        }).setTriggerProcedure(() => MidiImport.toTracks(project, audioUnitBoxAdapter)),
        MenuItem.default({
            label: `Delete '${audioUnitBoxAdapter.input.label.unwrapOrElse("No Input")}'`,
            selectable: !audioUnitBoxAdapter.isOutput,
            separatorBefore: true
        }).setTriggerProcedure(() => editing.modify(() =>
            project.api.deleteAudioUnit(audioUnitBoxAdapter.box))),
        MenuItem.default({
            label: optTrackBoxAdapter.mapOr(track => `Delete ${TrackType.toLabelString(track.type)} Track`, "Delete Track"),
            selectable: !audioUnitBoxAdapter.isOutput && !isFrozen,
            hidden: optTrackBoxAdapter.isEmpty() || audioUnitBoxAdapter.tracks.collection.size() === 1
        }).setTriggerProcedure(() => optTrackBoxAdapter.ifSome(track => editing.modify(() => {
            if (audioUnitBoxAdapter.tracks.collection.size() === 1) {
                project.api.deleteAudioUnit(audioUnitBoxAdapter.box)
            } else {
                audioUnitBoxAdapter.deleteTrack(track)
            }
        }))),
        DebugMenus.debugBox(audioUnitBoxAdapter.box)
    )
}