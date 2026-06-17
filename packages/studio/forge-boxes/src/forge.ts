import {BoxForge} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceDefinitions} from "./schema/devices"
import {ModuleDefinitions} from "./schema/std/modular"
import {Definitions} from "./schema/std"

BoxForge.gen<Pointers>({
    path: "../boxes/src/",
    pointers: {
        from: "@opendaw/studio-enums",
        enum: "Pointers",
        print: pointer => `Pointers.${Pointers[pointer]}`
    },
    rust: {path: "../../../crates/studio-boxes/src/registry.rs"},
    boxes: [
        ...Definitions,
        ...DeviceDefinitions,
        ...ModuleDefinitions
    ]
}).then(() => console.debug("forged."))