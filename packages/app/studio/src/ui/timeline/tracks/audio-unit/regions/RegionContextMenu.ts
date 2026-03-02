import {EmptyExec, isInstanceOf, Selection, Terminable} from "@opendaw/lib-std"
import {AudioContentModifier, ContextMenu, ElementCapturing, MenuItem, TimelineRange} from "@opendaw/studio-core"
import {AnyRegionBoxAdapter, AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import {RegionCaptureTarget} from "@/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts"
import {TimelineBox} from "@opendaw/studio-boxes"
import {Surface} from "@/ui/surface/Surface.tsx"
import {RegionTransformer} from "@/ui/timeline/tracks/audio-unit/regions/RegionTransformer.ts"
import {NameValidator} from "@/ui/validator/name.ts"
import {DebugMenus} from "@/ui/menu/debug"
import {exportNotesToMidiFile} from "@/ui/timeline/editors/notes/NoteUtils"
import {ColorMenu} from "@/ui/timeline/ColorMenu"
import {BPMTools} from "@opendaw/lib-dsp"
import {Browser} from "@opendaw/lib-dom"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {StudioService} from "@/service/StudioService"
import {Promises} from "@opendaw/lib-runtime"
import {RegionsShortcuts} from "@/ui/shortcuts/RegionsShortcuts"
import {AudioConsolidation} from "@/service/AudioConsolidation"

type Construct = {
    element: Element
    service: StudioService
    capturing: ElementCapturing<RegionCaptureTarget>
    selection: Selection<AnyRegionBoxAdapter>
    timelineBox: TimelineBox
    range: TimelineRange
}

export const installRegionContextMenu =
    ({element, service, capturing, selection, timelineBox, range}: Construct): Terminable => {
        const {project} = service
        const {editing, selection: vertexSelection} = project
        const computeSelectionRange = () => selection.selected().reduce((range, region) => {
            range[0] = Math.min(region.position, range[0])
            range[1] = Math.max(region.complete, range[1])
            return range
        }, [Number.MAX_VALUE, -Number.MAX_VALUE])
        return ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
            const target = capturing.captureEvent(client)
            if (target === null || target.type === "track") {return}
            if (!selection.isSelected(target.region)) {
                selection.deselectAll()
                selection.select(target.region)
            }
            const region = target.region
            addItems(
                MenuItem.default({label: "Delete", shortcut: "⌫"})
                    .setTriggerProcedure(() => editing.modify(() => selection.selected().slice()
                        .forEach(adapter => adapter.box.delete()))),
                MenuItem.default({label: "Duplicate"})
                    .setTriggerProcedure(() => editing.modify(() => {
                        project.api.duplicateRegion(region)
                            .ifSome(duplicate => {
                                selection.deselectAll()
                                selection.select(duplicate)
                            })
                    })),
                MenuItem.default({
                    label: "Mute",
                    checked: region.mute,
                    shortcut: RegionsShortcuts["toggle-mute"].shortcut.format()
                }).setTriggerProcedure(() => editing.modify(() => {
                    const newValue = !region.mute
                    return selection.selected().slice().forEach(adapter => adapter.box.mute.setValue(newValue))
                })),
                ColorMenu.createItem(hue => editing.modify(() =>
                    selection.selected().slice().forEach(adapter => adapter.box.hue.setValue(hue)))),
                MenuItem.default({label: "Rename"})
                    .setTriggerProcedure(() => Surface.get(element).requestFloatingTextInput(client, region.label)
                        .then(value => NameValidator.validate(value, {
                            success: name => editing.modify(() => selection.selected()
                                .forEach(adapter => adapter.box.label.setValue(name)))
                        }), EmptyExec)),
                MenuItem.default({label: "Loop Selection"})
                    .setTriggerProcedure(() => {
                        const [min, max] = computeSelectionRange()
                        editing.modify(() => {
                            timelineBox.loopArea.from.setValue(min)
                            timelineBox.loopArea.to.setValue(max)
                        })
                    }),
                MenuItem.default({label: "Zoom Selection"})
                    .setTriggerProcedure(() => {
                        const [min, max] = computeSelectionRange()
                        range.zoomRange(min, max)
                    }),
                MenuItem.default({
                    label: "Consolidate",
                    selectable: selection.selected().some(x => x.isMirrowed),
                    separatorBefore: true
                }).setTriggerProcedure(() => editing.modify(() => selection.selected().slice()
                    .forEach(adapter => adapter.consolidate()))),
                MenuItem.default({label: "Flatten", selectable: region.canFlatten(selection.selected())})
                    .setTriggerProcedure(() => {
                        if (region instanceof AudioRegionBoxAdapter) {
                            const audioRegions = selection.selected()
                                .filter((adapter): adapter is AudioRegionBoxAdapter =>
                                    isInstanceOf(adapter, AudioRegionBoxAdapter))
                            AudioConsolidation.flatten(project, service.sampleService, audioRegions)
                                .then(EmptyExec, console.warn)
                        } else {
                            editing.modify(() =>
                                region.flatten(selection.selected()).ifSome(box => project.selection.select(box)))
                        }
                    }),
                MenuItem.default({label: "Convert to Clip"})
                    .setTriggerProcedure(() => editing.modify(() => {
                        service.timeline.clips.visible.setValue(true)
                        const clip = RegionTransformer.toClip(region)
                        vertexSelection.select(clip)
                        project.userEditingManager.timeline.edit(clip)
                    })),
                MenuItem.default({
                    label: "Export to Midi-File",
                    hidden: region.type !== "note-region"
                }).setTriggerProcedure(() => {
                    if (region.type === "note-region") {
                        const label = region.label
                        exportNotesToMidiFile(region.optCollection.unwrap(),
                            `${label.length === 0 ? "region" : label}.mid`).then(EmptyExec, EmptyExec)
                    }
                }),
                MenuItem.default({
                    label: "Reset Fades",
                    hidden: region.type !== "audio-region"
                }).setTriggerProcedure(() => {
                    if (isInstanceOf(region, AudioRegionBoxAdapter)) {
                        editing.modify(() => region.fading.reset())
                    }
                }),
                MenuItem.default({
                    label: "Play Mode",
                    hidden: region.type !== "audio-region"
                }).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.default({
                        label: "Pitch",
                        checked: region.type === "audio-region" && region.asPlayModePitchStretch.nonEmpty()
                    }).setTriggerProcedure(async () => {
                        const {status, value: modifier, error} =
                            await Promises.tryCatch(AudioContentModifier.toPitchStretch(selection.selected()
                                .filter((region): region is AudioRegionBoxAdapter => region.type === "audio-region")))
                        if (status === "resolved") {
                            editing.modify(modifier)
                        } else {
                            console.warn(error)
                        }
                    }),
                    MenuItem.default({
                        label: "Timestretch",
                        checked: region.type === "audio-region" && region.asPlayModeTimeStretch.nonEmpty()
                    }).setTriggerProcedure(async () => {
                        const {status, value: modifier, error} =
                            await Promises.tryCatch(AudioContentModifier.toTimeStretch(selection.selected()
                                .filter((region): region is AudioRegionBoxAdapter => region.type === "audio-region")))
                        if (status === "resolved") {
                            editing.modify(modifier)
                        } else {
                            console.warn(error)
                        }
                    }),
                    MenuItem.default({
                        label: "No Warp",
                        checked: region.type === "audio-region" && region.isPlayModeNoStretch
                    }).setTriggerProcedure(async () => {
                            const {status, value: modifier, error} =
                                await Promises.tryCatch(AudioContentModifier.toNotStretched(selection.selected()
                                    .filter((region): region is AudioRegionBoxAdapter => region.type === "audio-region")))
                            if (status === "resolved") {
                                editing.modify(modifier)
                            } else {
                                console.warn(error)
                            }
                        }
                    )
                )),
                MenuItem.default({
                    label: "Calc Bpm",
                    hidden: region.type !== "audio-region" || !Browser.isLocalHost()
                }).setTriggerProcedure(() => {
                    if (region.type === "audio-region") {
                        region.file.data.ifSome(data => {
                            const bpm = BPMTools.detect(data.frames[0], data.sampleRate)
                            Dialogs.info({headline: "BPMTools", message: `${bpm.toFixed(3)} BPM`})
                                .finally()
                        })
                    }
                }),
                DebugMenus.debugBox(region.box)
            )
        })
    }