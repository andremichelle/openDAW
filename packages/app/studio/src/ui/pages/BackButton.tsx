import css from "./BackButton.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@moises-ai/studio-enums"
import {createElement, LocalLink} from "@moises-ai/lib-jsx"

const className = Html.adoptStyleSheet(css, "BackButton")

export const BackButton = () => {
    return (
        <div className={className}>
            <LocalLink href="/">
                <Icon symbol={IconSymbol.OpenDAW} style={{fontSize: "1.25em"}}/><span>GO BACK TO STUDIO</span>
            </LocalLink>
        </div>
    )
}