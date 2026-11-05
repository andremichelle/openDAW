import {GrooveAdapter, Grooves, GrooveStackBoxAdapter} from "@opendaw/studio-adapters"
import {GrooveReveal} from "@/ui/grooves/GrooveReveal"
import {MenuItem, Project} from "@opendaw/studio-core"
import {Box} from "@opendaw/lib-box"
import {isDefined, Nullable} from "@opendaw/lib-std"

// The menus of the groove controls, shared by the Zeitgeist panel and the Grooves list
export namespace GrooveMenus {
    export const NoneLabel = "None"

    // A new groove of any kind or an existing one joins the stack at its end
    export const memberItems = (project: Project, stack: GrooveStackBoxAdapter) => (parent: MenuItem): void => {
        const {editing, rootBoxAdapter} = project
        parent.addMenuItem(MenuItem.default({
            label: "New Groove"
        }).setRuntimeChildrenProcedure(sub => sub.addMenuItem(...Grooves.Kinds.map(kind =>
            MenuItem.default({label: kind.label}).setTriggerProcedure(() => editing.modify(() =>
                Grooves.addToStack(project, stack.box, Grooves.create(project, kind.kind))))))))
        const candidates = rootBoxAdapter.grooves.adapters()
            .filter(candidate => Grooves.canAddToStack(stack.box, candidate.box))
        parent.addMenuItem(MenuItem.default({
            label: "Add",
            selectable: candidates.length > 0
        }).setRuntimeChildrenProcedure(sub => sub.addMenuItem(...candidates.map(candidate =>
            MenuItem.default({label: candidate.label}).setTriggerProcedure(() =>
                editing.modify(() => Grooves.addToStack(project, stack.box, candidate.box)))))))
    }

    // Picks the groove of the selected regions or clips, hidden when none of them takes one
    export const timelineItem = (project: Project, boxes: ReadonlyArray<Box>) => {
        const {editing} = project
        const pointers = boxes.flatMap(box => Grooves.pointerOf(box).match({none: () => [], some: pointer => [pointer]}))
        const uses = (groove: Nullable<Box>) => pointers.length > 0 && pointers.every(pointer =>
            pointer.targetVertex.match({none: () => !isDefined(groove), some: ({box}) => box === groove}))
        const current = (): Nullable<GrooveAdapter> => project.rootBoxAdapter.grooves.adapters()
            .find(groove => uses(groove.box)) ?? null
        return MenuItem.default({label: "Groove", hidden: pointers.length === 0})
            .setRuntimeChildrenProcedure(parent => {
                const shared = current()
                parent.addMenuItem(MenuItem.default({
                    label: `Go to ${shared?.label ?? NoneLabel}`,
                    selectable: isDefined(shared)
                }).setTriggerProcedure(() => {if (isDefined(shared)) {GrooveReveal.request(shared.uuid)}}))
                parent.addMenuItem(MenuItem.default({label: NoneLabel, checked: uses(null), separatorBefore: true})
                    .setTriggerProcedure(() => editing.modify(() => pointers.forEach(pointer => pointer.defer()))))
                parent.addMenuItem(...project.rootBoxAdapter.grooves.adapters().map(groove =>
                    MenuItem.default({label: groove.label, checked: uses(groove.box)})
                        .setTriggerProcedure(() => editing.modify(() =>
                            pointers.forEach(pointer => pointer.refer(groove.box))))))
                parent.addMenuItem(MenuItem.default({label: "New", separatorBefore: true})
                    .setRuntimeChildrenProcedure(sub => sub.addMenuItem(...Grooves.Kinds.map(kind =>
                        MenuItem.default({label: kind.label}).setTriggerProcedure(() => editing.modify(() => {
                            const groove = Grooves.create(project, kind.kind)
                            pointers.forEach(pointer => pointer.refer(groove))
                            return groove
                        }).ifSome(groove => GrooveReveal.request(groove.address.uuid)))))))
            })
    }
}
