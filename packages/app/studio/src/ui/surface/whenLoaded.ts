// A new window is usable once its document is complete. The desktop app routes resizeBy, dragging and closing of its
// windows through the shell, set up after the document loaded (popout_script in main.rs): it waits for that too.
export const whenLoaded = (owner: WindowProxy, shell: boolean): Promise<boolean> => new Promise(resolve => {
    const check = () => {
        if (owner.closed) {
            resolve(false)
        } else if (owner.location.href !== "about:blank" && owner.document.readyState === "complete"
            && (!shell || typeof owner.__shellClose__ === "function")) {
            resolve(true)
        } else {
            setTimeout(check, 10)
        }
    }
    check()
})
