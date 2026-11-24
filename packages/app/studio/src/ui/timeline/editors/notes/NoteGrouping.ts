import {DefaultObservableValue, Editing, Option, Selection, UUID} from "@opendaw/lib-std"
import {EventCollection} from "@opendaw/lib-dsp"
import {NoteEventBoxAdapter, NoteEventFeatures} from "@opendaw/studio-adapters"
import {NoteEventGroupBox} from "@opendaw/studio-boxes"
import {NotePropertyChance, PropertyAccessor} from "@/ui/timeline/editors/notes/property/PropertyAccessor.ts"

export namespace NoteGrouping {
    export const lastMode = new DefaultObservableValue<NoteEventFeatures.GroupMode>(NoteEventFeatures.GroupMode.PlayAll)

    // The one group every selected note belongs to, the target of a mode switch
    export const sharedGroup = (selection: Selection<NoteEventBoxAdapter>): Option<NoteEventGroupBox> => {
        const adapters = selection.selected()
        if (adapters.length === 0) {return Option.None}
        const first = adapters[0].group
        return first.nonEmpty() && adapters.every(adapter => adapter.group.equals(first)) ? first : Option.None
    }

    export const canGroup = (selection: Selection<NoteEventBoxAdapter>): boolean =>
        selection.count() > 1 || sharedGroup(selection).nonEmpty()

    export const canUngroup = (selection: Selection<NoteEventBoxAdapter>): boolean =>
        selection.selected().some(adapter => adapter.group.nonEmpty())

    export const group = (editing: Editing, selection: Selection<NoteEventBoxAdapter>,
                          mode: NoteEventFeatures.GroupMode): boolean => {
        if (!canGroup(selection)) {return false}
        lastMode.setValue(mode)
        sharedGroup(selection).match({
            none: () => {editing.modify(() => NoteEventFeatures.group(selection.selected().map(adapter => adapter.box), mode))},
            some: group => {editing.modify(() => group.mode.setValue(mode))}
        })
        return true
    }

    export const ungroup = (editing: Editing, selection: Selection<NoteEventBoxAdapter>): boolean => {
        if (!canUngroup(selection)) {return false}
        editing.modify(() => NoteEventFeatures.ungroup(selection.selected().map(adapter => adapter.box)))
        return true
    }

    export const leaveGroup = (editing: Editing, selection: Selection<NoteEventBoxAdapter>): boolean => {
        if (!canUngroup(selection)) {return false}
        editing.modify(() => NoteEventFeatures.leaveGroup(selection.selected().map(adapter => adapter.box)))
        return true
    }

    export const status = (selection: Selection<NoteEventBoxAdapter>): string => {
        const adapters = selection.selected()
        if (adapters.length === 0) {return "No selection"}
        const groups = UUID.newSet<NoteEventGroupBox>(group => group.address.uuid)
        adapters.forEach(adapter => adapter.group.ifSome(group => groups.add(group)))
        if (groups.size() === 0) {return "No group"}
        if (groups.size() > 1 || adapters.some(adapter => adapter.group.isEmpty())) {return "Mixed"}
        const group = groups.values()[0]
        const mode = group.mode.getValue() === NoteEventFeatures.GroupMode.PlayOne ? "Play One" : "Play All"
        return `${mode}, ${group.pointerHub.incoming().length} notes`
    }

    // Only the chance lane draws one marker per group, on the group's earliest member
    export const leadsIn = (accessor: PropertyAccessor,
                             events: EventCollection<NoteEventBoxAdapter>): Option<ReadonlySet<NoteEventBoxAdapter>> =>
        accessor === NotePropertyChance ? Option.wrap(leadsOf(events)) : Option.None

    export const showsMarker = (leads: Option<ReadonlySet<NoteEventBoxAdapter>>, event: NoteEventBoxAdapter): boolean =>
        leads.mapOr(set => event.group.isEmpty() || set.has(event), true)

    export const leadsOf = (events: EventCollection<NoteEventBoxAdapter>): ReadonlySet<NoteEventBoxAdapter> => {
        const leads = UUID.newSet<{ uuid: UUID.Bytes, lead: NoteEventBoxAdapter }>(entry => entry.uuid)
        events.asArray().forEach(event => event.group
            .ifSome(group => leads.getOrCreate(group.address.uuid, uuid => ({uuid, lead: event}))))
        return new Set(leads.values().map(({lead}) => lead))
    }
}
