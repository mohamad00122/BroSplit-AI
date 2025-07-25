// server.js
console.log("▶️ Starting enhanced server.js…");

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

// ────────────────────────────────────────────────────────────────
// 1) Stripe Checkout
// ────────────────────────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
app.post("/api/checkout", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: 500,
          product_data: { name: "6-Week BroSplit Plan" }
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

// ────────────────────────────────────────────────────────────────
// 2) Plan Generation via OpenAI
// ────────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────────
// 3) PDF Generation & Email Service
// ────────────────────────────────────────────────────────────────
function generateEnhancedPDF(planText, userProfile = {}) {
  const doc = new PDFDocument({
    margin: 50,
    size: "A4",
    bufferPages: true
  });
  const { width, height } = doc.page;
  const margin = 50;
  const bottomMargin = height - margin;

  // ──────────────── Sticky Header ────────────────
  function addHeader() {
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#2563eb")
       .text("BroSplit AI • 6-Week Plan", margin, margin / 2, {
         align: "left"
       });
    // horizontal rule
    doc.moveTo(margin, margin + 12)
       .lineTo(width - margin, margin + 12)
       .strokeColor("#e5e7eb")
       .stroke();
    doc.y = margin + 20;
  }
  doc.on("pageAdded", addHeader);

  // ──────────────── Fonts & Colors ────────────────
  doc.registerFont("H1", "Helvetica-Bold");
  doc.registerFont("H2", "Helvetica-Bold");
  doc.registerFont("Body", "Helvetica");
  doc.registerFont("Italic", "Helvetica-Oblique");
  doc.registerFont("Bold", "Helvetica-Bold");
  const cols = {
    primary: "#1f2937",
    accent: "#2563eb",
    success: "#059669",
    border: "#e5e7eb",
    light: "#f8fafc"
  };

  // ──────────────── Page Numbers (buffered) ────────────────
  function addFooter() {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.font("Helvetica").fontSize(9).fillColor(cols.primary)
         .text(`Page ${i + 1} of ${range.count}`, 0, height - 30, {
           align: "center"
         });
    }
  }

  // ──────────────── Quote & Week Metadata ────────────────
  const motivationalQuotes = [
    { quote: "The last three or four reps is what makes the muscle grow.", author: "Arnold Schwarzenegger" },
    { quote: "If you think lifting is dangerous, try being weak.", author: "Bret Contreras" },
    { quote: "Everybody wants to be a bodybuilder, but nobody wants to lift no heavy-ass weights.", author: "Ronnie Coleman" }
  ];
  const selectedQuote = motivationalQuotes[Math.floor(Math.random() * motivationalQuotes.length)];
  const weekMeta = {
    1: { title: "Foundation Week - Building Your Base", desc: "Focus on perfect form & groove.", intensity: "RPE 6–7" },
    2: { title: "Volume Week - Stepping It Up", desc: "Add volume—muscles love work.", intensity: "RPE 7" },
    3: { title: "Intensity Week - Bringing the Heat", desc: "Heavier loads, focused effort.", intensity: "RPE 7–8" },
    4: { title: "Recovery Week - Smart Training", desc: "Deload & mobilize strategically.", intensity: "RPE 5–6" },
    5: { title: "Peak Week - Maximum Effort", desc: "Push your limits with confidence.", intensity: "RPE 8–9" },
    6: { title: "Ultimate Peak - Your Victory Lap", desc: "Show yourself what you’re capable of!", intensity: "RPE 9" }
  };

  // ──────────────── 1) Cover Page ────────────────
  addHeader();
  doc.font("H1").fontSize(32).fillColor(cols.accent)
     .text("Your Personal", { align: "center" });
  doc.moveDown(0.2);
  doc.font("H1").fontSize(28).fillColor(cols.primary)
     .text("6-Week BroSplit Journey", { align: "center" });
  doc.moveDown(2);
  const name = userProfile.name || "Champion";
  doc.font("H2").fontSize(18).fillColor(cols.primary)
     .text(`Hey ${name}! 👋`, margin, doc.y);
  doc.moveDown(1.5);
  doc.font("Body").fontSize(12).fillColor(cols.primary)
     .text(
       `Welcome to your customized 6-week transformation! Every rep and week is designed for your goals.`,
       { lineGap: 4, paragraphGap: 12 }
     );
  doc.moveDown(1);
  // Quote box
  doc.rect(margin, doc.y, width - margin * 2, 60).fill(cols.light);
  doc.fillColor(cols.accent).font("Italic").fontSize(12)
     .text(`"${selectedQuote.quote}"`, margin + 10, doc.y + 10, {
       width: width - margin * 2 - 20,
       align: "center"
     });
  doc.fillColor(cols.primary).font("Body").fontSize(10)
     .text(`— ${selectedQuote.author}`, margin + 10, doc.y + 35, {
       width: width - margin * 2 - 20,
       align: "center"
     });
  doc.addPage();

  // ──────────────── 2) Table of Contents ────────────────
  // auto-header triggered
  doc.font("H2").fontSize(20).fillColor(cols.primary)
     .text("Your 6-Week Journey", margin, doc.y);
  doc.moveDown(1);
  Object.entries(weekMeta).forEach(([num, info]) => {
    // page break if needed
    if (doc.y > bottomMargin - 80) doc.addPage();
    // accent bar
    doc.rect(margin, doc.y, 4, 40).fill(cols.accent);
    doc.font("Bold").fontSize(14).fillColor(cols.primary)
       .text(`  Week ${num}: ${info.title}`, margin, doc.y);
    doc.font("Body").fontSize(10).fillColor(cols.primary)
       .text(info.desc, margin + 10, doc.y + 18, { width: 400 });
    doc.font("Italic").fontSize(9).fillColor(cols.accent)
       .text(info.intensity, margin + 10, doc.y + 33);
    doc.moveDown(2);
  });
  doc.addPage();

  // ──────────────── 3) Training Tips ────────────────
  doc.font("H2").fontSize(18).fillColor(cols.primary)
     .text("🎯 Pro Tips for Maximum Results", margin, doc.y);
  doc.moveDown(1);
  [
    { icon: "💪", title: "Progressive Overload", text: "Aim for slight weekly increases." },
    { icon: "😴", title: "Recovery is Key", text: "Sleep 7–9 hrs; muscles grow off-day." },
    { icon: "🍖", title: "Fuel Your Gains", text: "0.8–1g protein/lb bodyweight." },
    { icon: "📱", title: "Track Everything", text: "Log workouts & celebrate wins." },
    { icon: "🔥", title: "Form > Ego", text: "Perfect reps over heavy sloppy ones." }
  ].forEach(tip => {
    if (doc.y > bottomMargin - 60) doc.addPage();
    doc.font("Body").fontSize(14).fillColor(cols.primary)
       .text(`${tip.icon}  `, { continued: true })
       .font("Bold").text(tip.title)
       .font("Body").text(`\n${tip.text}`, { lineGap: 4, paragraphGap: 8 });
    doc.moveDown(1.5);
  });
  doc.addPage();

  // ──────────────── 4) Weeks & Workouts ────────────────
  // Parse the plan text into weeks/days/exercises
  const lines = planText.replace(/\*\*/g, "").split(/\r?\n/);
  const weeks = [];
  let currW = null, currD = null;
  lines.forEach(ln => {
    const line = ln.trim();
    if (!line) return;
    const w = line.match(/^Week\s+(\d+)/i);
    if (w) {
      if (currD) currW.days.push(currD);
      if (currW) weeks.push(currW);
      currW = { number: +w[1], days: [] };
      currD = null;
      return;
    }
    const d = line.match(/^Day\s+\d+/i);
    if (d) {
      if (currD) currW.days.push(currD);
      currD = { name: line.replace(/[–—]/g, "-"), exercises: [] };
      return;
    }
    if (currD && /:/.test(line)) {
      currD.exercises.push(line);
    }
  });
  if (currD) currW.days.push(currD);
  if (currW) weeks.push(currW);

  // Render each week
  weeks.slice(0, 6).forEach(wk => {
    const info = weekMeta[wk.number];
    // page break before week if needed
    if (doc.y > bottomMargin - 120) doc.addPage();
    // Week Header
    doc.font("H1").fontSize(20).fillColor(cols.accent)
       .text(`Week ${wk.number}: ${info.title}`, margin, doc.y);
    doc.font("Italic").fontSize(10).fillColor(cols.primary)
       .text(info.intensity, { lineGap: 4, paragraphGap: 8 });
    doc.moveDown(1.5);

    wk.days.forEach((day, idx) => {
      // break before day if needed
      if (doc.y > bottomMargin - 100) doc.addPage();
      // horizontal rule
      doc.moveTo(margin, doc.y).lineTo(width - margin, doc.y)
         .strokeColor(cols.border).stroke();
      doc.moveDown(0.5);

      // Day header
      doc.font("H2").fontSize(16).fillColor(cols.primary)
         .text(day.name, { lineGap: 4, paragraphGap: 8 });
      doc.moveDown(0.5);

      // Exercises
      day.exercises.forEach(ex => {
        if (doc.y > bottomMargin - 30) doc.addPage();
        doc.font("Body").fontSize(11).fillColor(cols.primary)
           .text(`• ${ex}`, { lineGap: 4 });
      });
      doc.moveDown(1);

      // Motivational callout
      const calls = [
        "💥 Finish strong!", "🔥 You've got this!",
        "💪 Beast mode activated!", "⚡ Power through!", "🎯 Lock in and dominate!"
      ];
      doc.font("Italic").fontSize(10).fillColor(cols.success)
         .text(calls[idx % calls.length], { paragraphGap: 12 });
      doc.moveDown(2);
    });
  });

  // ──────────────── 5) Footer & Page Numbers ────────────────
  addFooter();
  doc.end();
  return doc;
}

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      pool: true,
      maxConnections: 5,
      maxMessages: 10
    });
    this.transporter.verify(err => {
      if (err) console.error("SMTP failed:", err);
      else console.log("✅ SMTP ready");
    });
  }

  async sendWorkoutPlan(email, plan, userProfile = {}) {
    const doc = generateEnhancedPDF(plan, userProfile);
    const pdfBuffer = await this._toBuffer(doc);
    const html = this._emailHtml(userProfile);
    const mailOpts = {
      from: `"BroSplit AI" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `🔥 Your 6-Week BroSplit is Ready, ${userProfile.name || "Champion"}!`,
      html,
      attachments: [{
        filename: `BroSplit-Plan-${new Date().toISOString().split("T")[0]}.pdf`,
        content: pdfBuffer
      }],
      headers: { "X-Priority": "1" }
    };
    return this.transporter.sendMail(mailOpts);
  }

  _toBuffer(doc) {
    return new Promise((res, rej) => {
      const bufs = [];
      doc.on("data", c => bufs.push(c));
      doc.on("end", () => res(Buffer.concat(bufs)));
      doc.on("error", rej);
    });
  }

  _emailHtml(userProfile) {
    const name = userProfile.name || "Champion";
    const goal = userProfile.goal || "building muscle";
    return `
    <!DOCTYPE html><html><head><meta charset="utf-8">
    <style>
      body { font-family: Arial, sans-serif; background: #f8fafc; margin:0; padding:0; }
      .container { max-width:600px; margin:auto; background:#fff; }
      .header{background:#2563eb;color:#fff;padding:30px;text-align:center;}
      .header h1{margin:0;font-size:24px;}
      .content{padding:20px;}
      .footer{background:#1f2937;color:#fff;padding:20px;text-align:center;font-size:12px;}
    </style>
    </head><body><div class="container">
      <div class="header"><h1>🔥 Your BroSplit Plan is Ready!</h1></div>
      <div class="content">
        <p>Hey ${name},</p>
        <p>Your personalized 6-week plan is attached. Let’s crush that goal of <strong>${goal}</strong>!</p>
        <p><a href="#">Download your plan</a></p>
      </div>
      <div class="footer">
        BroSplit AI Team • support@brosplit-ai.com
      </div>
    </div></body></html>`;
  }
}

// ────────────────────────────────────────────────────────────────
// 4) Email Endpoint
// ────────────────────────────────────────────────────────────────
app.post("/api/email-plan", async (req, res) => {
  try {
    const { email, plan, userProfile = {} } = req.body;
    if (!email || !plan) return res.status(400).json({ error: "Missing fields" });
    const service = new EmailService();
    await service.sendWorkoutPlan(email, plan, userProfile);
    res.json({ success: true, message: "Plan emailed!" });
  } catch (err) {
    console.error("Email error:", err);
    res.status(500).json({ error: "Email delivery failed" });
  }
});

// ────────────────────────────────────────────────────────────────
// 5) Health Check
// ────────────────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  try {
    const svc = new EmailService();
    await svc.transporter.verify();
    res.json({
      status: "ok",
      services: {
        smtp: "healthy",
        openai: process.env.OPENAI_API_KEY ? "ok" : "missing",
        stripe: process.env.STRIPE_SECRET_KEY ? "ok" : "missing"
      },
      timestamp: new Date().toISOString()
    });
  } catch {
    res.status(503).json({ status: "degraded" });
  }
});

// ────────────────────────────────────────────────────────────────
// 6) Start Server
// ────────────────────────────────────────────────────────────────
app.listen(4000, () => console.log("🚀 Enhanced BroSplit AI on :4000"));
