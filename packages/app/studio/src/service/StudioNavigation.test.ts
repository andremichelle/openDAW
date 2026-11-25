// @vitest-environment jsdom

import {beforeEach, describe, expect, it, vi} from "vitest"
import {DefaultObservableValue, Nullable, Option} from "@opendaw/lib-std"
import type {ProjectProfileService} from "@/service/ProjectProfileService"
import type {Workspace} from "@/ui/workspace/Workspace.ts"

// Live errors 1200/1201: the page had lost its <body>, so the "Closing Project?" dialog threw while attaching.
// closeProject kept #confirming set, so no later Back (or dashboard switch) could close the project again.

vi.mock("@/ui/workspace/Workspace.ts", () => ({Workspace: {}}))
vi.mock("@opendaw/lib-dom", async importOriginal => {
    const original = await importOriginal<typeof import("@opendaw/lib-dom")>()
    return {...original, Html: {...original.Html, adoptStyleSheet: (_css: string, prefix?: string) => prefix ?? "C"}}
})

const fakeProfiles =(answers: Array<() => Promise<boolean>>) => {
    const profile = new DefaultObservableValue<Option<unknown>>(Option.wrap({}))
    let asked = 0
    const service = {
        getValue: () => profile.getValue(),
        setValue: (value: Option<unknown>) => profile.setValue(value),
        approveLosingChanges: () => answers[asked++]()
    }
    return {profiles: service as unknown as ProjectProfileService, isOpen: () => profile.getValue().nonEmpty()}
}

describe("StudioNavigation.closeProject", () => {
    beforeEach(() => history.replaceState(null, "", "/create"))
    it("can close the project after the approval dialog failed once", async () => {
        const {StudioNavigation} = await import("@/service/StudioNavigation")
        const {profiles, isOpen} = fakeProfiles([
            () => Promise.reject(new TypeError("Cannot read properties of null (reading 'appendChild')")),
            () => Promise.resolve(true)
        ])
        const navigation = new StudioNavigation(new DefaultObservableValue<Nullable<Workspace.ScreenKeys>>(null), profiles)
        await expect(navigation.closeProject()).rejects.toThrow("appendChild")
        expect(isOpen()).toBe(true)
        await navigation.closeProject()
        expect(isOpen()).toBe(false)
    })
    it("keeps the project open when closing is declined, and can close it later", async () => {
        const {StudioNavigation} = await import("@/service/StudioNavigation")
        const {profiles, isOpen} = fakeProfiles([() => Promise.resolve(false), () => Promise.resolve(true)])
        const navigation = new StudioNavigation(new DefaultObservableValue<Nullable<Workspace.ScreenKeys>>(null), profiles)
        await navigation.closeProject()
        expect(isOpen()).toBe(true)
        await navigation.closeProject()
        expect(isOpen()).toBe(false)
    })
    // a page like a contest keeps its own route, closing the project from there must still reach the dashboard
    it("goes to the dashboard when the project is closed from another page", async () => {
        const {StudioNavigation} = await import("@/service/StudioNavigation")
        const {RouteLocation} = await import("@opendaw/lib-jsx")
        RouteLocation.get().navigateTo("/contests/spring")
        const {profiles, isOpen} = fakeProfiles([() => Promise.resolve(true)])
        const navigation = new StudioNavigation(new DefaultObservableValue<Nullable<Workspace.ScreenKeys>>(null), profiles)
        await navigation.closeProject()
        expect(isOpen()).toBe(false)
        expect(RouteLocation.get().path).toBe("/")
    })
})
