import {Browser} from "@moises-ai/lib-dom"

const API_URL = "https://api.opendaw.studio/users/visitor-counter.php"
const STORAGE_KEY = "visitor-reported-date"

export const reportVisitor = (): void => {
    const today = new Date().toISOString().slice(0, 10)
    if (localStorage.getItem(STORAGE_KEY) === today) return
    localStorage.setItem(STORAGE_KEY, today)
    navigator.sendBeacon(API_URL, JSON.stringify({id: Browser.id()}))
}
