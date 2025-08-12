// File: server.js

// ─── Imports & Configuration ──────────────────────────────────────────────────
import 'dotenv/config';
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import PDFDocument from "pdfkit";
import fs from "fs";
import Stripe from "stripe";
import OpenAI from "openai";
import dotenv from "dotenv";
import { makePrompt } from "./prompt.js";
import path from "path";
import { fileURLToPath } from "url";

// —— ESM __dirname shim ————————————————————————————————————————————————
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: "*", credentials: true }));

// ─── 1. Stripe Checkout Endpoint ───────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
app.post("/api/checkout", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price: 'price_1RsQJUAhLaqVN2Rssepup9EE',
        quantity: 1
      }],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).send("Stripe error");
  }
});

// ─── 2. Plan Generation Endpoint ────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.post("/api/generate-plan", async (req, res) => {
  try {
    const {
      sessionId, daysPerWeek, equipment, injuries, experience,
      goal, dislikes, focusMuscle, age, sex, bodyweight, lifts
    } = req.body;

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return res.status(402).send("Payment required");
    }

    const prompt = makePrompt({
      daysPerWeek, equipment, injuries, experience,
      goal, dislikes, focusMuscle, age, sex, bodyweight, lifts
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 4500,
      messages: [{ role: "user", content: prompt }]
    });

    res.json({ plan: completion.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).send("Plan generation error");
  }
});

// ─── 3. Improved PDF Generation Function ────────────────────────────────────────
function generateEnhancedPDF(planText, userProfile = {}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 50, bottom: 50, left: 50, right: 50 }
  });
  const { width, height } = doc.page;

  // Typography styles
  const styles = {
    heading1: { font: 'Helvetica-Bold', size: 24, color: '#2563eb' },
    heading2: { font: 'Helvetica-Bold', size: 18, color: '#1f2937' },
    body:     { font: 'Helvetica',      size: 12, color: '#1f2937', lineGap: 5 },
    small:    { font: 'Helvetica',      size: 9,  color: '#6b7280' }
  };

  function applyStyle(style) {
    doc.font(style.font)
       .fontSize(style.size)
       .fillColor(style.color);
  }

  function rule() {
    doc.moveDown(0.5);
    doc.strokeColor('#e5e7eb')
       .lineWidth(0.5)
       .moveTo(doc.x, doc.y)
       .lineTo(width - doc.page.margins.right, doc.y)
       .stroke();
    doc.moveDown(0.5);
  }

  // ─── Cover Page ──────────────────────────────────────────────────────────────
  applyStyle(styles.heading1);
  doc.text('Your Personal 6-Week BroSplit Journey', { align: 'center' });
  doc.moveDown(1);
  applyStyle(styles.body);
  const name = userProfile.name || 'Champion';
  doc.text(`Hey ${name}! Welcome to your transformation.`, {
    align: 'center', lineGap: styles.body.lineGap
  });
  doc.moveDown(2);

  // Logo
  const logoPath  = path.join(__dirname, 'assets', 'BroSplitLogo.png');
  const logoWidth = 250;
  const logoX     = (width - logoWidth) / 2;
  const logoY     = (height / 2) - (logoWidth / 2);
  try {
    const logoBuffer = fs.readFileSync(logoPath);
    doc.image(logoBuffer, logoX, logoY, { width: logoWidth });
  } catch (err) {
    console.warn('⚠️ Could not load logo:', err.message);
  }

  doc.addPage();

  // ─── Table of Contents ───────────────────────────────────────────────────────
  applyStyle(styles.heading2);
  doc.text('Table of Contents', { align: 'left' });
  doc.moveDown(0.5);
  applyStyle(styles.body);
  [
    'Cover Page', 'Introduction', 'Pro Tips',
    'Week 1', 'Week 2', 'Week 3',
    'Week 4', 'Week 5', 'Week 6', 'Footer'
  ].forEach((item, i) => doc.text(`${i+1}. ${item}`));
  doc.addPage();

  // ─── Pro Tips Section ───────────────────────────────────────────────────────
  applyStyle(styles.heading2);
  doc.text('Ready to Get Started?');
  rule();
  applyStyle(styles.body);
  [
    'Progressive Overload: Aim to add a little more each week.',
    'Recovery Matters: 7-9 hours of sleep for muscle growth.',
    'Nutrition: 0.8-1g protein per lb bodyweight.',
    'Track Progress: Log workouts and celebrate wins.',
    'Form Over Ego: Quality reps beat heavy sloppy reps.'
  ].forEach(tip => doc.text(`• ${tip}`, { indent: 20 }));
  doc.addPage();

  // ─── Parse and Render Weeks ──────────────────────────────────────────────────
  const lines = planText.replace(/\*\*/g, '').split(/\r?\n/).map(l => l.trim());
  const weeks = [];
  let currentWeek = null, currentDay = null;
  lines.forEach(line => {
    if (!line) return;
    const w = line.match(/^Week\s+(\d+)/i);
    const d = line.match(/^Day\s+\d+/i);
    if (w) {
      currentWeek = { number: +w[1], days: [] };
      weeks.push(currentWeek);
    } else if (d && currentWeek) {
      currentDay = { name: line, exercises: [] };
      currentWeek.days.push(currentDay);
    } else if (currentDay && /:/.test(line)) {
      currentDay.exercises.push(line);
    }
  });

  weeks.slice(0, 6).forEach(week => {
    applyStyle(styles.heading2);
    doc.text(`Week ${week.number}`);
    rule();
    week.days.forEach(day => {
      applyStyle(styles.heading1);
      doc.text(day.name);
      applyStyle(styles.body);
      day.exercises.forEach(ex => doc.text(`• ${ex}`, { indent: 20 }));
      doc.moveDown(1);
    });
    doc.addPage();
  });

  // ─── Footer Page ─────────────────────────────────────────────────────────────
  applyStyle(styles.heading2);
  doc.text('Ready to Get Started?');
  rule();
  applyStyle(styles.body);
  doc.text(
    "This plan was crafted for YOU. Consistency is key. Track photos, log workouts, and don't skip recovery. Let's crush it!",
    { width: width - 100 }
  );

  // ─── Page Numbering ──────────────────────────────────────────────────────────
  doc.flushPages();
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    applyStyle(styles.small);
    doc.text(`Page ${i+1} of ${range.count}`, 0, doc.page.height - 40, { align: 'center' });
  }

  doc.end();
  return doc;
}

// ─── 4. Email Endpoint using Resend ────────────────────────────────────────────
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

// Branded, mobile‑friendly email with inline logo + plain‑text fallback
async function sendWorkoutPlanWithResend(email, plan, userProfile = {}) {
  // 1) Generate the PDF buffer (with clear errors if it fails)
  let pdfBuffer;
  try {
    const doc = generateEnhancedPDF(plan, userProfile);
    pdfBuffer = await new Promise((resolve, reject) => {
      const bufs = [];
      doc.on('data', c => bufs.push(c));
      doc.on('end', () => resolve(Buffer.concat(bufs)));
      doc.on('error', reject);
    });
  } catch (err) {
    console.error('❌ PDF generation failed:', err);
    throw new Error('Failed to generate PDF');
  }

  // 2) Try to inline your logo so it appears even if remote images are blocked
  let logoDataUri = '';
  try {
    const logoPath = path.join(__dirname, 'assets', 'BroSplitLogo.png');
    const logoBase64 = fs.readFileSync(logoPath).toString('base64');
    logoDataUri = `data:image/png;base64,${logoBase64}`;
  } catch (e) {
    console.warn('⚠️ Could not inline logo, sending email without it:', e.message);
  }

  // 3) Branding + content
  const brand = {
    bg: '#ffffff',
    panel: '#f8fafc',
    text: '#1f2937',
    subtext: '#4b5563',
    accent: '#ff6b6b',
  };
  const instagramURL = 'https://www.instagram.com/brosplitai/profilecard/?igsh=NTc4MTIwNjQ2YQ==';
  const preheader = 'Your 6‑Week BroSplit training plan is attached as a PDF. Save it to your phone or print it.';

  const html = `
  <div style="background:${brand.panel};padding:16px 0;">
    <div style="max-width:620px;margin:0 auto;background:${brand.bg};border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
      <span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;visibility:hidden;">${preheader}</span>
      <div style="text-align:center;background:${brand.accent};padding:18px;">
        ${logoDataUri
          ? `<img src="${logoDataUri}" alt="BroSplit" style="max-width:140px;height:auto;display:block;margin:0 auto 6px;" />`
          : `<h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;letter-spacing:.3px;">BROSPLIT</h1>`}
        <div style="color:#fff;font-size:18px;font-weight:700;letter-spacing:.2px;margin-top:6px;">Your 6‑Week Plan</div>
      </div>
      <div style="padding:24px 22px;color:${brand.text};line-height:1.55;">
        <p style="margin:0 0 12px;">Your personalized <strong>6‑Week BroSplit Training Plan</strong> is attached as a PDF.</p>
        <p style="margin:0 0 18px;color:${brand.subtext};">Inside you’ll find your weekly split, sets & reps, and pro tips. Save it to your phone or print it for the gym.</p>
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:18px 0;">
          <div style="font-weight:700;margin-bottom:10px;">Next steps (60 seconds):</div>
          <ol style="padding-left:18px;margin:0;color:${brand.text};">
            <li>Open the attached <strong>BroSplit‑Plan.pdf</strong>.</li>
            <li>Save it to Files / Google Drive (or print).</li>
            <li>Start <strong>Day 1</strong> today — no excuses.</li>
          </ol>
        </div>
        <div style="text-align:center;margin:22px 0 8px;">
          <a href="https://brosplit.org" target="_blank"
             style="display:inline-block;background:${brand.accent};color:#fff;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:10px;">
            Open BroSplit.org
          </a>
        </div>
        <p style="margin:18px 0 8px;color:${brand.subtext};font-size:14px;">
          Questions or feedback? Reply to this email or DM us on IG:
          <a href="${instagramURL}" target="_blank" style="color:${brand.accent};text-decoration:none;">@brosplitai</a>
        </p>
        <p style="margin:10px 0 0;font-size:14px;color:${brand.subtext};">Crush it this week,</p>
        <p style="margin:2px 0 0;font-weight:700;">— The BroSplit Team</p>
      </div>
      <div style="background:#f3f4f6;color:#6b7280;text-align:center;padding:12px 10px;font-size:12px;">
        BroSplit AI • support@brosplit.org
      </div>
    </div>
  </div>
  `;

  const text = `Your 6‑Week BroSplit Training Plan is attached as a PDF.

Next steps:
1) Open the attached BroSplit‑Plan.pdf
2) Save it to your phone or print it
3) Start Day 1 today

Questions? Reply here or DM us on IG @brosplitai
BroSplit AI • support@brosplit.org`;

  // 4) Send via Resend
  try {
    await resend.emails.send({
      from: 'BroSplit AI Coach <support@brosplit.org>',
      to: email,
      subject: '🔥 Your 6‑Week BroSplit Plan (PDF attached)',
      html,
      text,
      attachments: [
        {
          filename: 'BroSplit-Plan.pdf',
          content: pdfBuffer.toString('base64'),
          type: 'application/pdf',
        }
      ],
    });
  } catch (err) {
    console.error('❌ Email delivery failed:', err?.response?.data || err?.message || err);
    throw new Error('Email delivery failed');
  }
}

// Email route (used by your frontend)
app.post('/api/email-plan', async (req, res) => {
  try {
    const { email, plan, userProfile = {} } = req.body;
    if (!email || !plan) {
      return res.status(400).json({ error: 'Email and plan are required' });
    }
    await sendWorkoutPlanWithResend(email, plan, userProfile);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Email delivery failed:', err?.response?.data || err?.message || err);
    res.status(500).json({ error: 'Email delivery failed' });
  }
});

// ─── 5. Health Check Endpoint ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── 6. Start Server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server listening on :${PORT}`));
