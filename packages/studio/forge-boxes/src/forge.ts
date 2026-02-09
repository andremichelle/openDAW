import {BoxForge} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {DeviceDefinitions} from "./schema/devices"
import {ModuleDefinitions} from "./schema/std/modular"
import {Definitions} from "./schema/std"

BoxForge.gen<Pointers>({
    path: "../boxes/src/",
    pointers: {
        from: "@moises-ai/studio-enums",
        enum: "Pointers",
        print: pointer => `Pointers.${Pointers[pointer]}`
    },
    boxes: [
        ...Definitions,
        ...DeviceDefinitions,
        ...ModuleDefinitions
    ]
}).then(() => console.debug("forged."))