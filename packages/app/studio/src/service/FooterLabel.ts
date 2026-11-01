import {Exec, Subscription, Terminable} from "@opendaw/lib-std"

export interface FooterLabel extends Terminable {
    setTitle(value: string): void
    setValue(value: string): void
    setColor(value: string): void
    onClick(exec: Exec): Subscription
}

// "center": between the footer's items and the links, for a label that asks for attention
export type FooterPlacement = "start" | "center"

export type FooterLabelFactory = (placement?: FooterPlacement) => FooterLabel
