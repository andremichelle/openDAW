import {Optional} from "@opendaw/lib-std"

export type TourSide = "above" | "below" | "left" | "right"
export type TourPlacement = TourSide | "center"
export type Rect = { x: number, y: number, width: number, height: number }
export type Size = { width: number, height: number }
export type CardLayout = { x: number, y: number, side: Optional<TourSide>, notch: number }

const Gap = 12
const Margin = 8
const NotchInset = 20

const Opposite: Record<TourSide, TourSide> = {above: "below", below: "above", left: "right", right: "left"}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

const spaceFor = (side: TourSide, anchor: Rect, viewport: Size): number => {
    switch (side) {
        case "above":
            return anchor.y
        case "below":
            return viewport.height - (anchor.y + anchor.height)
        case "left":
            return anchor.x
        case "right":
            return viewport.width - (anchor.x + anchor.width)
    }
}

const needed = (side: TourSide, card: Size): number =>
    (side === "above" || side === "below" ? card.height : card.width) + Gap + Margin

export const frameRect = (anchor: Rect, padding: number, viewport: Size): Rect => {
    const x = Math.max(Margin / 4, anchor.x - padding)
    const y = Math.max(Margin / 4, anchor.y - padding)
    return {
        x, y,
        width: Math.min(viewport.width - Margin / 4, anchor.x + anchor.width + padding) - x,
        height: Math.min(viewport.height - Margin / 4, anchor.y + anchor.height + padding) - y
    }
}

export const centerCard = (card: Size, viewport: Size): CardLayout => ({
    x: Math.round((viewport.width - card.width) / 2),
    y: Math.round((viewport.height - card.height) / 2),
    side: undefined,
    notch: 0
})

export const placeCard = (anchor: Rect, card: Size, viewport: Size, preferred: TourPlacement): CardLayout => {
    if (preferred === "center") {
        const maxX = Math.max(Margin, viewport.width - card.width - Margin)
        const maxY = Math.max(Margin, viewport.height - card.height - Margin)
        return {
            x: Math.round(clamp(anchor.x + (anchor.width - card.width) / 2, Margin, maxX)),
            y: Math.round(clamp(anchor.y + (anchor.height - card.height) / 2, Margin, maxY)),
            side: undefined,
            notch: 0
        }
    }
    const candidates: ReadonlyArray<TourSide> = [preferred, Opposite[preferred],
        ...(["below", "above", "right", "left"] as const).filter(side => side !== preferred && side !== Opposite[preferred])]
    const side = candidates.find(candidate => spaceFor(candidate, anchor, viewport) >= needed(candidate, card))
        ?? candidates.reduce((best, candidate) =>
            spaceFor(candidate, anchor, viewport) > spaceFor(best, anchor, viewport) ? candidate : best)
    const centerX = anchor.x + anchor.width / 2
    const centerY = anchor.y + anchor.height / 2
    const maxX = Math.max(Margin, viewport.width - card.width - Margin)
    const maxY = Math.max(Margin, viewport.height - card.height - Margin)
    if (side === "above" || side === "below") {
        const x = clamp(centerX - card.width / 2, Margin, maxX)
        const y = side === "below" ? anchor.y + anchor.height + Gap : anchor.y - card.height - Gap
        return {x: Math.round(x), y: Math.round(clamp(y, Margin, maxY)), side, notch: clamp(centerX - x, NotchInset, card.width - NotchInset)}
    }
    const y = clamp(centerY - card.height / 2, Margin, maxY)
    const x = side === "right" ? anchor.x + anchor.width + Gap : anchor.x - card.width - Gap
    return {x: Math.round(clamp(x, Margin, maxX)), y: Math.round(y), side, notch: clamp(centerY - y, NotchInset, card.height - NotchInset)}
}
