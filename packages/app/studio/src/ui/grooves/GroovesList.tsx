import modulatorCss from "../modulation/ModulatorEditor.sass?inline"
import targetCss from "../modulation/TargetList.sass?inline"
import css from "./GroovesList.sass?inline"
import {Errors, Lifecycle, panic, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {GrooveAdapter, Grooves, ParameterOwner} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Icon} from "@/ui/components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {Button} from "@/ui/components/Button"
import {Dialogs} from "@/ui/components/dialogs"
import {Surface} from "@/ui/surface/Surface"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {GrooveEditor} from "@/ui/grooves/GrooveEditor"
import {PanelTabs} from "@/ui/grooves/PanelTabs"
import {GrooveReveal} from "@/ui/grooves/GrooveReveal"

const rowClassName = Html.adoptStyleSheet(modulatorCss, "GrooveRow")
const usersClassName = Html.adoptStyleSheet(targetCss, "GrooveUsers")
const className = Html.adoptStyleSheet(css, "GroovesList")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

// Asks where the users of a groove go before it is deleted, a groove nobody uses goes at once
export const deleteGroove = async (service: StudioService, groove: GrooveAdapter, origin?: Element): Promise<void> => {
    const {project} = service
    const count = Grooves.targets(groove.box).length
    if (count === 0) {
        project.editing.modify(() => Grooves.deleteAll(project, [groove.box], "remove"))
        return
    }
    const choice = await Dialogs.choose<Grooves.DeleteMode>({
        headline: "Delete Groove",
        message: `"${groove.label}" is used ${count === 1 ? "once" : `${count} times`}.`,
        choices: [
            {text: "Remove from targets", value: "remove"},
            {text: "Use Global Shuffle", value: "fallback"}
        ],
        origin
    })
    choice.ifSome(mode => project.editing.modify(() => Grooves.deleteAll(project, [groove.box], mode)))
}

// The Grooves tab of the modulation panel, laid out like the modulators
export const GroovesList = ({lifecycle, service}: Construct): HTMLElement => {
    const {project} = service
    const {editing, rootBoxAdapter, userEditingManager} = project
    const contents = lifecycle.own(new Terminator())
    // Who uses the groove, like a modulator's targets: the instrument, the device, a delete
    const usedBy = (owner: Lifecycle, groove: GrooveAdapter): HTMLElement => {
        const entries: HTMLElement = <div className="entries" style={{gridTemplateColumns: "1fr auto"}}/>
        const rows = owner.own(new Terminator())
        const render = () => {
            rows.terminate()
            Html.empty(entries)
            const targets = Grooves.targets(groove.box)
            if (targets.length === 0) {
                entries.append(<div className="placeholder">Choose this groove in a Zeitgeist</div>)
                return
            }
            targets.forEach(pointer => {
                const user = Grooves.userOf(pointer)
                const ownerName: HTMLElement = <span className="owner"/>
                const deviceName: HTMLElement = <span className="parameter"/>
                if (user.type === "stack") {
                    deviceName.textContent = "Stack member"
                    rows.own(user.box.label.catchupAndSubscribe(field => ownerName.textContent = field.getValue()))
                } else {
                    ParameterOwner.audioUnitOf(project, pointer).ifSome(unit => {
                        rows.own(unit.input.catchupAndSubscribeLabelChange(label =>
                            ownerName.textContent = label.unwrapOrElse("")))
                        rows.own(Events.subscribe(ownerName, "click", () =>
                            userEditingManager.audioUnit.edit(unit.box.editing)))
                    })
                    rows.own(ParameterOwner.catchupAndSubscribeName(project, pointer, name =>
                        deviceName.textContent = name))
                }
                entries.append(
                    <div className="entry">
                        <span className="target">{ownerName}{deviceName}</span>
                        <Button lifecycle={rows} onClick={() => editing.modify(() => Grooves.unassign(pointer))}
                                appearance={{tooltip: "Remove the groove from this target"}}>
                            <Icon symbol={IconSymbol.Delete}/>
                        </Button>
                    </div>)
            })
        }
        owner.own(groove.box.pointerHub.subscribe({onAdded: () => render(), onRemoved: () => render()}))
        render()
        return <div className={usersClassName}>{entries}</div>
    }
    const row = (owner: Lifecycle, groove: GrooveAdapter): HTMLElement => {
        const isGlobal = Grooves.isGlobal(project, groove.box)
        const title: HTMLElement = (
            <h1 onInit={element => owner.ownAll(
                groove.labelField.catchupAndSubscribe(field => element.textContent = field.getValue()),
                Events.subscribeDblDwn(element, async event => {
                    if (isGlobal) {return}
                    const {status, error, value} = await Promises.tryCatch(
                        Surface.get(element).requestFloatingTextInput(event, groove.label))
                    if (status === "rejected") {
                        if (!Errors.isAbort(error)) {return panic(error)}
                    } else {
                        editing.modify(() => groove.labelField.setValue(value))
                    }
                }))}/>
        )
        const menu = MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
            MenuItem.default({label: "Duplicate"})
                .setTriggerProcedure(() => editing.modify(() => Grooves.duplicate(project, groove.box))),
            MenuItem.default({label: "Delete", selectable: !isGlobal, separatorBefore: true})
                .setTriggerProcedure(() => deleteGroove(service, groove, title))
        ))
        return (
            <div className={rowClassName}>
                <div className="modulator">
                    <header>
                        <span/>
                        {title}
                        <MenuButton root={menu} appearance={{color: Colors.cream}}>
                            <Icon symbol={IconSymbol.Menu}/>
                        </MenuButton>
                    </header>
                    <div className="body">
                        <div className="editor">{GrooveEditor({lifecycle: owner, service, groove})}</div>
                    </div>
                </div>
                {usedBy(owner, groove)}
            </div>
        )
    }
    const scroller: HTMLElement = (
        <div className={Html.buildClassList("scroller", className)}
             style={{gridTemplateColumns: "max-content var(--targets-width)"}}
             onConnect={host => {
                 requestAnimationFrame(() => revealRequested())
                 return lifecycle.own(installScrollbars(host))
             }}>
            <h5 className="head modulators">
                <PanelTabs lifecycle={lifecycle} active="grooves"/>
                <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent =>
                    parent.addMenuItem(...Grooves.Kinds.map(kind => MenuItem.default({label: kind.label})
                        .setTriggerProcedure(() => editing.modify(() => Grooves.create(project, kind.kind))))))}
                            appearance={{}}>
                    <Icon symbol={IconSymbol.Add}/>
                </MenuButton>
            </h5>
            <h5 className="head targets"><span>Used by</span></h5>
        </div>
    )
    const rows = UUID.newSet<{uuid: UUID.Bytes, element: HTMLElement}>(entry => entry.uuid)
    // a row is display: contents, so the scroll targets its first child, which has a box
    const revealRequested = () => GrooveReveal.requested.ifSome(uuid => rows.opt(uuid).ifSome(({element}) => {
        const target = element.firstElementChild
        if (!(target instanceof HTMLElement) || !target.isConnected) {return}
        target.scrollIntoView({block: "nearest"})
        element.classList.add("revealed")
        element.addEventListener("animationend", () => element.classList.remove("revealed"), {once: true})
        GrooveReveal.requested.clear()
    }))
    const render = () => {
        contents.terminate()
        rows.clear()
        while (scroller.childElementCount > 2) {scroller.lastElementChild?.remove()}
        rootBoxAdapter.grooves.adapters().forEach(groove => {
            const element = row(contents, groove)
            rows.add({uuid: groove.uuid, element})
            scroller.append(element)
        })
        revealRequested()
    }
    lifecycle.own(GrooveReveal.requested.subscribe(() => requestAnimationFrame(() => revealRequested())))
    lifecycle.own(rootBoxAdapter.grooves.catchupAndSubscribe({
        onAdd: () => render(),
        onRemove: () => render(),
        onReorder: () => render()
    }))
    render()
    return scroller
}
