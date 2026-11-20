import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {Terminable} from "@opendaw/lib-std"
import {OpfsQuota} from "./OpfsQuota"

const quotaError = (message: string = "No space available") => new DOMException(message, "QuotaExceededError")

describe("OpfsQuota", () => {
    const installed: Array<Terminable> = []
    const install = (handler: OpfsQuota.Handler): Terminable => {
        const terminable = OpfsQuota.install(handler)
        installed.push(terminable)
        return terminable
    }
    beforeEach(() => {vi.spyOn(console, "warn").mockImplementation(() => {})})
    afterEach(() => {
        installed.splice(0).forEach(terminable => terminable.terminate())
        vi.restoreAllMocks()
    })

    describe("isExceeded", () => {
        it("recognises a QuotaExceededError", () => {
            expect(OpfsQuota.isExceeded(quotaError())).toBe(true)
        })
        it("rejects other errors", () => {
            expect(OpfsQuota.isExceeded(new DOMException("x", "InvalidStateError"))).toBe(false)
            expect(OpfsQuota.isExceeded(new Error("QuotaExceededError"))).toBe(false)
            expect(OpfsQuota.isExceeded("QuotaExceededError")).toBe(false)
            expect(OpfsQuota.isExceeded(undefined)).toBe(false)
        })
    })

    describe("retry", () => {
        it("answers the value of a save that works, without rollback or handler", async () => {
            const handler = vi.fn(async () => true)
            install(handler)
            const rollback = vi.fn(async () => {})
            expect(await OpfsQuota.retry("a", async () => 42, rollback)).toBe(42)
            expect(rollback).not.toHaveBeenCalled()
            expect(handler).not.toHaveBeenCalled()
        })
        it("passes any other error through after rolling back, without asking the handler", async () => {
            const handler = vi.fn(async () => true)
            install(handler)
            const rollback = vi.fn(async () => {})
            const error = new DOMException("gone", "InvalidStateError")
            const operation = vi.fn(async () => {throw error})
            await expect(OpfsQuota.retry("a", operation, rollback)).rejects.toBe(error)
            expect(operation).toHaveBeenCalledOnce()
            expect(rollback).toHaveBeenCalledOnce()
            expect(handler).not.toHaveBeenCalled()
        })
        it("passes a quota error through when no handler is installed", async () => {
            const rollback = vi.fn(async () => {})
            const error = quotaError()
            const operation = vi.fn(async () => {throw error})
            await expect(OpfsQuota.retry("a", operation, rollback)).rejects.toBe(error)
            expect(operation).toHaveBeenCalledOnce()
            expect(rollback).toHaveBeenCalledOnce()
        })
        it("rolls back, asks the handler and runs the whole save once more", async () => {
            const order: Array<string> = []
            const error = quotaError()
            install(async event => {
                order.push(`handler ${event.path} ${event.error.name}`)
                return true
            })
            let calls = 0
            const value = await OpfsQuota.retry("samples/v2/x", async () => {
                order.push(`save ${++calls}`)
                if (calls === 1) {throw error}
                return "stored"
            }, async () => {order.push("rollback")})
            expect(value).toBe("stored")
            expect(order).toEqual(["save 1", "rollback", "handler samples/v2/x QuotaExceededError", "save 2"])
        })
        it("hands the handler the error the save failed with", async () => {
            const error = quotaError("Wrote 2 of 4 bytes")
            const handler = vi.fn(async () => false)
            install(handler)
            await expect(OpfsQuota.retry("p", async () => {throw error}, async () => {})).rejects.toBe(error)
            expect(handler).toHaveBeenCalledExactlyOnceWith({path: "p", error, cached: false})
        })
        it("tells the handler whether the data can be fetched again", async () => {
            const handler = vi.fn(async () => false)
            install(handler)
            const error = quotaError()
            await expect(OpfsQuota.retry("p", async () => {throw error}, async () => {}, {cached: true})).rejects.toBe(error)
            expect(handler).toHaveBeenCalledExactlyOnceWith({path: "p", error, cached: true})
        })
        it("passes the original error through when the handler answers false", async () => {
            install(async () => false)
            const error = quotaError()
            const operation = vi.fn(async () => {throw error})
            await expect(OpfsQuota.retry("a", operation, async () => {})).rejects.toBe(error)
            expect(operation).toHaveBeenCalledOnce()
        })
        it("retries only once and rolls back the second attempt too", async () => {
            const handler = vi.fn(async () => true)
            install(handler)
            const rollback = vi.fn(async () => {})
            const first = quotaError("first")
            const second = quotaError("second")
            let calls = 0
            const operation = vi.fn(async () => {throw ++calls === 1 ? first : second})
            await expect(OpfsQuota.retry("a", operation, rollback)).rejects.toBe(second)
            expect(operation).toHaveBeenCalledTimes(2)
            expect(rollback).toHaveBeenCalledTimes(2)
            expect(handler).toHaveBeenCalledOnce()
        })
        it("treats a handler that rejects as false", async () => {
            install(async () => {throw new Error("handler broke")})
            const error = quotaError()
            await expect(OpfsQuota.retry("a", async () => {throw error}, async () => {})).rejects.toBe(error)
        })
        it("treats a handler that throws synchronously as false", async () => {
            install((() => {throw new Error("sync")}) as unknown as OpfsQuota.Handler)
            const error = quotaError()
            await expect(OpfsQuota.retry("a", async () => {throw error}, async () => {})).rejects.toBe(error)
        })
        it("still asks the handler when the rollback fails", async () => {
            const handler = vi.fn(async () => true)
            install(handler)
            let calls = 0
            const value = await OpfsQuota.retry("a", async () => {
                if (++calls === 1) {throw quotaError()}
                return "ok"
            }, async () => {throw new Error("cannot remove")})
            expect(value).toBe("ok")
            expect(handler).toHaveBeenCalledOnce()
        })
        it("runs saves one at a time", async () => {
            let active = 0
            let maxActive = 0
            const save = () => OpfsQuota.retry("a", async () => {
                active++
                maxActive = Math.max(maxActive, active)
                await new Promise(resolve => setTimeout(resolve, 2))
                active--
            }, async () => {}, {serial: true})
            await Promise.all([save(), save(), save()])
            expect(maxActive).toBe(1)
        })
        it("never overlaps writes when many saves fail together and retry", async () => {
            const {promise: room, resolve: made} = Promise.withResolvers<boolean>()
            const handler = vi.fn(() => room)
            install(handler)
            let active = 0
            let maxActive = 0
            let failed = 0
            const save = () => {
                let calls = 0
                return OpfsQuota.retry("s", async () => {
                    active++
                    maxActive = Math.max(maxActive, active)
                    await new Promise(resolve => setTimeout(resolve, 1))
                    active--
                    if (++calls === 1) {
                        failed++
                        throw quotaError()
                    }
                    return calls
                }, async () => {}, {serial: true})
            }
            const saves = Array.from({length: 8}, save)
            // the handler must still be busy when the last save fails, however slow the machine is
            await vi.waitFor(() => expect(failed).toBe(8))
            await new Promise(resolve => setTimeout(resolve, 1))
            made(true)
            expect(await Promise.all(saves)).toEqual(Array.from({length: 8}, () => 2))
            expect(maxActive).toBe(1)
            expect(handler).toHaveBeenCalledOnce()
        })
        it("goes on with the next save after one failed", async () => {
            const results = await Promise.allSettled([
                OpfsQuota.retry("a", async () => {throw new Error("broken")}, async () => {}, {serial: true}),
                OpfsQuota.retry("b", async () => "b", async () => {}, {serial: true})])
            expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"])
        })
        it("lets a save the handler starts itself run without waiting for the save that asked", async () => {
            let inner: Promise<string> = Promise.resolve("")
            install(async () => {
                inner = OpfsQuota.retry("inner", async () => "inner", async () => {}, {serial: true})
                await inner
                return true
            })
            let calls = 0
            const outer = await OpfsQuota.retry("outer", async () => {
                if (++calls === 1) {throw quotaError()}
                return "outer"
            }, async () => {}, {serial: true})
            expect(outer).toBe("outer")
            expect(await inner).toBe("inner")
        })
        it("shares one handler call among saves that fail while it runs", async () => {
            const {promise: room, resolve: made} = Promise.withResolvers<boolean>()
            const handler = vi.fn(() => room)
            install(handler)
            const failOnce = (path: string) => {
                let calls = 0
                return OpfsQuota.retry(path, async () => {
                    if (++calls === 1) {throw quotaError()}
                    return path
                }, async () => {})
            }
            const first = failOnce("a")
            await vi.waitFor(() => expect(handler).toHaveBeenCalled())
            const second = failOnce("b")
            await new Promise(resolve => setTimeout(resolve, 0))
            made(true)
            expect(await Promise.all([first, second])).toEqual(["a", "b"])
            expect(handler).toHaveBeenCalledOnce()
        })
        it("asks separately for a save that can not be fetched again while a cached one waits", async () => {
            const {promise: room, resolve: made} = Promise.withResolvers<boolean>()
            const events: Array<OpfsQuota.Exceeded> = []
            install(async event => {
                events.push(event)
                return event.cached ? room : true
            })
            const failOnce = (cached: boolean) => {
                let calls = 0
                return OpfsQuota.retry("p", async () => {
                    if (++calls === 1) {throw quotaError()}
                    return cached
                }, async () => {}, {cached})
            }
            const cached = failOnce(true)
            await vi.waitFor(() => expect(events.length).toBe(1))
            const other = failOnce(false)
            await new Promise(resolve => setTimeout(resolve, 0))
            made(false)
            await expect(cached).rejects.toThrow()
            expect(await other).toBe(false)
            expect(events.map(event => event.cached)).toEqual([true, false])
        })
        it("never runs two handler calls at once", async () => {
            let active = 0
            let maxActive = 0
            install(async () => {
                active++
                maxActive = Math.max(maxActive, active)
                await new Promise(resolve => setTimeout(resolve, 5))
                active--
                return true
            })
            const failOnce = (cached: boolean) => {
                let calls = 0
                return OpfsQuota.retry("p", async () => {
                    if (++calls === 1) {throw quotaError()}
                    return cached
                }, async () => {}, {cached})
            }
            expect(await Promise.all([failOnce(true), failOnce(false)])).toEqual([true, false])
            expect(maxActive).toBe(1)
        })
        it("retries a waiting save without asking when the call before it made room", async () => {
            const events: Array<OpfsQuota.Exceeded> = []
            const {promise: room, resolve: made} = Promise.withResolvers<boolean>()
            install(async event => {
                events.push(event)
                return room
            })
            const failOnce = (cached: boolean) => {
                let calls = 0
                return OpfsQuota.retry("p", async () => {
                    if (++calls === 1) {throw quotaError()}
                    return cached
                }, async () => {}, {cached})
            }
            const sample = failOnce(true)
            await vi.waitFor(() => expect(events.length).toBe(1))
            const project = failOnce(false)
            await new Promise(resolve => setTimeout(resolve, 0))
            made(true)
            expect(await Promise.all([sample, project])).toEqual([true, false])
            expect(events.map(event => event.cached)).toEqual([true])
        })
        it("never lets a library download wait for the answer about a user's save", async () => {
            const {promise: answer, resolve: answered} = Promise.withResolvers<boolean>()
            install(async event => event.cached ? false : answer)
            const failOnce = (cached: boolean) => {
                let calls = 0
                return OpfsQuota.retry("p", async () => {
                    if (++calls === 1) {throw quotaError()}
                    return cached
                }, async () => {}, {cached})
            }
            const project = failOnce(false)
            await new Promise(resolve => setTimeout(resolve, 0))
            await expect(failOnce(true)).rejects.toThrow()
            answered(false)
            await expect(project).rejects.toThrow()
        })
        it("moves the queue on when a save never answers", async () => {
            vi.useFakeTimers()
            OpfsQuota.retry("hung", () => new Promise(() => {}), async () => {}, {serial: true}).catch(() => {})
            const next = OpfsQuota.retry("next", async () => "next", async () => {}, {serial: true})
            await vi.advanceTimersByTimeAsync(300_000)
            expect(await next).toBe("next")
            vi.useRealTimers()
        })
        it("does not queue saves that do not ask for it", async () => {
            let active = 0
            let maxActive = 0
            const save = () => OpfsQuota.retry("a", async () => {
                active++
                maxActive = Math.max(maxActive, active)
                await new Promise(resolve => setTimeout(resolve, 2))
                active--
            }, async () => {})
            await Promise.all([save(), save()])
            expect(maxActive).toBe(2)
        })
        it("asks again for a failure after the previous call ended", async () => {
            const handler = vi.fn(async () => true)
            install(handler)
            const failOnce = () => {
                let calls = 0
                return async () => {
                    if (++calls === 1) {throw quotaError()}
                    return calls
                }
            }
            await OpfsQuota.retry("a", failOnce(), async () => {})
            await OpfsQuota.retry("b", failOnce(), async () => {})
            expect(handler).toHaveBeenCalledTimes(2)
        })
    })

    describe("install", () => {
        it("stops asking after terminate", async () => {
            const handler = vi.fn(async () => true)
            install(handler).terminate()
            const error = quotaError()
            await expect(OpfsQuota.retry("a", async () => {throw error}, async () => {})).rejects.toBe(error)
            expect(handler).not.toHaveBeenCalled()
        })
        it("replaces an earlier handler, and terminating the earlier one keeps the new one", async () => {
            const first = vi.fn(async () => true)
            const second = vi.fn(async () => true)
            const earlier = install(first)
            install(second)
            earlier.terminate()
            let calls = 0
            await OpfsQuota.retry("a", async () => {if (++calls === 1) {throw quotaError()}}, async () => {})
            expect(first).not.toHaveBeenCalled()
            expect(second).toHaveBeenCalledOnce()
        })
    })
})
