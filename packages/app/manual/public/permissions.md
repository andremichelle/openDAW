# Browser Permissions

## TLDR

Browsers only reveal the full list of audio devices once microphone access has been granted. That’s why openDAW needs to
request microphone permission before you can select inputs. We recommend allowing this access permanently when prompted,
as it makes working with openDAW much smoother.

## More Info

In all modern browsers, `navigator.mediaDevices.enumerateDevices()` will only list audio and video devices after the
user
grants permission—typically via a getUserMedia() call. Chrome, Safari, and Firefox have all adopted this behavior to
protect user privacy and reduce fingerprinting risks. Without permission, device names, IDs, or availability remain
hidden. This is how browsers are designed. Granting microphone access ensures openDAW can list
all connected audio devices properly.

[Lookup 'enumerateDevices'](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices)

## MIDI

openDAW asks for MIDI access when you learn a MIDI control, select a MIDI input or output, or open a project with learned
MIDI controls. If you declined it once, the browser remembers that and blocks MIDI on this website.

To allow it again:

* **Chrome / Edge**: Click the icon left of the address bar, set **MIDI devices** to **Allow** (or reset the permission),
  then reload the page.
* **Firefox**: Click the icon left of the address bar and remove the blocked MIDI permission, then reload the page.
  Firefox asks again and installs a small site permission add-on for openDAW.
* **Safari**: Safari does not support MIDI in the browser.
