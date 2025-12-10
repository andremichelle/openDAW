import {
    Arrays,
    assert,
    ByteArrayInput,
    float,
    int,
    isDefined,
    Option,
    panic,
    Procedure,
    SortedSet,
    Subscription,
    Terminable
} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {AnimationFrame} from "@opendaw/lib-dom"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {PackageType} from "./PackageType"
import {Subscribers} from "./Subscribers"
import {Protocol} from "./Protocol"
import {Lock} from "./Lock"
import {Flags} from "./Flags"

interface Package<T> extends Terminable {
    dispatch(address: Address, input: ByteArrayInput): void
    subscribe(address: Address, procedure: Procedure<T>): Subscription
    hasSubscribers(address: Address): boolean
}

class FloatPackage implements Package<float> {
    readonly subscribers = new Subscribers<Procedure<float>>()

    dispatch(address: Address, input: ByteArrayInput): void {
        const value = input.readFloat()
        this.subscribers.getOrNull(address)?.forEach(procedure => procedure(value))
    }
    subscribe(address: Address, procedure: Procedure<float>): Subscription {
        return this.subscribers.subscribe(address, procedure)
    }
    hasSubscribers(address: Address): boolean {return !this.subscribers.isEmpty(address)}
    terminate(): void {this.subscribers.terminate()}
}

class IntegerPackage implements Package<int> {
    readonly subscribers = new Subscribers<Procedure<int>>()

    dispatch(address: Address, input: ByteArrayInput): void {
        const value = input.readInt()
        this.subscribers.getOrNull(address)?.forEach(procedure => procedure(value))
    }
    subscribe(address: Address, procedure: Procedure<int>): Subscription {
        return this.subscribers.subscribe(address, procedure)
    }
    hasSubscribers(address: Address): boolean {return !this.subscribers.isEmpty(address)}
    terminate(): void {this.subscribers.terminate()}
}

type ArrayTypes = Float32Array | Int32Array | Int8Array

type ArrayEntry<T extends ArrayTypes> = { address: Address, array: T }

abstract class ArrayPackage<T extends ArrayTypes> implements Package<T> {
    readonly subscribers = new Subscribers<Procedure<T>>()
    readonly #arrays: SortedSet<Address, ArrayEntry<T>> = Address.newSet<ArrayEntry<T>>(entry => entry.address)

    abstract create(length: int): T
    abstract read(input: ByteArrayInput, array: T, length: int): void

    dispatch(address: Address, input: ByteArrayInput): void {
        const length = input.readInt()
        const entry = this.#arrays.getOrNull(address)
        let array: T
        if (isDefined(entry)) {
            array = entry.array
        } else {
            array = this.create(length)
            this.#arrays.add({address, array})
        }
        this.read(input, array, length)
        this.subscribers.getOrNull(address)?.forEach(procedure => procedure(array))
    }

    subscribe(address: Address, procedure: Procedure<T>): Subscription {
        const subscription = this.subscribers.subscribe(address, procedure)
        return {
            terminate: () => {
                subscription.terminate()
                if (this.subscribers.isEmpty(address) && this.#arrays.hasKey(address)) {
                    this.#arrays.removeByKey(address)
                }
            }
        }
    }

    hasSubscribers(address: Address): boolean {return !this.subscribers.isEmpty(address)}
    terminate(): void {this.subscribers.terminate()}
}

class FloatArrayPackage extends ArrayPackage<Float32Array> {
    create(length: number): Float32Array {return new Float32Array(length)}
    read(input: ByteArrayInput, array: Float32Array, length: number): void {
        for (let i = 0; i < length; i++) {array[i] = input.readFloat()}
    }
}

class IntegerArrayPackage extends ArrayPackage<Int32Array> {
    create(length: number): Int32Array {return new Int32Array(length)}
    read(input: ByteArrayInput, array: Int32Array, length: number): void {
        for (let i = 0; i < length; i++) {array[i] = input.readInt()}
    }
}

class ByteArrayPackage extends ArrayPackage<Int8Array> {
    create(length: number): Int8Array {return new Int8Array(length)}
    read(input: ByteArrayInput, array: Int8Array, _length: number): void {
        input.readBytes(array)
    }
}

type StructureEntry = { address: Address, package: Package<unknown> }

export class LiveStreamReceiver implements Terminable {
    static ID: int = 0 | 0

    readonly #float = new FloatPackage()
    readonly #integer = new IntegerPackage()
    readonly #floats = new FloatArrayPackage()
    readonly #integers = new IntegerArrayPackage()
    readonly #bytes = new ByteArrayPackage()
    readonly #packages: Array<Package<unknown>> = []
    readonly #procedures: Array<Procedure<ByteArrayInput>> = []
    readonly #structure: Array<StructureEntry> = []
    readonly #id: int

    #optLock: Option<Int8Array> = Option.None
    #sab: Option<ArrayBufferLike> = Option.None
    #memory: Option<ByteArrayInput> = Option.None
    #subscriptionFlags: Option<Uint8Array> = Option.None
    #numPackages: int = 0

    #structureVersion = -1
    #connected = false

    constructor() {
        this.#id = LiveStreamReceiver.ID++
        this.#packages[PackageType.Float] = this.#float
        this.#packages[PackageType.FloatArray] = this.#floats
        this.#packages[PackageType.Integer] = this.#integer
        this.#packages[PackageType.IntegerArray] = this.#integers
        this.#packages[PackageType.ByteArray] = this.#bytes
    }

    connect(messenger: Messenger): Terminable {
        assert(!this.#connected, "Already connected")
        this.#connected = true
        return Terminable.many(
            {terminate: () => {this.#disconnect()}},
            Communicator.executor<Protocol>(messenger, {
                sendShareLock: (lock: SharedArrayBuffer) => this.#optLock = Option.wrap(new Int8Array(lock)),
                sendUpdateData: (data: ArrayBufferLike) => {
                    // SAB layout: [subscription flags (numPackages bytes)][data]
                    // Store the raw SAB, views will be created in #updateDataViews after structure is known
                    this.#sab = Option.wrap(data)
                    this.#updateDataViews()
                },
                sendUpdateStructure: (structure: ArrayBufferLike) => {
                    this.#updateStructure(new ByteArrayInput(structure))
                    // Always recreate views after structure update
                    // This handles both cases:
                    // 1. Structure arrives before SAB: #sab might be empty or old, views won't work but that's ok
                    // 2. SAB arrives before structure: #sab is new, now create correct views with new numPackages
                    this.#updateDataViews()
                }
            }),
            AnimationFrame.add(() => this.#dispatch())
        )
    }

    #updateDataViews(): void {
        if (this.#sab.isEmpty() || this.#numPackages === 0) {return}
        const data = this.#sab.unwrap()
        this.#subscriptionFlags = Option.wrap(new Uint8Array(data, 0, this.#numPackages))
        this.#memory = Option.wrap(new ByteArrayInput(data, this.#numPackages))
    }

    #disconnect(): void {
        this.#memory = Option.None
        this.#optLock = Option.None
        this.#sab = Option.None
        this.#subscriptionFlags = Option.None
        this.#numPackages = 0
        this.#structureVersion = -1
        this.#connected = false
        Arrays.clear(this.#procedures)
        Arrays.clear(this.#structure)
        this.#float.terminate()
        this.#floats.terminate()
        this.#integer.terminate()
        this.#integers.terminate()
        this.#bytes.terminate()
    }

    subscribeFloat(address: Address, procedure: Procedure<float>): Subscription {
        return this.#float.subscribe(address, procedure)
    }

    subscribeInteger(address: Address, procedure: Procedure<int>): Subscription {
        return this.#integer.subscribe(address, procedure)
    }

    subscribeFloats(address: Address, procedure: Procedure<Float32Array>): Subscription {
        return this.#floats.subscribe(address, procedure)
    }

    subscribeIntegers(address: Address, procedure: Procedure<Int32Array>): Subscription {
        return this.#integers.subscribe(address, procedure)
    }

    subscribeByteArray(address: Address, procedure: Procedure<Int8Array>): Subscription {
        return this.#bytes.subscribe(address, procedure)
    }

    terminate(): void {this.#disconnect()}

    #dispatch(): void {
        if (this.#optLock.isEmpty() || this.#memory.isEmpty()) {return}
        const lock = this.#optLock.unwrap()
        if (Atomics.load(lock, 0) === Lock.READ) {
            const byteArrayInput = this.#memory.unwrap()
            this.#dispatchData(byteArrayInput)
            byteArrayInput.position = 0 // Reset to start of data view (view is already offset past flags)
            this.#writeSubscriptionFlags()
            Atomics.store(lock, 0, Lock.WRITE)
        }
    }

    #writeSubscriptionFlags(): void {
        if (this.#subscriptionFlags.isEmpty()) {return}
        const flags = this.#subscriptionFlags.unwrap()
        for (let i = 0; i < this.#structure.length; i++) {
            const {address, package: pkg} = this.#structure[i]
            flags[i] = pkg.hasSubscribers(address) ? 1 : 0
        }
    }

    #updateStructure(input: ByteArrayInput): void {
        Arrays.clear(this.#procedures)
        Arrays.clear(this.#structure)
        this.#parseStructure(input)
    }

    #dispatchData(input: ByteArrayInput): boolean {
        let version = input.readInt()
        if (version !== this.#structureVersion) {
            // we simply skip and await the latest version soon enough
            return false
        }
        if (input.readInt() !== Flags.START) {throw new Error("stream is broken (no start flag)")}
        for (const procedure of this.#procedures) {procedure(input)}
        if (input.readInt() !== Flags.END) {throw new Error("stream is broken (no end flag)")}
        return true
    }

    #parseStructure(input: ByteArrayInput): void {
        if (input.readInt() !== Flags.ID) {throw new Error("no valid id")}
        const version = input.readInt()
        if (version <= this.#structureVersion) {
            return panic("Invalid version. new: " + version + `, was: ${this.#structureVersion}, id: ${this.#id}`)
        }
        this.#structureVersion = version
        this.#numPackages = input.readInt()
        for (let i = 0; i < this.#numPackages; i++) {
            const address = Address.read(input)
            const pkg = this.#packages[input.readByte() as PackageType]
            this.#structure.push({address, package: pkg})
            this.#procedures.push(input => pkg.dispatch(address, input))
        }
    }
}