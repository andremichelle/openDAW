import {LinearScale} from "@opendaw/studio-core"

const height = 157
const padding = 10
export const Vertical = {
    scale: new LinearScale(0, 27),
    height,
    padding,
    innerHeight: height - padding * 2
}