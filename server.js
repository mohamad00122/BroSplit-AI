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

// Security + validation
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

// Global rate limit (safe defaults); extra limit on gen routes below
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

// ─── 1) Stripe Checkout ───────────────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.post("/api/checkout", async (req, res) => {
  try {
    // choose price by tier; default to base
    const price =
      req.body.planType === "pro"
        ? process.env.STRIPE_PRICE_PRO || "price_1RsQJUAhLaqVN2Rssepup9EE" // $15
        : process.env.STRIPE_PRICE_BASE || "price_1RsQJUAhLaqVN2Rssepup9EE"; // $5

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

// ─── 2) Workout Plan Generation ───────────────────────────────────────────────
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

// ─── 2.5) Nutrition helpers ───────────────────────────────────────────────────
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
const mifflin = ({ sex, age, height_cm, weight_kg }) =>
  10*weight_kg + 6.25*height_cm - 5*age + (sex === "male" ? 5 : -161);

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
      console.error("JSON parse failed");
      return res.status(502).json({ error: "Model returned invalid JSON", raw: completion.choices[0].message.content, targets });
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

// ─── 4) Workout PDF builder (existing) ────────────────────────────────────────
function generateEnhancedPDF(planText, userProfile = {}) {
  const doc = new PDFDocument({ size: "A4", margins: { top: 50, bottom: 50, left: 50, right: 50 } });
  const { width, height } = doc.page;
  const styles = {
    heading1: { font: 'Helvetica-Bold', size: 24, color: '#2563eb' },
    heading2: { font: 'Helvetica-Bold', size: 18, color: '#1f2937' },
    body:     { font: 'Helvetica', size: 12, color: '#1f2937', lineGap: 5 },
    small:    { font: 'Helvetica', size: 9, color: '#6b7280' }
  };
  const apply = s => doc.font(s.font).fontSize(s.size).fillColor(s.color);
  const rule = () => { doc.moveDown(0.5); doc.strokeColor('#e5e7eb').lineWidth(0.5).moveTo(doc.x, doc.y).lineTo(width - doc.page.margins.right, doc.y).stroke(); doc.moveDown(0.5); };

  // Cover
  apply(styles.heading1); doc.text('Your Personal 6-Week BroSplit Journey', { align: 'center' });
  doc.moveDown(1); apply(styles.body);
  const name = userProfile.name || 'Champion';
  doc.text(`Hey ${name}! Welcome to your transformation.`, { align: 'center', lineGap: styles.body.lineGap }); doc.moveDown(2);
  try { const p = path.join(__dirname, 'assets', 'BroSplitLogo.png'); const buf = fs.readFileSync(p); const w = 250; doc.image(buf, (doc.page.width - w)/2, (height/2)-(w/2), { width: w }); } catch {}
  doc.addPage();

  // TOC
  apply(styles.heading2); doc.text('Table of Contents'); doc.moveDown(0.5); apply(styles.body);
  ['Cover Page','Introduction','Pro Tips','Week 1','Week 2','Week 3','Week 4','Week 5','Week 6','Footer'].forEach((t,i)=>doc.text(`${i+1}. ${t}`));
  doc.addPage();

  // Tips
  apply(styles.heading2); doc.text('Ready to Get Started?'); rule(); apply(styles.body);
  ['Progressive Overload: Aim to add a little more each week.','Recovery Matters: 7-9 hours of sleep for muscle growth.','Nutrition: 0.8-1g protein per lb bodyweight.','Track Progress: Log workouts and celebrate wins.','Form Over Ego: Quality reps beat heavy sloppy reps.'].forEach(t=>doc.text(`• ${t}`,{indent:20}));
  doc.addPage();

  // Parse plan
  const lines = planText.replace(/\*\*/g, '').split(/\r?\n/).map(l=>l.trim());
  const weeks=[]; let curW=null, curD=null;
  for (const line of lines) {
    if (!line) continue;
    const w = line.match(/^Week\s+(\d+)/i);
    const d = line.match(/^Day\s+\d+/i);
    if (w) { curW = { number:+w[1], days:[] }; weeks.push(curW); }
    else if (d && curW) { curD = { name: line, exercises: [] }; curW.days.push(curD); }
    else if (curD && /:/.test(line)) { curD.exercises.push(line); }
  }

  weeks.slice(0,6).forEach(week=>{
    apply(styles.heading2); doc.text(`Week ${week.number}`); rule();
    week.days.forEach(day=>{ apply(styles.heading1); doc.text(day.name); apply(styles.body); day.exercises.forEach(ex=>doc.text(`• ${ex}`,{indent:20})); doc.moveDown(1); });
    doc.addPage();
  });

  // Footer
  apply(styles.heading2); doc.text('Ready to Get Started?'); rule(); apply(styles.body);
  doc.text("This plan was crafted for YOU. Consistency is key. Track photos, log workouts, and don't skip recovery.");
  doc.flushPages();
  const range = doc.bufferedPageRange();
  for (let i=0;i<range.count;i++){ doc.switchToPage(i); apply(styles.small); doc.text(`Page ${i+1} of ${range.count}`,0,doc.page.height-40,{align:'center'}); }
  doc.end();
  return doc;
}

const pdfToBuffer = (doc) => new Promise((resolve,reject)=>{
  const bufs=[]; doc.on('data',b=>bufs.push(b)); doc.on('end',()=>resolve(Buffer.concat(bufs))); doc.on('error',reject);
});

// ─── 4.5) Nutrition PDF builder (NEW) ─────────────────────────────────────────
async function buildNutritionPDFBuffer(plan, userProfile = {}) {
  const doc = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 40, left: 40, right: 40 } });
  const styles = {
    h1: { font: 'Helvetica-Bold', size: 24, color: '#16a34a' },
    h2: { font: 'Helvetica-Bold', size: 16, color: '#111827' },
    body: { font: 'Helvetica', size: 11, color: '#111827' },
    small: { font: 'Helvetica', size: 9, color: '#6b7280' }
  };
  const rule = () => { doc.moveDown(0.4); doc.strokeColor('#e5e7eb').lineWidth(0.5).moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke(); doc.moveDown(0.4); };
  const apply = s => doc.font(s.font).fontSize(s.size).fillColor(s.color);

  // Cover
  apply(styles.h1);
  doc.text('Your Personalized Nutrition Plan', { align: 'center' });
  doc.moveDown(0.5);
  apply(styles.body);
  doc.text(`Prepared for ${userProfile.name || 'Athlete'}`, { align: 'center' });
  rule();

  // Summary chips
  const s = plan.summary || {};
  const chips = [
    `Calories: ${s.calories} kcal`,
    `Protein: ${s.protein_g} g`,
    `Carbs: ${s.carbs_g} g`,
    `Fat: ${s.fat_g} g`,
    `Fiber: ${s.fiber_target_g} g`,
    `Sodium cap: ${s.sodium_cap_mg} mg`,
    `Meals/day: ${s.meals_per_day}`
  ];
  chips.forEach(c => { doc.roundedRect(doc.x, doc.y, doc.widthOfString(c)+18, 20, 6).stroke('#d1fae5'); doc.text(c, doc.x+9, doc.y+4); doc.moveDown(0.3); });
  doc.moveDown(0.5);

  // Guidelines
  apply(styles.h2); doc.text('Guidelines'); rule(); apply(styles.body);
  const g = plan.guidelines || {};
  doc.text(`• Protein/meal: ${g.protein_per_meal_rule || '—'}`);
  doc.text(`• Pre/Post training: ${g.pre_post || '—'}`);
  doc.text(`• Notes: ${g.notes || '—'}`);
  doc.addPage();

  // Day plans (first 7)
  const days = (plan.day_plans || []).slice(0,7);
  days.forEach((d, idx) => {
    apply(styles.h2); doc.text(`Day ${d.day || idx+1} — ${d.total_kcal || s.calories} kcal`); rule(); apply(styles.body);
    (d.meals || []).forEach(meal => {
      doc.font('Helvetica-Bold').text(meal.name || 'Meal');
      doc.font('Helvetica').text(meal.recipe || '');
      const m = meal.macros || {};
      const showMacros = [m.kcal, m.protein_g, m.carbs_g, m.fat_g].some(v => typeof v === 'number' && v > 0);
      if (showMacros) {
        doc.text(`  ▸ ${m.kcal} kcal   P${m.protein_g||0}/C${m.carbs_g||0}/F${m.fat_g||0}`);
      }
      const ings = (meal.ingredients || []).map(i => {
        if (i.grams) return `• ${i.item} — ${i.grams} g`;
        if (i.kg)    return `• ${i.item} — ${i.kg} kg`;
        if (i.ml)    return `• ${i.item} — ${i.ml} ml`;
        if (i.count) return `• ${i.item} — ${i.count} ct`;
        return `• ${i.item}`;
      });
      if (ings.length) doc.text(ings.join('\n'), { indent: 12 });
      doc.moveDown(0.6);
    });
    if (idx < days.length - 1) doc.addPage();
  });

  doc.addPage();

  // Grocery list
  apply(styles.h2); doc.text('Grocery List'); rule(); apply(styles.body);
  (plan.grocery_list?.items || []).forEach(it => {
    let qty = it.kg ? `${it.kg} kg` : it.ml ? `${it.ml} ml` : it.count ? `${it.count} ct` : it.grams ? `${it.grams} g` : '';
    doc.text(`• ${it.item}${qty ? ` — ${qty}` : ''}`);
  });
  doc.moveDown(0.8);

  // Batch prep
  apply(styles.h2); doc.text('Batch Prep'); rule(); apply(styles.body);
  (plan.batch_prep || []).forEach(b => doc.text(`• ${b.day}: ${Array.isArray(b.steps) ? b.steps.join('  • ') : ''}`));
  doc.moveDown(0.8);

  // Footer
  apply(styles.small);
  doc.text('This is general nutrition guidance and not medical advice.', { align: 'center' });

  doc.flushPages();
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    apply(styles.small);
    doc.text(`Page ${i+1} of ${range.count}`, 0, doc.page.height - 30, { align: 'center' });
  }

  doc.end();
  return await pdfToBuffer(doc);
}

// ─── 5) Email endpoint (now can attach BOTH PDFs) ─────────────────────────────
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendPlansEmail({ email, workoutPlanText, nutritionPlanJson, userProfile = {} }) {
  // Workout PDF
  const workoutDoc = generateEnhancedPDF(workoutPlanText, userProfile);
  const workoutBuf = await pdfToBuffer(workoutDoc);
  const attachments = [{
    filename: 'BroSplit-Workout-Plan.pdf',
    content: workoutBuf.toString('base64'),
    type: 'application/pdf'
  }];

  // Optional nutrition PDF
  if (nutritionPlanJson) {
    try {
      const nbuf = await buildNutritionPDFBuffer(nutritionPlanJson, userProfile);
      attachments.push({
        filename: 'BroSplit-Nutrition-Plan.pdf',
        content: nbuf.toString('base64'),
        type: 'application/pdf'
      });
    } catch (e) {
      console.warn("Nutrition PDF build failed:", e.message);
    }
  }

  await resend.emails.send({
    from: 'support@brosplit.org',
    to: email,
    subject: `Your Plan is Ready${userProfile.name ? `, ${userProfile.name}` : ''}`,
    html: `<p>Your personalized plan is attached.</p>`,
    attachments
  });
}

app.post('/api/email-plan', async (req, res) => {
  try {
    const { email, plan, nutrition = null, userProfile = {} } = req.body;
    if (!email || !plan) return res.status(400).json({ error: 'Email and workout plan are required' });
    await sendPlansEmail({ email, workoutPlanText: plan, nutritionPlanJson: nutrition, userProfile });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Email delivery failed:", err);
    res.status(500).json({ error: 'Email delivery failed' });
  }
});

// ─── 6) Direct Nutrition PDF download endpoint (for the button) ───────────────
app.post('/api/nutrition-pdf', async (req, res) => {
  try {
    const { plan, userProfile = {} } = req.body || {};
    if (!plan) return res.status(400).json({ error: 'Missing nutrition plan JSON' });
    const buffer = await buildNutritionPDFBuffer(plan, userProfile);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="BroSplit-Nutrition-Plan.pdf"');
    res.send(buffer);
  } catch (err) {
    console.error("Nutrition PDF error:", err);
    res.status(500).json({ error: 'Failed to build nutrition PDF' });
  }
});

// ─── 7) Health & Server start ────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server listening on :${PORT}`));
