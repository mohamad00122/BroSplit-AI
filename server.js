// File: server.js

// ─── Imports & Configuration ──────────────────────────────────────────────────
import 'dotenv/config';
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer"; // (unused; safe to remove if you want)
import fs from "fs";
import Stripe from "stripe";
import OpenAI from "openai";
import dotenv from "dotenv";
import { makePrompt, makeNutritionPrompt } from "./prompt.js";
import path from "path";
import { fileURLToPath } from "url";

// NEW: security + validation
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";

// —— ESM __dirname shim ————————————————————————————————————————————————
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config();

const app = express();
app.set("trust proxy", 1);
app.use(bodyParser.json());
app.use(cors({ origin: "*", credentials: true }));
app.use(helmet());

// Global rate limit (safe defaults); tighten for generation endpoints below.
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

// ─── 1. Stripe Checkout Endpoint ───────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// OPTIONAL: move these to .env for safety
// STRIPE_PRICE_BASE=price_1RrLHFAhLaqVN2RsuypXJYSA   # $5
// STRIPE_PRICE_PRO=price_1RwCtIAhLaqVN2RsgNnz8QSH     # $15
const PRICE_BASE = process.env.STRIPE_PRICE_BASE || 'price_1RrLHFAhLaqVN2RsuypXJYSA';
const PRICE_PRO  = process.env.STRIPE_PRICE_PRO  || 'price_1RwCtIAhLaqVN2RsgNnz8QSH';

app.post("/api/checkout", async (req, res) => {
  try {
    // Decide which tier we’re selling
    const price = req.body.planType === 'pro' ? PRICE_PRO : PRICE_BASE;

    const session = await stripe.checkout.sessions.create({
      line_items: [{ price, quantity: 1 }],
      mode: "payment",
      // (optional) allow promo codes / coupons in Checkout:
      // allow_promotion_codes: true,
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).send("Stripe error");
  }
});

// ─── 2. Plan Generation Endpoint (workout) ─────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Tight rate limit for generation endpoints
const genLimiter = rateLimit({ windowMs: 60_000, limit: 12 });

app.post("/api/generate-plan", genLimiter, async (req, res) => {
  try {
    const {
      sessionId, daysPerWeek, equipment, injuries, experience,
      goal, dislikes, focusMuscle, age, sex, bodyweight, lifts
    } = req.body;

    // Optional: verify payment (comment out if testing locally)
    if (sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== "paid") {
        return res.status(402).send("Payment required");
      }
    }

    const prompt = makePrompt({
      daysPerWeek, equipment, injuries, experience,
      goal, dislikes, focusMuscle, age, sex, bodyweight, lifts
    });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o",
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

// ─── 2.5 Nutrition Helpers (server-side math) ──────────────────────────────────
const NutritionInput = z.object({
  sex: z.enum(["male","female"]),
  age: z.number().int().min(13).max(90),
  height_cm: z.number().min(120).max(230),
  weight_kg: z.number().min(35).max(250),
  activity: z.enum(["sedentary","light","moderate","very_active"]),
  goal: z.enum(["cut","recomp","gain"]),
  training_load: z.enum(["light","moderate","high"]),
  meals_per_day: z.number().int().min(3).max(6).default(4),
  cuisine_prefs: z.array(z.string()).default([]),
  diet_prefs: z.array(z.enum([
    "none","vegetarian","vegan","pescatarian","halal","kosher","dairy_free","gluten_free"
  ])).default(["none"]),
  allergies: z.array(z.string()).default([]),
  budget_level: z.enum(["tight","normal","flex"]).default("normal"),
  name: z.string().optional(),
  email: z.string().email().optional()
});

const AF = { sedentary:1.2, light:1.375, moderate:1.55, very_active:1.725 };

function mifflin({ sex, age, height_cm, weight_kg }) {
  return 10*weight_kg + 6.25*height_cm - 5*age + (sex === "male" ? 5 : -161);
}

function calorieGoal(rmr, activity, goal) {
  const tdee = rmr * AF[activity];
  const adj = goal === "cut" ? 0.80 : goal === "gain" ? 1.12 : 0.95;
  return Math.round(tdee * adj);
}

function macroTargets({ weight_kg, kcal, goal, training_load }) {
  const proteinPerKg = goal === "cut" ? 2.2 : 1.8;
  const protein_g = Math.round(proteinPerKg * weight_kg);

  let fat_g = Math.round((kcal * 0.30) / 9);

  const band = training_load === "high" ? [8,10]
             : training_load === "moderate" ? [5,7]
             : [3,5];
  const minCarb_g = Math.round(band[0] * weight_kg);

  let carbs_g = Math.round((kcal - (protein_g*4 + fat_g*9)) / 4);
  if (carbs_g < minCarb_g) {
    fat_g = Math.round((kcal * 0.22) / 9);
    carbs_g = Math.round((kcal - (protein_g*4 + fat_g*9)) / 4);
  }
  if (carbs_g < 0) carbs_g = Math.max(0, minCarb_g);

  const fiber_g = Math.round((kcal / 1000) * 14);
  const sodium_mg_cap = 2300;

  return { kcal, protein_g, carbs_g, fat_g, fiber_g, sodium_mg_cap };
}

// ─── 3. Nutrition Generation Endpoint ──────────────────────────────────────────
app.post("/api/nutrition", genLimiter, async (req, res) => {
  try {
    const input = NutritionInput.parse(req.body);

    const rmr = mifflin(input);
    const kcal = calorieGoal(rmr, input.activity, input.goal);
    const targets = macroTargets({
      weight_kg: input.weight_kg,
      kcal,
      goal: input.goal,
      training_load: input.training_load
    });

    const prompt = makeNutritionPrompt({ input, targets });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o",
      temperature: 0.2,
      max_tokens: 3000,
      messages: [
        {
          role: "system",
          content: "You are a sports nutrition assistant. Use the supplied targets verbatim. Respond ONLY with valid JSON."
        },
        { role: "user", content: prompt }
      ]
    });

    let planJson;
    try {
      planJson = JSON.parse(completion.choices[0].message.content);
    } catch (e) {
      console.error("JSON parse failed, returning raw text");
      return res.status(502).json({
        error: "Model returned invalid JSON",
        raw: completion.choices[0].message.content,
        targets
      });
    }

    res.json({ targets, plan: planJson });
  } catch (err) {
    console.error(err);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid nutrition input", details: err.errors });
    }
    res.status(500).json({ error: "Nutrition generation error" });
  }
});

// ─── 4. Enhanced PDF Generation (Training + optional Nutrition) ────────────────
function generateEnhancedPDF(planText, userProfile = {}, nutritionPlan = null) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 50, bottom: 50, left: 50, right: 50 }
  });
  const { width, height } = doc.page;
  const hasNutrition = !!nutritionPlan;

  const styles = {
    heading1: { font: 'Helvetica-Bold', size: 24, color: '#2563eb' },
    heading2: { font: 'Helvetica-Bold', size: 18, color: '#1f2937' },
    body:     { font: 'Helvetica',      size: 12, color: '#1f2937', lineGap: 5 },
    small:    { font: 'Helvetica',      size: 9,  color: '#6b7280' }
  };

  function applyStyle(style) { doc.font(style.font).fontSize(style.size).fillColor(style.color); }
  function rule() {
    doc.moveDown(0.5);
    doc.strokeColor('#e5e7eb').lineWidth(0.5)
       .moveTo(doc.x, doc.y)
       .lineTo(width - doc.page.margins.right, doc.y)
       .stroke();
    doc.moveDown(0.5);
  }

  // Cover
  applyStyle(styles.heading1);
  doc.text(`Your Personal 6-Week ${hasNutrition ? 'Training + Nutrition' : 'BroSplit'} Journey`, { align: 'center' });
  doc.moveDown(1);
  applyStyle(styles.body);
  const name = userProfile.name || 'Champion';
  doc.text(`Hey ${name}! Welcome to your transformation.`, { align: 'center', lineGap: styles.body.lineGap });
  doc.moveDown(2);

  // Logo (optional)
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

  // TOC (dynamic)
  applyStyle(styles.heading2);
  doc.text('Table of Contents', { align: 'left' });
  doc.moveDown(0.5);
  applyStyle(styles.body);

  const toc = [
    'Cover Page', 'Introduction', 'Pro Tips',
    'Week 1', 'Week 2', 'Week 3',
    'Week 4', 'Week 5', 'Week 6'
  ];
  if (hasNutrition) {
    toc.push('Nutrition Summary', '7-Day Meal Plan', 'Grocery List', 'Batch Prep');
  }
  toc.push('Footer');
  toc.forEach((item, i) => doc.text(`${i+1}. ${item}`));
  doc.addPage();

  // Pro Tips
  applyStyle(styles.heading2);
  doc.text('Ready to Get Started?');
  rule();
  applyStyle(styles.body);
  [
    'Progressive Overload: Aim to add a little more each week.',
    'Recovery Matters: 7–9 hours of sleep for muscle growth.',
    'Nutrition: ~0.7–1.0 g protein per lb bodyweight.',
    'Track Progress: Log workouts and celebrate wins.',
    'Form Over Ego: Quality reps beat sloppy heavy reps.'
  ].forEach(tip => doc.text(`• ${tip}`, { indent: 20 }));
  doc.addPage();

  // Parse and render weeks (Training)
  const lines = (planText || '').replace(/\*\*/g, '').split(/\r?\n/).map(l => l.trim());
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

  // Nutrition (if provided)
  if (hasNutrition) {
    const n = nutritionPlan;

    // Nutrition Summary
    applyStyle(styles.heading2);
    doc.text('Nutrition Summary');
    rule();
    applyStyle(styles.body);
    const rows = [
      ['Calories', `${n?.summary?.calories ?? '-'} kcal`],
      ['Protein', `${n?.summary?.protein_g ?? '-'} g/day (~${n?.summary?.per_meal_protein_g ?? '-'} g/meal)`],
      ['Carbs', `${n?.summary?.carbs_g ?? '-'} g/day`],
      ['Fat', `${n?.summary?.fat_g ?? '-'} g/day`],
      ['Fiber', `${n?.summary?.fiber_target_g ?? '-'} g/day`],
      ['Sodium cap', `${n?.summary?.sodium_cap_mg ?? '-'} mg/day`],
      ['Meals/day', `${n?.summary?.meals_per_day ?? '-'}`]
    ];
    rows.forEach(([k, v]) => doc.text(`• ${k}: ${v}`, { indent: 20 }));
    if (n?.guidelines) {
      doc.moveDown(0.5);
      if (n.guidelines.protein_per_meal_rule) doc.text(`• ${n.guidelines.protein_per_meal_rule}`, { indent: 20 });
      if (n.guidelines.pre_post) doc.text(`• ${n.guidelines.pre_post}`, { indent: 20 });
      if (n.guidelines.notes) doc.text(`• ${n.guidelines.notes}`, { indent: 20 });
    }
    doc.addPage();

    // 7-Day Meal Plan
    applyStyle(styles.heading2);
    doc.text('7-Day Meal Plan');
    rule();
    applyStyle(styles.body);
    (n?.day_plans || []).slice(0, 7).forEach(day => {
      applyStyle(styles.heading1);
      doc.text(`Day ${day.day} — ${day.total_kcal || n?.summary?.calories || ''} kcal`);
      applyStyle(styles.body);
      (day.meals || []).forEach(m => {
        const macros = m.macros ? ` (${m.macros.kcal || 0} kcal • P${m.macros.protein_g || 0}/C${m.macros.carbs_g || 0}/F${m.macros.fat_g || 0})` : '';
        doc.text(`• ${m.name}: ${m.recipe}${macros}`, { indent: 20 });
        (m.ingredients || []).forEach(i => {
          const qty = i.grams ? `${i.grams} g` : i.ml ? `${i.ml} ml` : i.count ? `${i.count} ct` : '';
          doc.text(`   – ${i.item}${qty ? ` — ${qty}` : ''}`);
        });
        doc.moveDown(0.25);
      });
      doc.moveDown(0.5);
    });
    doc.addPage();

    // Grocery List
    applyStyle(styles.heading2);
    doc.text('Grocery List');
    rule();
    applyStyle(styles.body);
    (n?.grocery_list?.items || []).forEach(it => {
      const qty = it.kg ? `${it.kg} kg` : it.ml ? `${it.ml} ml` : it.count ? `${it.count} ct` : '';
      doc.text(`• ${it.item}${qty ? ` — ${qty}` : ''}`, { indent: 20 });
    });
    doc.addPage();

    // Batch Prep
    applyStyle(styles.heading2);
    doc.text('Batch Prep');
    rule();
    applyStyle(styles.body);
    (n?.batch_prep || []).forEach(b => {
      applyStyle(styles.heading1);
      doc.text(b.day);
      applyStyle(styles.body);
      (b.steps || []).forEach(step => doc.text(`• ${step}`, { indent: 20 }));
      doc.moveDown(0.5);
    });
    doc.addPage();
  }

  // Footer
  applyStyle(styles.heading2);
  doc.text('Ready to Get Started?');
  rule();
  applyStyle(styles.body);
  doc.text(
    "This plan was crafted for YOU. Consistency is key. Track photos, log workouts, and don't skip recovery. Let's crush it!",
    { width: width - 100 }
  );

  // Page numbers
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

// ─── 5. Email Endpoint using Resend (now accepts nutrition) ────────────────────
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendWorkoutPlanWithResend(email, plan, userProfile = {}, nutrition = null) {
  const doc = generateEnhancedPDF(plan, userProfile, nutrition);
  const buffer = await new Promise((resolve, reject) => {
    const bufs = [];
    doc.on('data', chunk => bufs.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);
  });

  const base64PDF = buffer.toString('base64');

  await resend.emails.send({
    from: 'support@brosplit.org',
    to: email,
    subject: `Your ${nutrition ? 'Training + Nutrition' : '6-Week'} Plan is Ready${userProfile.name ? `, ${userProfile.name}` : ''}`,
    html: `<p>Your personalized ${nutrition ? 'training + nutrition ' : ''}plan is attached!</p>`,
    attachments: [
      {
        filename: 'BroSplit-Plan.pdf',
        content: base64PDF,
        type: 'application/pdf',
      }
    ]
  });
}

app.post('/api/email-plan', async (req, res) => {
  try {
    const { email, plan, userProfile = {}, nutrition = null } = req.body;
    if (!email || !plan) {
      return res.status(400).json({ error: 'Email and plan are required' });
    }
    await sendWorkoutPlanWithResend(email, plan, userProfile, nutrition);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Email delivery failed:", err);
    res.status(500).json({ error: 'Email delivery failed' });
  }
});

// ─── 6. Health Check Endpoint ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── 7. Start Server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server listening on :${PORT}`));
