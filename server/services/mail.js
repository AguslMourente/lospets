// server/services/mail.js
require("dotenv").config();

async function sendReportEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    // modo dev
    console.log("EMAIL DEV >>>", { to, subject });
    return { dev: true };
  }
  const { Resend } = require("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: process.env.FROM_EMAIL || "notificaciones@example.com",
    to,
    subject,
    html,
  });
  return { ok: true };
}

module.exports = { sendReportEmail };
