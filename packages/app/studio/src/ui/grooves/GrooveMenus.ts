import {Grooves, GrooveStackBoxAdapter} from "@opendaw/studio-adapters"
import {MenuItem, Project} from "@opendaw/studio-core"

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
}
