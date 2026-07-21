export const CONSENT_TEXT_VERSION = "2026-07-21-v1";

export const WHATSAPP_CONTACT_CONSENT =
  "I agree that ManateeCaller may contact me on WhatsApp for the voice-note interview.";

export const VOICE_PROCESSING_CONSENT =
  "I agree that my voice notes will be transcribed to create an anonymous colour tile. Raw audio will be deleted after processing.";

export const PRIVACY_NOTICE_SUMMARY =
  "ManateeCaller collects your name and WhatsApp number to run an opt-in interview. Voice notes are transcribed, converted to a colour, and deleted. See /privacy.html for full details.";

export const INTERVIEW_QUESTIONS = [
  "What colour does a calm manatee morning feel like to you? Reply with a voice note.",
  "Tell us about a gentle moment you want to float with today. Reply with a voice note.",
  "If your voice were a ripple in still water, what would it say? Reply with a voice note.",
] as const;

export const PROMPTS = {
  intro:
    "Welcome to ManateeCaller — a small art experiment. We'll ask three short questions. Please reply to each with a voice note. Your answers become one anonymous colour in our shared mosaic. Reply STOP any time to opt out.",
  wrongMedia:
    "Please reply with a voice note for this question. Text and other media can't be used for your tile.",
  optOut: "You've been unsubscribed from ManateeCaller. We won't message you again. Reply START if you change your mind.",
  complete: (slug: string, baseUrl: string) =>
    `Thank you for floating with us. Your tile is now part of the mosaic: ${baseUrl}/mosaic.html#${slug}`,
  expired:
    "This interview session has expired. Visit our signup page if you'd like to begin again.",
  alreadyComplete: "You've already completed your tile. View the mosaic on our website.",
} as const;

export type InterviewState =
  | "pending_invite"
  | "invited"
  | "awaiting_opt_in"
  | "intro_sent"
  | "awaiting_voice_q1"
  | "awaiting_voice_q2"
  | "awaiting_voice_q3"
  | "processing"
  | "complete"
  | "opted_out"
  | "expired";

export function nextStateAfterOptIn(current: InterviewState): InterviewState {
  if (current === "awaiting_opt_in" || current === "invited") {
    return "intro_sent";
  }
  return current;
}

export function stateAfterIntroSent(): InterviewState {
  return "awaiting_voice_q1";
}

export function stateAfterVoiceAnswer(
  current: InterviewState,
  questionIndex: number,
): InterviewState {
  if (questionIndex >= INTERVIEW_QUESTIONS.length - 1) {
    return "processing";
  }
  const nextIndex = questionIndex + 1;
  return (`awaiting_voice_q${nextIndex + 1}` as InterviewState);
}

export function questionIndexForState(state: InterviewState): number | null {
  const match = state.match(/^awaiting_voice_q(\d+)$/);
  return match ? Number(match[1]) - 1 : null;
}

export function promptForState(state: InterviewState): string | null {
  const index = questionIndexForState(state);
  if (index === null) {
    return null;
  }
  return INTERVIEW_QUESTIONS[index] ?? null;
}
