// Only the url of the engine device, so the studio can link it at boot without loading the analysis code
export const MasteringDeviceUrl: string = new URL("../dist/device_mastering.wasm", import.meta.url).href
export const MasteringDeviceBoxType = "MasteringDeviceBox"
