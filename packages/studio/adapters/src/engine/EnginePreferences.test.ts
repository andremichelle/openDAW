import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {Messenger} from "@opendaw/lib-runtime"
import {EnginePreferencesMain} from "./EnginePreferencesMain"
import {EnginePreferencesClient} from "./EnginePreferencesClient"
import {EnginePreferencesSchema} from "./EnginePreferencesSchema"

const EnginePreferencesDefaults = EnginePreferencesSchema.parse({})

const waitForBroadcast = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10))

interface TestContext {
    mainChannel: BroadcastChannel
    audioChannel: BroadcastChannel
    main: EnginePreferencesMain
    client: EnginePreferencesClient
}

describe("EnginePreferences", () => {
    beforeEach<TestContext>(context => {
        const channelName = `engine-preferences-${Math.random()}`
        context.mainChannel = new BroadcastChannel(channelName)
        context.audioChannel = new BroadcastChannel(channelName)
        context.main = new EnginePreferencesMain()
        context.client = new EnginePreferencesClient()
    })

    afterEach<TestContext>(context => {
        context.main.terminate()
        context.client.terminate()
        context.mainChannel.close()
        context.audioChannel.close()
    })

    it<TestContext>("should have default values on main", ({main}) => {
        expect(main.values).toEqual(EnginePreferencesDefaults)
    })

    it<TestContext>("should have default values on client before connection", ({client}) => {
        expect(client.values).toEqual(EnginePreferencesDefaults)
    })

    it<TestContext>("should send initial state to client on connect", async ({main, client, mainChannel, audioChannel}) => {
        main.values.metronome.enabled = false
        main.values.metronome.gain = 0.8
        await waitForBroadcast()

        main.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        expect(client.values.metronome.enabled).toBe(false)
        expect(client.values.metronome.gain).toBe(0.8)
    })

    it<TestContext>("should broadcast changes to connected client", async ({main, client, mainChannel, audioChannel}) => {
        main.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        main.values.metronome.beatSubDivision = 8
        await waitForBroadcast()

        expect(client.values.metronome.beatSubDivision).toBe(8)
    })

    it<TestContext>("should batch multiple changes within same microtask", async ({main, client, mainChannel, audioChannel}) => {
        const updateSpy = vi.fn()
        main.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        client.catchupAndSubscribe(updateSpy, "metronome")
        updateSpy.mockClear()

        main.values.metronome.enabled = false
        main.values.metronome.gain = 0.3
        main.values.metronome.beatSubDivision = 2
        await waitForBroadcast()

        expect(updateSpy).toHaveBeenCalledTimes(1)
        expect(client.values.metronome.enabled).toBe(false)
        expect(client.values.metronome.gain).toBe(0.3)
        expect(client.values.metronome.beatSubDivision).toBe(2)
    })

    it<TestContext>("should support catchupAndSubscribe on main", ({main}) => {
        const observer = vi.fn()
        main.catchupAndSubscribe(observer, "metronome", "enabled")

        expect(observer).toHaveBeenCalledWith(true)

        main.values.metronome.enabled = false
        expect(observer).toHaveBeenCalledWith(false)
    })

    it<TestContext>("should support catchupAndSubscribe on client", async ({main, client, mainChannel, audioChannel}) => {
        main.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        const observer = vi.fn()
        client.catchupAndSubscribe(observer, "metronome", "gain")
        expect(observer).toHaveBeenCalledWith(0.5)

        observer.mockClear()
        main.values.metronome.gain = 0.9
        await waitForBroadcast()

        expect(observer).toHaveBeenCalledWith(0.9)
    })

    it<TestContext>("should broadcast to multiple clients", async ({main, mainChannel}) => {
        const channelName = `engine-preferences-multi-${Math.random()}`
        const mainChannel2 = new BroadcastChannel(channelName)
        const audioChannel1 = new BroadcastChannel(channelName)
        const audioChannel2 = new BroadcastChannel(channelName)

        const client1 = new EnginePreferencesClient()
        const client2 = new EnginePreferencesClient()

        main.connect(Messenger.for(mainChannel2))
        client1.connect(Messenger.for(audioChannel1))
        client2.connect(Messenger.for(audioChannel2))
        await waitForBroadcast()

        main.values.metronome.enabled = false
        await waitForBroadcast()

        expect(client1.values.metronome.enabled).toBe(false)
        expect(client2.values.metronome.enabled).toBe(false)

        client1.terminate()
        client2.terminate()
        mainChannel2.close()
        audioChannel1.close()
        audioChannel2.close()
    })

    it<TestContext>("should only notify changed keys on client", async ({main, client, mainChannel, audioChannel}) => {
        main.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        const metronomeObserver = vi.fn()
        client.catchupAndSubscribe(metronomeObserver, "metronome")
        metronomeObserver.mockClear()

        main.values.metronome.gain = 0.7
        await waitForBroadcast()

        expect(metronomeObserver).toHaveBeenCalledTimes(1)
    })

    it<TestContext>("should handle disconnect", async ({main, mainChannel, audioChannel}) => {
        const client = new EnginePreferencesClient()
        const connection = main.connect(Messenger.for(mainChannel))
        client.connect(Messenger.for(audioChannel))
        await waitForBroadcast()

        connection.terminate()

        main.values.metronome.enabled = false
        await waitForBroadcast()

        expect(client.values.metronome.enabled).toBe(true)
        client.terminate()
    })
})
