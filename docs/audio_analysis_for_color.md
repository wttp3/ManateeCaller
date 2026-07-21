# Audio Processing for Colour Mapping

ManateeCaller MVP uses **transcript-based colour mapping**, not raw audio features.

## Flow

1. Download voice note from Meta Cloud API into a temp directory (`TEMP_AUDIO_DIR`).
2. Transcribe with ElevenLabs speech-to-text.
3. Store encrypted transcript temporarily in SQL Server until all three answers are collected.
4. Delete local temp file and call Meta media DELETE for the voice note.
5. When the interview completes, normalize and combine transcripts, compute colour, erase transcripts.

## Colour algorithm

```text
combined = normalize(q1) + "|" + normalize(q2) + "|" + normalize(q3)
color    = "#" + HMAC-SHA256(TILE_HMAC_KEY, combined).slice(0, 6)
```

Normalization: trim, lowercase, collapse whitespace.

## Retention

| Data | Retention |
|---|---|
| Raw audio (local temp) | Deleted immediately after transcription |
| Raw audio (Meta) | DELETE requested after download |
| Transcripts | Encrypted until tile created, then NULLed |
| Tile | Anonymous hex colour + public slug only |

## ElevenLabs retention

By default ElevenLabs retains STT inputs. Enable Zero Retention (`enable_logging=false`) only if your account supports it, then set `ELEVENLABS_ENABLE_ZERO_RETENTION=true`. Do not claim immediate third-party deletion without verifying this.

## Deferred

Pitch, loudness, tempo, and emotion-based mapping remain future work.
