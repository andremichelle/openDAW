# Neural Amp

AI-powered amplifier and effects modeling using [Neural Amp Modeler](https://www.neuralampmodeler.com/) technology.

---

![screenshot](neural-amp.webp)

---

## 0. Overview

_Neural Amp_ uses machine learning to recreate the sound of real amplifiers, pedals, and other analog gear with remarkable accuracy. It loads NAM model files that capture the complete tonal character of the original equipment.

Example uses:

- Guitar amp simulation without physical hardware
- Recreating vintage or boutique amp tones
- Adding realistic drive and saturation
- Processing any audio through amp-like coloration

---

## 1. Loading Models

### 1.1 Browse Button

Click the folder icon to open a file browser and select a NAM model file (`.nam` extension). The model name will appear in the display area.

### 1.2 Model Info

Click the info button (ⓘ) to view detailed metadata about the loaded model, including:

- Model name and author
- Captured gear information
- Training parameters
- Architecture details

### 1.3 Model Sources

NAM models can be found on community sites like [ToneHunt](https://tonehunt.org) and [TONE3000](https://tone3000.com). Models are typically captures of real amplifiers, pedals, or complete signal chains.

---

## 2. Controls

### 2.1 Input

**Range: -∞ to +12 dB**

Adjusts the signal level entering the neural network. Higher input levels drive the model harder, producing more saturation and compression—similar to turning up the gain on a real amp.

- **Negative values**: Clean, headroom-preserving tones
- **0 dB**: Unity gain input
- **Positive values**: Increased drive and saturation

### 2.2 Mix

**Range: 0% to 100%**

Blends the processed (wet) signal with the original (dry) signal.

- **0%**: Fully dry (bypassed)
- **50%**: Equal blend of dry and wet
- **100%**: Fully wet (processed only)

Use partial mix settings for parallel processing effects.

### 2.3 Output

**Range: -∞ to +12 dB**

Adjusts the final output level after processing. Use to match levels with bypassed signal or compensate for loud/quiet models.

### 2.4 Mono

When enabled, sums the stereo input to mono before processing through a single neural network instance. The mono output is then sent to both channels.

When disabled, left and right channels are processed independently through separate neural network instances, preserving stereo information but doubling CPU usage.

---

## 3. Spectrum Display

The top section shows a real-time frequency spectrum of the output signal:

- **Horizontal axis**: 20 Hz to 20 kHz (logarithmic scale)
- **Vertical axis**: -60 dB to -3 dB
- **Blue fill**: Current frequency content with gradient fade

The spectrum helps visualize the tonal character of different models and how the Input control affects harmonic content.

---

## 4. Technical Notes

- Uses WebAssembly-compiled NAM engine for efficient processing
- Models are loaded and processed entirely in the browser
- Stereo mode runs two independent neural network instances
- Supports standard NAM model format (.nam JSON files)
- Real-time coefficient updates without audio glitches
- Sample-rate adaptive processing

---

## 5. Tips

### 5.1 Gain Staging

Start with Input at 0 dB and adjust based on your source signal. Guitar DI signals often benefit from +6 to +12 dB of input gain to properly drive amp models.

### 5.2 CPU Usage

Enable Mono mode when stereo processing isn't needed—it halves CPU usage. This is especially helpful when using multiple Neural Amp instances.
