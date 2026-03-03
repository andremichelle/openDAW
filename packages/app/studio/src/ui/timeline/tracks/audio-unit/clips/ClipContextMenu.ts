import {AudioContentModifier, ContextMenu, ElementCapturing, MenuItem, Project} from "@opendaw/studio-core"
import {AnyClipBoxAdapter, AudioClipBoxAdapter} from "@opendaw/studio-adapters"
import {EmptyExec, Procedure, Selection, UUID} from "@opendaw/lib-std"
import {Surface} from "@/ui/surface/Surface.tsx"
import {NameValidator} from "@/ui/validator/name.ts"
import {ClipCaptureTarget} from "@/ui/timeline/tracks/audio-unit/clips/ClipCapturing.ts"
import {DebugMenus} from "@/ui/menu/debug"
import {exportNotesToMidiFile} from "@/ui/timeline/editors/notes/NoteUtils"
import {AudioRegionBox, NoteRegionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {ColorMenu} from "@/ui/timeline/ColorMenu"
import {Promises} from "@opendaw/lib-runtime"

type Creation = {
    element: HTMLElement
    project: Project
    capturing: ElementCapturing<ClipCaptureTarget>
    selection: Selection<AnyClipBoxAdapter>
}

export const installClipContextMenu = ({element, project, selection, capturing}: Creation) =>
    ContextMenu.subscribe(element, collector => {
        const client = collector.client
        const target = capturing.captureEvent(client)
        const {editing} = project
        if (target === null) {
            // TODO Create clips
        } else if (target.type === "clip") {
            const {clip} = target
            if (!selection.isSelected(clip)) {
                selection.deselectAll()
                selection.select(clip)
            }
            const modify = <T extends AnyClipBoxAdapter>(procedure: Procedure<T>) =>
                editing.modify(() => selection.selected().forEach(adapter => procedure(adapter as T)))
            collector.addItems(
                MenuItem.default({label: "Delete"})
                    .setTriggerProcedure(() => editing.modify(() =>
                        selection.selected().forEach(clip => clip.box.delete()))),
                MenuItem.default({label: "Rename"})
                    .setTriggerProcedure(() => Surface.get(element).requestFloatingTextInput(client, clip.label)
                        .then(value => {
                            NameValidator.validate(value, {
                                success: name => editing.modify(() => selection.selected()
                                    .forEach(adapter => adapter.box.label.setValue(name)))
                            })
                        }, EmptyExec)),
                MenuItem.default({label: "Mute", checked: clip.box.mute.getValue()})
                    .setTriggerProcedure(() => {
                        const newValue = !clip.box.mute.getValue()
                        modify(({box: {mute}}) => mute.setValue(newValue))
                    }),
                ColorMenu.createItem(hue => modify(adapter => adapter.box.hue.setValue(hue))),
                MenuItem.default({label: "Consolidate", selectable: clip.isMirrowed})
                    .setTriggerProcedure(() => editing.modify(() =>
                        selection.selected().forEach(clip => clip.consolidate()))),
                MenuItem.default({
                    label: "Playback",
                    hidden: clip.type !== "audio-clip",
                    separatorBefore: true
                }).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.default({
                        label: "Pitch",
                        checked: clip.type === "audio-clip" && clip.asPlayModePitchStretch.nonEmpty()
                    }).setTriggerProcedure(async () => {
                        const {status, value: modifier, error} =
                            await Promises.tryCatch(AudioContentModifier.toPitchStretch(selection.selected()
                                .filter((clip): clip is AudioClipBoxAdapter => clip.type === "audio-clip")))
                        if (status === "resolved") {
                            editing.modify(modifier)
                        } else {
                            console.warn(error)
                        }
                    }),
                    MenuItem.default({
                        label: "Timestretch",
                        checked: clip.type === "audio-clip" && clip.asPlayModeTimeStretch.nonEmpty()
                    }).setTriggerProcedure(async () => {
                        const {status, value: modifier, error} =
                            await Promises.tryCatch(AudioContentModifier.toTimeStretch(selection.selected()
                                .filter((clip): clip is AudioClipBoxAdapter => clip.type === "audio-clip")))
                        if (status === "resolved") {
                            editing.modify(modifier)
                        } else {
                            console.warn(error)
                        }
                    }),
                    MenuItem.default({
                        label: "No Warp",
                        checked: clip.type === "audio-clip" && clip.isPlayModeNoStretch
                    }).setTriggerProcedure(async () => {
                            const {status, value: modifier, error} =
                                await Promises.tryCatch(AudioContentModifier.toNotStretched(selection.selected()
                                    .filter((clip): clip is AudioClipBoxAdapter => clip.type === "audio-clip")))
                            if (status === "resolved") {
                                editing.modify(modifier)
                            } else {
                                console.warn(error)
                            }
                        }
                    )
                )),
                MenuItem.default({label: "Trigger"})
                    .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                        MenuItem.default({label: "Loop", checked: clip.box.triggerMode.loop.getValue()})
                            .setTriggerProcedure(() => {
                                const newValue = !clip.box.triggerMode.loop.getValue()
                                modify(({box: {triggerMode: {loop}}}) => loop.setValue(newValue))
                            })
                    )),
                MenuItem.default({
                    label: "Convert to Region", separatorBefore: true
                }).setTriggerProcedure(() => {
                    const trackBoxAdapter = clip.trackBoxAdapter.unwrap()
                    const regions = trackBoxAdapter.regions
                    const lastRegion = regions.collection.lowerEqual(Number.POSITIVE_INFINITY)
                    const position = lastRegion?.complete ?? 0
                    // TODO Move to ClipTransformer and put into edit mode
                    editing.modify(() => {
                        if (clip.type === "note-clip") {
                            NoteRegionBox.create(clip.box.graph, UUID.generate(), box => {
                                box.position.setValue(position)
                                box.duration.setValue(clip.duration)
                                box.loopOffset.setValue(0)
                                box.loopDuration.setValue(clip.duration)
                                box.hue.setValue(clip.hue)
                                box.label.setValue(clip.label)
                                box.mute.setValue(clip.mute)
                                box.events.refer(clip.box.events.targetVertex.unwrap())
                                box.regions.refer(trackBoxAdapter.box.regions)
                            })
                        } else if (clip.type === "audio-clip") {
                            AudioRegionBox.create(clip.box.graph, UUID.generate(), box => {
                                box.position.setValue(position)
                                box.duration.setValue(clip.duration)
                                box.loopOffset.setValue(0)
                                box.loopDuration.setValue(clip.duration)
                                box.hue.setValue(clip.hue)
                                box.label.setValue(clip.label)
                                box.mute.setValue(clip.mute)
                                box.timeBase.setValue(clip.timeBase)
                                box.file.refer(clip.box.file.targetVertex.unwrap())
                                box.events.refer(clip.box.events.targetVertex.unwrap())
                                box.regions.refer(trackBoxAdapter.box.regions)
                                clip.box.playMode.ifVertex(vertex => box.playMode.refer(vertex))
                            })
                        } else if (clip.type === "value-clip") {
                            ValueRegionBox.create(clip.box.graph, UUID.generate(), box => {
                                box.position.setValue(position)
                                box.duration.setValue(clip.duration)
                                box.loopOffset.setValue(0)
                                box.loopDuration.setValue(clip.duration)
                                box.hue.setValue(clip.hue)
                                box.label.setValue(clip.label)
                                box.mute.setValue(clip.mute)
                                box.events.refer(clip.box.events.targetVertex.unwrap())
                                box.regions.refer(trackBoxAdapter.box.regions)
                            })
                        }
                    })
                }),
                MenuItem.default({
                    label: "Export to Midi-File",
                    hidden: clip.type !== "note-clip"
                }).setTriggerProcedure(() => {
                    if (clip.type === "note-clip") {
                        const label = clip.label
                        exportNotesToMidiFile(clip.optCollection.unwrap(),
                            `${label.length === 0 ? "clip" : label}.mid`).then()
                    }
                }),
                DebugMenus.debugBox(clip.box))
        }
    })