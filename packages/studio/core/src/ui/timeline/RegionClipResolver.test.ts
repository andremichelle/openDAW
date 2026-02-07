import {describe, expect, it} from "vitest"
import {ClipTask, RegionClipResolver} from "./RegionClipResolver"
import {AnyRegionBoxAdapter} from "@opendaw/studio-adapters"

interface Mask {
    type: string
    position: number
    complete: number
}

const createMask = (position: number, complete: number): Mask => ({type: "range", position, complete})

const createRegion = (position: number, duration: number, isSelected = false) => ({
    position,
    duration,
    complete: position + duration,
    isSelected
}) as unknown as AnyRegionBoxAdapter

const runCreateTasks = (
    regions: AnyRegionBoxAdapter[],
    masks: Mask[],
    showOrigin = false
): ReadonlyArray<ClipTask> => {
    const maxComplete = masks.reduce((max, mask) => Math.max(max, mask.complete), 0)
    return RegionClipResolver.createTasksFromMasks(regions, maxComplete, masks, showOrigin)
}

describe("RegionClipResolver.sortAndJoinMasks", () => {
    it("should handle single mask", () => {
        const masks = [createMask(0, 10)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 10))
    })

    it("should merge two adjacent masks", () => {
        const masks = [createMask(0, 10), createMask(10, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 20))
    })

    it("should keep two non-adjacent masks separate", () => {
        const masks = [createMask(0, 10), createMask(15, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(2)
        expect(result[0]).toEqual(createMask(0, 10))
        expect(result[1]).toEqual(createMask(15, 20))
    })

    it("should merge two overlapping masks", () => {
        const masks = [createMask(0, 15), createMask(10, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 20))
    })

    it("should handle mask completely contained in another", () => {
        const masks = [createMask(0, 100), createMask(10, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 100))
    })

    it("should handle multiple masks completely contained in one", () => {
        const masks = [
            createMask(0, 100),
            createMask(10, 20),
            createMask(30, 40),
            createMask(50, 60)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 100))
    })

    it("should sort unsorted masks before merging", () => {
        const masks = [createMask(20, 30), createMask(0, 10), createMask(10, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 30))
    })

    it("should merge multiple overlapping masks into one", () => {
        const masks = [
            createMask(0, 15),
            createMask(10, 25),
            createMask(20, 35),
            createMask(30, 40)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 40))
    })

    it("should create multiple ranges for separated groups", () => {
        const masks = [
            createMask(0, 10),
            createMask(10, 20),
            createMask(30, 40),
            createMask(40, 50),
            createMask(60, 70)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(3)
        expect(result[0]).toEqual(createMask(0, 20))
        expect(result[1]).toEqual(createMask(30, 50))
        expect(result[2]).toEqual(createMask(60, 70))
    })

    it("should handle complex mix of overlapping and separated masks", () => {
        const masks = [
            createMask(0, 15),
            createMask(10, 25),
            createMask(50, 60),
            createMask(55, 70),
            createMask(100, 110)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(3)
        expect(result[0]).toEqual(createMask(0, 25))
        expect(result[1]).toEqual(createMask(50, 70))
        expect(result[2]).toEqual(createMask(100, 110))
    })

    it("should handle masks with same start position", () => {
        const masks = [
            createMask(0, 10),
            createMask(0, 20),
            createMask(0, 15)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 20))
    })

    it("should handle masks with same end position", () => {
        const masks = [
            createMask(0, 20),
            createMask(10, 20),
            createMask(5, 20)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 20))
    })

    it("should handle identical masks", () => {
        const masks = [
            createMask(0, 10),
            createMask(0, 10),
            createMask(0, 10)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 10))
    })

    it("should handle zero-length masks (position equals complete)", () => {
        const masks = [createMask(10, 10), createMask(20, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(2)
        expect(result[0]).toEqual(createMask(10, 10))
        expect(result[1]).toEqual(createMask(20, 20))
    })

    it("should merge adjacent zero-length and non-zero-length masks", () => {
        const masks = [createMask(10, 10), createMask(10, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(10, 20))
    })

    it("should not mutate input array", () => {
        const masks = [createMask(20, 30), createMask(0, 10), createMask(10, 20)]
        const original = [...masks]

        RegionClipResolver.sortAndJoinMasks(masks)

        expect(masks).toEqual(original)
    })

    it("should handle large number of masks", () => {
        const masks: Mask[] = []
        for (let i = 0; i < 100; i++) {
            masks.push(createMask(i * 5, i * 5 + 10))
        }

        const result = RegionClipResolver.sortAndJoinMasks(masks)

        // All masks overlap, should merge into one
        expect(result).toHaveLength(1)
        expect(result[0].position).toBe(0)
        expect(result[0].complete).toBe(505) // 99 * 5 + 10
    })

    it("should handle masks in reverse order", () => {
        const masks = [
            createMask(60, 70),
            createMask(40, 50),
            createMask(20, 30),
            createMask(0, 10)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(4)
        expect(result[0]).toEqual(createMask(0, 10))
        expect(result[1]).toEqual(createMask(20, 30))
        expect(result[2]).toEqual(createMask(40, 50))
        expect(result[3]).toEqual(createMask(60, 70))
    })
})

describe("RegionClipResolver.createTasksFromMasks", () => {
    describe("single mask", () => {
        it("should delete region fully contained in mask", () => {
            const region = createRegion(5, 5)
            const tasks = runCreateTasks([region], [createMask(0, 20)])

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("delete")
            expect(tasks[0].region).toBe(region)
        })

        it("should delete region exactly matching mask", () => {
            const region = createRegion(5, 10)
            const tasks = runCreateTasks([region], [createMask(5, 15)])

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("delete")
        })

        it("should separate region spanning entire mask", () => {
            const region = createRegion(0, 30)
            const tasks = runCreateTasks([region], [createMask(10, 20)])

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("separate")
            if (tasks[0].type === "separate") {
                expect(tasks[0].begin).toBe(10)
                expect(tasks[0].end).toBe(20)
            }
        })

        it("should trim start when region begins within mask", () => {
            const region = createRegion(5, 20)
            const tasks = runCreateTasks([region], [createMask(0, 10)])

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("start")
            if (tasks[0].type === "start") {
                expect(tasks[0].position).toBe(10)
            }
        })

        it("should trim end when region ends within mask", () => {
            const region = createRegion(0, 15)
            const tasks = runCreateTasks([region], [createMask(10, 20)])

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("complete")
            if (tasks[0].type === "complete") {
                expect(tasks[0].position).toBe(10)
            }
        })

        it("should skip region entirely before mask", () => {
            const region = createRegion(0, 5)
            const tasks = runCreateTasks([region], [createMask(10, 20)])

            expect(tasks).toHaveLength(0)
        })

        it("should skip region entirely after mask (within maxComplete)", () => {
            const region = createRegion(25, 5)
            const tasks = runCreateTasks([region], [createMask(10, 20)], false)

            expect(tasks).toHaveLength(0)
        })
    })

    describe("selected region filtering", () => {
        it("should skip selected regions when showOrigin is false", () => {
            const region = createRegion(5, 5, true)
            const tasks = runCreateTasks([region], [createMask(0, 20)], false)

            expect(tasks).toHaveLength(0)
        })

        it("should include selected regions when showOrigin is true", () => {
            const region = createRegion(5, 5, true)
            const tasks = runCreateTasks([region], [createMask(0, 20)], true)

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("delete")
        })

        it("should always include unselected regions regardless of showOrigin", () => {
            const region = createRegion(5, 5, false)
            const tasksFalse = runCreateTasks([region], [createMask(0, 20)], false)
            const tasksTrue = runCreateTasks([region], [createMask(0, 20)], true)

            expect(tasksFalse).toHaveLength(1)
            expect(tasksTrue).toHaveLength(1)
        })
    })

    describe("multiple regions with single mask", () => {
        it("should create tasks for each overlapping region", () => {
            const region1 = createRegion(0, 5)
            const region2 = createRegion(5, 10)
            const region3 = createRegion(20, 5)
            const tasks = runCreateTasks(
                [region1, region2, region3],
                [createMask(3, 12)]
            )

            expect(tasks).toHaveLength(2)
            expect(tasks[0].region).toBe(region1)
            expect(tasks[0].type).toBe("complete")
            expect(tasks[1].region).toBe(region2)
            expect(tasks[1].type).toBe("start")
        })

        it("should handle mixed task types across regions", () => {
            const region1 = createRegion(0, 30)
            const region2 = createRegion(8, 4)
            const region3 = createRegion(15, 20)
            const tasks = runCreateTasks(
                [region1, region2, region3],
                [createMask(5, 20)]
            )

            expect(tasks).toHaveLength(3)
            expect(tasks[0].type).toBe("separate")
            expect(tasks[0].region).toBe(region1)
            expect(tasks[1].type).toBe("delete")
            expect(tasks[1].region).toBe(region2)
            expect(tasks[2].type).toBe("start")
            expect(tasks[2].region).toBe(region3)
        })
    })

    describe("two non-adjacent masks (bug #676 scenario)", () => {
        it("should create right-to-left tasks for region spanning both masks", () => {
            const region = createRegion(0, 30)
            const tasks = runCreateTasks(
                [region],
                [createMask(5, 10), createMask(15, 20)]
            )

            expect(tasks).toHaveLength(2)
            expect(tasks[0].type).toBe("separate")
            if (tasks[0].type === "separate") {
                expect(tasks[0].begin).toBe(15)
                expect(tasks[0].end).toBe(20)
            }
            expect(tasks[1].type).toBe("separate")
            if (tasks[1].type === "separate") {
                expect(tasks[1].begin).toBe(5)
                expect(tasks[1].end).toBe(10)
            }
        })

        it("should handle region overlapping both: complete on right, separate on left", () => {
            const region = createRegion(3, 15)
            const tasks = runCreateTasks(
                [region],
                [createMask(5, 10), createMask(15, 20)]
            )

            expect(tasks).toHaveLength(2)
            expect(tasks[0].type).toBe("complete")
            if (tasks[0].type === "complete") {
                expect(tasks[0].position).toBe(15)
            }
            expect(tasks[1].type).toBe("separate")
            if (tasks[1].type === "separate") {
                expect(tasks[1].begin).toBe(5)
                expect(tasks[1].end).toBe(10)
            }
        })

        it("should handle region overlapping both: start on left, separate on right", () => {
            const region = createRegion(7, 18)
            const tasks = runCreateTasks(
                [region],
                [createMask(5, 10), createMask(15, 20)]
            )

            expect(tasks).toHaveLength(2)
            expect(tasks[0].type).toBe("separate")
            if (tasks[0].type === "separate") {
                expect(tasks[0].begin).toBe(15)
                expect(tasks[0].end).toBe(20)
            }
            expect(tasks[1].type).toBe("start")
            if (tasks[1].type === "start") {
                expect(tasks[1].position).toBe(10)
            }
        })

        it("should handle region overlapping both: complete on right, start on left", () => {
            const region = createRegion(7, 12)
            const tasks = runCreateTasks(
                [region],
                [createMask(5, 10), createMask(15, 20)]
            )

            expect(tasks).toHaveLength(2)
            expect(tasks[0].type).toBe("complete")
            if (tasks[0].type === "complete") {
                expect(tasks[0].position).toBe(15)
            }
            expect(tasks[1].type).toBe("start")
            if (tasks[1].type === "start") {
                expect(tasks[1].position).toBe(10)
            }
        })

        it("should only create one task for region overlapping single mask", () => {
            const region = createRegion(6, 3)
            const tasks = runCreateTasks(
                [region],
                [createMask(5, 10), createMask(15, 20)]
            )

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("delete")
            expect(tasks[0].region).toBe(region)
        })

        it("should handle multiple regions with two masks", () => {
            const region1 = createRegion(0, 30)
            const regionInGap = createRegion(12, 2)
            const regionInMask = createRegion(6, 3)
            const tasks = runCreateTasks(
                [region1, regionInMask, regionInGap],
                [createMask(5, 10), createMask(15, 20)]
            )

            expect(tasks).toHaveLength(3)
            expect(tasks[0].type).toBe("separate")
            expect(tasks[0].region).toBe(region1)
            expect(tasks[1].type).toBe("separate")
            expect(tasks[1].region).toBe(region1)
            expect(tasks[2].type).toBe("delete")
            expect(tasks[2].region).toBe(regionInMask)
            const gapTasks = tasks.filter(task => task.region === regionInGap)
            expect(gapTasks).toHaveLength(0)
        })
    })

    describe("three non-adjacent masks", () => {
        it("should create three tasks for region spanning all masks", () => {
            const region = createRegion(0, 35)
            const tasks = runCreateTasks(
                [region],
                [createMask(5, 10), createMask(15, 20), createMask(25, 30)]
            )

            expect(tasks).toHaveLength(3)
            expect(tasks[0].type).toBe("separate")
            if (tasks[0].type === "separate") {
                expect(tasks[0].begin).toBe(25)
                expect(tasks[0].end).toBe(30)
            }
            expect(tasks[1].type).toBe("separate")
            if (tasks[1].type === "separate") {
                expect(tasks[1].begin).toBe(15)
                expect(tasks[1].end).toBe(20)
            }
            expect(tasks[2].type).toBe("separate")
            if (tasks[2].type === "separate") {
                expect(tasks[2].begin).toBe(5)
                expect(tasks[2].end).toBe(10)
            }
        })

        it("should handle region overlapping only the last two masks", () => {
            const region = createRegion(13, 22)
            const tasks = runCreateTasks(
                [region],
                [createMask(5, 10), createMask(15, 20), createMask(25, 30)]
            )

            expect(tasks).toHaveLength(2)
            expect(tasks[0].type).toBe("separate")
            if (tasks[0].type === "separate") {
                expect(tasks[0].begin).toBe(25)
                expect(tasks[0].end).toBe(30)
            }
            expect(tasks[1].type).toBe("separate")
            if (tasks[1].type === "separate") {
                expect(tasks[1].begin).toBe(15)
                expect(tasks[1].end).toBe(20)
            }
        })
    })

    describe("edge cases", () => {
        it("should produce no tasks for empty region list", () => {
            const tasks = runCreateTasks([], [createMask(0, 10)])

            expect(tasks).toHaveLength(0)
        })

        it("should produce no tasks when no regions overlap any mask", () => {
            const region = createRegion(20, 5)
            const tasks = runCreateTasks([region], [createMask(0, 10)])

            expect(tasks).toHaveLength(0)
        })

        it("should handle region touching mask boundary without overlap", () => {
            const region = createRegion(0, 10)
            const tasks = runCreateTasks([region], [createMask(10, 20)])

            expect(tasks).toHaveLength(0)
        })

        it("should handle region starting exactly at mask start", () => {
            const region = createRegion(5, 10)
            const tasks = runCreateTasks([region], [createMask(5, 20)])

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("delete")
        })

        it("should handle region ending exactly at mask end", () => {
            const region = createRegion(0, 20)
            const tasks = runCreateTasks([region], [createMask(5, 20)])

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("complete")
        })

        it("should handle multiple regions where some are skipped (selected) and some processed", () => {
            const selected = createRegion(5, 5, true)
            const unselected = createRegion(12, 5)
            const tasks = runCreateTasks(
                [selected, unselected],
                [createMask(0, 20)],
                false
            )

            expect(tasks).toHaveLength(1)
            expect(tasks[0].region).toBe(unselected)
        })

        it("should handle region spanning gap between two masks without overlapping either", () => {
            const region = createRegion(11, 3)
            const tasks = runCreateTasks(
                [region],
                [createMask(5, 10), createMask(15, 20)]
            )

            expect(tasks).toHaveLength(0)
        })

        it("should break early for regions past maxComplete", () => {
            const region1 = createRegion(5, 5)
            const region2 = createRegion(50, 5)
            const tasks = runCreateTasks(
                [region1, region2],
                [createMask(0, 20)]
            )

            expect(tasks).toHaveLength(1)
            expect(tasks[0].region).toBe(region1)
        })
    })

    describe("task ordering for right-to-left multi-mask processing", () => {
        it("should produce tasks in right-to-left order for execution correctness", () => {
            const region = createRegion(3, 22)
            const masks = [createMask(5, 10), createMask(15, 20)]
            const tasks = runCreateTasks([region], masks)

            expect(tasks).toHaveLength(2)
            if (tasks[0].type === "separate") {
                expect(tasks[0].begin).toBe(15)
            }
            if (tasks[1].type === "separate") {
                expect(tasks[1].begin).toBe(5)
            }
        })

        it("should produce complete before separate (right-to-left) for region ending in right mask", () => {
            const region = createRegion(3, 16)
            const masks = [createMask(5, 10), createMask(15, 20)]
            const tasks = runCreateTasks([region], masks)

            expect(tasks).toHaveLength(2)
            expect(tasks[0].type).toBe("complete")
            expect(tasks[1].type).toBe("separate")
        })

        it("should produce separate before start (right-to-left) for region starting in left mask", () => {
            const region = createRegion(7, 18)
            const masks = [createMask(5, 10), createMask(15, 20)]
            const tasks = runCreateTasks([region], masks)

            expect(tasks).toHaveLength(2)
            expect(tasks[0].type).toBe("separate")
            expect(tasks[1].type).toBe("start")
        })

        it("should produce complete then start for region within gap boundaries", () => {
            const region = createRegion(7, 12)
            const masks = [createMask(5, 10), createMask(15, 20)]
            const tasks = runCreateTasks([region], masks)

            expect(tasks).toHaveLength(2)
            expect(tasks[0].type).toBe("complete")
            if (tasks[0].type === "complete") {
                expect(tasks[0].position).toBe(15)
            }
            expect(tasks[1].type).toBe("start")
            if (tasks[1].type === "start") {
                expect(tasks[1].position).toBe(10)
            }
        })
    })

    describe("execution correctness (simulated right-to-left processing)", () => {
        it("separate + separate: region [3,25] with masks [5,10] and [15,20] produces valid segments", () => {
            const region = createRegion(3, 22)
            const tasks = runCreateTasks([region], [createMask(5, 10), createMask(15, 20)])

            expect(tasks).toHaveLength(2)
            // Right-to-left execution:
            // 1. separate at [15,20]: region [3,25] -> [3,15] + new [20,25]
            // 2. separate at [5,10]: region [3,15] -> [3,5] + new [10,15]
            // Expected segments: [3,5], [10,15], [20,25]
            // Verify task 1 (rightmost) is a separate at [15,20]
            expect(tasks[0].type).toBe("separate")
            if (tasks[0].type === "separate") {
                expect(tasks[0].begin).toBe(15)
                expect(tasks[0].end).toBe(20)
                // After this, region.complete (originally 25) would become 15.
                // complete - end = 25 - 20 = 5 > 0, valid.
            }
            // Verify task 2 (leftmost) is a separate at [5,10]
            expect(tasks[1].type).toBe("separate")
            if (tasks[1].type === "separate") {
                expect(tasks[1].begin).toBe(5)
                expect(tasks[1].end).toBe(10)
                // After task 1, region is [3,15]. complete - end = 15 - 10 = 5 > 0, valid.
            }
        })

        it("complete + separate: region [3,18] with masks [5,10] and [15,20] produces valid segments", () => {
            const region = createRegion(3, 15)
            const tasks = runCreateTasks([region], [createMask(5, 10), createMask(15, 20)])

            expect(tasks).toHaveLength(2)
            // 1. complete at 15: region [3,18] -> [3,15]
            // 2. separate at [5,10]: region [3,15] -> [3,5] + new [10,15]
            expect(tasks[0].type).toBe("complete")
            if (tasks[0].type === "complete") {
                expect(tasks[0].position).toBe(15)
            }
            expect(tasks[1].type).toBe("separate")
            if (tasks[1].type === "separate") {
                expect(tasks[1].begin).toBe(5)
                expect(tasks[1].end).toBe(10)
            }
        })

        it("separate + start: region [7,25] with masks [5,10] and [15,20] produces valid segments", () => {
            const region = createRegion(7, 18)
            const tasks = runCreateTasks([region], [createMask(5, 10), createMask(15, 20)])

            expect(tasks).toHaveLength(2)
            // 1. separate at [15,20]: region [7,25] -> [7,15] + new [20,25]
            // 2. start at 10: region [7,15] -> [10,15]
            expect(tasks[0].type).toBe("separate")
            if (tasks[0].type === "separate") {
                expect(tasks[0].begin).toBe(15)
                expect(tasks[0].end).toBe(20)
            }
            expect(tasks[1].type).toBe("start")
            if (tasks[1].type === "start") {
                expect(tasks[1].position).toBe(10)
            }
        })

        it("complete + start: region [5,20] with masks [5,10] and [15,20] leaves gap only", () => {
            const region = createRegion(5, 15)
            const tasks = runCreateTasks([region], [createMask(5, 10), createMask(15, 20)])

            expect(tasks).toHaveLength(2)
            // 1. complete at 15: region [5,20] -> [5,15]
            // 2. start at 10: region [5,15] -> [10,15]
            expect(tasks[0].type).toBe("complete")
            expect(tasks[1].type).toBe("start")
        })
    })

    describe("region fully within one mask of multiple masks", () => {
        it("should delete region within first mask only", () => {
            const region = createRegion(6, 3)
            const tasks = runCreateTasks(
                [region],
                [createMask(5, 10), createMask(15, 20)]
            )

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("delete")
        })

        it("should delete region within second mask only", () => {
            const region = createRegion(16, 3)
            const tasks = runCreateTasks(
                [region],
                [createMask(5, 10), createMask(15, 20)]
            )

            expect(tasks).toHaveLength(1)
            expect(tasks[0].type).toBe("delete")
        })
    })
})
