<p align="center">
  <img src="public/manateecaller_logo.svg" width="200" alt="ManateeCaller Logo"/>
</p>

<p align="center">
  <img src="badges/manatee_love.svg" alt="Made for Manatee Lovers" width="162"  />
  <img src="badges/zero_props.svg" alt="Zero Propellers Since 2024" width="202"/>
</p>

# 🧜 ManateeCaller

**ManateeCaller** is an opt-in **WhatsApp voice-note art experiment** for **manatee lovers and enthusiasts**. People sign up, explicitly agree to be contacted on WhatsApp, and answer a few gentle questions with voice notes. Each response becomes a single anonymous **colour tile** in a growing, shared mosaic — a sea of voices, no two the same.

> This is a rework of the original cold-call concept. Instead of ringing strangers, ManateeCaller is **consent-first and asynchronous**: nobody is contacted without opting in, and raw audio is deleted as soon as its tile is made.

---

## 🌊 How It Works

1. **Sign up.** A participant enters their name and WhatsApp number on a mobile-friendly page, confirms they're 16+, reads the privacy notice, and gives explicit consent to be interviewed on WhatsApp.
2. **Invitation.** We send one approved WhatsApp template that identifies ManateeCaller and offers a clear way out. Tapping "I'm in" opens the conversation.
3. **The interview.** A short, friendly chat asks 2–3 questions. The participant replies with a **voice note** to each.
4. **Voice → colour.** Each voice note is transcribed (via ElevenLabs), hashed into a deterministic hex colour, and turned into a tile. **The raw audio is then deleted.**
5. **The mosaic.** Tiles appear anonymously in a public mosaic — colour only, no names, no numbers, no playback.

```mermaid
flowchart LR
    Signup[Signup + Consent] --> Invite[WhatsApp Template]
    Invite --> Interview[Voice-Note Interview]
    Interview --> Process[Transcribe + Colour]
    Process --> Delete[Delete Raw Audio]
    Process --> Mosaic[Anonymous Mosaic]
```

---

## 🔒 Privacy & Consent (UK/EU)

ManateeCaller is designed for UK/EU participants and treats every voice note as personal data.

- **Explicit, recorded consent** is collected at signup, with a timestamp and the exact wording shown.
- **Two consents are kept distinct:** consent to be contacted on WhatsApp, and consent for voice recording/processing.
- **Data minimisation:** we keep only the derived tile data. Raw audio is deleted immediately after a tile is generated; phone numbers are stored privately and never appear in artwork.
- **Rights & opt-out:** `STOP` suppresses further messages, and participants can withdraw consent or request deletion at any time.
- A DPIA and privacy notice (controller identity, lawful basis, retention, contact route) ship as scaffolding for legal review before any real-world pilot.

---

## 🛠️ Tech Stack

- **Node.js / TypeScript / Express**
- **Meta WhatsApp Business Cloud API** (messaging, media, webhooks)
- **ElevenLabs** speech-to-text
- **PostgreSQL** for participants, consents, sessions, and tiles
- **HTML/CSS** signup + anonymous mosaic

---

## 📦 Setup & Run Locally

### Requirements

- Node.js 18+
- PostgreSQL 14+
- A Meta WhatsApp Business app (the **test number** is enough to build and pilot)
- An ElevenLabs API key
- A tunnel (e.g. ngrok) to receive Meta webhooks locally

### .env File

```
PORT=3000
DATABASE_URL=postgres://user:pass@localhost:5432/manateecaller

# Meta WhatsApp Cloud API
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_APP_SECRET=...
WHATSAPP_WEBHOOK_VERIFY_TOKEN=...
WHATSAPP_TEMPLATE_NAME=manatee_invite

# ElevenLabs
ELEVENLABS_API_KEY=...

# Encryption key for phone numbers at rest (32-byte hex)
DATA_ENCRYPTION_KEY=...
```

### Install & Run

```bash
npm install
npm run migrate
npm start
```

---

## 🗺️ Roadmap

### ✅ MVP (invitation-only pilot)

- [ ] Signup page with dual consent + age gate
- [ ] Meta Cloud API messaging, webhooks, and media download
- [ ] Interview state machine (ordered prompts, retries, opt-out)
- [ ] Transcribe → deterministic hex colour → tile
- [ ] Delete raw audio after processing
- [ ] Anonymous public mosaic

### 🧪 Later

- [ ] Richer audio-driven colour (pitch/loudness) with ffmpeg + meyda
- [ ] Background queue/worker for processing at volume
- [ ] Full WhatsApp Business verification + higher messaging tier
- [ ] Downloadable / shareable mosaic snapshots

### 🐚 Deferred

- WhatsApp **voice calls** (requires Meta Calling eligibility + SIP/WebRTC) — revisit only if demand justifies it.

---

## 📄 License

MIT – Use freely, remix boldly.
