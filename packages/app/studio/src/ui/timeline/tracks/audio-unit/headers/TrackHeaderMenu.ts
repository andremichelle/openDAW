import {TrackGrouping} from "../TrackGrouping"
import {CaptureAudio, MenuItem, Project} from "@opendaw/studio-core"
import {MonitoringDialog} from "@/ui/monitoring/MonitoringDialog"
import {Browser} from "@opendaw/lib-dom"
import {isInstanceOf, Option, Procedure} from "@opendaw/lib-std"
import {
    AudioUnitBoxAdapter,
    AudioUnitGroups,
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
import {MenuChannelMapping} from "@/ui/timeline/tracks/audio-unit/menu/channel-mapping"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {MenuItems} from "@/ui/devices/menu-items"

// The unit lane and the first notes/audio track carry the unit's entries, every other track only its own.
export const installTrackHeaderMenu = (service: StudioService,
                                       audioUnitBoxAdapter: AudioUnitBoxAdapter,
                                       optTrackBoxAdapter: Option<TrackBoxAdapter>): Procedure<MenuItem> => parent => {
    const inputAdapter = audioUnitBoxAdapter.input.adapter()
    if (inputAdapter.isEmpty()) {return parent}
    const accepts: DeviceAccepts = inputAdapter.unwrap("Cannot unwrap input adapter").accepts
    const acceptMidi = audioUnitBoxAdapter.captureBox.mapOr(box => isInstanceOf(box, CaptureMidiBox), false)
    // An input that accepts neither (a Playfield slot) has no track type to offer.
    const optTrackType = accepts === false || AudioUnitGroups.isGroup(audioUnitBoxAdapter.box) ? Option.None : Option.wrap(DeviceAccepts.toTrackType(accepts))
    const {project} = service
    TrackGrouping.selectForMenu(project, audioUnitBoxAdapter.box)
    const {audioUnitFreeze, captureDevices, editing, selection} = project
    const isFrozen = audioUnitFreeze.isFrozen(audioUnitBoxAdapter)
    const unitLevel = optTrackBoxAdapter.mapOr(track =>
        audioUnitBoxAdapter.tracks.values().find(other => other.type !== TrackType.Value) === track, true)
    const unitOnly = (item: MenuItem): MenuItem => unitLevel ? item : item.isHidden()
    const importsToLane: Option<TrackBoxAdapter> =
        !unitLevel && optTrackBoxAdapter.mapOr(track => track.type === TrackType.Notes, false) ? optTrackBoxAdapter : Option.None
    // the open menu outlives graph changes (undo, a live-room update), so every action re-checks its boxes
    const guarded = (procedure: Procedure<MenuItem>): Procedure<MenuItem> => item => {
        if (!audioUnitBoxAdapter.box.isAttached()) {return}
        if (optTrackBoxAdapter.mapOr(track => !track.box.isAttached(), false)) {return}
        procedure(item)
    }
    return parent.addMenuItem(
        ...TrackGrouping.groupingMenuItems(project, audioUnitBoxAdapter.box).map(unitOnly),
        MenuItem.default({
            label: "Enabled",
            checked: optTrackBoxAdapter.mapOr(track => track.enabled.getValue(), false),
            hidden: optTrackBoxAdapter.isEmpty()
        }).setTriggerProcedure(guarded(() => optTrackBoxAdapter.ifSome(track =>
            editing.modify(() => track.enabled.toggle())))),
        MenuItem.default({
            label: optTrackType.mapOr(type => `New ${TrackType.toLabelString(type)} Track`, "New Track"),
            hidden: optTrackType.isEmpty() || !unitLevel
        }).setTriggerProcedure(guarded(() => optTrackType.ifSome(type => editing.modify(() =>
            type === TrackType.Notes
                ? project.api.createNoteTrack(audioUnitBoxAdapter.box)
                : project.api.createAudioTrack(audioUnitBoxAdapter.box))))),
        unitOnly(MenuCapture.createItem(service, audioUnitBoxAdapter,
            optTrackBoxAdapter, editing, captureDevices.get(audioUnitBoxAdapter.uuid))),
        MenuItem.default({
            label: "Monitoring",
            hidden: !unitLevel || captureDevices.get(audioUnitBoxAdapter.uuid)
                .mapOr(capture => !isInstanceOf(capture, CaptureAudio), true)
        }).setTriggerProcedure(guarded(() => {
            const optCapture = captureDevices.get(audioUnitBoxAdapter.uuid)
            if (optCapture.isEmpty()) {return}
            const capture = optCapture.unwrap()
            if (!isInstanceOf(capture, CaptureAudio)) {return}
            capture.armed.setValue(true)
            MonitoringDialog.open(service, capture).finally()
        })),
        unitOnly(MenuChannelMapping.createItem(captureDevices.get(audioUnitBoxAdapter.uuid), editing, guarded)),
        MenuItem.default({
            label: "Duplicate AudioUnit",
            shortcut: GlobalShortcuts["copy-device"].shortcut.format(),
            separatorBefore: true,
            hidden: !unitLevel || audioUnitBoxAdapter.isOutput,
            selectable: project.audioUnitSelection.nonEmpty()
        }).setTriggerProcedure(guarded(() => TrackGrouping.duplicateSelectedTracks(project))),
        unitOnly(MenuItems.copyAudioUnit(audioUnitBoxAdapter)),
        MenuItem.default({
            label: "Freeze AudioUnit",
            hidden: !unitLevel || !audioUnitBoxAdapter.isInstrument || isFrozen
        }).setTriggerProcedure(guarded(() => project.audioUnitFreeze.freeze(audioUnitBoxAdapter))),
        MenuItem.default({
            label: "Unfreeze AudioUnit",
            hidden: !unitLevel || !audioUnitBoxAdapter.isInstrument || !isFrozen
        }).setTriggerProcedure(guarded(() => project.audioUnitFreeze.unfreeze(audioUnitBoxAdapter))),
        MenuItem.default({
            label: "Extract AudioUnit Into New Project",
            hidden: !unitLevel || audioUnitBoxAdapter.isOutput
        }).setTriggerProcedure(guarded(async () => {
            if (!await service.projectProfileService.approveLosingChanges()) {return}
            const newProject = Project.new(service)
            editing.modify(() => {
                const {boxGraph, skeleton} = newProject
                boxGraph.beginTransaction()
                TransferAudioUnits.transfer([audioUnitBoxAdapter.box], skeleton, {includeGroupDescendants: true, layoutOrder: true})
                boxGraph.endTransaction()
            })
            service.projectProfileService.setProject(newProject, "NEW")
        })),
        MenuItem.default({
            label: "Select Clips",
            selectable: optTrackBoxAdapter.mapOr(track => !track.clips.collection.isEmpty(), false) && !isFrozen,
            hidden: optTrackBoxAdapter.isEmpty()
        }).setTriggerProcedure(guarded(() => optTrackBoxAdapter.ifSome(track => track.clips.collection.adapters()
            .forEach(clip => selection.select(clip.box))))),
        MenuItem.default({
            label: "Select Regions",
            selectable: optTrackBoxAdapter.mapOr(track => !track.regions.collection.isEmpty(), false) && !isFrozen,
            hidden: optTrackBoxAdapter.isEmpty()
        }).setTriggerProcedure(guarded(() => optTrackBoxAdapter.ifSome(track => track.regions.collection.asArray()
            .forEach(region => selection.select(region.box))))),
        MenuItem.default({
            label: "Compact Tracks",
            hidden: !unitLevel || !Browser.isLocalHost(),
            selectable: !isFrozen,
            separatorBefore: true
        }).setTriggerProcedure(guarded(() => editing.modify(() =>
            project.api.compactTracks(audioUnitBoxAdapter.box)))),
        MenuItem.default({
            label: "Import MIDI File...",
            hidden: !acceptMidi || (!unitLevel && importsToLane.isEmpty()),
            selectable: !isFrozen,
            separatorBefore: true
        }).setTriggerProcedure(guarded(() => MidiImport.toTracks(project, audioUnitBoxAdapter, importsToLane))),
        unitOnly(MenuItem.default({
            label: `Delete '${audioUnitBoxAdapter.input.label.unwrapOrElse("No Input")}'`,
            selectable: !audioUnitBoxAdapter.isOutput,
            separatorBefore: true
        }).setTriggerProcedure(guarded(() => editing.modify(() =>
            project.api.deleteAudioUnit(audioUnitBoxAdapter.box))))),
        MenuItem.default({
            label: optTrackBoxAdapter.mapOr(track => `Delete ${TrackType.toLabelString(track.type)} Track`, "Delete Track"),
            selectable: !audioUnitBoxAdapter.isOutput && !isFrozen,
            hidden: optTrackBoxAdapter.isEmpty() || audioUnitBoxAdapter.tracks.collection.size() === 1,
            separatorBefore: !unitLevel
        }).setTriggerProcedure(guarded(() => optTrackBoxAdapter.ifSome(track => editing.modify(() => {
            if (audioUnitBoxAdapter.tracks.collection.size() === 1) {
                project.api.deleteAudioUnit(audioUnitBoxAdapter.box)
            } else {
                audioUnitBoxAdapter.deleteTrack(track)
            }
        })))),
        DebugMenus.debugBox(audioUnitBoxAdapter.box)
    )
}