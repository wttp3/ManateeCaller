const form = document.getElementById("signup-form");
const message = document.getElementById("form-message");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.hidden = true;

  const data = new FormData(form);
  const payload = {
    name: String(data.get("name") ?? ""),
    phone: String(data.get("phone") ?? ""),
    ageConfirmed: data.get("ageConfirmed") === "on",
    privacyAccepted: data.get("privacyAccepted") === "on",
    whatsappConsent: data.get("whatsappConsent") === "on",
    voiceConsent: data.get("voiceConsent") === "on",
  };

  try {
    const response = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error ?? "Signup failed");
    }
    const keyword = result.optInKeyword || "I'm in";
    message.textContent = result.delivery === "template"
      ? `You're in. Check WhatsApp for your invitation. Keep this participant ID for deletion requests: ${result.participantId}`
      : `You're in. Send "${keyword}" to the ManateeCaller WhatsApp number to start. We reply in that chat and do not message you first. Keep this participant ID for deletion requests: ${result.participantId}`;
    message.className = "message success";
    message.hidden = false;
    form.reset();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : "Signup failed";
    message.className = "message error";
    message.hidden = false;
  }
});
