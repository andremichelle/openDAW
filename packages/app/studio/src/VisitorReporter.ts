import {Browser} from "@opendaw/lib-dom"

const API_URL = "https://api.opendaw.studio/users/visitor-counter.php"

// Report on every load. The server dedupes the id per day for the "unique visitors" metric and counts every
// POST for the raw "visitors" metric, so this one beacon feeds both. (Previously deduped once/day client-side,
// which made raw visits uncountable.)
export const reportVisitor = (): void => {
    navigator.sendBeacon(API_URL, JSON.stringify({id: Browser.id()}))
}
