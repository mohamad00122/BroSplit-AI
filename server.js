// File: server.js

// ─── Imports & Configuration ──────────────────────────────────────────────────
import 'dotenv/config';
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
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
        price: 'price_1RrCLrAhLaqVN2Rs8VdMzi96',
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

    const prompt = makePrompt({ daysPerWeek, equipment, injuries, experience,
      goal, dislikes, focusMuscle, age, sex, bodyweight, lifts });

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

  // 1. Render cover text at top
  applyStyle(styles.heading1);
  doc.text('Your Personal 6-Week BroSplit Journey', { align: 'center' });
  doc.moveDown(1);
  applyStyle(styles.body);
  const name = userProfile.name || 'Champion';
  doc.text(`Hey ${name}! Welcome to your transformation.`, {
    align: 'center', lineGap: styles.body.lineGap
  });
  doc.moveDown(2);

  // 2. Draw logo in vertical center
  const logoPath  = path.join(__dirname, 'assets', 'BroSplitLogo.png');
  const logoWidth = 250;  // increased size for bigger logo
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
  doc.text('🚀 Ready to Get Started?');
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

// ─── 4. Email Endpoint with PDF Attachment ─────────────────────────────────────
class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }

  async sendWorkoutPlan(email, plan, userProfile = {}) {
    const doc = generateEnhancedPDF(plan, userProfile);
    const buffer = await new Promise((resolve, reject) => {
      const bufs = []; doc.on('data', chunk => bufs.push(chunk)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    });

    return this.transporter.sendMail({
      from: `"BroSplit AI" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Your 6-Week Plan is Ready, ${userProfile.name || ''}`,
      text: 'Your personalized workout plan is attached!',
      attachments: [{ filename: 'BroSplit-Plan.pdf', content: buffer }]
    });
  }
}

app.post('/api/email-plan', async (req, res) => {
  try {
    const { email, plan, userProfile = {} } = req.body;
    if (!email || !plan) {
      return res.status(400).json({ error: 'Email and plan are required' });
    }
    const emailService = new EmailService();
    await emailService.sendWorkoutPlan(email, plan, userProfile);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
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