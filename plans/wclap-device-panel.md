# WebCLAP device panel views

A WebCLAP plugin today shows its UI only in a floating window (`WclapWindows`), the device panel carries the
generic header, parameter tree and an "Open UI" button. Like an Apparat `@view` + `@window` pair, own plugins
should draw a compact view inside the device panel and open their big window from there. The same bundle must
run unchanged in every other CLAP host: nothing openDAW-specific may be required, everything must be ignored
by a host that does not know it.

## Today

1. **Host identity.** `clap_host.name` and `vendor` are "openDAW" (`wclap-bridge.ts:625`).
2. **One gui session per device.** `openGui` calls `clap.webview get_uri`, then `clap.gui create("webview",
   is_floating=0)`, `get_size`, `set_parent`, `show`, and sets `guiOpen` (`wclap-bridge.ts:181`). `closeGui`
   hides and destroys. `clap.webview send` and `clap.gui request_resize` are dropped while `guiOpen` is false.
3. **Host gui callbacks.** `request_show`, `request_hide` answer 0, `closed` and `resize_hints_changed` are empty
   (`wclap-bridge.ts:595`).
4. **Frame protocol.** The window loads `wclap-frame.html` on the plugin origin, the frame posts
   `wclap-frame-ready` with a `MessagePort`, the host answers `wclap-open {uuid, page, files}`. Plugin bytes go
   through `WclapGuis.register(uuid, receiver)`, one receiver per device (`WclapGuis.ts:7`).
5. **Descriptor features** are read at describe time (`wclap-bridge.ts:427`), known before the device editor is
   built.
6. **Plugin surface is 176px high.** The panel is 248px (`DevicePanel.sass:5`), minus the editors margin
   (0.25rem + 0.75rem), the container border (1px) and the device header (2rem) leaves 199px. Every device body
   uses `mixins.Control`: `height: 192px`, `padding: 0.5em 0.25em`, border-box, so 176px of content. That equals
   the stock grid of 3 × 3.5em rows + 2 × 0.25em gaps (`ScriptDeviceEditor.sass:15`), the height an Apparat
   `@view` spans. Devices grow in width.

## Design

### 1. Opt in: feature string

The plugin lists `"opendaw:device-panel"` in its descriptor features. CLAP allows vendor-prefixed features,
other hosts skip unknown ones. Without the feature nothing changes: generic editor, "Open UI" button, floating
window.

### 2. Plugin extension `opendaw.device-panel/1`

Plugin side, found with `plugin->get_extension`. Other hosts never ask for the id, the code stays unused there.

```c
typedef struct opendaw_plugin_device_panel {
    // panel page, same rules as clap.webview get_uri, returns the length or <= 0 for none
    int32_t (*get_uri)(const clap_plugin_t *plugin, char *uri, uint32_t capacity);
    // the width the view wants for the given panel height (logical pixels)
    bool (*get_width)(const clap_plugin_t *plugin, uint32_t height, uint32_t *width);
} opendaw_plugin_device_panel_t;
```

- `clap.webview get_uri` stays the big window, the page every host shows.
- The panel page may be the same page as the window, it learns where it lives from `wclap-open`
  (`placement: "panel" | "window"`). The panel height passed to `get_width` is the 176px surface, in logical pixels. Other hosts never send the field, the page falls back to its window layout.
- Feature present but extension missing: the panel shows the window page with `placement: "panel"`, width from
  `clap.gui get_size` scaled to the panel height.

### 3. Opening the big window

- The plugin calls the host's `clap.gui request_show`. openDAW answers 1 and opens the existing `WclapWindows`
  window (main thread, posted from the bridge like `requestGuiResize`). Other hosts read it as "show your
  window", the same meaning.
- `request_hide` closes it, `closed` is not used by the host.
- The header button "Open UI" stays as the fallback for plugins without a panel view.

### 4. One gui session, two frames

`clap.gui` and `clap.webview` know one UI per plugin instance. With panel and window open at the same time the
host keeps one session and multiplexes:

- **Session refcount.** `openGui` creates and shows on the first frame, `closeGui` destroys on the last.
  `guiOpen` becomes `frames > 0`.
- **Plugin to UI.** `WclapGuis` holds a set of receivers per device, every `clap.webview send` reaches every open
  frame.
- **UI to plugin.** Both frames feed `clap.webview receive`. The plugin sees one UI and keeps both pages in sync
  through the messages it sends back, which is what a plugin that broadcasts its state already does.
- **Size.** `clap.gui set_size` and `request_resize` belong to the window only. The panel size comes from
  `get_width`, it is not a clap.gui size.
- **Alternative**, if fan-out proves fragile: while the window is open the panel shows a placeholder, one frame
  at a time, no multiplexing. Decided after the first plugin.

### 5. Device editor

Two strategies, today everything sits in one block in `populateControls` (`WclapDeviceEditor.tsx:455`):

1. **Host strategy (today, unchanged).** Plugin box, Load Plugin, Update, Open UI, Parameters, Audio In, about
   text. Used with no plugin loaded, a failed load, and every plugin without `opendaw:device-panel`. Existing
   devices stay bit-identical.
2. **Panel strategy.** The 176px surface holds only the panel iframe (`wclap-frame.html`, same origin isolation,
   same frame protocol, `placement: "panel"`) at the width from `get_width`. Load Plugin, Update, Parameters and
   Audio In move into the `populateMenu` menu, Open UI and Update become header tools (`populateHeader`,
   `with-tools`). Used when the described plugin lists `opendaw:device-panel`.

Switching:

- The choice comes from `state.info.features`, known at describe time, not from the load status. While the plugin
  loads the panel strategy shows a placeholder at the panel width, no jump from the host layout to the panel.
- A failed load falls back to the host strategy, so the error and Load Plugin are visible.
- A `clapId` or `url` change (pick, Update, undo, Live Room peer) chooses again, the old strategy terminates
  completely, iframe included.
- One container in `populateControls` swaps its content, each strategy owns a `Terminator` under the editor
  lifecycle. `pluginMenu`, `parametersMenu` and `audioInMenu` are built once and shared, never duplicated.

Panel strategy details:
- The panel frame lives with the editor lifecycle, the window with the device, as `ScriptWindows`.
- Context menu, double-click, wheel, keys and `clap.param-hovered` work in the panel frame as in the window
  (`onFrameMessage` shared, not copied).
- A frame that moves in the DOM reloads (`reopen` in `WclapWindows`), the panel frame needs the same path.

## Steps

1. Extract the frame session out of `WclapWindows.open` (port, `onFrameMessage`, reopen) into one reusable unit,
   the window keeps working bit-identical. Test: window open, close, move.
2. Bridge: gui session refcount + `WclapGuis` receiver sets. Node test: two receivers get every send, the last
   close destroys.
3. Bridge: read the `opendaw:device-panel` feature, query `opendaw.device-panel/1`, `request_show` / `request_hide`
   posted to the main thread. Node test with a stub plugin.
4. `WclapDeviceEditor` panel frame + `placement` in `wclap-open`.
5. Reference plugin in open-webclap: a panel view with a "big view" button calling `request_show`, verified in
   openDAW and in one other CLAP host (window only, no errors).
6. Docs for plugin authors: the feature, the extension header, the `placement` field.

## Open

1. Fan-out (4) or placeholder while the window is open.
2. Panel width limits: the 176px height is fixed, may a view ask for any width?
3. Does the panel view also replace the generic header controls (bypass, menu stay), or sit below them?
