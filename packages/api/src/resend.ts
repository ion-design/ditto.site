export type SendSignupEmailInput = {
  apiKey: string;
  from: string;
  to: string;
  verifyUrl: string;
  expiresAt: Date;
};

export async function sendSignupEmail(input: SendSignupEmailInput): Promise<void> {
  const expires = input.expiresAt.toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const text = [
    "Your ditto.site API key is almost ready.",
    "",
    `Open this link to verify your email and reveal your key: ${input.verifyUrl}`,
    "",
    `This link expires at ${expires} UTC.`,
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  const html = `
    <div style="font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.55;color:#0e2a3d">
      <h1 style="font-size:22px;margin:0 0 12px">Your ditto.site API key is almost ready.</h1>
      <p>Open the link below to verify your email and reveal your key.</p>
      <p><a href="${input.verifyUrl}" style="display:inline-block;background:#14b3ad;color:#06251f;padding:12px 16px;text-decoration:none;font-weight:700;border:2px solid #0f2c40">Verify and get key</a></p>
      <p style="color:#3c5b6a;font-size:14px">This link expires at ${expires} UTC.</p>
      <p style="color:#3c5b6a;font-size:14px">If you did not request this, you can ignore this email.</p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: input.from,
      to: input.to,
      subject: "Verify your ditto.site API key",
      text,
      html,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${detail.slice(0, 500)}`);
  }
}
