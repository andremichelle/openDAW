import {describe, expect, it} from "vitest"
import {Comparator, int} from "@moises-ai/lib-std"
import {Event, EventCollection} from "./events"

class ScheduleEvent implements Event {
    readonly type = "schedule-event"
    constructor(readonly position: int) {}
}

class IndexedScheduleEvent implements Event {
    readonly type = "priority-event"
    constructor(readonly position: int, readonly priority: int) {}
}

describe("event schedule", () => {
    it("basic operations", () => {
        const createEvent = (time: int): Event => new ScheduleEvent(time)
        const events = EventCollection.create(EventCollection.DefaultComparator)
        const x = createEvent(12)
        const y = createEvent(28)
        const z = createEvent(36)
        const w = createEvent(50)

        expect(events.length(), "initial count").toBe(0)
        expect(events.isEmpty(), "empty at start").true
        expect(events.greaterEqual(5), "greaterEqual").toStrictEqual(null)

        events.add(y)
        expect(events.contains(x), "contains missing event").false
        expect(events.contains(y), "contains added event").true

        events.add(z)
        events.add(x)
        expect(events.contains(x), "contains all added").true
        expect(events.contains(y), "contains original").true

        events.add(w)
        expect(events.isEmpty(), "not empty after adds").false
        expect(events.length(), "total count").toStrictEqual(4)
        expect(events.asArray(), "events ordered").toStrictEqual([x, y, z, w])
        expect(events.greaterEqual(0), "greaterEqual").toStrictEqual(x)
        expect(events.greaterEqual(8), "greaterEqual").toStrictEqual(x)
        expect(events.greaterEqual(13), "greaterEqual").toStrictEqual(y)
        expect(events.greaterEqual(29), "greaterEqual").toStrictEqual(z)
        expect(events.greaterEqual(50), "greaterEqual").toStrictEqual(w)
        expect(events.lowerEqual(10), "lowerEqual").toStrictEqual(null)
        expect(events.lowerEqual(12), "lowerEqual").toStrictEqual(x)
        expect(events.lowerEqual(35), "lowerEqual").toStrictEqual(y)
        expect(events.lowerEqual(70), "lowerEqual").toStrictEqual(w)

        expect(Array.from(events.iterateRange(12, 51))).toStrictEqual([x, y, z, w])
        expect(Array.from(events.iterateRange(15, 35))).toStrictEqual([y])
        expect(Array.from(events.iterateRange(30, 37))).toStrictEqual([z])
        expect(Array.from(events.iterateRange(31, 32))).toStrictEqual([])
        expect(Array.from(events.iterateFrom(5))).toStrictEqual([x, y, z, w])
        expect(Array.from(events.iterateFrom(28))).toStrictEqual([y, z, w])
        expect(Array.from(events.iterateFrom(38))).toStrictEqual([z, w])
    })

    it("indexed events (priority keys)", () => {
        const Comparator: Comparator<IndexedScheduleEvent> = (eventA, eventB) => {
            const timeDiff = eventA.position - eventB.position
            if (timeDiff !== 0) {
                return timeDiff
            }
            const priorityDiff = eventA.priority - eventB.priority
            if (priorityDiff !== 0) {
                return priorityDiff
            }
            throw new Error(`${eventA} and ${eventB} have identical keys`)
        }

        const createEvent = (time: int, priority: int): IndexedScheduleEvent =>
            new IndexedScheduleEvent(time, priority)

        const events = EventCollection.create(Comparator)
        const ev1 = createEvent(15, 0)
        const ev2 = createEvent(25, 1)
        const ev3 = createEvent(29, 0)
        const ev4 = createEvent(40, 2)

        expect(events.length(), "initial count").toBe(0)
        expect(events.isEmpty(), "empty schedule").true
        expect(events.greaterEqual(0), "greaterEqual").toStrictEqual(null)

        events.add(ev2)
        expect(events.contains(ev1), "contains missing").false
        expect(events.contains(ev2), "contains added event").true

        events.add(ev3)
        events.add(ev1)
        expect(events.contains(ev1), "added contains").true
        expect(events.contains(ev2), "original contains").true

        events.add(ev4)
        expect(events.isEmpty(), "schedule is populated").false
        expect(events.length(), "total count").toStrictEqual(4)
        expect(events.asArray(), "events remain sorted").toStrictEqual([ev1, ev2, ev3, ev4])

        expect(Array.from(events.iterateFrom(30))).toStrictEqual([ev3, ev4])
        expect(Array.from(events.iterateFrom(25))).toStrictEqual([ev2, ev3, ev4])
        expect(Array.from(events.iterateFrom(20))).toStrictEqual([ev1, ev2, ev3, ev4])
    })
})