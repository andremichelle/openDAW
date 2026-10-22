import css from "./Spotlight.sass?inline"
import {DefaultObservableValue, int, MutableObservableOption, Option, Point, Terminable, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import type {StudioService} from "@/service/StudioService"
import {Icon} from "@/ui/components/Icon"
import {Surface} from "@/ui/surface/Surface"
import {openManual} from "@/ui/manuals"
import {CommunityAPI} from "@/opendaw-api/CommunityAPI"
import {CommunityScript} from "@/opendaw-api/CommunityIndex"
import {SpotlightVerbs} from "@/ui/spotlight/SpotlightVerbs"
import {SpotlightEntry} from "@/ui/spotlight/SpotlightEntry"
import {SpotlightCreateEntries} from "@/ui/spotlight/SpotlightCreateEntries"
import {SpotlightStudioEntries} from "@/ui/spotlight/SpotlightStudioEntries"
import {SpotlightUsage} from "@/ui/spotlight/SpotlightUsage"

const className = Html.adoptStyleSheet(css, "Spotlight")

const MAX_RESULTS = 100

export class Spotlight {
    readonly #service: StudioService

    #position: Option<Point> = Option.None
    #session: Option<Terminator> = Option.None

    constructor(service: StudioService) {this.#service = service}

    toggle(): void {
        this.#session.match({
            some: session => session.terminate(),
            none: () => this.#open()
        })
    }

    #open(): void {
        const service = this.#service
        const {presets, hasProfile} = service
        const surface = Surface.get()
        const position = this.#position.unwrapOrElse(() => Point.create(surface.width / 2, surface.height / 3))
        this.#position = Option.wrap(position)
        const lifecycle = new Terminator()
        this.#session = Option.wrap(lifecycle)
        const scripts = lifecycle.own(new DefaultObservableValue<ReadonlyArray<CommunityScript>>([]))
        const entries = lifecycle.own(new DefaultObservableValue<ReadonlyArray<SpotlightEntry>>([]))
        const selected = lifecycle.own(new DefaultObservableValue<int>(0))
        const results = lifecycle.own(new DefaultObservableValue<ReadonlyArray<SpotlightEntry>>([]))
        const scope = lifecycle.own(new MutableObservableOption<string>())
        const outerQuery = lifecycle.own(new DefaultObservableValue<string>(""))
        const input: HTMLInputElement = <input type="text"/>
        const verbIcon: HTMLElement = <div className="verb"/>
        const scopeChip: HTMLElement = <div className="scope"/>
        const list: HTMLElement = <div className="results"/>
        const help: HTMLElement = <footer/>
        const element: HTMLElement = (
            <div className={className} tabindex={-1}>
                <header>{verbIcon}{scopeChip}{input}</header>
                {list}
                {help}
            </div>
        )
        const close = () => lifecycle.terminate()
        const browsable = (entry: SpotlightEntry): boolean => entry.children.length > 0 && entry.disabled.isEmpty()
        const selectedEntry = (): Option<SpotlightEntry> => Option.wrap(results.getValue().at(selected.getValue()))
        const scopeEntry = (): Option<SpotlightEntry> =>
            scope.flatMap(label => Option.wrap(entries.getValue().find(entry => entry.label === label)))
        const runSelected = () => selectedEntry().ifSome(entry => {
            if (entry.disabled.nonEmpty()) {return}
            close()
            SpotlightUsage.record(entry)
            entry.run()
        })
        const enterScope = () => selectedEntry().ifSome(entry => {
            if (!browsable(entry)) {return}
            outerQuery.setValue(input.value)
            scope.wrap(entry.label)
            input.value = ""
            render()
            input.focus()
        })
        const leaveScope = () => scope.ifSome(label => {
            scope.clear()
            input.value = outerQuery.getValue()
            render()
            const index = results.getValue().findIndex(entry => entry.label === label)
            if (index >= 0) {selected.setValue(index)}
        })
        const renderHeader = () => {
            const {verb} = SpotlightVerbs.parse(input.value)
            verb.ifSome(({icon, word}) => replaceChildren(verbIcon, <Icon symbol={icon}/>, <span>{word}</span>))
            scopeEntry().match({
                none: () => {
                    verbIcon.classList.toggle("hidden", verb.isEmpty())
                    scopeChip.classList.add("hidden")
                    input.placeholder = "Type a device, preset, script or place..."
                },
                some: parent => {
                    verbIcon.classList.add("hidden")
                    scopeChip.classList.remove("hidden")
                    replaceChildren(scopeChip, <Icon symbol={parent.icon}/>, <span>{parent.names[0]}</span>)
                    input.placeholder = `Filter ${parent.children.length} entries...`
                }
            })
        }
        const renderList = () => {
            const {verb, subject} = SpotlightVerbs.parse(input.value)
            const ranked = scopeEntry().match({
                none: () => subject.length === 0
                    ? verb.mapOr(({verb}) => SpotlightEntry.frequent(entries.getValue(), verb, SpotlightUsage.count()), [])
                    : SpotlightEntry.rank(entries.getValue(), verb.map(({verb}) => verb), subject),
                some: parent => SpotlightEntry.browse(parent.children, input.value)
            }).slice(0, MAX_RESULTS)
            const listing = scope.nonEmpty() || subject.length > 0 || verb.nonEmpty()
            results.setValue(ranked)
            selected.setValue(0)
            help.classList.toggle("hidden", listing)
            list.classList.toggle("hidden", !listing)
            replaceChildren(list, ranked.length === 0
                ? <div className="empty">{scope.nonEmpty() ? `No match for '${input.value.trim()}'`
                    : verb.match({
                        none: () => `Nothing found for '${subject}'`,
                        some: ({verb, word}) => verb === "create" || verb === "open" || verb === "goto"
                            ? `Nothing to ${word} for '${subject}'` : `'${word}' is not available yet`
                    })}</div>
                : ranked.map((entry, index) => (
                    <div className={Html.buildClassList("entry", entry.disabled.nonEmpty() && "disabled")}
                         onpointerenter={() => selected.setValue(index)}
                         onclick={() => {
                             selected.setValue(index)
                             runSelected()
                         }}>
                        <Icon symbol={entry.icon}/>
                        <span className="label">{entry.label}</span>
                        <span className="detail">{entry.disabled.unwrapOrElse(entry.detail)}</span>
                        {browsable(entry) && (
                            <span className="children"
                                  onclick={(event: MouseEvent) => {
                                      event.stopPropagation()
                                      selected.setValue(index)
                                      enterScope()
                                  }}>
                                {String(entry.children.length)}<Icon symbol={IconSymbol.ArrowRight}/>
                            </span>
                        )}
                    </div>
                )))
            renderSelection()
        }
        const render = () => {
            if (scope.nonEmpty() && scopeEntry().isEmpty()) {scope.clear()}
            renderHeader()
            renderList()
        }
        const renderSelection = () => {
            Array.from(list.children).forEach((child, index) =>
                child.classList.toggle("selected", index === selected.getValue()))
            list.children.item(selected.getValue())?.scrollIntoView({block: "nearest"})
        }
        const renderHelp = () => {
            const available = entries.getValue()
            replaceChildren(help,
                SpotlightVerbs.List
                    .filter(({verb}) => available.some(entry => entry.verb === verb))
                    .map(({symbol, word}) => <span><b>{symbol}</b> {word}</span>),
                available.some(browsable) && <span><b>→</b> browse</span>,
                <span className="manual" title="Open the Spotlight manual" onclick={() => {
                    close()
                    openManual("/manuals/spotlight")
                }}><Icon symbol={IconSymbol.Help}/></span>)
        }
        const refresh = () => {
            entries.setValue([...SpotlightStudioEntries.places(service), ...SpotlightStudioEntries.actions(service),
                ...SpotlightStudioEntries.opens(service),
                ...SpotlightCreateEntries.collect(service, scripts.getValue())])
            renderHelp()
            render()
        }
        const caretAt = (position: int): boolean => input.selectionStart === position && input.selectionEnd === position
        const moveSelection = (delta: int) => {
            const count = results.getValue().length
            if (count > 0) {selected.setValue((selected.getValue() + delta + count) % count)}
        }
        const updatePosition = () => element.style.transform = `translate(${position.x}px, ${position.y}px)`
        updatePosition()
        lifecycle.ownAll(
            selected.subscribe(renderSelection),
            scripts.subscribe(refresh),
            presets.userIndex.subscribe(refresh),
            presets.cloudIndex.subscribe(refresh),
            hasProfile ? service.project.userEditingManager.audioUnit.catchupAndSubscribe(refresh) : Terminable.Empty,
            Dragging.attach(element, ({target, clientX, clientY}) => {
                if (target instanceof Element && target.closest("input, .results") !== null) {return Option.None}
                const {x, y} = position
                return Option.wrap({
                    update: (event: Dragging.Event) => {
                        position.x = x + event.clientX - clientX
                        position.y = y + event.clientY - clientY
                        updatePosition()
                    },
                    cancel: () => {
                        position.x = x
                        position.y = y
                        updatePosition()
                    },
                    finally: () => input.focus()
                })
            }),
            Events.subscribe(input, "input", render),
            Events.subscribe(input, "keydown", (event: KeyboardEvent) => {
                switch (event.code) {
                    case "ArrowDown":
                        event.preventDefault()
                        moveSelection(1)
                        break
                    case "ArrowUp":
                        event.preventDefault()
                        moveSelection(-1)
                        break
                    case "Enter":
                    case "NumpadEnter":
                        event.preventDefault()
                        runSelected()
                        break
                    case "ArrowRight":
                        if (caretAt(input.value.length)) {
                            event.preventDefault()
                            enterScope()
                        }
                        break
                    case "ArrowLeft":
                        if (scope.nonEmpty() && caretAt(0)) {
                            event.preventDefault()
                            leaveScope()
                        }
                        break
                    case "Backspace":
                        if (scope.nonEmpty() && input.value.length === 0) {
                            event.preventDefault()
                            leaveScope()
                        }
                        break
                    case "Escape":
                        event.preventDefault()
                        if (scope.nonEmpty()) {leaveScope()} else {close()}
                        break
                    case "Tab":
                        event.preventDefault()
                        if (scope.isEmpty()) {
                            SpotlightVerbs.parse(input.value).completion.ifSome(completion => {
                                input.value = completion
                                render()
                            })
                        }
                        break
                }
            }),
            Events.subscribe(element, "focusout", (event: FocusEvent) => {
                const related = event.relatedTarget
                if (!(related instanceof Node) || !element.contains(related)) {close()}
            }),
            {
                terminate: () => {
                    this.#session = Option.None
                    element.remove()
                }
            }
        )
        CommunityAPI.get().scripts().then(index => {
            if (this.#session.contains(lifecycle)) {scripts.setValue(index.scripts)}
        })
        refresh()
        surface.flyout.appendChild(element)
        requestAnimationFrame(() => input.focus())
    }
}