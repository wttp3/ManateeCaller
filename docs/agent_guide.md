# ManateeCaller WhatsApp Prompt Guide

Use a warm, calm tone — like a tide lapping at the mangroves.

## Phase 1 pilot

There is no approved `manatee_invite` template. A colleague opts in by sending the keyword (default **I'm in**) to the existing WhatsApp number. That message opens the customer-service window. Reply with the free-form session messages only. Template invites stay behind `WHATSAPP_TEMPLATE_INVITES_ENABLED`, which is off by default. Only numbers in `PILOT_ALLOWED_SENDERS` are answered.

## Invitation template (only when template invites are enabled)

> Hi {{1}}, this is ManateeCaller — a small opt-in art experiment for manatee lovers. Tap **I'm in** to begin a short voice-note interview on WhatsApp. Reply STOP any time to opt out.

## After opt-in

> Welcome to ManateeCaller. We'll ask three short questions — please reply to each with a voice note. Your answers become one anonymous colour in our shared mosaic. Reply STOP any time to opt out.

## Questions

1. What colour does a calm manatee morning feel like to you? Reply with a voice note.
2. Tell us about a gentle moment you want to float with today. Reply with a voice note.
3. If your voice were a ripple in still water, what would it say? Reply with a voice note.

## Wrong media

> Please reply with a voice note for this question. Text and other media can't be used for your tile.

## Completion

> Thank you for floating with us. Your tile is now part of the mosaic: {{mosaic_url}}

## Opt-out (`STOP`)

`STOP`, `unsubscribe`, `cancel`, and `opt out` opt the sender out in every state. Ignore case and extra spaces.

> You've been unsubscribed from ManateeCaller. We won't message you again.

Send that confirmation only when this request is the one that opts them out and the 24-hour window is still open. Cancel pending invites and jobs, including jobs that only name the session id. Do not send anything else. A later opt-in keyword can opt them back in. Do not let a late job or outbox write change `opted_out`, `cancelled`, or an erased row.

## Erasure

The sender can text `DELETE MY DATA` (or `ERASURE_KEYWORD`). Delete WhatsApp media for their audio ids first (best effort), then their participant, consents, sessions, transcripts, and audio references. Anonymise their mosaic tile and remove their webhook rows. Also delete jobs that only name the session id. Confirm once if the window is open. The erasure token blocks template invites and other outbound contact we start. An inbound opt-in keyword is fresh consent and starts a new participant:

> Your ManateeCaller data has been deleted. We won't message you again.
