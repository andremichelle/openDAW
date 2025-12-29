import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {Messenger} from "@opendaw/lib-runtime"
import {EnginePreferencesHost} from "./EnginePreferencesHost"
import {EnginePreferencesClient} from "./EnginePreferencesClient"
import {EnginePreferencesSchema} from "./EnginePreferencesSchema"

const EnginePreferencesDefaults = EnginePreferencesSchema.parse({})

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
        context.host = new EnginePreferencesHost()
        context.client = new EnginePreferencesClient()
    })

    afterEach<TestContext>(context => {
        context.host.terminate()
        context.client.terminate()
        context.mainChannel.close()
        context.audioChannel.close()
    })

    it<TestContext>("should have default settings on host", ({host}) => {
        expect(host.settings).toEqual(EnginePreferencesDefaults)
    })

    it<TestContext>("should have default settings on client before connection", ({client}) => {
        expect(client.settings).toEqual(EnginePreferencesDefaults)
    })

    it<TestContext>("should send initial state to client on connect", async ({
                                                                                 host,
                                                                                 client,
                                                                                 mainChannel,
                                                                                 audioChannel
                                                                             }) => {
        host.settings.metronome.enabled = false
        host.settings.metronome.gain = 0.8
        await waitForBroadcast()

        host.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        expect(client.settings.metronome.enabled).toBe(false)
        expect(client.settings.metronome.gain).toBe(0.8)
    })

    it<TestContext>("should broadcast changes to connected client", async ({
                                                                               host,
                                                                               client,
                                                                               mainChannel,
                                                                               audioChannel
                                                                           }) => {
        host.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        host.settings.metronome.beatSubDivision = 8
        await waitForBroadcast()

        expect(client.settings.metronome.beatSubDivision).toBe(8)
    })

    it<TestContext>("should batch multiple changes within same microtask", async ({
                                                                                      host,
                                                                                      client,
                                                                                      mainChannel,
                                                                                      audioChannel
                                                                                  }) => {
        const updateSpy = vi.fn()
        host.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        client.catchupAndSubscribe(updateSpy, "metronome")
        updateSpy.mockClear()

        host.settings.metronome.enabled = false
        host.settings.metronome.gain = 0.3
        host.settings.metronome.beatSubDivision = 2
        await waitForBroadcast()

        expect(updateSpy).toHaveBeenCalledTimes(1)
        expect(client.settings.metronome.enabled).toBe(false)
        expect(client.settings.metronome.gain).toBe(0.3)
        expect(client.settings.metronome.beatSubDivision).toBe(2)
    })

    it<TestContext>("should support catchupAndSubscribe on host", ({host}) => {
        const observer = vi.fn()
        host.catchupAndSubscribe(observer, "metronome", "enabled")

        expect(observer).toHaveBeenCalledWith(true)

        host.settings.metronome.enabled = false
        expect(observer).toHaveBeenCalledWith(false)
    })

    it<TestContext>("should support catchupAndSubscribe on client", async ({
                                                                               host,
                                                                               client,
                                                                               mainChannel,
                                                                               audioChannel
                                                                           }) => {
        host.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        const observer = vi.fn()
        client.catchupAndSubscribe(observer, "metronome", "gain")
        expect(observer).toHaveBeenCalledWith(0.5)

        observer.mockClear()
        host.settings.metronome.gain = 0.9
        await waitForBroadcast()

        expect(observer).toHaveBeenCalledWith(0.9)
    })

    it<TestContext>("should broadcast to multiple clients", async ({host}) => {
        const channelName = `engine-preferences-multi-${Math.random()}`
        const mainChannel = new BroadcastChannel(channelName)
        const audioChannel1 = new BroadcastChannel(channelName)
        const audioChannel2 = new BroadcastChannel(channelName)

        const client1 = new EnginePreferencesClient()
        const client2 = new EnginePreferencesClient()

        host.connect(Messenger.for(mainChannel))
        client1.connect(Messenger.for(audioChannel1))
        client2.connect(Messenger.for(audioChannel2))
        await waitForBroadcast()

        host.settings.metronome.enabled = false
        await waitForBroadcast()

        expect(client1.settings.metronome.enabled).toBe(false)
        expect(client2.settings.metronome.enabled).toBe(false)

        client1.terminate()
        client2.terminate()
        mainChannel.close()
        audioChannel1.close()
        audioChannel2.close()
    })

    it<TestContext>("should only notify changed keys on client", async ({
                                                                            host,
                                                                            client,
                                                                            mainChannel,
                                                                            audioChannel
                                                                        }) => {
        host.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        const metronomeObserver = vi.fn()
        client.catchupAndSubscribe(metronomeObserver, "metronome")
        metronomeObserver.mockClear()

        host.settings.metronome.gain = 0.7
        await waitForBroadcast()

        expect(metronomeObserver).toHaveBeenCalledTimes(1)
    })

    it<TestContext>("should handle disconnect", async ({host, mainChannel, audioChannel}) => {
        const client = new EnginePreferencesClient()
        const connection = host.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        connection.terminate()

        host.settings.metronome.enabled = false
        await waitForBroadcast()

        expect(client.settings.metronome.enabled).toBe(true)
        client.terminate()
    })
})
