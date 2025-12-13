import {LinearScale} from "@/ui/canvas/scale"

const height = 157
const padding = 10
export const Vertical = {
    scale: new LinearScale(0, 27),
    height,
    padding,
    innerHeight: height - padding * 2
}