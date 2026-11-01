import {Terminable} from "@opendaw/lib-std"

export interface FooterLabel extends Terminable {
    setTitle(value: string): void
    setValue(value: string): void
}