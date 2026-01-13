import {
    Arrays,
    assert,
    ByteArrayOutput,
    float,
    int,
    nextPowOf2,
    Option,
    Procedure,
    Provider,
    Terminable
} from "@moises-ai/lib-std"
import {Address} from "@moises-ai/lib-box"
import {Communicator, Messenger} from "@moises-ai/lib-runtime"
import {Lock} from "./Lock"
import {PackageType} from "./PackageType"
import {Protocol} from "./Protocol"
import {Flags} from "./Flags"

interface Package {
    readonly address: Address
    readonly type: PackageType
    readonly capacity: int
    put(output: ByteArrayOutput, hasSubscribers: boolean): void
}

export class LiveStreamBroadcaster {
    static create(messenger: Messenger, name: string): LiveStreamBroadcaster {
        return new LiveStreamBroadcaster(messenger.channel(name))
    }

    readonly #packages: Array<Package> = []
    readonly #lock = new SharedArrayBuffer(1)
    readonly #lockArray = new Int8Array(this.#lock)
    readonly #sender: Protocol

    #output: ByteArrayOutput = ByteArrayOutput.create(0)
    #sabOption: Option<SharedArrayBuffer> = Option.None
    #subscriptionFlags: Option<Uint8Array> = Option.None
    #availableUpdate: Option<ArrayBufferLike> = Option.None

    #version: int = -1
    #capacity: int = -1
    #invalid: boolean = false
    #lockShared = false
    #lastNumPackages: int = 0

    private constructor(messenger: Messenger) {
        this.#sender = Communicator.sender<Protocol>(messenger, ({dispatchAndForget}) =>
            new class implements Protocol {
                sendShareLock(lock: SharedArrayBuffer): void {dispatchAndForget(this.sendShareLock, lock)}
                sendUpdateData(buffer: ArrayBufferLike): void {dispatchAndForget(this.sendUpdateData, buffer)}
                sendUpdateStructure(buffer: ArrayBufferLike): void {dispatchAndForget(this.sendUpdateStructure, buffer)}
            })
    }

    flush(): void {
        const update = this.#updateAvailable()
        if (update.nonEmpty()) {
            if (!this.#lockShared) {
                this.#sender.sendShareLock(this.#lock)
                this.#lockShared = true
            }
            this.#sender.sendUpdateStructure(update.unwrap())
            const numPackages = this.#packages.length
            const capacity = this.#computeCapacity()
            // SAB layout: [subscription flags (numPackages bytes)][data]
            // Must create new SAB if:
            // 1. No SAB exists yet
            // 2. SAB too small
            // 3. numPackages changed (offset changes even if capacity is sufficient)
            const requiredSize = numPackages + capacity
            const needsNewSab = this.#sabOption.isEmpty()
                || this.#sabOption.unwrap().byteLength < requiredSize
                || numPackages !== this.#lastNumPackages
            if (needsNewSab) {
                const size = nextPowOf2(requiredSize)
                const sab = new SharedArrayBuffer(size)
                this.#subscriptionFlags = Option.wrap(new Uint8Array(sab, 0, numPackages))
                this.#output = ByteArrayOutput.use(sab, numPackages)
                this.#sabOption = Option.wrap(sab)
                this.#lastNumPackages = numPackages
                this.#sender.sendUpdateData(sab)
            }
        }
        if (this.#sabOption.isEmpty()) {return}
        // If main-thread is not interested, no data will ever be sent again, since it will not set the lock to CAN_WRITE.
        // No lock is necessary since the other side skips reading until we set the lock to CAN_READ.
        if (Atomics.load(this.#lockArray, 0) === Lock.WRITE) {
            this.#flushData(this.#output)
            this.#output.position = 0 // Reset to start of data view (view is already offset past flags)
            Atomics.store(this.#lockArray, 0, Lock.READ)
        }
    }

    broadcastFloat(address: Address, provider: Provider<float>): Terminable {
        return this.#storeChunk(new class implements Package {
            readonly type: PackageType = PackageType.Float
            readonly address: Address = address
            readonly capacity: number = 8
            put(output: ByteArrayOutput, _hasSubscribers: boolean): void {output.writeFloat(provider())}
        })
    }

    broadcastInteger(address: Address, provider: Provider<int>): Terminable {
        return this.#storeChunk(new class implements Package {
            readonly type: PackageType = PackageType.Integer
            readonly address: Address = address
            readonly capacity: number = 8
            put(output: ByteArrayOutput, _hasSubscribers: boolean): void {output.writeInt(provider())}
        })
    }

    broadcastFloats(address: Address, values: Float32Array, before?: Procedure<boolean>): Terminable {
        return this.#storeChunk(new class implements Package {
            readonly type: PackageType = PackageType.FloatArray
            readonly address: Address = address
            readonly capacity: number = 4 + (values.byteLength << 2)
            put(output: ByteArrayOutput, hasSubscribers: boolean): void {
                before?.(hasSubscribers)
                output.writeInt(values.length)
                for (const value of values) {output.writeFloat(value)}
            }
        })
    }

    broadcastIntegers(address: Address, values: Int32Array, update: Procedure<boolean>): Terminable {
        return this.#storeChunk(new class implements Package {
            readonly type: PackageType = PackageType.IntegerArray
            readonly address: Address = address
            readonly capacity: number = 4 + (values.byteLength << 2)
            put(output: ByteArrayOutput, hasSubscribers: boolean): void {
                update(hasSubscribers)
                output.writeInt(values.length)
                values.forEach(value => output.writeInt(value))
            }
        })
    }

    broadcastByteArray(address: Address, values: Int8Array, update: Procedure<boolean>): Terminable {
        return this.#storeChunk(new class implements Package {
            readonly type: PackageType = PackageType.ByteArray
            readonly address: Address = address
            readonly capacity: number = 4 + values.byteLength
            put(output: ByteArrayOutput, hasSubscribers: boolean): void {
                update(hasSubscribers)
                output.writeInt(values.byteLength)
                output.writeBytes(values)
            }
        })
    }

    #updateAvailable(): Option<ArrayBufferLike> {
        if (this.#invalid) {
            try {
                this.#availableUpdate = Option.wrap(this.#compileStructure())
            } catch (reason: unknown) {throw reason}
            this.#invalid = false
        }
        if (this.#availableUpdate.nonEmpty()) {
            const option = this.#availableUpdate
            this.#availableUpdate = Option.None
            return option
        }
        return Option.None
    }

    #computeCapacity(): int {
        if (-1 === this.#capacity) {
            this.#capacity = this.#sumRequiredCapacity() + 12
        }
        return this.#capacity
    }

    terminate(): void {
        Arrays.clear(this.#packages)
        this.#availableUpdate = Option.None
        this.#invalid = false
        this.#capacity = 0
    }

    #flushData(output: ByteArrayOutput): void {
        assert(!this.#invalid && this.#availableUpdate.isEmpty(), "Cannot flush while update is available")
        const requiredCapacity = this.#computeCapacity()
        assert(output.remaining >= requiredCapacity, "Insufficient data")
        output.writeInt(this.#version)
        output.writeInt(Flags.START)
        const flags = this.#subscriptionFlags
        for (let i = 0; i < this.#packages.length; i++) {
            const hasSubscribers = flags.nonEmpty() && flags.unwrap()[i] !== 0
            this.#packages[i].put(output, hasSubscribers)
        }
        output.writeInt(Flags.END)
    }

    #sumRequiredCapacity(): int {
        return this.#packages.reduce((sum, pack) => sum + pack.capacity, 0)
    }

    #storeChunk(pack: Package): Terminable {
        this.#packages.push(pack)
        this.#invalidate()
        return {
            terminate: () => {
                Arrays.removeOpt(this.#packages, pack)
                this.#invalidate()
            }
        }
    }

    #invalidate(): void {
        this.#capacity = -1
        this.#invalid = true
    }

    #compileStructure(): ArrayBufferLike {
        const output = ByteArrayOutput.create()
        output.writeInt(Flags.ID)
        output.writeInt(++this.#version)
        output.writeInt(this.#packages.length)
        for (const {address, type} of this.#packages) {
            address.write(output)
            output.writeByte(type)
        }
        return output.toArrayBuffer()
    }
}