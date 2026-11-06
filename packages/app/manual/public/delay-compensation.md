# Delay Compensation

What the PDC number in the footer means, and what happens when a device needs more than 100 ms.

---

## What is delay compensation?

Some devices cannot answer a sample right away. A look-ahead limiter looks at audio that has not been played yet, Autotune needs a buffer of the voice before it can shift the pitch, and an FFT needs a full window before it can transform it. These devices output their audio later than it came in.

Without help, a track with such a device would play late against the rest of the mix. openDAW measures how late every path through the mixer is and delays all the other paths by the same amount, so everything meets in time at the master. This is called plugin delay compensation, PDC for short.

Devices that add delay include:

- Maximizer and Compressor with look-ahead
- Autotune
- Fold
- Werkstatt and Apparat scripts that declare `// @latency`
- WebCLAP plugins that report a latency

## The PDC number in the footer

The footer shows **PDC** whenever the project contains a delaying device. The number is how far the whole mix is delayed so that every path lines up. The footer hides it when it is zero.

This delay is the same for everything you hear, so the mix stays in time with itself. openDAW also accounts for it in every place where timing matters:

- Recorded takes land where you played them
- Mixdowns and stems start in time
- The metronome clicks in time with the delayed mix
- Automation on devices after a delaying device follows its delayed audio

What you notice is that playing live through a track feels this much later, on top of the output latency of your audio device (see [Latency](/manuals/latency)). It does not matter for playback, mixing or exports.

## The 100 ms limit

openDAW compensates up to **100 ms** per path. If a path needs more, for example a script that declares `// @latency 150`, the other paths are delayed by the full 100 ms and no more. That path then plays later than the rest of the mix by whatever exceeds the limit. In the example, that is 50 ms.

When this happens:

- The footer shows the delay the mix actually gets, 100 ms in the example, in orange
- A note above the footer says that delay compensation is capped
- The Signal Graph page marks the path that exceeds the limit

The note goes away as soon as no path needs more than 100 ms.

## How to stay below the limit

- Use smaller settings on the delaying device. A smaller FFT window or a shorter look-ahead needs less delay
- Avoid chaining several delaying devices on one track, because their delays add up
- Check that a script's `// @latency` matches what it really needs

Why a limit at all? Every compensated path keeps a delay buffer. More delay also means that playing live through a track feels later. 100 ms is already far more than a look-ahead limiter or a pitch tracker needs.
