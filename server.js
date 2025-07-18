// server.js
console.log("▶️ Starting server.js…");

import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import express from "express";
import Stripe from "stripe";
import OpenAI from "openai";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";
import { makePrompt } from "./prompt.js";

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: "*", credentials: true }));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// 1. Stripe checkout
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
app.post("/api/checkout", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: 500,
          product_data: { name: "6-Week Bro-Split Plan" }
        },
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

// 2. Plan generator
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.post("/api/generate-plan", async (req, res) => {
  try {
    const {
      sessionId,
      daysPerWeek,
      equipment,
      injuries,
      experience,
      goal,
      dislikes,
      focusMuscle,
      age,
      sex,
      bodyweight,
      lifts
    } = req.body;

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return res.status(402).send("Payment required");
    }

    const prompt = makePrompt({
      daysPerWeek,
      equipment,
      injuries,
      experience,
      goal,
      dislikes,
      focusMuscle,
      age,
      sex,
      bodyweight,
      lifts
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

// 3. Polished PDF generator with Cover, TOC & Quotes
function generateOptimizedPDF(planText) {
  const doc = new PDFDocument({ margin: 50, size: "A4", bufferPages: true });

  // Register fonts (including an italic for quotes)
  doc.registerFont("H1", "Helvetica-Bold");
  doc.registerFont("H2", "Helvetica-Bold");
  doc.registerFont("Body", "Helvetica");
  doc.registerFont("Italic", "Helvetica-Oblique");

  const cols = { primary: "#1f2937", accent: "#2563eb", border: "#e5e7eb" };
  let y = 60;

  // --- Custom quotes and week descriptions ---
  const quotes = [
    "The last three or four reps is what makes the muscle grow… – Arnold Schwarzenegger",
    "If you think lifting is dangerous… try being weak. – Bret Contreras",
    "The worst thing I can be is the same as everybody else. – Arnold Schwarzenegger",
    "Look good, feel good, play good. – Tom Platz",
    "Everybody wants to be a bodybuilder, but nobody wants to lift no heavy-ass weights. – Ronnie Coleman",
    "Train hard, turn heads. – Chris Bumstead"
  ];
  const quote = quotes[Math.floor(Math.random() * quotes.length)];

  const weekDesc = {
    1: "Base Volume (RPE 6–7)",
    2: "+5–10% Volume (RPE 7)",
    3: "+5–10% Load (RPE 7–8)",
    4: "Deload: 50% Volume + Mobility (RPE 5–6)",
    5: "Peak: –2 reps vs Week 3 (RPE 8–9)",
    6: "Ultimate Peak: –1 rep (RPE 9)"
  };

  // COVER PAGE
  doc
    .font("H1").fontSize(32).fillColor(cols.accent)
    .text("6-Week BroSplit Plan", { align: "center", underline: true });
  doc.moveDown(1)
    .font("Body").fontSize(14).fillColor(cols.primary)
    .text(`Generated on ${new Date().toLocaleDateString()}`, { align: "center" });
  doc.moveDown(2)
    .font("Italic").fontSize(12).fillColor(cols.primary)
    .text(`“${quote}”`, { align: "center" });
  doc.addPage();

  // TABLE OF CONTENTS
  doc.font("H2").fontSize(18).fillColor(cols.primary).text("Table of Contents", 50, y);
  y += 30;
  for (let i = 1; i <= 6; i++) {
    doc
      .font("Body").fontSize(12).fillColor(cols.primary)
      .text(`• Week ${i}: ${weekDesc[i]}`, 80, y);
    y += 20;
  }
  doc.addPage();
  y = 60;

  // Helpers
  function newPage() {
    doc.addPage();
    y = 60;
  }
  function hr() {
    doc.strokeColor(cols.border).lineWidth(0.5)
       .moveTo(50, y).lineTo(doc.page.width - 50, y).stroke();
    y += 10;
  }
  function addHeader() {
    doc.font("H1").fontSize(24).fillColor(cols.primary)
       .text("BroSplit AI Workout Plan", 50, 20, { align: "center" });
    y = 60;
  }
  function addWeek(week) {
    doc.font("H2").fontSize(18).fillColor(cols.accent)
       .text(`Week ${week.number}`, 50, y);
    y += 25; hr();
    week.days.forEach(day => {
      doc.font("H2").fontSize(14).fillColor(cols.primary)
         .text(day.name, 50, y);
      y += 20;
      doc.font("Body").fontSize(12).fillColor(cols.primary);
      day.exercises.forEach(ex => {
        doc.text(`• ${ex.raw}`, 60, y, { width: doc.page.width - 120 });
        y += 18;
        if (y > doc.page.height - 80) newPage();
      });
      y += 15; hr();
      if (y > doc.page.height - 80) newPage();
    });
  }

  // PARSE AI OUTPUT
  const lines = planText.replace(/\*\*/g, "").split(/\r?\n/);
  const weeks = [];
  let currentWeek = null, currentDay = null;
  lines.forEach(raw => {
    const line = raw.trim();
    if (!line) return;
    const w = line.match(/^Week\s+(\d+)/i);
    if (w) {
      if (currentDay) currentWeek.days.push(currentDay);
      if (currentWeek) weeks.push(currentWeek);
      currentWeek = { number: +w[1], days: [] };
      currentDay = null;
      return;
    }
    const d = line.match(/^Day\s+\d+/i);
    if (d) {
      if (currentDay) currentWeek.days.push(currentDay);
      currentDay = { name: line.replace(/[–—]/g, "-"), exercises: [] };
      return;
    }
    if (currentDay && /:/.test(line)) {
      currentDay.exercises.push({ raw: line });
    }
  });
  if (currentDay) currentWeek.days.push(currentDay);
  if (currentWeek) weeks.push(currentWeek);

  // RENDER WEEKS
  addHeader();
  weeks.slice(0, 6).forEach((wk, i) => {
    if (i > 0 && y > doc.page.height - 200) newPage();
    addWeek(wk);
  });

  // NOTES PAGE
  newPage();
  doc.font("H2").fontSize(16).fillColor(cols.accent)
     .text("Training Notes", 50, y);
  y += 25;
  doc.font("Body").fontSize(12).fillColor(cols.primary);
  [
    "• Progressive overload: increase reps/sets weekly",
    "• Deload Week: 50% volume, RPE ~7",
    "• Rest 48–72h between muscle groups",
    "• Focus on form and track progress"
  ].forEach(note => {
    doc.text(note, 60, y);
    y += 18;
    if (y > doc.page.height - 80) newPage();
  });

  // PAGE NUMBERS
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.font("Body").fontSize(9).fillColor(cols.primary)
       .text(`Page ${i+1} / ${range.count}`, 0, doc.page.height - 40, { align: "center" });
  }

  doc.end();
  return doc;
}

// 4. Email endpoint
app.post("/api/email-plan", async (req, res) => {
  try {
    const { email, plan } = req.body;
    if (!email || !plan) return res.status(400).send("Missing email or plan");
    const doc = generateOptimizedPDF(plan);
    const bufs = [];
    doc.on("data", c => bufs.push(c));
    doc.on("end", async () => {
      const pdfBuffer = Buffer.concat(bufs);
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: +process.env.SMTP_PORT,
        secure: process.env.SMTP_SECURE === "true",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
      await transporter.sendMail({
        from: `"BroSplit AI" <${process.env.SMTP_USER}>`,
        to: email,
        subject: "Your Custom BroSplit AI Plan",
        html: `<h2>Your BroSplit AI Plan is Ready!</h2><p>See the attached PDF.</p>`,
        attachments: [{ filename: "BroSplit-AI-Plan.pdf", content: pdfBuffer }]
      });
      res.json({ success: true });
    });
  } catch (err) {
    console.error("Email error:", err);
    res.status(500).send("Email error");
  }
});

// 5. Boot server
app.listen(4000, () => console.log("🚀 BroSplit AI listening on :4000"));
console.log("✅ Express is listening on http://localhost:4000");
