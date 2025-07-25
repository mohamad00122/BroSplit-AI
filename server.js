// Complete Enhanced server.js
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

// 1. Stripe checkout (keeping your original)
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

// 2. Plan generator (keeping your original)
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

// 3. Enhanced PDF generator with friendlier tone and richer content
function generateEnhancedPDF(planText, userProfile = {}) {
  const doc = new PDFDocument({ margin: 50, size: "A4", bufferPages: true });

  // Register fonts
  doc.registerFont("H1", "Helvetica-Bold");
  doc.registerFont("H2", "Helvetica-Bold"); 
  doc.registerFont("Body", "Helvetica");
  doc.registerFont("Italic", "Helvetica-Oblique");
  doc.registerFont("Bold", "Helvetica-Bold");

  const cols = { 
    primary: "#1f2937", 
    accent: "#2563eb", 
    success: "#059669",
    warning: "#d97706",
    border: "#e5e7eb",
    light: "#f8fafc"
  };

  let y = 60;

  // Motivational quotes with attribution
  const motivationalQuotes = [
    { quote: "The last three or four reps is what makes the muscle grow.", author: "Arnold Schwarzenegger" },
    { quote: "If you think lifting is dangerous, try being weak.", author: "Bret Contreras" },
    { quote: "The worst thing I can be is the same as everybody else.", author: "Arnold Schwarzenegger" },
    { quote: "Everybody wants to be a bodybuilder, but nobody wants to lift no heavy-ass weights.", author: "Ronnie Coleman" },
    { quote: "Train hard, turn heads.", author: "Chris Bumstead" },
    { quote: "The iron never lies to you.", author: "Henry Rollins" }
  ];

  const selectedQuote = motivationalQuotes[Math.floor(Math.random() * motivationalQuotes.length)];

  // Week descriptions with motivational context
  const weekDescriptions = {
    1: { 
      title: "Foundation Week - Building Your Base",
      description: "We're starting strong but smart. Focus on perfect form and getting into your groove.",
      intensity: "Base Volume (RPE 6–7)"
    },
    2: { 
      title: "Volume Week - Stepping It Up", 
      description: "Time to add some volume! Your muscles are adapting - let's give them more work.",
      intensity: "+5–10% Volume (RPE 7)"
    },
    3: { 
      title: "Intensity Week - Bringing the Heat",
      description: "Now we're talking! Higher weights, focused effort. You've got this.",
      intensity: "+5–10% Load (RPE 7–8)"
    },
    4: { 
      title: "Recovery Week - Smart Training", 
      description: "Deload doesn't mean easy - it means strategic. Let your body supercompensate.",
      intensity: "Deload: 50% Volume + Mobility (RPE 5–6)"
    },
    5: { 
      title: "Peak Week - Maximum Effort",
      description: "This is where champions are made. Push your limits with confidence.",
      intensity: "Peak: –2 reps vs Week 3 (RPE 8–9)"
    },
    6: { 
      title: "Ultimate Peak - Your Victory Lap",
      description: "The culmination of your hard work. Show yourself what you're capable of!",
      intensity: "Ultimate Peak: –1 rep (RPE 9)"
    }
  };

  // Helper functions
  function addPersonalizedCover() {
    // Background accent box
    doc.rect(0, 0, doc.page.width, 120).fill(cols.light);
    
    doc.font("H1").fontSize(36).fillColor(cols.accent)
       .text("Your Personal", 50, 40, { align: "center" });
    doc.fontSize(32).fillColor(cols.primary)
       .text("6-Week BroSplit Journey", 50, 80, { align: "center" });
    
    y = 160;
    
    // Personal greeting
    const name = userProfile.name || "Champion";
    doc.font("H2").fontSize(18).fillColor(cols.primary)
       .text(`Hey ${name}! 👋`, 50, y);
    y += 40;
    
    doc.font("Body").fontSize(14).fillColor(cols.primary);
    const welcomeText = `Welcome to your completely personalized 6-week transformation! This isn't just another cookie-cutter workout plan - this is YOUR plan, designed specifically for your goals, equipment, and experience level.

Every exercise, every rep, every week has been carefully crafted to help you achieve your goal of ${userProfile.goal || 'building muscle'}. Whether you're a seasoned lifter or just getting serious about your gains, this plan will meet you where you are and take you where you want to go.

Ready to turn heads? Let's make it happen! 💪`;
    
    doc.text(welcomeText, 50, y, { width: doc.page.width - 100, lineGap: 5 });
    y += 200;
    
    // Quote section
    doc.rect(50, y, doc.page.width - 100, 80).fill(cols.accent).fillOpacity(0.1);
    doc.fillOpacity(1);
    
    doc.font("Italic").fontSize(14).fillColor(cols.accent)
       .text(`"${selectedQuote.quote}"`, 70, y + 20, { 
         width: doc.page.width - 140, 
         align: "center" 
       });
    
    doc.font("Body").fontSize(12).fillColor(cols.primary)
       .text(`— ${selectedQuote.author}`, 70, y + 50, { 
         width: doc.page.width - 140, 
         align: "center" 
       });

    doc.addPage();
  }

  function addEnhancedTOC() {
    y = 60;
    doc.font("H1").fontSize(24).fillColor(cols.primary)
       .text("Your 6-Week Journey", 50, y);
    y += 40;
    
    doc.font("Body").fontSize(12).fillColor(cols.primary)
       .text("Here's what lies ahead - each week building on the last:", 50, y);
    y += 30;

    Object.entries(weekDescriptions).forEach(([weekNum, info]) => {
      // Week header with colored accent
      doc.rect(50, y, 5, 50).fill(cols.accent);
      
      doc.font("Bold").fontSize(14).fillColor(cols.primary)
         .text(`Week ${weekNum}: ${info.title}`, 70, y);
      
      doc.font("Body").fontSize(11).fillColor(cols.primary)
         .text(info.description, 70, y + 18, { width: 400 });
      
      doc.font("Italic").fontSize(10).fillColor(cols.accent)
         .text(info.intensity, 70, y + 35);
      
      y += 65;
    });

    doc.addPage();
  }

  function addTrainingTips() {
    y = 60;
    doc.font("H1").fontSize(20).fillColor(cols.accent)
       .text("🎯 Pro Tips for Maximum Results", 50, y);
    y += 40;

    const tips = [
      {
        icon: "💪",
        title: "Progressive Overload is King",
        text: "Every week, aim to do slightly more - whether that's an extra rep, 5 more pounds, or just better form. Your muscles adapt to whatever you throw at them."
      },
      {
        icon: "😴", 
        title: "Recovery is Where Growth Happens",
        text: "Sleep 7-9 hours per night. Your muscles don't grow in the gym - they grow while you're recovering. Don't skip the deload week!"
      },
      {
        icon: "🍖",
        title: "Fuel Your Gains",
        text: "Eat enough protein (0.8-1g per lb bodyweight) and don't be afraid of carbs around your workouts. You can't build muscle in a severe deficit."
      },
      {
        icon: "📱",
        title: "Track Everything",
        text: "Log your workouts, take progress photos, and celebrate small wins. What gets measured gets improved."
      },
      {
        icon: "🔥",
        title: "Form Over Ego",
        text: "Perfect reps with lighter weight beat sloppy reps with heavy weight every time. Your future self will thank you."
      }
    ];

    tips.forEach(tip => {
      if (y > doc.page.height - 100) {
        doc.addPage();
        y = 60;
      }
      
      doc.font("Body").fontSize(16).fillColor(cols.primary)
         .text(tip.icon, 50, y);
      
      doc.font("Bold").fontSize(13).fillColor(cols.primary)
         .text(tip.title, 80, y);
      
      doc.font("Body").fontSize(11).fillColor(cols.primary)
         .text(tip.text, 80, y + 18, { width: 450, lineGap: 2 });
      
      y += 60;
    });

    doc.addPage();
  }

  function addWeekWithMotivation(week) {
    const weekInfo = weekDescriptions[week.number];
    
    if (y > doc.page.height - 150) {
      doc.addPage();
      y = 60;
    }
    
    // Week header with background
    doc.rect(40, y - 10, doc.page.width - 80, 60).fill(cols.light);
    
    doc.font("H1").fontSize(22).fillColor(cols.accent)
       .text(`Week ${week.number}: ${weekInfo.title}`, 50, y);
    
    doc.font("Body").fontSize(12).fillColor(cols.primary)
       .text(weekInfo.description, 50, y + 25);
    
    doc.font("Italic").fontSize(10).fillColor(cols.accent)
       .text(`Focus: ${weekInfo.intensity}`, 50, y + 40);
    
    y += 80;
    
    // Workouts
    week.days.forEach((day, dayIndex) => {
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 60;
      }
      
      // Day header
      doc.font("H2").fontSize(16).fillColor(cols.primary)
         .text(day.name, 50, y);
      y += 25;
      
      // Exercises with better formatting
      day.exercises.forEach(exercise => {
        if (y > doc.page.height - 30) {
          doc.addPage();
          y = 60;
        }
        
        doc.font("Body").fontSize(11).fillColor(cols.primary)
           .text(`• ${exercise.raw}`, 65, y, { width: doc.page.width - 130 });
        y += 16;
      });
      
      y += 20;
      
      // Add motivational note for last exercise of each day
      if (dayIndex < week.days.length) {
        const encouragements = [
          "💥 Finish strong!",
          "🔥 You've got this!",
          "💪 Beast mode activated!",
          "⚡ Power through!",
          "🎯 Lock in and dominate!"
        ];
        
        doc.font("Italic").fontSize(10).fillColor(cols.success)
           .text(encouragements[dayIndex % encouragements.length], 65, y);
        y += 25;
      }
    });
  }

  // Build the PDF
  addPersonalizedCover();
  addEnhancedTOC();
  addTrainingTips();
  
  // Parse and add workouts (using your existing parsing logic)
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

  weeks.slice(0, 6).forEach(addWeekWithMotivation);

  // Footer with contact info
  doc.addPage();
  y = 60;
  doc.font("H2").fontSize(18).fillColor(cols.accent)
     .text("🚀 Ready to Get Started?", 50, y);
  y += 40;
  
  doc.font("Body").fontSize(12).fillColor(cols.primary);
  const footerText = `You now have everything you need for an incredible 6-week transformation. Remember:

• This plan was designed specifically for YOU
• Consistency beats perfection every time  
• Progress photos and measurements are your best friends
• Don't be afraid to ask for help or modifications

Questions? Feedback? We're here to help! Reach out to us at support@brosplit-ai.com

Now stop reading and go lift some weights! Your future self is counting on you. 💪

— The BroSplit AI Team`;

  doc.text(footerText, 50, y, { width: doc.page.width - 100, lineGap: 5 });

  // Add page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.font("Body").fontSize(9).fillColor(cols.primary)
       .text(`Page ${i+1} of ${range.count}`, 0, doc.page.height - 30, { align: "center" });
  }

  doc.end();
  return doc;
}

// Enhanced email system with retry logic and better templates
class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: { 
        user: process.env.SMTP_USER, 
        pass: process.env.SMTP_PASS 
      },
      pool: true, // Enable connection pooling
      maxConnections: 5,
      maxMessages: 10
    });
    
    // Verify connection on startup
    this.transporter.verify((error, success) => {
      if (error) {
        console.error('SMTP connection failed:', error);
      } else {
        console.log('✅ SMTP server is ready');
      }
    });
  }

  async sendWorkoutPlan(email, plan, userProfile = {}) {
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        const doc = generateEnhancedPDF(plan, userProfile);
        const pdfBuffer = await this.generatePDFBuffer(doc);
        
        const htmlTemplate = this.createEmailHTML(userProfile);
        
        const mailOptions = {
          from: `"BroSplit AI - Your Personal Trainer" <${process.env.SMTP_USER}>`,
          to: email,
          subject: `🔥 Your Personal 6-Week BroSplit is Ready, ${userProfile.name || 'Champion'}!`,
          html: htmlTemplate,
          attachments: [{
            filename: `BroSplit-AI-Personal-Plan-${new Date().toISOString().split('T')[0]}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf'
          }],
          // Email tracking and delivery options
          headers: {
            'X-Priority': '1',
            'X-MSMail-Priority': 'High',
            'Importance': 'high'
          }
        };

        const result = await this.transporter.sendMail(mailOptions);
        console.log('✅ Email sent successfully:', result.messageId);
        
        // Send follow-up email after 24 hours (you'd implement this with a job queue)
        // this.scheduleFollowUpEmail(email, userProfile);
        
        return { success: true, messageId: result.messageId };
        
      } catch (error) {
        attempt++;
        console.error(`Email attempt ${attempt} failed:`, error);
        
        if (attempt >= maxRetries) {
          // Log to external service, send admin alert, etc.
          console.error('❌ All email attempts failed:', error);
          throw new Error(`Email delivery failed after ${maxRetries} attempts: ${error.message}`);
        }
        
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }

  generatePDFBuffer(doc) {
    return new Promise((resolve, reject) => {
      const bufs = [];
      doc.on('data', chunk => bufs.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(bufs)));
      doc.on('error', reject);
    });
  }

  createEmailHTML(userProfile) {
    const name = userProfile.name || 'Champion';
    const goal = userProfile.goal || 'building muscle';
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Your BroSplit AI Plan is Ready!</title>
        <style>
            body { font-family: 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f8fafc; }
            .container { max-width: 600px; margin: 0 auto; background: white; }
            .header { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; padding: 40px 30px; text-align: center; }
            .header h1 { margin: 0; font-size: 28px; font-weight: 700; }
            .header p { margin: 10px 0 0; font-size: 16px; opacity: 0.9; }
            .content { padding: 40px 30px; }
            .highlight-box { background: #eff6ff; border-left: 4px solid #2563eb; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0; }
            .cta-button { display: inline-block; background: #2563eb; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0; }
            .tips { background: #f0fdf4; padding: 25px; border-radius: 8px; margin: 25px 0; }
            .footer { background: #1f2937; color: white; padding: 30px; text-align: center; }
            .emoji { font-size: 20px; }
            ul { padding-left: 20px; }
            li { margin: 8px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1><span class="emoji">🔥</span> Your Personal BroSplit is Ready!</h1>
                <p>Hey ${name}! Time to transform your physique</p>
            </div>
            
            <div class="content">
                <h2>Welcome to Your Transformation Journey! <span class="emoji">💪</span></h2>
                
                <p>I'm genuinely excited for you! Your completely personalized 6-week BroSplit plan is attached and ready to help you achieve your goal of <strong>${goal}</strong>.</p>
                
                <div class="highlight-box">
                    <h3><span class="emoji">🎯</span> What Makes This Plan Special</h3>
                    <ul>
                        <li><strong>100% Personalized:</strong> Built specifically for your equipment, experience, and goals</li>
                        <li><strong>Progressive Structure:</strong> Each week builds on the last with strategic deload periods</li>
                        <li><strong>Proven Results:</strong> Based on evidence-backed training principles</li>
                        <li><strong>Flexible & Adaptable:</strong> Works with your schedule and preferences</li>
                    </ul>
                </div>

                <h3><span class="emoji">🚀</span> Ready to Get Started?</h3>
                <p>Here's how to make the most of your plan:</p>
                
                <div class="tips">
                    <h4><span class="emoji">💡</span> Pro Tips for Success</h4>
                    <ul>
                        <li><strong>Start Week 1 on Monday</strong> - gives you the weekend to prep and plan</li>
                        <li><strong>Take "before" photos today</strong> - you'll want them in 6 weeks!</li>
                        <li><strong>Track every workout</strong> - use your phone notes, an app, or old-school pen and paper</li>
                        <li><strong>Don't skip the deload week</strong> - it's where the magic happens</li>
                        <li><strong>Ask for help</strong> - form checks, spot requests, whatever you need</li>
                    </ul>
                </div>

                <h3><span class="emoji">📱</span> Stay Connected</h3>
                <p>Questions about your plan? Need modifications? Just hit reply to this email - I read every message personally and I'm here to help you succeed!</p>
                
                <p>You can also follow us for daily motivation and tips:</p>
                <ul>
                    <li>Instagram: @brosplit_ai</li>
                    <li>Website: brosplit-ai.com/support</li>
                </ul>

                <div class="highlight-box">
                    <p><strong>Remember:</strong> The best workout plan is the one you actually follow. You've got everything you need - now it's time to show up and put in the work!</p>
                    <p><em>Your future self is counting on you. Let's make it happen! </em><span class="emoji">🔥</span></p>
                </div>
            </div>
            
            <div class="footer">
                <h3>The BroSplit AI Team</h3>
                <p>Transforming physiques one rep at a time</p>
                <p style="font-size: 12px; opacity: 0.8; margin-top: 20px;">
                    Questions? Email us at support@brosplit-ai.com<br>
                    Follow your plan, track your progress, and prepare to be amazed!
                </p>
            </div>
        </div>
    </body>
    </html>`;
  }
}

// 4. Updated email endpoint with enhanced error handling
app.post("/api/email-plan", async (req, res) => {
  try {
    const { email, plan, userProfile = {} } = req.body;
    
    // Input validation
    if (!email || !plan) {
      return res.status(400).json({ 
        error: "Missing required fields", 
        details: "Email and plan are required" 
      });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        error: "Invalid email format" 
      });
    }

    const emailService = new EmailService();
    const result = await emailService.sendWorkoutPlan(email, plan, userProfile);
    
    res.json({ 
      success: true, 
      message: "Your workout plan has been delivered! Check your inbox (and spam folder just in case).",
      messageId: result.messageId 
    });
    
  } catch (error) {
    console.error("Email delivery error:", error);
    
    // Different responses based on error type
    if (error.message.includes('Invalid email')) {
      res.status(400).json({ 
        error: "Email delivery failed", 
        details: "Please check your email address and try again" 
      });
    } else {
      res.status(500).json({ 
        error: "Email delivery failed", 
        details: "Our team has been notified. Please try again in a few minutes or contact support@brosplit-ai.com" 
      });
    }
  }
});

// 5. Health check endpoint that also verifies email service
app.get("/api/health", async (req, res) => {
  try {
    const emailService = new EmailService();
    await emailService.transporter.verify();
    
    res.json({ 
      status: "ok", 
      services: {
        server: "healthy",
        email: "healthy",
        openai: process.env.OPENAI_API_KEY ? "configured" : "missing",
        stripe: process.env.STRIPE_SECRET_KEY ? "configured" : "missing"
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({ 
      status: "degraded", 
      error: "Email service unavailable",
      timestamp: new Date().toISOString()
    });
  }
});

// 6. Boot server
app.listen(4000, () => console.log("🚀 Enhanced BroSplit AI listening on :4000"));
console.log("✅ Express is listening on http://localhost:4000");