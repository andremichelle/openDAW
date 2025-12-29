import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {Messenger} from "@opendaw/lib-runtime"
import {EnginePreferencesHost} from "./EnginePreferencesHost"
import {EnginePreferencesClient} from "./EnginePreferencesClient"
import {EngineSettingsSchema} from "./EnginePreferencesSchema"

const EngineSettingsDefaults = EngineSettingsSchema.parse({})

const waitForBroadcast = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10))

interface TestContext {
    mainChannel: BroadcastChannel
    audioChannel: BroadcastChannel
    host: EnginePreferencesHost
    client: EnginePreferencesClient
}

describe("EnginePreferences", () => {
    beforeEach<TestContext>(context => {
        const channelName = `engine-preferences-${Math.random()}`
        context.mainChannel = new BroadcastChannel(channelName)
        context.audioChannel = new BroadcastChannel(channelName)
        context.host = new EnginePreferencesHost(Messenger.for(context.mainChannel))
        context.client = new EnginePreferencesClient(Messenger.for(context.audioChannel))
    })

    afterEach<TestContext>(context => {
        context.host.terminate()
        context.client.terminate()
        context.mainChannel.close()
        context.audioChannel.close()
    })

    it<TestContext>("should have default settings on host", ({host}) => {
        expect(host.settings()).toEqual(EngineSettingsDefaults)
    })

    it<TestContext>("should have default settings on client before receiving", ({client}) => {
        expect(client.settings()).toEqual(EngineSettingsDefaults)
    })

    it<TestContext>("should send initial state to client", async ({client}) => {
        await waitForBroadcast()

        expect(client.settings().metronome.enabled).toBe(true)
        expect(client.settings().metronome.gain).toBe(0.5)
        expect(client.settings().metronome.beatSubDivision).toBe(4)
    })

    it<TestContext>("should broadcast changes to client", async ({host, client}) => {
        await waitForBroadcast()

        host.settings().metronome.beatSubDivision = 8
        await waitForBroadcast()

        expect(client.settings().metronome.beatSubDivision).toBe(8)
    })

    it<TestContext>("should batch multiple changes within same microtask", async ({host, client}) => {
        await waitForBroadcast()

        const updateSpy = vi.fn()
        client.catchupAndSubscribe(updateSpy, "metronome")
        updateSpy.mockClear()

        host.settings().metronome.enabled = false
        host.settings().metronome.gain = 0.3
        host.settings().metronome.beatSubDivision = 2
        await waitForBroadcast()

        expect(updateSpy).toHaveBeenCalledTimes(1)
        expect(client.settings().metronome.enabled).toBe(false)
        expect(client.settings().metronome.gain).toBe(0.3)
        expect(client.settings().metronome.beatSubDivision).toBe(2)
    })

    it<TestContext>("should support catchupAndSubscribe on host", ({host}) => {
        const observer = vi.fn()
        host.catchupAndSubscribe(observer, "metronome", "enabled")

        expect(observer).toHaveBeenCalledWith(true)

        host.settings().metronome.enabled = false
        expect(observer).toHaveBeenCalledWith(false)
    })

    it<TestContext>("should support catchupAndSubscribe on client", async ({host, client}) => {
        await waitForBroadcast()

        const observer = vi.fn()
        client.catchupAndSubscribe(observer, "metronome", "gain")
        expect(observer).toHaveBeenCalledWith(0.5)

        observer.mockClear()
        host.settings().metronome.gain = 0.9
        await waitForBroadcast()

        expect(observer).toHaveBeenCalledWith(0.9)
    })

    it<TestContext>("should only notify changed keys on client", async ({host, client}) => {
        await waitForBroadcast()

        const metronomeObserver = vi.fn()
        client.catchupAndSubscribe(metronomeObserver, "metronome")
        metronomeObserver.mockClear()

        host.settings().metronome.gain = 0.7
        await waitForBroadcast()

        expect(metronomeObserver).toHaveBeenCalledTimes(1)
    })
})
