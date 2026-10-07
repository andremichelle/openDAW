import {WclapPluginInfo} from "@opendaw/studio-adapters"
import {WclapBridges, WclapBundleLoader} from "./wclap-bridge"

// Lists a bundle's plugins without an engine (main thread): entry init and the factory's descriptors, cached per url
export const createWclapDescriber = (loadBundle: WclapBundleLoader): (url: string) => Promise<ReadonlyArray<WclapPluginInfo>> => {
    const bridges = new WclapBridges(new WebAssembly.Memory({initial: 1}), 48000, {
        loadBundle,
        sendGui: () => {}, sendState: () => {}, sendParams: () => {}, sendParam: () => {}, sendHovered: () => {},
        requestGuiResize: () => {},
        sendStatus: () => {}, requestSave: () => {}, track: () => {}
    })
    return url => bridges.describe(url)
}
