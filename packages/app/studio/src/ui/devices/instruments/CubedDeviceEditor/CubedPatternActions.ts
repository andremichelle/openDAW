import {asInstanceOf, Editing, EmptyExec, Func, isInstanceOf, Option, RuntimeNotifier, tryCatch} from "@opendaw/lib-std"
import {Clipboard, Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {
    AblPattern, CubedDeviceBoxAdapter, CubedPatternData, CubedPatternNotes, CubedPatternTransform, TrackBoxAdapter, TrackType
} from "@opendaw/studio-adapters"
import {NoteClipBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox} from "@opendaw/studio-boxes"
import {MenuItem} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {CubedPatternClipboard} from "./CubedPatternClipboard"
import {StudioService} from "@/service/StudioService"
import {Surface} from "@/ui/surface/Surface"

export namespace CubedPatternActions {
    type Context = {
        readonly editing: Editing
        readonly adapter: CubedDeviceBoxAdapter
        readonly origin?: Element
    }

    const notify = (message: string, icon: IconSymbol, origin?: Element): void =>
        RuntimeNotifier.notify({message, icon: IconSymbol.toName(icon), origin})

    const applyPattern = ({editing, adapter, origin}: Context,
                          data: Option<CubedPatternData>,
                          failure: string): void => {
        if (data.isEmpty()) {
            notify(failure, IconSymbol.Warning, origin)
            return
        }
        editing.modify(() => adapter.writeCurrentPattern(data.unwrap()))
        notify("Pattern pasted", IconSymbol.Paste, origin)
    }

    const loadAblPattern = async ({editing, adapter, origin}: Context): Promise<void> => {
        const opened = await Promises.tryCatch(Files.open({
            types: [{description: "AudioRealism ABL pattern", accept: {"text/plain": [".pat"]}}]
        }))
        if (opened.status === "rejected") {return}
        const [file] = opened.value
        const text = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))
        const parsed = tryCatch(() => AblPattern.parse(text))
        if (parsed.status === "failure" || parsed.value.steps.length === 0) {
            notify(`Not a readable ABL pattern: ${file.name}`, IconSymbol.Warning, origin)
            return
        }
        editing.modify(() => adapter.writeCurrentPattern(parsed.value))
        notify(`Loaded ${file.name}`, IconSymbol.Cube, origin)
    }

    export const clipboardItems = (context: Context): ReadonlyArray<MenuItem> => [
        MenuItem.default({label: "Copy Pattern", separatorBefore: true})
            .setTriggerProcedure(() => CubedPatternClipboard.write(context.adapter.readCurrentPattern())
                .then(() => notify("Pattern copied", IconSymbol.Copy, context.origin), EmptyExec)),
        MenuItem.default({label: "Paste Pattern"})
            .setTriggerProcedure(() => CubedPatternClipboard.read()
                .then(data => applyPattern(context, data, "No pattern in clipboard"), EmptyExec)),
        MenuItem.default({label: "Copy Pattern to JSON", separatorBefore: true})
            .setTriggerProcedure(() =>
                Clipboard.writeText(CubedPatternData.toJSON(context.adapter.readCurrentPattern()))
                    .then(() => notify("Pattern copied as JSON", IconSymbol.Copy, context.origin), EmptyExec)),
        MenuItem.default({label: "Paste Pattern from JSON"})
            .setTriggerProcedure(() => Clipboard.readText()
                .then(text => applyPattern(context, CubedPatternData.fromJSON(text),
                    "No readable pattern JSON in clipboard"), EmptyExec))
    ]

    const transform = ({editing, adapter, origin}: Context, procedure: Func<CubedPatternData, Option<CubedPatternData>>,
                       refusal: string): void => {
        if (!editing.modify(() => adapter.transformCurrentPattern(procedure)).unwrapOrElse(true)) {
            notify(refusal, IconSymbol.Warning, origin)
        }
    }

    const askPivot = async (context: Context): Promise<void> => {
        const rect = context.origin?.getBoundingClientRect()
        const client = {clientX: rect?.left ?? 0, clientY: (rect?.top ?? 0) + 16}
        const {status, value} = await Promises.tryCatch(Surface.get(context.origin).requestFloatingTextInput(client, "60"))
        if (status === "rejected") {return}
        CubedPatternData.parseNote(value).match({
            none: () => notify(`Not a note: ${value}`, IconSymbol.Warning, context.origin),
            some: pivot => transform(context, data => CubedPatternTransform.invert(data, pivot),
                "Inverting would move notes out of the MIDI range")
        })
    }

    const noteTrack = (adapter: CubedDeviceBoxAdapter): Option<TrackBoxAdapter> => Option.wrap(adapter.audioUnitBoxAdapter()
        .tracks.collection.adapters().find(track => track.type === TrackType.Notes))

    const patternName = (adapter: CubedDeviceBoxAdapter): string => `Pattern ${adapter.box.patternIndex.getValue() + 1}`

    const exportTo = ({editing, adapter, origin}: Context, service: StudioService, target: "region" | "clip"): void => {
        const {api, engine} = service.project
        const data = adapter.readCurrentPattern()
        const duration = CubedPatternNotes.durationOf(data)
        const notes = CubedPatternNotes.toNotes(data)
        noteTrack(adapter).match({
            none: () => notify("The track has no note lane", IconSymbol.Warning, origin),
            some: track => editing.modify(() => {
                const owner = target === "region"
                    ? api.createTrackRegion(track.box, Math.max(0, service.timeline.snapping.floor(engine.position.getValue())),
                        duration, {name: patternName(adapter)}).map(region => asInstanceOf(region, NoteRegionBox))
                    : Option.wrap(api.createNoteClip(track.box, track.clips.collection.getMinFreeIndex(), {name: patternName(adapter)}))
                owner.ifSome(box => {
                    if (isInstanceOf(box, NoteClipBox)) {box.duration.setValue(duration)}
                    notes.forEach(({position, duration, pitch, velocity}) =>
                        api.createNoteEvent({owner: box, position, duration, pitch, velocity}))
                })
            })
        })
    }

    const selectedNotes = (service: StudioService): Option<NoteRegionBox | NoteClipBox> => Option.wrap(service.project.selection
        .selected().map(({box}) => box)
        .find((box): box is NoteRegionBox | NoteClipBox => isInstanceOf(box, NoteRegionBox) || isInstanceOf(box, NoteClipBox)))

    const importFrom = (context: Context, service: StudioService): void => selectedNotes(service).ifSome(box => {
        const notes = box.events.targetVertex.mapOr(({box: collection}) => asInstanceOf(collection, NoteEventCollectionBox)
            .events.pointerHub.incoming().map(({box: event}) => asInstanceOf(event, NoteEventBox))
            .map(event => ({position: event.position.getValue(), duration: event.duration.getValue(),
                pitch: event.pitch.getValue(), velocity: event.velocity.getValue()})), [])
        const duration = isInstanceOf(box, NoteRegionBox) ? box.loopDuration.getValue() : box.duration.getValue()
        transform(context, data => Option.wrap(CubedPatternNotes.fromNotes(notes, duration, data)), "")
        notify(`${isInstanceOf(box, NoteRegionBox) ? "Region" : "Clip"} imported`, IconSymbol.Cube, context.origin)
    })

    export const editItems = (context: Context, service: StudioService): ReadonlyArray<MenuItem> => [
        MenuItem.default({label: "Octave Up"})
            .setTriggerProcedure(() => transform(context, data => CubedPatternTransform.transpose(data, 12),
                "Notes would leave the MIDI range")),
        MenuItem.default({label: "Octave Down"})
            .setTriggerProcedure(() => transform(context, data => CubedPatternTransform.transpose(data, -12),
                "Notes would leave the MIDI range")),
        MenuItem.default({label: "Double", selectable: context.adapter.readCurrentPattern().length < CubedPatternData.MaxSteps})
            .setTriggerProcedure(() => transform(context, data => Option.wrap(CubedPatternTransform.double(data)), "")),
        MenuItem.default({label: "Reverse"})
            .setTriggerProcedure(() => transform(context, data => Option.wrap(CubedPatternTransform.reverse(data)), "")),
        MenuItem.default({label: "Invert…"})
            .setTriggerProcedure(() => {askPivot(context).catch(console.warn)}),
        MenuItem.default({label: "Export to Note Region", separatorBefore: true})
            .setTriggerProcedure(() => exportTo(context, service, "region")),
        MenuItem.default({label: "Export to Note Clip"})
            .setTriggerProcedure(() => exportTo(context, service, "clip")),
        MenuItem.default({label: "Import Selected Region or Clip", selectable: selectedNotes(service).nonEmpty()})
            .setTriggerProcedure(() => importFrom(context, service))
    ]

    /** Loads into the CURRENT pattern, leaving the other 15 untouched. */
    export const loadAblItem = (context: Context): MenuItem =>
        MenuItem.default({label: "Load ABL .pat…", separatorBefore: true})
            .setTriggerProcedure(() => {loadAblPattern(context).catch(console.warn)})
}
