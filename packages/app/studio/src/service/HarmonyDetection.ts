import {isInstanceOf, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {ChordDetection, Harmony, LoopableRegion, ppqn} from "@opendaw/lib-dsp"
import {
    AnyClipBoxAdapter,
    AnyRegionBoxAdapter,
    ChordEventBoxAdapter,
    NoteClipBoxAdapter,
    NoteRegionBoxAdapter
} from "@opendaw/studio-adapters"
import {ChordEventBox} from "@opendaw/studio-boxes"
import {StudioService} from "@/service/StudioService"
import {ChordOverlaps} from "@/ui/timeline/tracks/primary/chord/ChordOverlaps"

export namespace HarmonyDetection {
    // the notes to analyse in song positions and the range they cover
    export type Source = { readonly notes: ReadonlyArray<ChordDetection.Note>, readonly from: ppqn, readonly to: ppqn }

    // every note the note regions play, loops unrolled and cut at the region end
    export const fromRegions = (adapters: ReadonlyArray<AnyRegionBoxAdapter>): Source => {
        const regions = adapters.filter((region): region is NoteRegionBoxAdapter => isInstanceOf(region, NoteRegionBoxAdapter))
        return {
            notes: collectNotes(regions),
            from: Math.min(...regions.map(({position}) => position)),
            to: Math.max(...regions.map(({complete}) => complete))
        }
    }

    // the notes of the note clips as if they started together at `position`
    export const fromClips = (adapters: ReadonlyArray<AnyClipBoxAdapter>, position: ppqn): Source => {
        const clips = adapters.filter((clip): clip is NoteClipBoxAdapter => isInstanceOf(clip, NoteClipBoxAdapter))
        return {
            notes: clips.flatMap(clip => clip.optCollection.mapOr(collection => collection.events.asArray()
                .filter(event => event.position < clip.duration)
                .map(event => ({
                    position: position + event.position,
                    duration: Math.min(event.duration, clip.duration - event.position),
                    pitch: event.pitch
                })), [])),
            from: position,
            to: position + Math.max(0, ...clips.map(({duration}) => duration))
        }
    }

    const collectNotes = (regions: ReadonlyArray<NoteRegionBoxAdapter>): ReadonlyArray<ChordDetection.Note> =>
        regions.flatMap(region => region.optCollection.mapOr(collection => {
            const notes: Array<ChordDetection.Note> = []
            for (const {resultStart, resultEnd, rawStart, regionEnd} of LoopableRegion.locateLoops(region, region.position, region.complete)) {
                for (const event of collection.events.iterateRange(Math.floor(resultStart - rawStart), Math.floor(resultEnd - rawStart))) {
                    const position = event.position + rawStart
                    const duration = Math.min(event.duration, regionEnd - position)
                    if (duration > 0) {notes.push({position, duration, pitch: event.pitch})}
                }
            }
            return notes
        }, []))

    export const detectChords = (service: StudioService, {notes, from, to}: Source): void => {
        const {project, timeline: {primaryVisibility}} = service
        const {editing, boxGraph, boxAdapters, timelineBoxAdapter: {keyTrack, chordTrack}} = project
        const segments = ChordDetection.segment(notes, from, to)
        if (segments.length === 0) {
            RuntimeNotifier.notify({message: "No chords found", icon: "Info"})
            return
        }
        editing.modify(() => {
            const created: Array<ChordEventBoxAdapter> = []
            segments.forEach(({position, duration, chord}) => ChordDetection.toStep(keyTrack.keyAt(position), chord)
                .ifSome(({degree, shift, shape, notes, inversion}) => {
                    const box = ChordEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(position)
                        box.duration.setValue(duration)
                        box.degree.setValue(degree)
                        box.shift.setValue(shift)
                        box.shape.setValue(shape)
                        box.notes.setValue(notes)
                        box.inversion.setValue(inversion)
                        box.track.refer(chordTrack.object.events)
                    })
                    created.push(boxAdapters.adapterFor(box, ChordEventBoxAdapter))
                }))
            created.forEach(adapter => ChordOverlaps.resolve(chordTrack, adapter, created))
        })
        primaryVisibility.chords.setValue(true)
    }

    export const detectKey = (service: StudioService, {notes, from, to}: Source): void => {
        const {editing, timelineBoxAdapter: {keyTrack}} = service.project
        ChordDetection.detectKey(ChordDetection.pitchClassWeights(notes, from, to)).match({
            none: () => RuntimeNotifier.notify({message: "No notes found", icon: "Info"}),
            some: key => {
                editing.modify(() => {
                    keyTrack.object.root.setValue(key.root)
                    keyTrack.object.scale.setValue(key.bits)
                })
                RuntimeNotifier.notify({message: `Project key set to ${Harmony.keyName(key)}`, icon: "Info"})
            }
        })
    }
}
