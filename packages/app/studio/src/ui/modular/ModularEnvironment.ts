import {
    assert,
    isDefined,
    Nullable,
    Option,
    Point,
    Provider,
    Selection,
    SortedSet,
    Terminable,
    Terminator,
    UUID
} from "@moises-ai/lib-std"
import {
    Direction,
    ModularAdapter,
    ModuleAdapter,
    ModuleConnectionAdapter,
    ModuleConnectorAdapter,
    Modules
} from "@moises-ai/studio-adapters"
import {Address, Vertex} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {ModuleConnectionBox} from "@moises-ai/studio-boxes"
import {Camera} from "@/ui/modular/Camera.ts"
import {Surface} from "@/ui/surface/Surface.tsx"
import {Events} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService"
import {Project} from "@moises-ai/studio-core"

export type ModuleViewAdapter = {
    moduleView: Element
    moduleAdapter: ModuleAdapter
    lifecycle: Terminator
}

export class ConnectorViewAdapter {
    readonly #adapter: ModuleConnectorAdapter<any, any>
    readonly #element: Element
    readonly #pinLocator: Provider<Point>

    constructor(adapter: ModuleConnectorAdapter<any, any>, element: Element, pinLocator: Provider<Point>) {
        this.#adapter = adapter
        this.#element = element
        this.#pinLocator = pinLocator
    }

    get adapter(): ModuleConnectorAdapter<any, any> {return this.#adapter}
    get element(): Element {return this.#element}
    get pinPoint(): Point {return this.#pinLocator()}

    toString(): string {return `{ConnectorViewAdapter adapter: ${this.#adapter}`}
}

export interface WiringPreview {
    begin(connector: ConnectorViewAdapter, pointer: Point): {
        update: (pointer: Point, locked: boolean) => void
    } & Terminable
    highlight(connection: UUID.Bytes): Terminable
}

export class ModularEnvironment implements Terminable {
    readonly #service: StudioService
    readonly #modularAdapter: ModularAdapter
    readonly #camera: Camera

    readonly #terminator: Terminator
    readonly #selection: Selection<ModuleAdapter>

    readonly #modules: SortedSet<UUID.Bytes, ModuleViewAdapter>
    readonly #connectors: SortedSet<Address, ConnectorViewAdapter>

    #wiringPreview: Option<WiringPreview> = Option.None

    #isWiring: boolean = false

    constructor(service: StudioService, modularAdapter: ModularAdapter, camera: Camera) {
        this.#service = service
        this.#modularAdapter = modularAdapter
        this.#camera = camera

        this.#terminator = new Terminator()
        this.#selection = this.#terminator.own(this.#service.project.selection.createFilteredSelection(Modules.isVertexOfModule, {
            fx: (adapter: ModuleAdapter) => adapter.box,
            fy: vertex => Modules.adapterFor(this.#service.project.boxAdapters, vertex.box)
        }))
        this.#modules = UUID.newSet<ModuleViewAdapter>(viewAdapter => viewAdapter.moduleAdapter.uuid)
        this.#connectors = Address.newSet(view => view.adapter.address)

        this.#terminator.own(this.#selection.catchupAndSubscribe({
            onSelected: (adapter: ModuleAdapter) => {
                adapter.onSelected()
                this.#modules.getOrNull(adapter.uuid)?.moduleView.classList.add("selectable")
            },
            onDeselected: (adapter: ModuleAdapter) => {
                adapter.onDeselected()
                this.#modules.getOrNull(adapter.uuid)?.moduleView.classList.remove("selectable")
            }
        }))
    }

    setWiringPreview(preview: WiringPreview): void {
        this.#wiringPreview = Option.wrap(preview)
    }

    registerModule(viewAdapter: ModuleViewAdapter): void {
        console.debug(`registerModule(${viewAdapter.toString()})`)
        const added = this.#modules.add(viewAdapter)
        assert(added, `Could not register viewAdapter ${viewAdapter.toString()}`)
        viewAdapter.moduleAdapter.attributes
    }

    unregisterModule(uuid: UUID.Bytes): void {
        console.debug(`unregisterModule(${UUID.toString(uuid)})`)
        this.#modules.removeByKey(uuid).lifecycle.terminate()
    }

    registerConnectorView(view: ConnectorViewAdapter): Terminable {
        console.debug(`registerConnector(${view.adapter.address.toString()})`)
        const added = this.#connectors.add(view)
        assert(added, `Could not register connector at ${view.toString()}`)
        return {terminate: () => this.#connectors.removeByKey(view.adapter.address)}
    }

    findConnectorByViewAddress(address: Address): ConnectorViewAdapter {return this.#connectors.get(address)}

    findConnectorViewByEventTarget(target: Nullable<EventTarget>): Nullable<ConnectorViewAdapter> {
        if (target === null) {return null}
        return this.#connectors.values().find(view => view.element === target) ?? null
    }

    findMatchingConnectorViews(adapter: ModuleConnectorAdapter<Pointers, any>): ReadonlyArray<ConnectorViewAdapter> {
        return this.#connectors
            .values()
            .filter(view => view.adapter.matches(adapter))
    }

    beginWiring(adapter: ModuleConnectorAdapter<any, any>, pointer: Point): void {
        const runtime = new Terminator()
        this.#isWiring = true
        runtime.own({terminate: () => this.#isWiring = false})
        const matchingConnectors = this.findMatchingConnectorViews(adapter)
        if (matchingConnectors.length === 0) {return}
        matchingConnectors.forEach(connector => connector.element.classList.add("accepting"))
        runtime.own({
            terminate: () => matchingConnectors.forEach(connector => connector.element.classList.remove("accepting"))
        })
        const preview = runtime.own(this.#wiringPreview.unwrap("No preview set.")
            .begin(this.#connectors.get(adapter.address), pointer))
        let lock: Option<ConnectorViewAdapter> = Option.None
        const owner = Surface.get().owner // TODO we need a reference to the owner
        runtime.own(Events.subscribe(owner, "pointerover", event => {
            const view: Nullable<ConnectorViewAdapter> = this.findConnectorViewByEventTarget(event.target)
            if (isDefined(view) && matchingConnectors.includes(view)) {
                lock = Option.wrap(view)
            } else {
                lock = Option.None
            }
        }, {capture: true}))
        runtime.own(Events.subscribe(owner, "pointermove", event => preview.update(lock.match({
            none: () => Point.fromClient(event),
            some: ({pinPoint: {x, y}}) => this.#camera.localToGlobal(x, y)
        }), lock.nonEmpty()), {capture: true}))
        runtime.own(Events.subscribe(owner, "pointerup", event => {
            const view: Nullable<ConnectorViewAdapter> = this.findConnectorViewByEventTarget(event.target)
            if (isDefined(view)) {
                this.#connect(adapter, view.adapter)
            }
            runtime.terminate()
        }, {capture: true}))
    }

    beginRewiring(connection: ModuleConnectionAdapter, connectorAdapter: ModuleConnectorAdapter<any, any>, pointer: Point) {
        const vertex: Vertex = connection.source.address.equals(connectorAdapter.address)
            ? connection.target
            : connection.source
        const connector: ModuleConnectorAdapter<any, any> = this.findConnectorByViewAddress(vertex.address).adapter
        this.#service.project.editing.modify(() => connection.box.delete())
        this.beginWiring(connector, pointer)
    }

    highlightWire(connection: ModuleConnectionAdapter): Terminable {
        return this.#wiringPreview.match({
            none: () => Terminable.Empty,
            some: preview => preview.highlight(connection.uuid)
        })
    }

    get isWiring(): boolean {return this.#isWiring}
    get service(): StudioService {return this.#service}
    get project(): Project {return this.#service.project}
    get selection(): Selection<ModuleAdapter> {return this.#selection}
    get modularAdapter(): ModularAdapter {return this.#modularAdapter}

    terminate(): void {
        this.#wiringPreview = Option.None
        this.#modules.forEach(entry => entry.lifecycle.terminate())
        this.#modules.clear()
        this.#terminator.terminate()
    }

    #connect(adapter: ModuleConnectorAdapter<any, any>, other: ModuleConnectorAdapter<any, any>): void {
        if (adapter === other) {
            console.debug("Cannot connect same connector")
            return
        }
        if (!adapter.matches(other)) {
            console.debug("Cannot connect mismatching connectors")
            return
        }
        const source = adapter.direction === Direction.Output ? adapter : other
        const target = other.direction === Direction.Input ? other : adapter
        if (source.connections.some(connection => connection.box.target.targetVertex.unwrap().address.equals(target.address))) {
            // TODO showInfoDialog("Connection already exists")
            return
        }
        const {editing, boxGraph} = this.#service.project
        editing.modify(() => ModuleConnectionBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(this.#modularAdapter.box.connections)
            box.source.refer(source.field)
            box.target.refer(target.field)
        }))
    }
}