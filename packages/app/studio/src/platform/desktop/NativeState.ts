import {Arrays, Exec, isDefined, Optional} from "@opendaw/lib-std"
import {Field} from "@opendaw/lib-box"
import {NativeEffectBox, NativeInstrumentBox, WclapParameterBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import type {Project} from "@opendaw/studio-core"

// A plugin keeps its own history (its undo, its presets): its state and its parameter values stay out of the studio's,
// an undo never sets an older one. The project still saves the latest.
export namespace NativeState {
    export const store = (project: Project, box: NativeInstrumentBox | NativeEffectBox, bytes: Int8Array): void => {
        if (Arrays.equals(box.state.getValue(), bytes)) {return}
        outsideHistory(project, () => box.state.setValue(bytes))
    }

    // an edit in the plugin (its window, its undo, a preset), automation recording sees it
    export const edit = (project: Project, hub: Field<Pointers.Parameter>, paramId: number, value: number): void => {
        const paramBox = parameterOf(hub, paramId)
        if (!isDefined(paramBox) || paramBox.value.getValue() === Math.fround(value)) {return}
        const adapter = project.parameterFieldAdapters.opt(paramBox.value.address)
        const previous = adapter.map(adapter => adapter.getUnitValue())
        outsideHistory(project, () => paramBox.value.setValue(value))
        adapter.ifSome(adapter => project.parameterFieldAdapters.notifyWrite(adapter, previous.unwrap()))
    }

    // the plugin's edit following a value the host set (undo, redo, automation)
    export const follow = (project: Project, hub: Field<Pointers.Parameter>, paramId: number, value: number): void => {
        const paramBox = parameterOf(hub, paramId)
        if (!isDefined(paramBox) || paramBox.value.getValue() === Math.fround(value)) {return}
        outsideHistory(project, () => paramBox.value.setValue(value))
    }

    const parameterOf = (hub: Field<Pointers.Parameter>, paramId: number): Optional<WclapParameterBox> =>
        hub.pointerHub.incoming().map(({box}) => box)
            .find((box): box is WclapParameterBox => box instanceof WclapParameterBox && (box.clapId.getValue() >>> 0) === paramId)

    const outsideHistory = (project: Project, exec: Exec): void => {
        const graph = project.boxGraph
        if (graph.inTransaction()) {
            exec()
            return
        }
        graph.beginTransaction()
        exec()
        graph.endTransaction()
    }
}
