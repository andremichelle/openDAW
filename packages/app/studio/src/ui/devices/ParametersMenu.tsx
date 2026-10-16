import {asInstanceOf, clamp, EmptyExec, isDefined, Lifecycle, Optional} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Events} from "@opendaw/lib-dom"
import {Field} from "@opendaw/lib-box"
import {Colors, Pointers} from "@opendaw/studio-enums"
import {AudioUnitTracks, AutomatableParameterFieldAdapter, ParameterAdapterSet} from "@opendaw/studio-adapters"
import {WclapParameterBox} from "@opendaw/studio-boxes"
import {MenuItem, Project} from "@opendaw/studio-core"
import {parameterContextItems} from "@/ui/menu/automation.ts"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Layers} from "@/ui/surface/Layers.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {ParameterTree, WclapParameterTree} from "@/ui/devices/audio-effects/WclapParameterTree"

type Construct = {
    lifecycle: Lifecycle
    project: Project
    parametersField: Field<Pointers.Parameter>
    parameters: ParameterAdapterSet
    tracks: () => AudioUnitTracks
}

// The "Parameters" button of a plugin device (WclapParameterBoxes on its parameters hub): grouped by module and
// shared words, each parameter with "Enter Percentage..." and the automate, modulate and MIDI learn items
export const ParametersMenu = ({lifecycle, project, parametersField, parameters, tracks}: Construct): HTMLElement => {
    const {editing, midiLearning} = project
    // The hub notifies per child, so an earlier child's notification sees later children without an adapter yet
    const parameterOf = (paramBox: WclapParameterBox): Optional<AutomatableParameterFieldAdapter> =>
        parameters.parameters().find(parameter => parameter.address.equals(paramBox.value.address))
    // the input waits for the closing menu, which restores focus and would swallow the typed text
    const pointer = {x: 0, y: 0}
    const enterPercentage = (parameter: AutomatableParameterFieldAdapter): void => {
        const layers = Layers.get(button)
        const budget = {frames: 30}
        const open = (): void => {
            if (layers.hasFlyout && budget.frames-- > 0) {
                AnimationFrame.once(open)
                return
            }
            const origin = layers.flyout.getBoundingClientRect()
            const resolvers = Promise.withResolvers<string>()
            resolvers.promise.then(text => {
                const value = parseFloat(text)
                if (!isFinite(value)) {return}
                editing.modify(() => parameter.setUnitValue(clamp(value / 100.0, 0.0, 1.0)))
                editing.mark()
            }, EmptyExec)
            layers.flyout.appendChild(
                <FloatingTextInput position={{x: pointer.x - origin.left, y: pointer.y - origin.top}}
                                   value={(parameter.getUnitValue() * 100.0).toFixed(1)}
                                   unit="%"
                                   numeric
                                   resolvers={resolvers}/>
            )
        }
        AnimationFrame.once(open)
    }
    const parameterItems = (parameter: AutomatableParameterFieldAdapter): ReadonlyArray<MenuItem> => [
        MenuItem.default({label: "Enter Percentage..."}).setTriggerProcedure(() => enterPercentage(parameter)),
        ...parameterContextItems(editing, midiLearning, tracks(), parameter)
    ]
    const root = MenuItem.root().setRuntimeChildrenProcedure(parent => {
        const entries = parametersField.pointerHub.incoming().flatMap(({box}) => {
            const paramBox = asInstanceOf(box, WclapParameterBox)
            const parameter = parameterOf(paramBox)
            return isDefined(parameter)
                ? [{module: paramBox.module.getValue(), name: paramBox.label.getValue(), value: parameter}] : []
        })
        const populate = (parent: MenuItem, tree: ParameterTree<AutomatableParameterFieldAdapter>): void => {
            parent.addMenuItem(...tree.groups.map(({label, tree: child}) =>
                MenuItem.default({label}).setRuntimeChildrenProcedure(sub => populate(sub, child))))
            parent.addMenuItem(...tree.items.map(({label, value}) => MenuItem.default({label})
                .setRuntimeChildrenProcedure(leaf => leaf.addMenuItem(...parameterItems(value)))))
        }
        populate(parent, WclapParameterTree.build(entries))
    })
    const button: HTMLElement = (
        <MenuButton root={root}
                    appearance={{
                        framed: true,
                        color: Colors.shadow,
                        activeColor: Colors.white,
                        tooltip: "Automate, modulate or MIDI learn a parameter"
                    }}>
            <span className="button-label">Parameters</span>
        </MenuButton>
    )
    lifecycle.ownAll(
        Events.subscribe(globalThis, "pointermove", (event: PointerEvent) => {
            pointer.x = event.clientX
            pointer.y = event.clientY
        }, {capture: true}),
        Events.subscribe(globalThis, "pointerdown", (event: PointerEvent) => {
            pointer.x = event.clientX
            pointer.y = event.clientY
        }, {capture: true})
    )
    return button
}
