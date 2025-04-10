# 🎧 Audio Analysis for Color Mapping in ManateeCaller

In **ManateeCaller**, we're evolving from simple transcript-to-color conversion to a **rich, audio-driven mosaic generation system**. This document outlines how we can analyze recorded speech to influence color output and make each tile in the mosaic more uniquely expressive.

---

## 🧠 Why Go Beyond Transcripts?

Transcripts reduce human voice to words, but voices contain *emotion, tone, rhythm*, and *texture*. By analyzing these attributes, we can create tiles that reflect not just *what* was said — but *how* it was said.

---

## 🎛️ Audio Metrics → Color Mapping

| Audio Metric         | What It Represents          | Mapped To Color As...       |
|----------------------|-----------------------------|-----------------------------|
| Pitch                | Voice tone/frequency        | Hue                         |
| Loudness             | Volume/energy               | Brightness                  |
| Tempo / Speech Rate  | Calm vs urgency             | Saturation                  |
| Duration             | Length of spoken segment    | Tile size / transparency    |
| Timbre (tone quality)| Raspy vs smooth             | Texture (future animation?) |
| Emotion (AI)         | Mood or sentiment           | Palette or color category   |

---

## 🛠️ Node.js Tools & Libraries

### 🔊 For Basic Audio Features

- **[ffmpeg](https://ffmpeg.org/)** – Extract raw audio features like duration, volume
- **[fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg)** – Node wrapper for ffmpeg
- **[get-audio-duration](https://www.npmjs.com/package/get-audio-duration)** – Simple duration checker

### 🎵 For Audio Analysis

- **[meyda](https://github.com/meyda/meyda)** – JS audio feature extractor (pitch, spectral features)
- **[audiowaveform](https://github.com/bbc/audiowaveform)** – Optional waveform data generator (C++)

### 🧠 For AI-driven Emotion

- Use cloud APIs:
  - **Google Cloud Speech-to-Text**
  - **Azure Emotion Detection**
  - **AssemblyAI / Whisper API** (combined emotion + transcript)

---

## 🧪 Implementation Flow

1. **Download audio file** from Twilio’s webhook (`RecordingUrl`)
2. **Save temporarily to disk or buffer**
3. **Extract features** via local or API tools
4. **Generate HSL/HEX values** based on:
   ```js
   hue = pitchToHue(pitch);
   saturation = volumeToSaturation(volume);
   lightness = tempoToLightness(speechRate);
   hexColor = hslToHex(hue, saturation, lightness);
   ```
5. **Send tile info** to frontend

---

## 🐚 Bonus Ideas

- Animate tiles with pulsing rhythm based on tempo
- Add audio waveform trace or glow around voice prints
- Let users click a tile and play back the original voice

---

## 📦 Suggested NPM Modules

```bash
npm install fluent-ffmpeg get-audio-duration meyda
```

---

## 🧪 MVP Integration Plan

- [ ] Store Twilio audio file
- [ ] Extract pitch/loudness/tempo
- [ ] Generate HSL → convert to HEX
- [ ] Return tile color in `/transcript-webhook`
- [ ] Display tile in mosaic

---

Let’s make the sea of voices feel alive — one ripple at a time.
