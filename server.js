// File: server.js (BroSplit AI)
// Focus: split PDFs for Pro (workout + nutrition), single PDF for Base (workout only)
// + robust JSON + auto-repair to ensure 7-day nutrition with N meals/day
// + smart batch-prep derived from the actual grocery list & meals

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import Stripe from 'stripe';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { makePrompt, makeNutritionPrompt } from './prompt.js';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Resend } from 'resend';

// —— ESM __dirname shim ————————————————————————————————————————————————
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config();

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.json({ limit: '1mb' }));
app.use(cors({ origin: '*', credentials: true }));
app.use(helmet());
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

// ─── Stripe ───────────────────────────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PRICE_BASE = process.env.STRIPE_PRICE_BASE || 'price_1RsQJUAhLaqVN2Rssepup9EE';
const PRICE_PRO  = process.env.STRIPE_PRICE_PRO  || 'price_1RsQJUAhLaqVN2Rssepup9EE';

// ─── OpenAI ───────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const genLimiter = rateLimit({ windowMs: 60_000, limit: 12 });

// ─── Resend (email) ───────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── PDF helpers ──────────────────────────────────────────────────────────────
function createStyledDoc({ theme = 'blue' } = {}) {
  const color = theme === 'teal' ? '#0ea5e9' : '#2563eb';
  const subColor = '#111827';
  const ruleColor = '#e5e7eb';
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 }, bufferPages: true });
  const styles = {
    h1: { font: 'Helvetica-Bold', size: 24, color },
    h2: { font: 'Helvetica-Bold', size: 16, color: subColor },
    body: { font: 'Helvetica', size: 11.5, color: subColor, lineGap: 5 },
    small: { font: 'Helvetica', size: 9, color: '#6b7280' }
  };
  const apply = s => doc.font(s.font).fontSize(s.size).fillColor(s.color);
  const rule = () => {
    doc.moveDown(0.5);
    doc.strokeColor(ruleColor).lineWidth(0.7).moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
    doc.moveDown(0.5);
  };
  return { doc, styles, apply, rule };
}

function addPageNumbersAndEnd(doc, smallStyle) {
  doc.flushPages();
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.font(smallStyle.font).fontSize(smallStyle.size).fillColor(smallStyle.color);
    doc.text(`Page ${i + 1} of ${range.count}`, 0, doc.page.height - 40, { align: 'center' });
  }
  doc.end();
}

function parseWorkoutPlanText(planText) {
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
  return weeks;
}

function renderWorkoutSection({ doc, styles, apply, rule }, planText, userProfile = {}) {
  apply(styles.h1); doc.text('Your Personal 6-Week Program', { align: 'center' }); doc.moveDown(0.5);
  apply(styles.body); doc.text(`Hey ${userProfile.name || 'Athlete'} — let’s get to work.`, { align: 'center' });
  try {
    const logoPath = path.join(__dirname, 'assets', 'BroSplitLogo.png');
    if (fs.existsSync(logoPath)) doc.image(logoPath, (doc.page.width - 220) / 2, doc.page.height / 2 - 60, { width: 220 });
  } catch {}
  doc.addPage();

  apply(styles.h2); doc.text('Pro Tips'); rule();
  apply(styles.body);
  [
    'Progressive Overload: add a little weekly.',
    'Recovery: 7–9h sleep.',
    'Protein: 0.8–1g/lb bodyweight.',
    'Log training; chase quality reps.'
  ].forEach(t => doc.text(`• ${t}`, { indent: 18 }));
  doc.addPage();

  const weeks = parseWorkoutPlanText(planText).slice(0, 6);
  weeks.forEach(week => {
    apply(styles.h2); doc.text(`Week ${week.number}`); rule();
    week.days.forEach(day => {
      apply(styles.h1); doc.text(day.name);
      apply(styles.body);
      day.ex.forEach(e => doc.text(`• ${e}`, { indent: 18 }));
      doc.moveDown(0.6);
    });
    doc.addPage();
  });

  apply(styles.h2); doc.text('Stay Consistent'); rule();
  apply(styles.body); doc.text('Track workouts & recovery. You’ve got this!');
}

function renderNutritionSection({ doc, styles, apply, rule }, plan, userProfile = {}) {
  const nPlan = plan || {};
  const summary = nPlan.summary || {};
  const guidelines = nPlan.guidelines || {};
  const days = nPlan.day_plans || nPlan.days || [];
  const grocery = (nPlan.grocery_list && nPlan.grocery_list.items) || nPlan.grocery_list || [];
  const batch = nPlan.batch_prep || [];

  doc.addPage();
  apply(styles.h1); doc.text('Your Personalized Nutrition Plan', { align: 'center' }); doc.moveDown(0.5);
  apply(styles.body); doc.text(`Prepared for ${userProfile.name || 'Athlete'}`, { align: 'center' });
  doc.addPage();

  apply(styles.h2); doc.text('Daily Targets'); rule(); apply(styles.body);
  const chips = [
    `Calories: ${summary.calories || summary.kcal || '—'} kcal`,
    `Protein: ${summary.protein_g ?? '—'} g`,
    `Carbs: ${summary.carbs_g ?? '—'} g`,
    `Fat: ${summary.fat_g ?? '—'} g`,
    `Fiber: ${summary.fiber_target_g ?? '—'} g`,
    `Sodium cap: ${summary.sodium_cap_mg ?? '—'} mg`,
    `Meals/day: ${summary.meals_per_day ?? '—'}`
  ].filter(Boolean);
  chips.forEach(c => doc.text(`• ${c}`));
  doc.addPage();

  apply(styles.h2); doc.text('Guidelines'); rule(); apply(styles.body);
  if (guidelines.protein_per_meal_rule) doc.text(`• Protein/meal: ${guidelines.protein_per_meal_rule}`);
  if (guidelines.pre_post)            doc.text(`• Pre/Post training: ${guidelines.pre_post}`);
  if (guidelines.notes)               doc.text(`• Notes: ${guidelines.notes}`);
  doc.addPage();

  (Array.isArray(days) ? days : []).forEach((d, idx) => {
    apply(styles.h2);
    const kcal = d.total_kcal || summary.calories || summary.kcal || '';
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

  apply(styles.h2); doc.text('Grocery List'); rule(); apply(styles.body);
  (Array.isArray(grocery) ? grocery : []).forEach(it => {
    const item = it.item || it.name || it;
    const unit = it.kg ? `${it.kg} kg` : it.ml ? `${it.ml} ml` : it.count ? `${it.count} ct` : '';
    doc.text(`• ${item}${unit ? ` — ${unit}` : ''}`);
  });
  doc.addPage();

  apply(styles.h2); doc.text('Batch Prep'); rule(); apply(styles.body);
  (Array.isArray(batch) ? batch : []).forEach(b => {
    const steps = Array.isArray(b.steps) ? b.steps.join(' • ') : (b.instructions || '');
    doc.text(`• ${b.day || ''}: ${steps}`);
  });
}

function generateWorkoutPDF(planText, userProfile = {}) {
  const kit = createStyledDoc({ theme: 'blue' });
  renderWorkoutSection(kit, planText, userProfile);
  addPageNumbersAndEnd(kit.doc, kit.styles.small);
  return kit.doc;
}
function generateNutritionPDF(nPlan, userProfile = {}) {
  const kit = createStyledDoc({ theme: 'blue' });
  renderNutritionSection(kit, nPlan, userProfile);
  addPageNumbersAndEnd(kit.doc, kit.styles.small);
  return kit.doc;
}
function generateUnifiedPDF(workoutText, nutritionJson, userProfile = {}) {
  const kit = createStyledDoc({ theme: 'blue' });
  renderWorkoutSection(kit, workoutText, userProfile);
  renderNutritionSection(kit, nutritionJson, userProfile);
  addPageNumbersAndEnd(kit.doc, kit.styles.small);
  return kit.doc;
}

const toBuffer = (doc) => new Promise((resolve, reject) => {
  const bufs = []; doc.on('data', c => bufs.push(c)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
});

// ─── Checkout ────────────────────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  try {
    const planType = (req.body.planType || 'workout').toLowerCase();
    const price = planType === 'pro' ? PRICE_PRO : PRICE_BASE;

    const session = await stripe.checkout.sessions.create({
      line_items: [{ price, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&plan=${planType}`,
      cancel_url: `${process.env.FRONTEND_URL}/`,
      metadata: { planType }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).send('Stripe error');
  }
});

// ─── Stripe session check ────────────────────────────────────────────────────
async function requireProSession(sessionId) {
  if (!sessionId) throw new Error('NO_SESSION');
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') throw new Error('NOT_PAID');
  const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 10 });
  const hasPro = items.data.some(li =>
    (li.price && li.price.id === PRICE_PRO) || li.amount_total === 1500 || li.amount_subtotal === 1500
  );
  if (!hasPro) throw new Error('NOT_PRO');
  return session;
}

// ─── Workout plan generation ─────────────────────────────────────────────────
app.post('/api/generate-plan', genLimiter, async (req, res) => {
  try {
    const { sessionId, daysPerWeek, equipment, injuries, experience, goal, dislikes, focusMuscle, age, sex, bodyweight, lifts } = req.body;

    if (sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== 'paid') return res.status(402).send('Payment required');
    }

    const prompt = makePrompt({ daysPerWeek, equipment, injuries, experience, goal, dislikes, focusMuscle, age, sex, bodyweight, lifts });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      temperature: 0.7,
      max_tokens: 4500,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ plan: completion.choices[0].message.content });
  } catch (err) {
    console.error('Plan generation error:', err);
    res.status(500).send('Plan generation error');
  }
});

// ─── Nutrition input + math ──────────────────────────────────────────────────
const NutritionInput = z.object({
  sex: z.enum(['male','female']),
  age: z.number().int().min(13).max(90),
  height_cm: z.number().min(120).max(230),
  weight_kg: z.number().min(35).max(250),
  activity: z.enum(['sedentary','light','moderate','very_active']),
  goal: z.enum(['cut','recomp','gain']),
  training_load: z.enum(['light','moderate','high']),
  meals_per_day: z.number().int().min(3).max(6).default(4),
  cuisine_prefs: z.array(z.string()).default([]),
  diet_prefs: z.array(z.enum(['none','vegetarian','vegan','pescatarian','halal','kosher','dairy_free','gluten_free'])).default(['none']),
  allergies: z.array(z.string()).default([]),
  budget_level: z.enum(['tight','normal','flex']).default('normal'),
  name: z.string().optional(),
  email: z.string().email().optional(),
  sessionId: z.string().optional()
});

const AF = { sedentary:1.2, light:1.375, moderate:1.55, very_active:1.725 };
function mifflin({ sex, age, height_cm, weight_kg }) { return 10*weight_kg + 6.25*height_cm - 5*age + (sex === 'male' ? 5 : -161); }
function calorieGoal(rmr, activity, goal) { const tdee = rmr * AF[activity]; const adj = goal === 'cut' ? 0.80 : goal === 'gain' ? 1.12 : 0.95; return Math.round(tdee * adj); }
function macroTargets({ weight_kg, kcal, goal, training_load }) {
  const protein_g = Math.round((goal === 'cut' ? 2.2 : 1.8) * weight_kg);
  let fat_g = Math.round((kcal * 0.30) / 9);
  const band = training_load === 'high' ? [8,10] : training_load === 'moderate' ? [5,7] : [3,5];
  const minCarb_g = Math.round(band[0] * weight_kg);
  let carbs_g = Math.round((kcal - (protein_g*4 + fat_g*9)) / 4);
  if (carbs_g < minCarb_g) { fat_g = Math.round((kcal * 0.22) / 9); carbs_g = Math.round((kcal - (protein_g*4 + fat_g*9)) / 4); }
  const fiber_g = Math.round((kcal / 1000) * 14);
  const sodium_mg_cap = 2300;
  return { kcal, protein_g, carbs_g, fat_g, fiber_g, sodium_mg_cap };
}

// ─── Nutrition JSON guards/repair ────────────────────────────────────────────
function rescueJson(s) {
  try {
    const cleaned = String(s || '').replace(/```json|```/g, '').trim();
    const first = cleaned.indexOf('{'); const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last !== -1) return JSON.parse(cleaned.slice(first, last + 1));
  } catch {}
  return null;
}
function needsRepair(plan, mealsPerDay) {
  const days = plan?.day_plans || plan?.days || [];
  if (!Array.isArray(days) || days.length < 7) return true;
  return days.some(d => !Array.isArray(d.meals) || d.meals.length < mealsPerDay);
}
async function expandPlanWithModel({ basePlan, targets, mealsPerDay }) {
  const messages = [
    { role: 'system', content: 'Return ONLY strict JSON with keys: summary, guidelines, day_plans, grocery_list, batch_prep.' },
    { role: 'user', content:
`Expand/repair this to a complete 7-day plan.
- Use these daily targets: ${JSON.stringify(targets)}
- EXACTLY ${mealsPerDay} meals per day.
- Keep fields: day, total_kcal, meals[{name, recipe, macros{kcal,protein_g,carbs_g,fat_g}, ingredients[{item, grams?, ml?, count?, qty?}]}].
- Keep a simple grocery_list and batch_prep.
JSON:\n${JSON.stringify(basePlan)}` }
  ];
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: 0,
    max_tokens: 3500,
    response_format: { type: 'json_object' },
    messages
  });
  return JSON.parse(completion.choices[0].message.content);
}
function expandProgrammatically(plan, mealsPerDay) {
  const out = JSON.parse(JSON.stringify(plan || {}));
  let days = Array.isArray(out.day_plans) ? out.day_plans : (Array.isArray(out.days) ? out.days : []);
  if (!Array.isArray(days)) days = [];
  if (days.length === 0) days.push({ day: 1, total_kcal: out?.summary?.calories || out?.summary?.kcal || 0, meals: [] });
  // Ensure meals per day
  days.forEach(d => {
    d.meals = Array.isArray(d.meals) ? d.meals : [];
    while (d.meals.length < mealsPerDay) {
      const src = d.meals[d.meals.length - 1] || { name: 'Meal', recipe: 'Protein + carb + veg', macros: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, ingredients: [] };
      d.meals.push(JSON.parse(JSON.stringify(src)));
    }
  });
  while (days.length < 7) {
    const base = days[days.length - 1] || days[0];
    const clone = JSON.parse(JSON.stringify(base));
    clone.day = days.length + 1;
    if (clone.meals && clone.meals.length > 1) clone.meals.push(clone.meals.shift());
    days.push(clone);
  }
  out.day_plans = days;
  delete out.days;
  return out;
}

// ─── Batch-Prep enrichment helpers ───────────────────────────────────────────
function norm(s) { return String(s || '').toLowerCase(); }
function prettyJoin(arr) {
  if (!arr || arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(', ') + ' & ' + arr[arr.length - 1];
}
const KW = {
  proteins: [
    'chicken', 'beef', 'turkey', 'tuna', 'salmon', 'shrimp', 'cod', 'egg', 'eggs',
    'tofu', 'tempeh', 'pork', 'yogurt', 'cottage cheese', 'beef strips',
    'lentil', 'chickpea', 'black bean', 'beans'
  ],
  carbs: [
    'rice', 'brown rice', 'quinoa', 'oats', 'rolled oats', 'pasta', 'noodle',
    'potato', 'sweet potato', 'bread', 'whole grain bread', 'wrap', 'tortilla'
  ],
  veg: [
    'broccoli', 'spinach', 'mixed greens', 'greens', 'asparagus', 'green beans',
    'mixed vegetables', 'zucchini', 'bell pepper', 'peppers', 'lettuce',
    'salad', 'carrot', 'celery', 'corn'
  ],
  breakfast: [
    'oats', 'rolled oats', 'yogurt', 'almond milk', 'milk', 'berries', 'banana',
    'protein powder', 'honey', 'toast'
  ],
  sauces: [
    'olive oil', 'soy sauce', 'curry', 'tomato sauce', 'salsa', 'tahini',
    'peanut butter', 'almond butter'
  ]
};
function extractItemNames(plan) {
  let names = [];
  const gl = (plan?.grocery_list && plan.grocery_list.items) || plan?.grocery_list || [];
  if (Array.isArray(gl) && gl.length) {
    names = gl.map(it => norm(it.item || it.name || it));
  } else {
    const days = plan?.day_plans || plan?.days || [];
    days.forEach(d => (d.meals || []).forEach(m => {
      (m.ingredients || []).forEach(i => names.push(norm(i.item || i.name || i)));
    }));
  }
  return Array.from(new Set(names.filter(Boolean)));
}
function filterByKeywords(names, keywords) {
  const out = [];
  names.forEach(n => {
    const hit = keywords.find(k => n.includes(k));
    if (hit) out.push(n.replace(/[-–]\s*\d+.*$/, '').trim());
  });
  return Array.from(new Set(out));
}
function buildBatchPrepFromPlan(plan, mealsPerDay) {
  const names = extractItemNames(plan);
  const proteins = filterByKeywords(names, KW.proteins);
  const carbs    = filterByKeywords(names, KW.carbs);
  const veg      = filterByKeywords(names, KW.veg);
  const brk      = filterByKeywords(names, KW.breakfast);
  const sauces   = filterByKeywords(names, KW.sauces);

  const stepsSun = [];
  const stepsThu = [];

  if (proteins.length) {
    const eggs = proteins.filter(p => p.includes('egg'));
    const nonEggs = proteins.filter(p => !p.includes('egg'));
    if (nonEggs.length) {
      stepsSun.push(`Cook proteins in bulk: ${prettyJoin(nonEggs)}. Season simply (salt/pepper). Portion for ~3–4 days; freeze extra.`);
    }
    if (eggs.length) {
      stepsSun.push(`Hard-boil eggs for quick meals/snacks.`);
    }
    stepsThu.push(`Top-up proteins (${prettyJoin(proteins)}). Reheat from frozen if pre-portioned.`);
  }

  if (carbs.length) {
    const ovenables = carbs.filter(c => c.includes('potato'));
    const stovetop  = carbs.filter(c => !c.includes('potato'));
    if (stovetop.length) stepsSun.push(`Batch-cook grains/carbs: ${prettyJoin(stovetop)}.`);
    if (ovenables.length) stepsSun.push(`Roast/bake: ${prettyJoin(ovenables)}.`);
    stepsThu.push(`Cook a small fresh batch of carbs if low (e.g., ${prettyJoin(carbs.slice(0,3))}).`);
  }

  if (veg.length) {
    const leafy = veg.filter(v => v.includes('green') || v.includes('spinach') || v.includes('salad') || v.includes('lettuce'));
    const firm  = veg.filter(v => !leafy.includes(v));
    if (firm.length) stepsSun.push(`Wash/chop sturdy veg: ${prettyJoin(firm)}. Store in airtight containers.`);
    if (leafy.length) stepsSun.push(`Rinse/dry leafy greens (${prettyJoin(leafy)}); keep with paper towel to stay crisp.`);
    stepsThu.push(`Refresh veg: chop a new batch and portion for lunches/dinners.`);
  }

  if (brk.length) {
    stepsSun.push(`Assemble ${mealsPerDay >= 4 ? 'overnight oats / smoothie packs' : 'breakfast packs'} using ${prettyJoin(brk.slice(0,5))}.`);
  }

  if (sauces.length) {
    stepsSun.push(`Mix quick sauces/marinades: ${prettyJoin(sauces.slice(0,4))}. Store in jars.`);
  }

  stepsSun.push(`Label containers with meal/day. Aim for ${mealsPerDay} meals per day × 7 days.`);
  stepsThu.push(`Re-portion snacks; take inventory; adjust portions to stay on target.`);

  return [
    { day: 'Sunday',   steps: stepsSun },
    { day: 'Thursday', steps: stepsThu }
  ];
}
function ensureBatchPrep(plan, mealsPerDay) {
  const current = Array.isArray(plan?.batch_prep) ? plan.batch_prep : [];
  const weak = current.length < 2 || current.reduce((n, d) => n + ((d?.steps || []).length), 0) < 4;
  if (weak) {
    plan.batch_prep = buildBatchPrepFromPlan(plan, mealsPerDay);
  } else {
    const generated = buildBatchPrepFromPlan(plan, mealsPerDay);
    const have = new Set(current.flatMap(d => (d.steps || [])));
    generated.forEach(g => {
      const slot = current.find(d => norm(d.day) === norm(g.day)) || (current.push({ day: g.day, steps: [] }), current[current.length-1]);
      g.steps.forEach(s => { if (!have.has(s)) slot.steps.push(s); });
    });
    plan.batch_prep = current;
  }
  return plan;
}

// ─── Nutrition generation (PRO-gated) ────────────────────────────────────────
app.post('/api/nutrition', genLimiter, async (req, res) => {
  try {
    const input = NutritionInput.parse(req.body);

    // PRO gate
    try { await requireProSession(input.sessionId); }
    catch (e) {
      if (e.message === 'NO_SESSION') return res.status(401).json({ error: 'Missing sessionId' });
      if (e.message === 'NOT_PAID') return res.status(402).json({ error: 'Payment required' });
      if (e.message === 'NOT_PRO')  return res.status(403).json({ error: 'Nutrition is available with the Pro plan' });
      throw e;
    }

    const rmr = mifflin(input);
    const kcal = calorieGoal(rmr, input.activity, input.goal);
    const targets = macroTargets({ weight_kg: input.weight_kg, kcal, goal: input.goal, training_load: input.training_load });

    const prompt = makeNutritionPrompt({ input, targets });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      temperature: 0,
      max_tokens: 3500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a sports nutrition assistant. Use the supplied targets verbatim. Respond ONLY with valid JSON — no prose, no code fences.' },
        { role: 'user', content: prompt }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content ?? '';
    let planJson;
    try { planJson = JSON.parse(raw); }
    catch { planJson = rescueJson(raw); }

    if (!planJson) {
      console.error('Nutrition JSON parse failed. Raw (first 400 chars):', raw.slice(0, 400));
      return res.status(502).json({ error: 'Model returned invalid JSON', raw, targets });
    }

    // Enforce 7 days and EXACT meals/day selected by user
    const mealsPerDay = Number(input.meals_per_day || 4);
    let finalPlan = planJson;
    if (needsRepair(finalPlan, mealsPerDay)) {
      try {
        finalPlan = await expandPlanWithModel({ basePlan: finalPlan, targets, mealsPerDay });
      } catch {
        console.warn('Model repair failed — falling back to programmatic expansion.');
        finalPlan = expandProgrammatically(finalPlan, mealsPerDay);
      }
    }

    // Ensure batch_prep reflects ALL proteins/carbs/veg in the plan
    finalPlan = ensureBatchPrep(finalPlan, mealsPerDay);

    // Persist meals/day into summary if missing
    finalPlan.summary = finalPlan.summary || {};
    if (typeof finalPlan.summary.meals_per_day === 'undefined') {
      finalPlan.summary.meals_per_day = mealsPerDay;
    }

    res.json({ targets, plan: finalPlan });
  } catch (err) {
    console.error('Nutrition generation error:', err);
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid nutrition input', details: err.errors });
    res.status(500).json({ error: 'Nutrition generation error' });
  }
});

// ─── Email & PDFs ────────────────────────────────────────────────────────────
async function sendPlansWithResend({ email, workoutText, nutritionJson, userProfile = {}, merge = false }) {
  if (!email || !workoutText) throw new Error('EMAIL_OR_PLAN_MISSING');

  if (nutritionJson && merge) {
    const uDoc = generateUnifiedPDF(workoutText, nutritionJson, userProfile);
    const uBuf = await toBuffer(uDoc);
    await resend.emails.send({
      from: 'support@brosplit.org',
      to: email,
      subject: `Your Plan is Ready${userProfile.name ? `, ${userProfile.name}` : ''}`,
      html: `<p>Your personalized plan is attached (workout + nutrition).</p>`,
      attachments: [{ filename: 'BroSplit-Complete-Plan.pdf', content: uBuf.toString('base64'), type: 'application/pdf' }]
    });
    return;
  }

  const wDoc = generateWorkoutPDF(workoutText, userProfile);
  const wBuf = await toBuffer(wDoc);
  const attachments = [{ filename: 'BroSplit-Workout-Plan.pdf', content: wBuf.toString('base64'), type: 'application/pdf' }];

  if (nutritionJson) {
    const nDoc = generateNutritionPDF(nutritionJson, userProfile);
    const nBuf = await toBuffer(nDoc);
    attachments.push({ filename: 'BroSplit-Nutrition-Plan.pdf', content: nBuf.toString('base64'), type: 'application/pdf' });
  }

  await resend.emails.send({
    from: 'support@brosplit.org',
    to: email,
    subject: `Your Plan is Ready${userProfile.name ? `, ${userProfile.name}` : ''}`,
    html: `<p>Your personalized plan is attached.${nutritionJson ? ' Includes workout + nutrition PDFs.' : ''}</p>`,
    attachments
  });
}

app.post('/api/email-plan', async (req, res) => {
  try {
    const { email, plan, nutrition, userProfile = {}, merge } = req.body;
    await sendPlansWithResend({ email, workoutText: plan, nutritionJson: nutrition, userProfile, merge: merge ?? false });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Email delivery failed:', err);
    res.status(500).json({ error: 'Email delivery failed' });
  }
});

app.post('/api/nutrition-pdf', async (req, res) => {
  try {
    const { plan, userProfile = {} } = req.body;
    if (!plan) return res.status(400).json({ error: 'Missing plan JSON' });
    const doc = generateNutritionPDF(plan, userProfile);
    const buf = await toBuffer(doc);
    res.json({ base64: buf.toString('base64') });
  } catch (e) {
    console.error('nutrition-pdf:', e);
    res.status(500).json({ error: 'Failed to generate nutrition PDF' });
  }
});

app.post('/api/unified-pdf', async (req, res) => {
  try {
    const { workoutText, nutritionJson, userProfile = {} } = req.body;
    if (!workoutText || !nutritionJson) return res.status(400).json({ error: 'Missing workoutText or nutritionJson' });
    const doc = generateUnifiedPDF(workoutText, nutritionJson, userProfile);
    const buf = await toBuffer(doc);
    res.json({ base64: buf.toString('base64') });
  } catch (e) {
    console.error('unified-pdf:', e);
    res.status(500).json({ error: 'Failed to generate unified PDF' });
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server listening on :${PORT}`));
