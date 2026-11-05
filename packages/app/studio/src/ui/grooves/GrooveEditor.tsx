import css from "./GrooveEditor.sass?inline"
import {
    clamp,
    isDefined,
    isInstanceOf,
    Option,
    Lifecycle,
    MutableObservableValue,
    Notifier,
    Nullable,
    Observer,
    ObservableValue,
    Subscription,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {PPQN} from "@opendaw/lib-dsp"
import {PointerField} from "@opendaw/lib-box"
import {Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {
    CellGrooveBoxAdapter,
    GrooveAdapter,
    GrooveBox,
    GrooveDurations,
    GrooveKind,
    GrooveOffsetBoxAdapter,
    GrooveRandomBoxAdapter,
    Grooves,
    GrooveStackBoxAdapter
} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {DropDown} from "@/ui/composite/DropDown"
import {NumberInput} from "@/ui/components/NumberInput"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {GrooveLabelControl} from "@/ui/grooves/GrooveLabelControl"
import {GrooveDisplay} from "@/ui/grooves/GrooveDisplay"
import {GrooveMenus} from "@/ui/grooves/GrooveMenus"
import {GrooveReveal} from "@/ui/grooves/GrooveReveal"

const className = Html.adoptStyleSheet(css, "GrooveEditor")
const OffsetLimit = PPQN.fromSignature(1, 8)

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    // Nothing for a Zeitgeist without a groove
    groove: Nullable<GrooveAdapter>
    // The Zeitgeist's pointer: the editor then shows the Groove choice on top
    pointer?: PointerField<Pointers.Groove>
}

// A dropdown model from plain functions, the editor's values live in the box graph
const model = <T, >(get: () => T, set: (value: T) => void,
                     subscribe: (notify: () => void) => Subscription): MutableObservableValue<T> => {
    const notifier = new Notifier<ObservableValue<T>>()
    const self: MutableObservableValue<T> = {
        getValue: get,
        setValue: set,
        subscribe: (observer: Observer<ObservableValue<T>>): Subscription => {
            const own = notifier.subscribe(observer)
            const source = subscribe(() => notifier.notify(self))
            return Terminable.many(own, source)
        },
        catchupAndSubscribe: (observer: Observer<ObservableValue<T>>): Subscription => {
            observer(self)
            return self.subscribe(observer)
        }
    }
    return self
}

// The groove editor of the Zeitgeist panel and the Grooves list: the choices, the type's parameters, the display
export const GrooveEditor = ({lifecycle, service, groove, pointer}: Construct): HTMLElement => {
    const {project} = service
    const {editing, rootBoxAdapter} = project
    const field = (label: string, control: HTMLElement, extra?: HTMLElement): HTMLElement => (
        <div className="field"><h3>{label}{extra ?? ""}</h3>{control}</div>
    )
    // left: the Groove choice and the display, right: Type, Duration and the type's parameters
    const left: HTMLElement = <div className="left"/>
    const right: HTMLElement = <div className="right"/>
    const settings: HTMLElement = <div className="settings"/>
    if (isDefined(pointer)) {
        const current = (): Nullable<GrooveBox> => pointer.targetVertex.mapOr(vertex => Grooves.asGrooveBox(vertex.box), null)
        const shared: HTMLElement = <span className="shared"/>
        if (isDefined(groove)) {
            const update = () => {
                const count = Grooves.targets(groove.box).length
                shared.textContent = count > 1 ? `shared ×${count}` : ""
            }
            lifecycle.own(groove.box.pointerHub.subscribe({onAdded: update, onRemoved: update}))
            update()
        }
        left.append(field("Groove", (
            <DropDown lifecycle={lifecycle}
                      owner={model<Nullable<GrooveBox>>(current,
                          box => editing.modify(() => isDefined(box) ? pointer.refer(box) : pointer.defer()),
                          notify => Terminable.many(pointer.subscribe(notify),
                              isDefined(groove) ? groove.labelField.subscribe(notify) : Terminable.Empty))}
                      provider={() => [null, ...rootBoxAdapter.grooves.adapters().map(entry => entry.box)]}
                      mapping={box => isDefined(box) ? box.label.getValue() : GrooveMenus.NoneLabel}
                      width="100%"
                      appearance={{framed: true, color: Colors.blue, activeColor: Colors.bright}}
                      head={parent => parent.addMenuItem(MenuItem.default({
                          label: `Go to ${current()?.label.getValue() ?? GrooveMenus.NoneLabel}`,
                          selectable: isDefined(current())
                      }).setTriggerProcedure(() => {
                          const box = current()
                          if (isDefined(box)) {GrooveReveal.request(box.address.uuid)}
                      }))}
                      extra={parent => {
                          parent.addMenuItem(MenuItem.default({label: "New", separatorBefore: true})
                              .setRuntimeChildrenProcedure(sub => sub.addMenuItem(...Grooves.Kinds.map(kind =>
                                  MenuItem.default({label: kind.label}).setTriggerProcedure(() =>
                                      editing.modify(() => pointer.refer(Grooves.create(project, kind.kind))))))))
                          parent.addMenuItem(MenuItem.default({
                              label: "Make Unique",
                              selectable: isDefined(groove) && Grooves.targets(groove.box).length > 1
                          }).setTriggerProcedure(() => {
                              if (isDefined(groove)) {
                                  editing.modify(() => Grooves.makeUnique(project, groove.box, pointer))
                              }
                          }))
                      }}/>
        ), shared))
    }
    if (!isDefined(groove)) {
        return (
            <div className={className}>
                {left}
                <div className="right"/>
            </div>
        )
    }
    right.append(settings)
    settings.append(field("Type", (
        <DropDown lifecycle={lifecycle}
                  owner={model<GrooveKind>(() => groove.kind,
                      kind => editing.modify(() => Grooves.replace(project, groove.box, kind)),
                      notify => groove.subscribeChange(notify))}
                  provider={(): ReadonlyArray<GrooveKind> => Grooves.Kinds.map(kind => kind.kind)}
                  mapping={kind => Grooves.labelOf(kind)}
                  width="100%"
                  appearance={{framed: true, color: Colors.green, activeColor: Colors.bright}}/>
    )))
    settings.append(groove.duration.mapOr(duration => field("Duration", (
        <DropDown lifecycle={lifecycle}
                  owner={EditWrapper.forAutomatableParameter(editing, duration)}
                  provider={() => GrooveDurations.PPQNs}
                  mapping={ppqn => GrooveDurations.Labels[GrooveDurations.PPQNs.indexOf(ppqn)] ?? `${ppqn}`}
                  width="100%"
                  appearance={{framed: true, color: Colors.green, activeColor: Colors.bright}}/>
    )), <div className="field"/>))
    const parameters: HTMLElement = <div className="parameters"/>
    if (isInstanceOf(groove, CellGrooveBoxAdapter)) {
        parameters.append(<div className="slot amount">
            <GrooveLabelControl lifecycle={lifecycle} editing={editing} parameter={groove.amountParameter}/>
        </div>)
    }
    if (isInstanceOf(groove, GrooveRandomBoxAdapter)) {
        parameters.append(
            <div className="slot roughness">
                <GrooveLabelControl lifecycle={lifecycle} editing={editing} parameter={groove.roughness}/>
            </div>,
            <div className="slot steps">
                <GrooveLabelControl lifecycle={lifecycle} editing={editing} parameter={groove.steps}/>
            </div>,
            <div className="slot seed">
                <div className="control">
                    <h3>Seed</h3>
                    <NumberInput lifecycle={lifecycle} maxChars={6}
                                 guard={{guard: value => clamp(value, 0, GrooveRandomBoxAdapter.MaxSeed)}}
                                 model={EditWrapper.forValue(editing, groove.box.seed)}/>
                </div>
            </div>)
    }
    if (isInstanceOf(groove, GrooveOffsetBoxAdapter)) {
        parameters.append(
            <div className="slot offset">
                <div className="control">
                    <h3>Offset</h3>
                    <NumberInput lifecycle={lifecycle} maxChars={4}
                                 guard={{guard: value => clamp(Math.round(value), -OffsetLimit, OffsetLimit)}}
                                 model={EditWrapper.forValue(editing, groove.offsetField)}/>
                    <span className="hint">{`1/16 = ${PPQN.fromSignature(1, 16)}`}</span>
                </div>
            </div>)
    }
    if (isInstanceOf(groove, GrooveStackBoxAdapter)) {
        parameters.classList.add("stack")
        parameters.append(StackMembers({lifecycle, service, stack: groove}))
    }
    left.append(<GrooveDisplay lifecycle={lifecycle} groove={groove}/>)
    right.append(parameters)
    return (
        <div className={className}>
            {left}
            {right}
        </div>
    )
}

type StackMembersConstruct = {
    lifecycle: Lifecycle
    service: StudioService
    stack: GrooveStackBoxAdapter
}

// A stack's members in the order they apply, which changes the result: drag a row to move it, × removes it
const StackMembers = ({lifecycle, service, stack}: StackMembersConstruct): HTMLElement => {
    const {project} = service
    const {editing} = project
    const rows: HTMLElement = <div className="rows" onConnect={element => lifecycle.own(installScrollbars(element))}/>
    const owner = lifecycle.own(new Terminator())
    const render = () => {
        owner.terminate()
        Html.empty(rows)
        const entries = stack.entries.adapters()
        if (entries.length === 0) {rows.append(<div className="placeholder">No grooves</div>)}
        const elements: Array<HTMLElement> = []
        entries.forEach((entry, index) => {
            const element: HTMLElement = (
                <div className="member">
                    <span className="name">{entry.groove().mapOr(member => member.label, "")}</span>
                    <Button lifecycle={owner} onClick={() => editing.modify(() => Grooves.removeFromStack(entry.box))}
                            appearance={{color: Colors.gray, tooltip: "Remove from stack"}}>
                        <Icon symbol={IconSymbol.Close}/>
                    </Button>
                </div>
            )
            elements.push(element)
            rows.append(element)
            owner.own(Events.subscribe(element, "dblclick", () =>
                entry.groove().ifSome(member => GrooveReveal.request(member.uuid))))
            owner.own(Dragging.attach(element, (event: PointerEvent) => {
                if (event.target instanceof Element && isDefined(event.target.closest("button, input, label"))) {
                    return Option.None
                }
                let target = index
                // the rows show the new order while dragging
                const mark = () => elements.forEach((other, position) => {
                    const shown = position === index ? target
                        : position < index && position >= target ? position + 1
                            : position > index && position <= target ? position - 1 : position
                    other.style.order = String(shown)
                })
                mark()
                return Option.wrap({
                    update: (event: Dragging.Event) => {
                        const top = rows.getBoundingClientRect().top
                        const height = element.getBoundingClientRect().height + 1
                        target = clamp(Math.floor((event.clientY - top) / height), 0, elements.length - 1)
                        mark()
                    },
                    cancel: () => {
                        target = index
                        mark()
                    },
                    approve: () => {
                        if (target !== index) {editing.modify(() => Grooves.moveInStack(stack.box, entry.box, target))}
                        target = index
                        mark()
                    }
                })
            }))
        })
    }
    lifecycle.own(stack.subscribeChange(() => render()))
    render()
    return (
        <div className="slot members">
            <div className="head">
                <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(GrooveMenus.memberItems(project, stack))}
                            appearance={{color: Colors.gray, tooltip: "Add a groove"}}>
                    <Icon symbol={IconSymbol.Add}/>
                </MenuButton>
            </div>
            {rows}
        </div>
    )
}
