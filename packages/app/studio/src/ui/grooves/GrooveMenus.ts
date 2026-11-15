import {Grooves, GrooveStackBoxAdapter} from "@opendaw/studio-adapters"
import {GrooveReveal} from "@/ui/grooves/GrooveReveal"
import {MenuItem, Project} from "@opendaw/studio-core"
import {Box, PointerField} from "@opendaw/lib-box"
import {isDefined, Nullable} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"

export namespace GrooveMenus {
    export const NoneLabel = "None"

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

    export const timelineItem = (project: Project, boxes: ReadonlyArray<Box>) => {
        const pointers = boxes.flatMap(box => Grooves.pointerOf(box).match({none: () => [], some: pointer => [pointer]}))
        return MenuItem.default({label: "Groove", hidden: pointers.length === 0})
            .setRuntimeChildrenProcedure(choiceItems(project, pointers))
    }

    export const choiceRoot = (project: Project, pointer: PointerField<Pointers.Groove>): MenuItem =>
        MenuItem.root().setRuntimeChildrenProcedure(choiceItems(project, [pointer]))

    export const tooltip = (project: Project, pointer: PointerField<Pointers.Groove>) => (): string =>
        `Groove: ${pointer.targetVertex
            .mapOr(({box}) => Grooves.adapterOf(project, Grooves.asGrooveBox(box)).label, NoneLabel)}`

    export const choiceItems = (project: Project, pointers: ReadonlyArray<PointerField<Pointers.Groove>>) =>
        (parent: MenuItem): void => {
            const {editing} = project
            const uses = (groove: Nullable<Box>) => pointers.length > 0 && pointers.every(pointer =>
                pointer.targetVertex.match({none: () => !isDefined(groove), some: ({box}) => box === groove}))
            const shared = project.rootBoxAdapter.grooves.adapters().find(groove => uses(groove.box)) ?? null
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
        }
}
