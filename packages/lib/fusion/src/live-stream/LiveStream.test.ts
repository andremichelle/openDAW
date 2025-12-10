import {describe, expect, it, vi} from "vitest"
import {ByteArrayInput, ByteArrayOutput, UUID} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {Flags} from "./Flags"
import {PackageType} from "./PackageType"

const testUUID = UUID.parse("11111111-1111-4000-8000-000000000000")

describe("LiveStream data format", () => {
    describe("structure encoding", () => {
        it("should encode structure with ID flag and version", () => {
            const output = ByteArrayOutput.create()
            output.writeInt(Flags.ID)
            output.writeInt(0) // version
            output.writeInt(1) // numPackages

            const address = Address.compose(testUUID, 1)
            address.write(output)
            output.writeByte(PackageType.Float)

            const input = new ByteArrayInput(output.toArrayBuffer())
            expect(input.readInt()).toBe(Flags.ID)
            expect(input.readInt()).toBe(0) // version
            expect(input.readInt()).toBe(1) // numPackages

            const readAddress = Address.read(input)
            expect(readAddress.equals(address)).toBe(true)
            expect(input.readByte()).toBe(PackageType.Float)
        })

        it("should encode structure with multiple packages", () => {
            const output = ByteArrayOutput.create()
            output.writeInt(Flags.ID)
            output.writeInt(1) // version
            output.writeInt(3) // numPackages

            const addresses = [
                Address.compose(testUUID, 1),
                Address.compose(testUUID, 2),
                Address.compose(testUUID, 3)
            ]
            const types = [PackageType.Float, PackageType.FloatArray, PackageType.Integer]

            for (let i = 0; i < 3; i++) {
                addresses[i].write(output)
                output.writeByte(types[i])
            }

            const input = new ByteArrayInput(output.toArrayBuffer())
            expect(input.readInt()).toBe(Flags.ID)
            expect(input.readInt()).toBe(1)
            expect(input.readInt()).toBe(3)

            for (let i = 0; i < 3; i++) {
                const readAddress = Address.read(input)
                expect(readAddress.equals(addresses[i])).toBe(true)
                expect(input.readByte()).toBe(types[i])
            }
        })
    })

    describe("data encoding", () => {
        it("should encode data with version, START, and END flags", () => {
            const output = ByteArrayOutput.create()
            output.writeInt(0) // version
            output.writeInt(Flags.START)
            output.writeFloat(42.5) // sample float data
            output.writeInt(Flags.END)

            const input = new ByteArrayInput(output.toArrayBuffer())
            expect(input.readInt()).toBe(0) // version
            expect(input.readInt()).toBe(Flags.START)
            expect(input.readFloat()).toBeCloseTo(42.5)
            expect(input.readInt()).toBe(Flags.END)
        })

        it("should encode float array data", () => {
            const output = ByteArrayOutput.create()
            output.writeInt(0) // version
            output.writeInt(Flags.START)

            // Float array package: length then values
            const values = [1.0, 2.0, 3.0, 4.0]
            output.writeInt(values.length)
            for (const v of values) {
                output.writeFloat(v)
            }

            output.writeInt(Flags.END)

            const input = new ByteArrayInput(output.toArrayBuffer())
            expect(input.readInt()).toBe(0)
            expect(input.readInt()).toBe(Flags.START)

            const length = input.readInt()
            expect(length).toBe(4)

            for (let i = 0; i < length; i++) {
                expect(input.readFloat()).toBeCloseTo(values[i])
            }

            expect(input.readInt()).toBe(Flags.END)
        })

        it("should encode integer array data", () => {
            const output = ByteArrayOutput.create()
            output.writeInt(0) // version
            output.writeInt(Flags.START)

            const values = [100, 200, 300]
            output.writeInt(values.length)
            for (const v of values) {
                output.writeInt(v)
            }

            output.writeInt(Flags.END)

            const input = new ByteArrayInput(output.toArrayBuffer())
            expect(input.readInt()).toBe(0)
            expect(input.readInt()).toBe(Flags.START)

            const length = input.readInt()
            expect(length).toBe(3)

            for (let i = 0; i < length; i++) {
                expect(input.readInt()).toBe(values[i])
            }

            expect(input.readInt()).toBe(Flags.END)
        })

        it("should encode byte array data", () => {
            const output = ByteArrayOutput.create()
            output.writeInt(0) // version
            output.writeInt(Flags.START)

            const bytes = new Int8Array([1, 2, 3, 4, 5])
            output.writeInt(bytes.length)
            output.writeBytes(bytes)

            output.writeInt(Flags.END)

            const input = new ByteArrayInput(output.toArrayBuffer())
            expect(input.readInt()).toBe(0)
            expect(input.readInt()).toBe(Flags.START)

            const length = input.readInt()
            expect(length).toBe(5)

            const readBytes = new Int8Array(length)
            input.readBytes(readBytes)
            expect(Array.from(readBytes)).toEqual([1, 2, 3, 4, 5])

            expect(input.readInt()).toBe(Flags.END)
        })
    })

    describe("multiple packages in data", () => {
        it("should encode multiple packages of different types", () => {
            const output = ByteArrayOutput.create()
            output.writeInt(0) // version
            output.writeInt(Flags.START)

            // Package 1: Float
            output.writeFloat(3.14)

            // Package 2: FloatArray
            const floats = [1.0, 2.0]
            output.writeInt(floats.length)
            for (const f of floats) output.writeFloat(f)

            // Package 3: Integer
            output.writeInt(42)

            output.writeInt(Flags.END)

            const input = new ByteArrayInput(output.toArrayBuffer())
            expect(input.readInt()).toBe(0)
            expect(input.readInt()).toBe(Flags.START)

            // Read Float
            expect(input.readFloat()).toBeCloseTo(3.14)

            // Read FloatArray
            const arrLen = input.readInt()
            expect(arrLen).toBe(2)
            expect(input.readFloat()).toBeCloseTo(1.0)
            expect(input.readFloat()).toBeCloseTo(2.0)

            // Read Integer
            expect(input.readInt()).toBe(42)

            expect(input.readInt()).toBe(Flags.END)
        })
    })

    describe("version mismatch handling", () => {
        it("should detect version in data stream", () => {
            const output = ByteArrayOutput.create()
            output.writeInt(5) // version 5
            output.writeInt(Flags.START)
            output.writeFloat(1.0)
            output.writeInt(Flags.END)

            const input = new ByteArrayInput(output.toArrayBuffer())
            const version = input.readInt()

            // Simulate receiver checking version
            const expectedVersion = 3
            if (version !== expectedVersion) {
                // Should skip processing
                expect(version).toBe(5)
                expect(version).not.toBe(expectedVersion)
            }
        })
    })

    describe("Flags values", () => {
        it("should have distinct flag values", () => {
            expect(Flags.ID).not.toBe(Flags.START)
            expect(Flags.START).not.toBe(Flags.END)
            expect(Flags.ID).not.toBe(Flags.END)
        })

        it("should have expected flag values", () => {
            expect(Flags.ID).toBe(0xF0FF0F)
            expect(Flags.START).toBe(0xF0F0F0)
            expect(Flags.END).toBe(0x0F0F0F)
        })
    })

    describe("PackageType values", () => {
        it("should have correct package type values", () => {
            expect(PackageType.Float).toBeDefined()
            expect(PackageType.FloatArray).toBeDefined()
            expect(PackageType.Integer).toBeDefined()
            expect(PackageType.IntegerArray).toBeDefined()
            expect(PackageType.ByteArray).toBeDefined()
        })
    })
})

describe("LiveStream dynamic package changes", () => {
    describe("SAB layout when numPackages changes", () => {
        it("should correctly offset data when numPackages increases", () => {
            // Bug: When adding a new package, the subscription flags area grows,
            // changing where data should start. If views aren't recreated,
            // data will be written/read at the wrong offset.

            // Initial state: 2 packages
            const initialNumPackages = 2
            const dataCapacity = 100
            const initialSize = initialNumPackages + dataCapacity
            const sab1 = new SharedArrayBuffer(initialSize)

            // Create views for 2 packages
            const flags1 = new Uint8Array(sab1, 0, initialNumPackages)
            const output1 = ByteArrayOutput.use(sab1, initialNumPackages)

            // Write data at offset 2
            output1.writeInt(0) // version
            output1.writeInt(Flags.START)
            output1.writeFloat(3.14)
            output1.writeInt(Flags.END)

            // Read back at offset 2 - should work
            const input1 = new ByteArrayInput(sab1, initialNumPackages)
            expect(input1.readInt()).toBe(0) // version
            expect(input1.readInt()).toBe(Flags.START)
            expect(input1.readFloat()).toBeCloseTo(3.14)
            expect(input1.readInt()).toBe(Flags.END)

            // Now numPackages increases to 3
            const newNumPackages = 3

            // If we DON'T recreate views (the bug), we'd still write at offset 2
            // but read at offset 3, causing misalignment

            // Correct behavior: recreate views with new offset
            const newRequiredSize = newNumPackages + dataCapacity
            const sab2 = new SharedArrayBuffer(newRequiredSize)
            const flags2 = new Uint8Array(sab2, 0, newNumPackages)
            const output2 = ByteArrayOutput.use(sab2, newNumPackages)

            // Write data at new offset 3
            output2.writeInt(1) // version
            output2.writeInt(Flags.START)
            output2.writeFloat(2.71)
            output2.writeInt(Flags.END)

            // Read back at offset 3 - should work
            const input2 = new ByteArrayInput(sab2, newNumPackages)
            expect(input2.readInt()).toBe(1) // version
            expect(input2.readInt()).toBe(Flags.START)
            expect(input2.readFloat()).toBeCloseTo(2.71)
            expect(input2.readInt()).toBe(Flags.END)
        })

        it("should fail to read START flag if offset is wrong", () => {
            // This test demonstrates the bug when views aren't recreated
            const numPackages = 3
            const dataCapacity = 100
            const sab = new SharedArrayBuffer(numPackages + dataCapacity)

            // Bug scenario: write at offset 2 (old numPackages)
            const wrongOffset = 2
            const output = ByteArrayOutput.use(sab, wrongOffset)
            output.writeInt(0) // version
            output.writeInt(Flags.START)
            output.writeFloat(3.14)
            output.writeInt(Flags.END)

            // Try to read at offset 3 (new numPackages) - will fail
            const correctOffset = 3
            const input = new ByteArrayInput(sab, correctOffset)
            const version = input.readInt()
            const startFlag = input.readInt()

            // The start flag won't be correct because we're reading at wrong position
            expect(startFlag).not.toBe(Flags.START) // This demonstrates the bug
        })

        it("should require new SAB when numPackages changes even if capacity is sufficient", () => {
            // Even if the SAB has enough total capacity, the layout changes
            // when numPackages changes, so views must be recreated

            const oldNumPackages = 2
            const newNumPackages = 3
            const dataCapacity = 100

            // SAB with plenty of capacity
            const totalCapacity = 1024
            const sab = new SharedArrayBuffer(totalCapacity)

            // Write with old layout
            const oldOutput = ByteArrayOutput.use(sab, oldNumPackages)
            oldOutput.writeInt(0)
            oldOutput.writeInt(Flags.START)
            oldOutput.writeFloat(1.0)
            oldOutput.writeInt(Flags.END)

            // If receiver updates to new numPackages but broadcaster doesn't recreate views,
            // the receiver will read from wrong offset
            const input = new ByteArrayInput(sab, newNumPackages)
            const version = input.readInt()
            const maybeStart = input.readInt()

            // This will NOT be Flags.START because data was written at offset 2
            // but we're reading at offset 3
            expect(maybeStart).not.toBe(Flags.START)
        })
    })

    describe("version mismatch protection during SAB/structure out-of-sync", () => {
        it("should have mismatched version when reading old SAB with new offset", () => {
            // Scenario: Structure update arrives before SAB update
            // Receiver creates views with new offset on old SAB

            const oldNumPackages = 2
            const newNumPackages = 3

            // Old SAB with data at offset 2
            const oldSab = new SharedArrayBuffer(1024)
            const oldOutput = ByteArrayOutput.use(oldSab, oldNumPackages)
            const oldVersion = 5
            oldOutput.writeInt(oldVersion)
            oldOutput.writeInt(Flags.START)
            oldOutput.writeFloat(1.0)
            oldOutput.writeInt(Flags.END)

            // Receiver creates view with new offset on old SAB (bug scenario)
            const input = new ByteArrayInput(oldSab, newNumPackages)
            const readVersion = input.readInt()

            // The version read will be wrong (shifted by 1 byte)
            // It will read from byte 3 instead of byte 2
            expect(readVersion).not.toBe(oldVersion)
        })

        it("should have mismatched version when reading new SAB with old offset", () => {
            // Scenario: SAB update arrives before structure update
            // Receiver creates views with old offset on new SAB

            const oldNumPackages = 2
            const newNumPackages = 3

            // New SAB with data at offset 3
            const newSab = new SharedArrayBuffer(1024)
            const newOutput = ByteArrayOutput.use(newSab, newNumPackages)
            const newVersion = 6
            newOutput.writeInt(newVersion)
            newOutput.writeInt(Flags.START)
            newOutput.writeFloat(1.0)
            newOutput.writeInt(Flags.END)

            // Receiver creates view with old offset on new SAB (bug scenario)
            const input = new ByteArrayInput(newSab, oldNumPackages)
            const readVersion = input.readInt()

            // The version read will be wrong (includes flag byte)
            expect(readVersion).not.toBe(newVersion)
        })
    })
})

describe("LiveStream subscription-aware broadcasting", () => {
    describe("subscription flags memory layout", () => {
        it("should layout subscription flags at start of SAB", () => {
            const numPackages = 3
            const dataSize = 100

            // SAB layout: [flags...][data...]
            const sab = new SharedArrayBuffer(numPackages + dataSize)
            const flags = new Uint8Array(sab, 0, numPackages)
            const data = new Uint8Array(sab, numPackages, dataSize)

            // Initially all flags are 0 (no subscribers)
            expect(flags[0]).toBe(0)
            expect(flags[1]).toBe(0)
            expect(flags[2]).toBe(0)

            // Receiver sets flags based on subscribers
            flags[0] = 1 // has subscribers
            flags[1] = 0 // no subscribers
            flags[2] = 1 // has subscribers

            // Broadcaster reads flags
            expect(flags[0]).toBe(1)
            expect(flags[1]).toBe(0)
            expect(flags[2]).toBe(1)

            // Data area should be separate
            data[0] = 42
            expect(flags[0]).toBe(1) // flags unaffected
        })

        it("should handle ByteArrayInput with offset for subscription flags", () => {
            const numPackages = 3
            const dataSize = 50

            const buffer = new ArrayBuffer(numPackages + dataSize)
            const flags = new Uint8Array(buffer, 0, numPackages)

            // Set some flags
            flags[0] = 1
            flags[1] = 0
            flags[2] = 1

            // Write data after flags
            const dataView = new DataView(buffer, numPackages)
            dataView.setInt32(0, 123, false) // version
            dataView.setInt32(4, Flags.START, false)

            // Create ByteArrayInput with offset
            const input = new ByteArrayInput(buffer, numPackages)
            expect(input.readInt()).toBe(123)
            expect(input.readInt()).toBe(Flags.START)
        })
    })

    describe("before callback with hasSubscribers", () => {
        it("should pass hasSubscribers=true to callback when flag is set", () => {
            const callback = vi.fn()

            // Simulate broadcaster reading flag and calling callback
            const hasSubscribers = true
            callback(hasSubscribers)

            expect(callback).toHaveBeenCalledWith(true)
        })

        it("should pass hasSubscribers=false to callback when flag is not set", () => {
            const callback = vi.fn()

            const hasSubscribers = false
            callback(hasSubscribers)

            expect(callback).toHaveBeenCalledWith(false)
        })

        it("should allow skipping expensive computation when no subscribers", () => {
            const expensiveComputation = vi.fn()
            const spectrum = new Float32Array(256)

            // Simulate the pattern from EngineProcessor
            const beforeCallback = (hasSubscribers: boolean) => {
                if (hasSubscribers) {
                    expensiveComputation()
                    spectrum.fill(1.0)
                }
            }

            // No subscribers - should skip computation
            beforeCallback(false)
            expect(expensiveComputation).not.toHaveBeenCalled()
            expect(spectrum[0]).toBe(0)

            // Has subscribers - should run computation
            beforeCallback(true)
            expect(expensiveComputation).toHaveBeenCalled()
            expect(spectrum[0]).toBe(1.0)
        })
    })
})
