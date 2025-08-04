// prompt.js
export const makePrompt = ({
   daysPerWeek,
   equipment,
   injuries = [],
   experience = "intermediate",
   goal = "build muscle",
   dislikes = [],
   focusMuscle = "",
   age,
   sex,
   bodyweight,
   lifts = {}
 }) => {
   // Normalize inputs
   const g = goal.toLowerCase();
   const isFatLoss = g.includes("fat") || g.includes("lose");
   const isHypertrophy = g.includes("muscle") || g.includes("build");
 
   // Determine equipment rules
   let equipmentLine;
   let equipmentRule = '';
   if (equipment.toLowerCase().includes("body")) {
     equipmentLine = "• Equipment: Bodyweight only (no dumbbells or machines)";
     equipmentRule = "7. **Bodyweight Rule**: Use only bodyweight movements—no external load or machines.";
   } else if (equipment.toLowerCase().includes("dumbbell")) {
     equipmentLine = "• Equipment: Home dumbbells only";
   } else {
     equipmentLine = "• Equipment: Full gym access";
   }
 
   // Goal-specific rules
   let goalRule = '';
   if (isFatLoss && isHypertrophy) {
     goalRule = `7. **Dual Goal (Fat Loss + Muscle)**  
    – Use 8–12 reps, supersets on accessories,  
    and add 15–20 min HIIT on 2 off-days.`;
   } else if (isFatLoss) {
     goalRule = `7. **Fat-Loss Focus**  
    – Keep rest 30–45 sec, circuit 3×/week,  
    and add 20–30 min steady-state cardio on non-leg days.`;
   } else if (isHypertrophy) {
     goalRule = `7. **Muscle-Gain Focus**  
    – Use 8–12 reps for lifts, 1–2 drop-sets on accessories,  
    and ensure progressive overload each week.`;
   }
 
   // Gender-based emphasis
   let genderRule = '';
   if (sex && sex.toLowerCase().startsWith('f')) {
     genderRule = `8. **Female Emphasis**: Prioritize ≥40% of weekly volume on lower-body movements unless focusMuscle overrides.`;
   } else if (sex && sex.toLowerCase().startsWith('m')) {
     genderRule = `8. **Male Emphasis**: Keep volume balanced—no more than 25% on any one muscle group.`;
   }
 
   // Focus muscle override
   let focusRule = '';
   if (focusMuscle) {
     focusRule = `9. **Focus Muscle (${focusMuscle})**: Add 3–5 extra sets/week + 1 specialty movement for ${focusMuscle}.`;
   }
 
   return `BroSplitCoachAI — your no-BS hypertrophy coach — generate a **6-week** bespoke bro-split.
 
 CLIENT PROFILE
  • Goal: ${goal}
  • Days/week: ${daysPerWeek}
  ${equipmentLine}
  • Experience: ${experience}
  ${age ? `• Age: ${age}` : ``}
  ${sex ? `• Sex: ${sex}` : ``}
  ${bodyweight ? `• Bodyweight: ${bodyweight} lbs` : ``}
  ${lifts.bench||lifts.squat||lifts.deadlift||lifts.ohp 
      ? `• 1RMs: Bench ${lifts.bench||"-"}, Squat ${lifts.squat||"-"}, Deadlift ${lifts.deadlift||"-"}, OHP ${lifts.ohp||"-"}` 
      : ``}
 
 RULES
  1. **Structure**  
     - Label **Week 1** … **Week 6**.  
     - Within each week, generate **exactly ${daysPerWeek} training days**.  
     - Label each as **Day 1 – [Split Name]**, ..., **Day ${daysPerWeek} – [Split Name]**.  
     - Do **not** skip or omit any days.
 
  2. **Muscle-Group Days**  
     - 5–7 movements: ≥2 compounds + ≥3 accessories + 1 finisher.  
     - **Vary at least 2 exercises** each week per muscle group.
 
  3. **Core/Cardio Days**  
     - 3–4 movements: exactly 2 core exercises + 1–2 cardio modalities.  
     - **Alternate core/Cardio selection** each session.
 
  4. **Progression & Deload**  
     - Wk 1: Base volume, RPE 6–7  
     - Wk 2: +5–10% volume, RPE 7  
     - Wk 3: +5–10% load, RPE 7–8  
     - Wk 4 (Deload): 50% volume, RPE 5–6 + 10 min mobility on off-days  
     - Wk 5: Peak, –2 reps vs Wk 3, RPE 8–9  
     - Wk 6: Ultimate peak, –1 rep, RPE 9
 
  5. **Load Prescriptions**  
     - Show %1RM and exact lbs.  
     - **Round weights** to nearest 5 lbs.
 
  6. **Customization**  
     - Avoid/modify: ${injuries.length ? injuries.join(", ") : "none"}.  
     - Remove: ${dislikes.length ? dislikes.join(", ") : "none"}.
 
 ${equipmentRule}
 ${goalRule}
 ${genderRule}
 ${focusRule}
 
 FORMAT
  • **Bold headings** for weeks & days  
  • **Bullets** (“•”) for each exercise  
  • End with **Progression & Deload Notes**  
  • **Vary workouts** so no two weeks are identical  
  • **Output only** the plan in plain text (no commentary)`;
 };
 