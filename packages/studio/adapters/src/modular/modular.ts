import {ModularBox} from "@moises-ai/studio-boxes"
import {Address, Field, PointerField, StringField} from "@moises-ai/lib-box"
import {asDefined, ifDefined, Listeners, SortedSet, Subscription, Terminator, UUID} from "@moises-ai/lib-std"
import {ModuleConnectionAdapter} from "./connection"
import {Pointers} from "@moises-ai/studio-enums"
import {ModuleAdapter, Modules} from "./module"
import {BoxAdapter} from "../BoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ModularDeviceBoxAdapter} from "../devices/audio-effects/ModularDeviceBoxAdapter"

export interface ModularSystemListener {
    onModuleAdded?(adapter: ModuleAdapter): void
    onModuleRemoved?(adapter: ModuleAdapter): void
    onConnectionAdded?(adapter: ModuleConnectionAdapter): void
    onConnectionRemoved?(adapter: ModuleConnectionAdapter): void
}

export class ModularAdapter implements BoxAdapter {
    readonly #terminator: Terminator = new Terminator()
    readonly #listeners: Listeners<ModularSystemListener>

    readonly #context: BoxAdaptersContext
    readonly #box: ModularBox

    readonly #modules: SortedSet<UUID.Bytes, ModuleAdapter>
    readonly #connections: SortedSet<UUID.Bytes, ModuleConnectionAdapter>

    constructor(context: BoxAdaptersContext, box: ModularBox) {
        this.#context = context
        this.#box = box

        this.#listeners = this.#terminator.own(new Listeners<ModularSystemListener>())

        this.#modules = UUID.newSet<ModuleAdapter>(adapter => adapter.uuid)
        this.#connections = UUID.newSet<ModuleConnectionAdapter>(adapter => adapter.uuid)

        const addModule = (pointer: PointerField) => {
            const adapter = Modules.adapterFor(this.#context.boxAdapters, pointer.box)
            const added = this.#modules.add(adapter)
            // assert(added, `Could not add ${pointer}`)
            // TODO Implement catchupAndSubscribeTransactual that deals with that situation
            if (!added) {
                return
            }
            this.#listeners.proxy.onModuleAdded(adapter)
        }
        const removeModule = (pointer: PointerField) =>
            this.#listeners.proxy.onModuleRemoved(this.#modules.removeByKey(pointer.address.uuid))

        const addConnection = (pointer: PointerField) => {
            const adapter = this.#context.boxAdapters.adapterFor(pointer.box, ModuleConnectionAdapter)
            const added = this.#connections.add(adapter)
            // assert(added, `Could not add ${pointer}`)
            // TODO Implement catchupAndSubscribeTransactual that deals with that situation
            if (!added) {
                return
            }
            this.#listeners.proxy.onConnectionAdded(adapter)
        }
        const removeConnection = (pointer: PointerField) =>
            this.#listeners.proxy.onConnectionRemoved(this.#connections.removeByKey(pointer.address.uuid))

        this.#box.modules.pointerHub.filter(Pointers.ModuleCollection).forEach(addModule)
        this.#box.connections.pointerHub.filter(Pointers.ConnectionCollection).forEach(addConnection)

        this.#terminator.own(this.#box.modules.pointerHub
            .subscribe({onAdded: addModule, onRemoved: removeModule}, Pointers.ModuleCollection))
        this.#terminator.own(this.#box.connections.pointerHub
            .subscribe({onAdded: addConnection, onRemoved: removeConnection}, Pointers.ConnectionCollection))
    }

    catchupAndSubscribe(listener: ModularSystemListener): Subscription {
        ifDefined(listener.onModuleAdded, fn => this.#modules.forEach(adapter => fn(adapter)))
        ifDefined(listener.onConnectionAdded, fn => this.#connections.forEach(adapter => fn(adapter)))
        return this.#listeners.subscribe(listener)
    }

    get box(): ModularBox {return this.#box}
    get address(): Address {return this.#box.address}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get editingField(): Field<Pointers.Editing> {return this.#box.editing}
    get labelField(): StringField {return this.#box.label}
    get modules(): ReadonlyArray<ModuleAdapter> {return this.#modules.values()}
    get connections(): ReadonlyArray<ModuleConnectionAdapter> {return this.#connections.values()}
    get device(): ModularDeviceBoxAdapter {
        return this.#context.boxAdapters
            .adapterFor(asDefined(this.#box.device.pointerHub.incoming().at(0), "No device found").box, ModularDeviceBoxAdapter)
    }

    terminate(): void {
        console.debug(`terminate ${this}`)
        this.#terminator.terminate()
    }
}