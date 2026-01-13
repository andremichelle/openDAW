import {Fonts} from "@/ui/Fonts"
import {loadFont} from "@moises-ai/lib-dom"
import {Lazy} from "@moises-ai/lib-std"

export class FontLoader {
    @Lazy
    static async load() {
        return Promise.allSettled([
            loadFont(Fonts.Rubik), loadFont(Fonts.RubikBold), loadFont(Fonts.OpenSans)
        ])
    }
}