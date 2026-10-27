# Device Browser

The Device Browser is one dialog for everything that goes into a track: stock devices, presets, community scripts and
WebCLAP plugins. It lists only what fits the place you opened it for, and every pick is created right away, so you hear
it before you decide.

## Opening it

* **+ in the device panel** sits at every place an effect can go: in front of the first MIDI effect, after each MIDI
  effect, after the instrument and after each audio effect. The browser then lists effects for exactly that place.
* **Replace…** in the context menu of a device header swaps that device. The current device is preselected.
* **Add Instrument…** in the timeline creates a new track. You find it in the **+** menu next to the snap setting, below
  the last track and in the empty device panel. The new track appears right below the track you are editing.

**Add Audio Track** next to it creates a Tape track straight away, without the browser.

## Trying and keeping

* **A click** on an entry creates it, or replaces the device you opened the browser for. The next click undoes the
  previous pick first, so only one candidate is ever there.
* **↑** and **↓** pick the previous or next entry the same way
* **Enter** or **Ok** keeps the current pick and closes the browser. It becomes one undo step.
* **Escape** or **Cancel** removes the pick and restores everything as it was before opening
* **Space** starts and stops playback, so you can listen while picking. In the search field it types a space once you
  started typing.

If a picked instrument preset carries a timeline and the track already has one, openDAW asks once when you keep it
whether the timeline should be replaced.

## Playing notes

When the picked device can receive notes, a piano sits under the list. Click its keys, or play your MIDI keyboard. The
track is armed while the browser is open and returns to its previous state when it closes. The {icon:Midi} button in
the footer asks for MIDI access when it is not granted yet, see [Connect MIDI Device](/manuals/connect-midi-device).

This works for effects on instrument tracks too: the notes play the instrument and run through the MIDI effects, so you
hear what the effect does.

## Filters and search

The toggles above the list choose what is shown:

* **Cloud folder** shows what comes from openDAW: stock presets, community scripts and cloud WebCLAP plugins
* **User folder** shows what is stored on this device: your presets and imported WebCLAP plugins
* **Folder**, **Code** and **WebCLAP** show or hide presets, community scripts and WebCLAP plugins. Stock devices are
  always listed.

The search matches names, descriptions and tags. A click on a tag in the info card puts it into the search.

## The info card

The card on the right describes the selected entry: what it is, the device it runs on, author, license and tags. For
your own presets it also offers **Edit…** (name, description and tags), **Duplicate**, **Delete** and **Save to
Disk…**.

## Racks and Chains

* **Racks** are complete audio units. Picked for a new track, the rack creates it with its instrument, effects and
  mixer settings. Picked through **Replace…** on an instrument, the rack takes over the instrument and all effects of
  the track, the notes and regions stay. Racks are not offered inside a composite layer.
* **Chains** are listed at the **+** buttons of their kind, audio or MIDI. All effects of the chain go in at that
  place. Through **Replace…** on an effect, the chain takes the place of that one effect.

Both are presets, so the **Folder** toggle shows or hides them and the search finds them by `rack` and `chain`.
