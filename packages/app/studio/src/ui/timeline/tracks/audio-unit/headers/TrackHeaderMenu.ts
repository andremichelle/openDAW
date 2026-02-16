import {CaptureAudio, MenuItem, MonitoringMode, Project} from "@opendaw/studio-core"
import {isInstanceOf, Procedure, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, DeviceAccepts, TrackBoxAdapter, TrackType, TransferAudioUnits} from "@opendaw/studio-adapters"
import {DebugMenus} from "@/ui/menu/debug"
import {MidiImport} from "@/ui/timeline/MidiImport.ts"
import {CaptureMidiBox, TrackBox} from "@opendaw/studio-boxes"
import {StudioService} from "@/service/StudioService"
import {MenuCapture} from "@/ui/timeline/tracks/audio-unit/menu/capture"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"

export const installTrackHeaderMenu = (service: StudioService,
                                       audioUnitBoxAdapter: AudioUnitBoxAdapter,
                                       trackBoxAdapter: TrackBoxAdapter): Procedure<MenuItem> => parent => {
    const inputAdapter = audioUnitBoxAdapter.input.adapter()
    if (inputAdapter.isEmpty()) {return parent}
    const accepts: DeviceAccepts = inputAdapter.unwrap("Cannot unwrap input adapter").accepts
    const acceptMidi = audioUnitBoxAdapter.captureBox.mapOr(box => isInstanceOf(box, CaptureMidiBox), false)
    const trackType = DeviceAccepts.toTrackType(accepts)
    const {project} = service
    const {captureDevices, editing, userEditingManager, selection} = project
    return parent.addMenuItem(
        MenuItem.default({label: "Enabled", checked: trackBoxAdapter.enabled.getValue()})
            .setTriggerProcedure(() => editing.modify(() => trackBoxAdapter.enabled.toggle())),
        MenuItem.default({
            label: `New ${TrackType.toLabelString(trackType)} Track`,
            hidden: trackBoxAdapter.type === TrackType.Undefined
        }).setTriggerProcedure(() => editing.modify(() => {
            TrackBox.create(project.boxGraph, UUID.generate(), box => {
                box.type.setValue(trackType)
                box.tracks.refer(audioUnitBoxAdapter.box.tracks)
                box.index.setValue(audioUnitBoxAdapter.tracks.values().length)
                box.target.refer(audioUnitBoxAdapter.box)
            })
        })),
        MenuCapture.createItem(service, audioUnitBoxAdapter,
            trackBoxAdapter, editing, captureDevices.get(audioUnitBoxAdapter.uuid)),
        MenuItem.default({
            label: "Input Monitoring",
            hidden: captureDevices.get(audioUnitBoxAdapter.uuid)
                .mapOr(capture => !isInstanceOf(capture, CaptureAudio), true)
        }).setRuntimeChildrenProcedure(parent => {
            const optCapture = captureDevices.get(audioUnitBoxAdapter.uuid)
            if (optCapture.isEmpty()) {return parent}
            const capture = optCapture.unwrap()
            if (!isInstanceOf(capture, CaptureAudio)) {return parent}
            const currentMode = capture.monitoringMode
            const addModeItem = (mode: MonitoringMode, label: string) =>
                parent.addMenuItem(MenuItem.default({label, checked: currentMode === mode})
                    .setTriggerProcedure(() => capture.monitoringMode = mode))
            addModeItem("off", "Off")
            addModeItem("direct", "Direct")
            addModeItem("effects", "With Effects")
            return parent
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
            label: "Copy AudioUnit",
            shortcut: GlobalShortcuts["copy-device"].shortcut.format(),
            separatorBefore: true
        }).setTriggerProcedure(() => {
            const copies = editing.modify(() => TransferAudioUnits
                .transfer([trackBoxAdapter.audioUnit], project.skeleton), false).unwrap()
            userEditingManager.audioUnit.edit(copies[0].editing)
        }),
        MenuItem.default({
            label: "Extract AudioUnit Into New Project"
        }).setTriggerProcedure(async () => {
            if (service.hasProfile && !project.editing.isEmpty()) {
                const approved = await RuntimeNotifier.approve({
                    headline: "Closing Project?",
                    message: "You will lose all progress!"
                })
                if (!approved) {return}
            }
            const newProject = Project.new(service)
            editing.modify(() => {
                const {boxGraph, skeleton} = newProject
                boxGraph.beginTransaction()
                TransferAudioUnits.transfer([trackBoxAdapter.audioUnit], skeleton)
                boxGraph.endTransaction()
            })
            service.projectProfileService.setProject(newProject, "NEW")
        }),
        MenuItem.default({label: "Move", separatorBefore: true})
            .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                MenuItem.default({label: "Track 1 Up", selectable: trackBoxAdapter.indexField.getValue() > 0})
                    .setTriggerProcedure(() => editing.modify(() => audioUnitBoxAdapter.moveTrack(trackBoxAdapter, -1))),
                MenuItem.default({
                    label: "Track 1 Down",
                    selectable: trackBoxAdapter.indexField.getValue() < audioUnitBoxAdapter.tracks.collection.size() - 1
                }).setTriggerProcedure(() => editing.modify(() => audioUnitBoxAdapter.moveTrack(trackBoxAdapter, 1))),
                MenuItem.default({
                    label: "AudioUnit 1 Up",
                    selectable: audioUnitBoxAdapter.indexField.getValue() > 0 && false
                }).setTriggerProcedure(() => editing.modify(() => audioUnitBoxAdapter.move(-1))),
                MenuItem.default({
                    label: "AudioUnit 1 Down",
                    selectable: audioUnitBoxAdapter.indexField.getValue() < project.rootBoxAdapter.audioUnits.adapters()
                        .filter(adapter => !adapter.isOutput).length - 1 && false
                }).setTriggerProcedure(() => editing.modify(() => audioUnitBoxAdapter.move(1)))
            )),
        MenuItem.default({label: "Select Clips", selectable: !trackBoxAdapter.clips.collection.isEmpty()})
            .setTriggerProcedure(() => trackBoxAdapter.clips.collection.adapters()
                .forEach(clip => selection.select(clip.box))),
        MenuItem.default({label: "Select Regions", selectable: !trackBoxAdapter.regions.collection.isEmpty()})
            .setTriggerProcedure(() => trackBoxAdapter.regions.collection.asArray()
                .forEach(region => selection.select(region.box))),
        MenuItem.default({
            label: "Import MIDI File...",
            hidden: !acceptMidi,
            separatorBefore: true
        }).setTriggerProcedure(() => MidiImport.toTracks(project, audioUnitBoxAdapter)),
        MenuItem.default({
            label: `Delete '${audioUnitBoxAdapter.input.label.unwrapOrElse("No Input")}'`,
            selectable: !audioUnitBoxAdapter.isOutput,
            separatorBefore: true
        }).setTriggerProcedure(() => editing.modify(() =>
            project.api.deleteAudioUnit(audioUnitBoxAdapter.box))),
        MenuItem.default({
            label: `Delete ${TrackType.toLabelString(trackBoxAdapter.type)} Track`,
            selectable: !audioUnitBoxAdapter.isOutput,
            hidden: audioUnitBoxAdapter.tracks.collection.size() === 1
        }).setTriggerProcedure(() => editing.modify(() => {
            if (audioUnitBoxAdapter.tracks.collection.size() === 1) {
                project.api.deleteAudioUnit(audioUnitBoxAdapter.box)
            } else {
                audioUnitBoxAdapter.deleteTrack(trackBoxAdapter)
            }
        })),
        DebugMenus.debugBox(audioUnitBoxAdapter.box)
    )
}