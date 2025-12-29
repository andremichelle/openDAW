import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {Messenger} from "@opendaw/lib-runtime"
import {PreferencesFacade, PreferencesHost} from "@opendaw/lib-fusion"
import {EngineSettings, EngineSettingsSchema} from "./EnginePreferencesSchema"

const EngineSettingsDefaults = EngineSettingsSchema.parse({})

const waitForMicrotask = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe("EnginePreferencesFacade", () => {
    describe("without host", () => {
        let facade: PreferencesFacade<EngineSettings>

        beforeEach(() => {
            facade = new PreferencesFacade(EngineSettingsSchema.parse({}))
        })

        afterEach(() => {
            facade.terminate()
        })

        it("should have default settings", () => {
            expect(facade.settings).toEqual(EngineSettingsDefaults)
        })

        it("should allow modifying settings", () => {
            facade.settings.metronome.enabled = false
            facade.settings.metronome.gain = 0.8

            expect(facade.settings.metronome.enabled).toBe(false)
            expect(facade.settings.metronome.gain).toBe(0.8)
        })

        it("should support catchupAndSubscribe", () => {
            const observer = vi.fn()
            facade.catchupAndSubscribe(observer, "metronome", "enabled")

            expect(observer).toHaveBeenCalledWith(false)

            facade.settings.metronome.enabled = true
            expect(observer).toHaveBeenCalledWith(true)
        })
    })

    describe("with host", () => {
        let facade: PreferencesFacade<EngineSettings>
        let host: PreferencesHost<EngineSettings>
        let channel: BroadcastChannel

        beforeEach(() => {
            const channelName = `facade-test-${Math.random()}`
            channel = new BroadcastChannel(channelName)
            host = new PreferencesHost(Messenger.for(channel), EngineSettingsSchema.parse({}))
            facade = new PreferencesFacade(EngineSettingsSchema.parse({}))
        })

        afterEach(async () => {
            facade.terminate()
            host.terminate()
            await waitForMicrotask()
            channel.close()
        })

        it("should push facade state to host on setHost", () => {
            facade.settings.metronome.enabled = false
            facade.settings.metronome.gain = 0.7

            facade.setHost(host)

            expect(host.settings.metronome.enabled).toBe(false)
            expect(host.settings.metronome.gain).toBe(0.7)
        })

        it("should preserve facade settings when switching hosts", async () => {
            facade.settings.metronome.enabled = false
            facade.setHost(host)
            facade.releaseHost()
            await waitForMicrotask()

            const channelName2 = `facade-test-${Math.random()}`
            const channel2 = new BroadcastChannel(channelName2)
            const host2 = new PreferencesHost(Messenger.for(channel2), EngineSettingsSchema.parse({}))

            facade.setHost(host2)

            expect(facade.settings.metronome.enabled).toBe(false)
            expect(host2.settings.metronome.enabled).toBe(false)

            host2.terminate()
            await waitForMicrotask()
            channel2.close()
        })

        it("should propagate facade changes to host", async () => {
            facade.setHost(host)

            facade.settings.metronome.beatSubDivision = 8
            await waitForMicrotask()

            expect(host.settings.metronome.beatSubDivision).toBe(8)
        })

        it("should propagate host changes to facade", () => {
            facade.setHost(host)

            host.settings.metronome.gain = 0.3

            expect(facade.settings.metronome.gain).toBe(0.3)
        })

        it("should batch multiple facade changes", async () => {
            facade.setHost(host)

            const hostObserver = vi.fn()
            host.subscribeAll(hostObserver)

            facade.settings.metronome.enabled = false
            facade.settings.metronome.gain = 0.2
            facade.settings.metronome.beatSubDivision = 2
            await waitForMicrotask()

            expect(hostObserver).toHaveBeenCalledTimes(1)
            expect(host.settings.metronome.enabled).toBe(false)
            expect(host.settings.metronome.gain).toBe(0.2)
            expect(host.settings.metronome.beatSubDivision).toBe(2)
        })

        it("should stop syncing after releaseHost", async () => {
            facade.setHost(host)
            facade.releaseHost()

            facade.settings.metronome.enabled = true
            await waitForMicrotask()

            expect(host.settings.metronome.enabled).toBe(false)
        })
    })
})
