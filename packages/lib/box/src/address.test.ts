import {describe, expect, it} from "vitest"
import {ByteArrayInput, ByteArrayOutput, UUID} from "@moises-ai/lib-std"
import {Address, Addressable} from "./address"

describe("Address", () => {
    // Test data setup with diverse UUIDs
    const uuidA = UUID.parse("11111111-1111-4000-8000-000000000000")
    const uuidB = UUID.parse("22222222-2222-4000-8000-000000000000")
    const uuidC = UUID.parse("33333333-3333-4000-8000-000000000000")
    const uuidD = UUID.parse("44444444-4444-4000-8000-000000000000")
    const uuidE = UUID.parse("55555555-5555-4000-8000-000000000000")

    describe("Static Methods", () => {
        it("should create a new set with key extractor", () => {
            const set = Address.newSet<{ addr: Address }>(item => item.addr)
            expect(set).toBeDefined()
            const addr1 = Address.compose(uuidA)
            const addr2 = Address.compose(uuidB)
            set.add({addr: addr1})
            set.add({addr: addr2})
            expect(set.size()).toBe(2)
        })

        it("should compose address with UUID only", () => {
            const addr = Address.compose(uuidA)
            expect(addr.uuid).toEqual(uuidA)
            expect(addr.fieldKeys.length).toBe(0)
        })

        it("should compose address with UUID and fields", () => {
            const addr = Address.compose(uuidB, 1, 2)
            expect(addr.uuid).toEqual(uuidB)
            expect(Array.from(addr.fieldKeys)).toEqual([1, 2])
        })

        it("should decode address from string", () => {
            const str = "33333333-3333-4000-8000-000000000000/1/2/3"
            const addr = Address.decode(str)
            expect(addr.toString()).toBe(str)
        })

        it("should throw on invalid decode input", () => {
            expect(() => Address.decode("")).toThrow()
        })

        it("should reconstruct address from layout", () => {
            const layout: [UUID.Bytes, Int16Array] = [uuidC, new Int16Array([1, 2])]
            const addr = Address.reconstruct(layout)
            expect(addr.uuid).toEqual(uuidC)
            expect(Array.from(addr.fieldKeys)).toEqual([1, 2])
        })

        it("should handle box range with different UUIDs", () => {
            const items = [
                {addr: Address.compose(uuidA, 1)},
                {addr: Address.compose(uuidB, 1)},
                {addr: Address.compose(uuidB, 2)},
                {addr: Address.compose(uuidC, 1)}
            ]
            const set = Address.newSet<{ addr: Address }>(item => item.addr)
            items.forEach(item => set.add(item))

            const range = Address.boxRange(set, uuidB, item => item.addr.uuid)
            expect(range).not.toBeNull()
            expect(range![1] - range![0]).toBe(2) // Should find two items with uuidB
        })
    })

    describe("Instance Methods", () => {
        const emptyAddress = Address.compose(uuidA)
        const singleFieldAddress = Address.compose(uuidB, 1)

        it("should check if address is box", () => {
            expect(emptyAddress.isBox()).toBe(true)
            expect(singleFieldAddress.isBox()).toBe(false)
        })

        it("should check if address is content", () => {
            expect(emptyAddress.isContent()).toBe(false)
            expect(singleFieldAddress.isContent()).toBe(true)
        })

        it("should compare addresses with different UUIDs correctly", () => {
            const addr1 = Address.compose(uuidA, 1, 2)
            const addr2 = Address.compose(uuidB, 1, 2)
            const addr3 = Address.compose(uuidC, 1, 2)

            expect(addr1.equals(addr2)).toBe(false)
            expect(addr1.compareTo(addr2)).toBeLessThan(0)
            expect(addr2.compareTo(addr3)).toBeLessThan(0)
            expect(addr3.compareTo(addr1)).toBeGreaterThan(0)
        })

        it("should compare addresses with same UUID but different fields", () => {
            const addr1 = Address.compose(uuidA, 1, 2)
            const addr2 = Address.compose(uuidA, 1, 3)
            const addr3 = Address.compose(uuidA, 1, 2, 4)

            expect(addr1.equals(addr2)).toBe(false)
            expect(addr1.compareTo(addr2)).toBeLessThan(0)
            expect(addr1.compareTo(addr3)).toBeLessThan(0)
        })

        it("should append field key correctly", () => {
            const addr = emptyAddress.append(1)
            expect(Array.from(addr.fieldKeys)).toEqual([1])
        })

        it("should check startsWith correctly with different UUIDs", () => {
            const baseA = Address.compose(uuidA, 1)
            const extendedA = Address.compose(uuidA, 1, 2)
            const baseB = Address.compose(uuidB, 1)

            expect(extendedA.startsWith(baseA)).toBe(true)
            expect(extendedA.startsWith(baseB)).toBe(false)
        })

        it("should serialize and deserialize with different UUIDs", () => {
            const addresses = [
                Address.compose(uuidA, 1),
                Address.compose(uuidB, 1, 2),
                Address.compose(uuidC, 1, 2, 3)
            ]

            addresses.forEach(addr => {
                const output = ByteArrayOutput.create()
                addr.write(output)
                const input = new ByteArrayInput(output.toArrayBuffer())
                const deserialized = Address.read(input)
                expect(deserialized.equals(addr)).toBe(true)
            })
        })
    })

    describe("Addressable namespace", () => {
        const addresses = [
            Address.compose(uuidA, 1),
            Address.compose(uuidB, 1),
            Address.compose(uuidB, 1, 2),
            Address.compose(uuidC, 1),
            Address.compose(uuidD, 1, 2),
            Address.compose(uuidE, 1, 2, 3)
        ]
        const addressables = addresses.map(address => ({address}))

        it("should compare addressables with different UUIDs", () => {
            const sorted = [...addressables].sort(Addressable.Comparator)
            expect(sorted[0].address.uuid).toEqual(uuidA)
            expect(sorted[sorted.length - 1].address.uuid).toEqual(uuidE)
        })

        it("should find exact matches with equals across different UUIDs", () => {
            const results = Addressable.equals(addresses[1], addressables)
            expect(results.length).toBe(1)
            expect(results[0].address.equals(addresses[1])).toBe(true)
        })

        it("should find items starting with prefix for specific UUID", () => {
            const results = Addressable.startsWith(Address.compose(uuidB, 1), addressables)
            expect(results.length).toBe(2)
            results.forEach(result => {
                expect(result.address.uuid).toEqual(uuidB)
            })
        })

        it("should find items that are parents across different UUIDs", () => {
            const target = Address.compose(uuidE, 1, 2, 3)
            const results = Addressable.endsWith(target, addressables)
            expect(results.length).toBe(1)
            expect(results[0].address.uuid).toEqual(uuidE)
        })
    })
})