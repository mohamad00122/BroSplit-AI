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
import { makePrompt, makeNutritionPrompt } from "./prompt.js";
import path from "path";
import { fileURLToPath } from "url";

// Security + validation (lightweight, safe defaults)
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";

// —— ESM __dirname shim ————————————————————————————————————————————————
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config();

const app = express();
app.set("trust proxy", 1);
app.use(bodyParser.json({ limit: "1mb" }));
app.use(cors({ origin: "*", credentials: true }));
app.use(helmet());

// Global rate limit
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

// ─── 1) Stripe Checkout Endpoint ──────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Use your real IDs via env, with your provided fallback for Pro
const PRICE_BASE = process.env.STRIPE_PRICE_BASE || "price_1RsQJUAhLaqVN2Rssepup9EE"; // $5
const PRICE_PRO  = process.env.STRIPE_PRICE_PRO  || "price_1RsQJUAhLaqVN2Rssepup9EE"; // $15

app.post("/api/checkout", async (req, res) => {
  try {
    const planType = (req.body.planType || "workout").toLowerCase();
    const price = planType === "pro" ? PRICE_PRO : PRICE_BASE;

    const session = await stripe.checkout.sessions.create({
      line_items: [{ price, quantity: 1 }],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).send("Stripe error");
  }
});

// ─── 2) AI Plan Generation (Workout) ──────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const genLimiter = rateLimit({ windowMs: 60_000, limit: 12 });

app.post("/api/generate-plan", genLimiter, async (req, res) => {
  try {
    const {
      sessionId, daysPerWeek, equipment, injuries, experience,
      goal, dislikes, focusMuscle, age, sex, bodyweight, lifts
    } = req.body;

    if (sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== "paid") return res.status(402).send("Payment required");
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
    console.error("Plan generation error:", err);
    res.status(500).send("Plan generation error");
  }
});

// ─── 2.5) Nutrition Calculations ──────────────────────────────────────────────
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
  const protein_g = Math.round((goal === "cut" ? 2.2 : 1.8) * weight_kg);
  let fat_g = Math.round((kcal * 0.30) / 9);
  const band = training_load === "high" ? [8,10] : training_load === "moderate" ? [5,7] : [3,5];
  const minCarb_g = Math.round(band[0] * weight_kg);
  let carbs_g = Math.round((kcal - (protein_g*4 + fat_g*9)) / 4);
  if (carbs_g < minCarb_g) {
    fat_g = Math.round((kcal * 0.22) / 9);
    carbs_g = Math.round((kcal - (protein_g*4 + fat_g*9)) / 4);
  }
  const fiber_g = Math.round((kcal / 1000) * 14);
  const sodium_mg_cap = 2300;
  return { kcal, protein_g, carbs_g, fat_g, fiber_g, sodium_mg_cap };
}

// ─── 3) Nutrition Generation (JSON) ───────────────────────────────────────────
app.post("/api/nutrition", genLimiter, async (req, res) => {
  try {
    const input = NutritionInput.parse(req.body);

    const rmr = mifflin(input);
    const kcal = calorieGoal(rmr, input.activity, input.goal);
    const targets = macroTargets({ weight_kg: input.weight_kg, kcal, goal: input.goal, training_load: input.training_load });

    const prompt = makeNutritionPrompt({ input, targets });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o",
      temperature: 0.2,
      max_tokens: 3000,
      messages: [
        { role: "system", content: "You are a sports nutrition assistant. Use the supplied targets verbatim. Respond ONLY with valid JSON." },
        { role: "user", content: prompt }
      ]
    });

    let planJson;
    try {
      planJson = JSON.parse(completion.choices[0].message.content);
    } catch (e) {
      console.error("Nutrition JSON parse failed.");
      return res.status(502).json({ error: "Model returned invalid JSON", raw: completion.choices[0].message.content, targets });
    }

    res.json({ targets, plan: planJson });
  } catch (err) {
    console.error("Nutrition generation error:", err);
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid nutrition input", details: err.errors });
    res.status(500).json({ error: "Nutrition generation error" });
  }
});

// ─── 4) PDF Generators ────────────────────────────────────────────────────────
function generateWorkoutPDF(planText, userProfile = {}) {
  const doc = new PDFDocument({ size: "A4", margins: { top: 50, bottom: 50, left: 50, right: 50 } });
  const { width, height } = doc.page;
  const styles = {
    h1: { font: 'Helvetica-Bold', size: 24, color: '#2563eb' },
    h2: { font: 'Helvetica-Bold', size: 18, color: '#1f2937' },
    body: { font: 'Helvetica', size: 12, color: '#1f2937', lineGap: 5 },
    small: { font: 'Helvetica', size: 9, color: '#6b7280' }
  };
  const apply = s => doc.font(s.font).fontSize(s.size).fillColor(s.color);
  const rule = () => { doc.moveDown(0.5); doc.strokeColor('#e5e7eb').lineWidth(0.5).moveTo(doc.x, doc.y).lineTo(width - doc.page.margins.right, doc.y).stroke(); doc.moveDown(0.5); };

  // Cover
  apply(styles.h1); doc.text('Your Personal 6-Week Program', { align: 'center' }); doc.moveDown(1);
  apply(styles.body); doc.text(`Hey ${userProfile.name || 'Athlete'} — let’s get to work.`, { align: 'center' }); doc.moveDown(2);

  // Optional logo
  try {
    const logoBuffer = fs.readFileSync(path.join(__dirname, 'assets', 'BroSplitLogo.png'));
    doc.image(logoBuffer, (width-220)/2, (height/2)-60, { width: 220 });
  } catch {}
  doc.addPage();

  // TOC + Tips
  apply(styles.h2); doc.text('Pro Tips'); rule();
  apply(styles.body);
  ['Progressive Overload: add a little weekly.',
   'Recovery: 7–9h sleep.',
   'Protein: 0.8–1g/lb bodyweight.',
   'Log your training; chase quality reps.'].forEach(t => doc.text(`• ${t}`, { indent: 20 }));
  doc.addPage();

  // Parse weeks/days from plain text
  const lines = (planText || '').replace(/\*\*/g, '').split(/\r?\n/).map(l => l.trim());
  const weeks = []; let currentWeek = null, currentDay = null;
  for (const line of lines) {
    if (!line) continue;
    const w = line.match(/^Week\s+(\d+)/i);
    const d = line.match(/^Day\s+\d+/i);
    if (w) { currentWeek = { number: +w[1], days: [] }; weeks.push(currentWeek); continue; }
    if (d && currentWeek) { currentDay = { name: line, ex: [] }; currentWeek.days.push(currentDay); continue; }
    if (currentDay && /:/.test(line)) currentDay.ex.push(line);
  }

  weeks.slice(0, 6).forEach(week => {
    apply(styles.h2); doc.text(`Week ${week.number}`); rule();
    week.days.forEach(day => { apply(styles.h1); doc.text(day.name); apply(styles.body); day.ex.forEach(e => doc.text(`• ${e}`, { indent: 20 })); doc.moveDown(1); });
    doc.addPage();
  });

  // Footer + page numbers
  apply(styles.h2); doc.text('Stay Consistent'); rule(); apply(styles.body);
  doc.text("Track workouts & recovery. You’ve got this!");
  doc.flushPages(); const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { doc.switchToPage(i); apply(styles.small); doc.text(`Page ${i+1} of ${range.count}`, 0, doc.page.height - 40, { align:'center' }); }
  doc.end(); return doc;
}

function generateNutritionPDF(nPlan, userProfile = {}) {
  // Accept either {summary,guidelines,day_plans,grocery_list,batch_prep} or variations
  const plan = nPlan || {};
  const summary = plan.summary || {};
  const guidelines = plan.guidelines || {};
  const days = plan.day_plans || plan.days || [];
  const grocery = (plan.grocery_list && plan.grocery_list.items) || plan.grocery_list || [];
  const batch = plan.batch_prep || [];

  const doc = new PDFDocument({ size: "A4", margins: { top: 50, bottom: 50, left: 50, right: 50 } });
  const { width } = doc.page;
  const styles = {
    h1: { font: 'Helvetica-Bold', size: 24, color: '#0e7490' },
    h2: { font: 'Helvetica-Bold', size: 16, color: '#0f172a' },
    body: { font: 'Helvetica', size: 11, color: '#0f172a', lineGap: 4 },
    chip: { font: 'Helvetica-Bold', size: 11, color: '#0f172a' },
    small: { font: 'Helvetica', size: 9, color: '#6b7280' }
  };
  const apply = s => doc.font(s.font).fontSize(s.size).fillColor(s.color);
  const rule = () => { doc.moveDown(0.5); doc.strokeColor('#a7f3d0').lineWidth(0.8).moveTo(doc.x, doc.y).lineTo(width - doc.page.margins.right, doc.y).stroke(); doc.moveDown(0.5); };

  // Cover
  apply(styles.h1); doc.text('Your Personalized Nutrition Plan', { align:'center' }); doc.moveDown(0.5);
  apply(styles.body); doc.text(`Prepared for ${userProfile.name || "Athlete"}`, { align:'center' }); doc.moveDown(1.5);

  // Summary chips
  apply(styles.h2); doc.text('Daily Targets'); rule(); apply(styles.body);
  const chips = [
    `Calories: ${summary.calories || summary.kcal || "—"} kcal`,
    `Protein: ${summary.protein_g ?? "—"} g`,
    `Carbs: ${summary.carbs_g ?? "—"} g`,
    `Fat: ${summary.fat_g ?? "—"} g`,
    `Fiber: ${summary.fiber_target_g ?? "—"} g`,
    `Sodium cap: ${summary.sodium_cap_mg ?? "—"} mg`,
    `Meals/day: ${summary.meals_per_day ?? "—"}`
  ].filter(Boolean);
  chips.forEach(c => doc.text(`• ${c}`));
  doc.addPage();

  // Guidelines
  apply(styles.h2); doc.text('Guidelines'); rule(); apply(styles.body);
  if (guidelines.protein_per_meal_rule) doc.text(`• Protein/meal: ${guidelines.protein_per_meal_rule}`);
  if (guidelines.pre_post)            doc.text(`• Pre/Post training: ${guidelines.pre_post}`);
  if (guidelines.notes)               doc.text(`• Notes: ${guidelines.notes}`);
  doc.addPage();

  // Days
  (Array.isArray(days) ? days : []).forEach((d, idx) => {
    apply(styles.h2);
    const kcal = d.total_kcal || summary.calories || summary.kcal || "";
    doc.text(`Day ${d.day || idx + 1} — ${kcal} kcal`); rule();
    apply(styles.body);
    (d.meals || []).forEach(m => {
      const macros = m.macros ? ` (${m.macros.kcal || 0} kcal • P${m.macros.protein_g || 0}/C${m.macros.carbs_g || 0}/F${m.macros.fat_g || 0})` : '';
      doc.text(`${m.name || "Meal"}: ${m.recipe || ""}${macros}`);
      (m.ingredients || []).forEach(i => {
        const qty = i.grams ? `${i.grams} g` : i.ml ? `${i.ml} ml` : i.count ? `${i.count} ct` : (i.qty || "");
        doc.text(`   · ${i.item}${qty ? ` — ${qty}` : ""}`);
      });
      doc.moveDown(0.3);
    });
    doc.addPage();
  });

  // Grocery list
  apply(styles.h2); doc.text('Grocery List'); rule(); apply(styles.body);
  (Array.isArray(grocery) ? grocery : []).forEach(it => {
    const item = it.item || it.name || it;
    const unit = it.kg ? `${it.kg} kg` : it.ml ? `${it.ml} ml` : it.count ? `${it.count} ct` : '';
    doc.text(`• ${item}${unit ? ` — ${unit}` : ''}`);
  });
  doc.addPage();

  // Batch prep
  apply(styles.h2); doc.text('Batch Prep'); rule(); apply(styles.body);
  (Array.isArray(batch) ? batch : []).forEach(b => {
    doc.text(`• ${b.day || ""}: ${(b.steps || []).join(' • ')}`);
  });

  // Footer / page numbers
  doc.flushPages(); const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { doc.switchToPage(i); apply(styles.small); doc.text(`Page ${i+1} of ${range.count}`, 0, doc.page.height - 40, { align:'center' }); }
  doc.end(); return doc;
}

// ─── 5) Email + PDF Endpoints ────────────────────────────────────────────────
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

// Generate buffer from a PDFKit doc stream
const toBuffer = (doc) => new Promise((resolve, reject) => {
  const bufs = []; doc.on('data', c => bufs.push(c)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
});

async function sendPlansWithResend({ email, workoutText, nutritionJson, userProfile = {} }) {
  // Workout PDF
  const wDoc = generateWorkoutPDF(workoutText, userProfile);
  const workoutBuf = await toBuffer(wDoc);

  // Optional Nutrition PDF
  let nutritionAttachment = null;
  if (nutritionJson) {
    const nDoc = generateNutritionPDF(nutritionJson, userProfile);
    const nBuf = await toBuffer(nDoc);
    nutritionAttachment = {
      filename: 'BroSplit-Nutrition-Plan.pdf',
      content: nBuf.toString('base64'),
      type: 'application/pdf'
    };
  }

  const attachments = [
    { filename: 'BroSplit-Workout-Plan.pdf', content: workoutBuf.toString('base64'), type: 'application/pdf' },
    ...(nutritionAttachment ? [nutritionAttachment] : [])
  ];

  await resend.emails.send({
    from: 'support@brosplit.org',
    to: email,
    subject: `Your Plan is Ready${userProfile.name ? `, ${userProfile.name}` : ''}`,
    html: `<p>Your personalized plan is attached.${nutritionAttachment ? " Includes workout + nutrition PDFs." : ""}</p>`,
    attachments
  });
}

// Email endpoint (now supports nutrition attachment)
app.post('/api/email-plan', async (req, res) => {
  try {
    const { email, plan, nutrition, userProfile = {} } = req.body;
    if (!email || !plan) return res.status(400).json({ error: 'Email and workout plan are required' });

    await sendPlansWithResend({ email, workoutText: plan, nutritionJson: nutrition, userProfile });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Email delivery failed:", err);
    res.status(500).json({ error: 'Email delivery failed' });
  }
});

// On-demand Nutrition PDF download (for the success page "Download Nutrition PDF" button)
app.post('/api/nutrition-pdf', async (req, res) => {
  try {
    const { plan, userProfile = {} } = req.body;
    if (!plan) return res.status(400).json({ error: "Missing plan JSON" });
    const doc = generateNutritionPDF(plan, userProfile);
    const buf = await toBuffer(doc);
    res.json({ base64: buf.toString('base64') });
  } catch (e) {
    console.error("nutrition-pdf:", e);
    res.status(500).json({ error: "Failed to generate nutrition PDF" });
  }
});

// ─── 6) Health + Server ───────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server listening on :${PORT}`));
