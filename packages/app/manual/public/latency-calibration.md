# Latency Calibration

Measure how long your own setup takes from the sound leaving openDAW until it comes back through your input, so recordings land exactly in time.

---

## Why measure

When you record, openDAW shifts every take by the time your audio needs to travel out and back in. The browser only reports part of it.

- **The output part** is reported, but often wrong. Bluetooth headphones and speakers are the worst case: the browser may report 90 ms where the real delay is 300 ms.
- **The input part** is not reported at all.

A measurement replaces both numbers with the real one. Takes recorded afterwards sit on the beat, also with Bluetooth outputs.

## Setting it up

The measurement plays three short noise bursts and listens for them on the input. The input therefore has to hear the output while it runs.

- **Laptop speakers and built-in microphone**: works as it is. Keep the room reasonably quiet.
- **Headphones**: hold one ear cup against the microphone.
- **Audio interface**: connect an output to an input with a cable, or put the microphone in front of the monitors.
- **Instrument inputs** (a guitar into a DI input, for example): connect an output of the interface to that input for the measurement.

If the input cannot hear the output, openDAW tells you so and changes nothing.

## Running it

1. Stop playback.
2. Open the menu of the audio track you record on, and choose **Capture Audio** and then **Measure Latency...**
3. Click **Measure**. You hear three bursts of noise, about three seconds in total.
4. openDAW shows the measured round trip. From then on, the menu shows it next to **Measure Latency...**

The result belongs to this browser and to this pair of output and input device at the current sample rate. It does not travel with the project.

## When to measure again

- After you switch the output or the input device, including plugging in headphones
- After you change the sample rate of your audio device
- When recorded takes start to sound early or late

Measuring again replaces the earlier result for the same devices.

## What it does not change

- **Your own input latency setting on a track** takes priority. Leave it on "inherit" to use the measurement.
- **MIDI recording** is not affected. MIDI notes are placed by the browser's own clock for what you heard, which a round trip cannot correct.
- **Monitoring** keeps its delay. To play along without any delay, use the direct monitoring of your audio interface.
