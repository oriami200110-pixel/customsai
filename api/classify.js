// api/classify.js
// Tariffly — Phase B backend classifier (Reviewer Protocol)
// Two-pass: Broker (Stage 1) → CBP Legal Auditor (Stage 2) → Synthesis → Sanity rules
//
// Vercel Serverless Function (Node.js runtime)
//
// Responsibilities:
//   1. Hold the Gemini API key server-side (process.env.GEMINI_API_KEY)
//   2. Own the broker + auditor system prompts and the JSON schemas (IP protection)
//   3. Run an adversarial second pass that hunts for competing headings,
//      validates GRI 3(b) essential character, and tests Section/Chapter
//      note exclusions against the broker's heading
//   4. Apply defensive sanity rules as a third line of defense
//   5. Return a JSON envelope the existing frontend can render UNCHANGED;
//      audit metadata lives in `meta.audit` (additive, optional)
//
// Latency: ~2x Phase A. maxDuration bumped to 60s. If the auditor call fails
// for any reason (timeout, parse, upstream), we gracefully fall back to the
// broker's result so end-users never see a hard failure attributable to the
// audit layer.

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_AUDITOR_MODEL = process.env.GEMINI_AUDITOR_MODEL || GEMINI_MODEL;
const geminiUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const ALLOWED_ORIGINS = [
  'https://customsai.vercel.app',
  'https://tariffly.app',
  'https://www.tariffly.app',
  'http://localhost:3000',
  'http://localhost:5173',
];

// ════════════════════════════════════════════════════════════════════════════
// STAGE 1 — BROKER PROMPT
// The licensed broker doing the entry. Same prompt as Phase A.
// ════════════════════════════════════════════════════════════════════════════
const BROKER_PROMPT = `You are a Licensed U.S. Customs Broker (LCB) with 20+ years of experience in HTSUS classification. You know the General Rules of Interpretation, every Section and Chapter note, and the patterns in CBP CROSS rulings cold. Your output is filed verbatim into CBP Form 7501 by a brokerage that submits thousands of formal entries per month — accuracy is non-negotiable.

═══════════════════════════════════════════════════════════
MANDATORY CLASSIFICATION PROCEDURE — execute IN THIS ORDER:
═══════════════════════════════════════════════════════════

STEP 1 — IDENTIFY THE ARTICLE AS A WHOLE
Ask: "What IS this product, as it is bought and sold in commerce?"
Do NOT ask: "What components is it made of?"

  • A drone with a battery is a DRONE, not a battery.
  • A laptop with a screen is a LAPTOP, not a display.
  • An LED flashlight is a FLASHLIGHT, not an LED.
  • A cotton t-shirt with a polyester care-label is a COTTON T-SHIRT.
  • A coffee maker with a heating element is a COFFEE MAKER, not a heater.

STEP 2 — APPLY GRI 3(b): ESSENTIAL CHARACTER
For composite goods, identify the component or function that gives the article its essential character. Determined by:
  ✓ Function the article performs in actual use
  ✓ Commercial identity — what consumers, retailers, and brokers call it
  ✗ NOT the heaviest component
  ✗ NOT the most expensive component
  ✗ NOT the power source
  ✗ NOT the housing or packaging material

STEP 3 — APPLY GRI 1: CLASSIFY BY HEADING TEXT
Find the 4-digit heading whose text describes the article by its essential character. Narrow to 6-digit subheading per GRI 6.

STEP 4 — APPLY GRI 3(a) IF MULTIPLE HEADINGS APPLY
The most specific description prevails over a more general one.

STEP 5 — VERIFY WITH SECTION & CHAPTER NOTES
Section/Chapter notes are dispositive — they OVERRIDE headings. Always check exclusions before finalizing.

═══════════════════════════════════════════════════════════
KNOWN ANTI-PATTERNS — DO NOT MAKE THESE ERRORS:
═══════════════════════════════════════════════════════════

✗ Drone / UAV / quadcopter classified as "battery" or "lithium accumulator"
   → CORRECT: 8806.xx (unmanned aircraft)
✗ Electric bicycle classified as "motor"
   → CORRECT: 8711.60 (e-bike)
✗ Smartwatch classified only as "watch" (Chapter 91)
   → CORRECT: 8517.62 (data-transmission apparatus) per CBP CROSS pattern
✗ USB cable classified as "copper wire"
   → CORRECT: 8544.42 (insulated conductor with connector)
✗ Finished garment classified as "fabric"
   → CORRECT: Chapter 61 (knitted) or 62 (woven) by garment type
✗ Assembled furniture classified as "wood" or "metal"
   → CORRECT: Chapter 94
✗ First-aid / medical kit classified as the case or the most expensive component
   → CORRECT: GRI 3(b) by the kit's essential character (typically 3006.50)
✗ Toy with a small motor classified as a "motor"
   → CORRECT: Chapter 95
✗ Eyewear classified by lens material
   → CORRECT: 9004 (assembled spectacles) or 9001 (loose lenses)
✗ Headphones classified as "speaker"
   → CORRECT: 8518.30
✗ Power bank classified as "battery"
   → CORRECT: 8504.40 (static converter) per CBP HQ H300226

═══════════════════════════════════════════════════════════
COUNTRY-OF-ORIGIN DUTY OVERLAYS:
═══════════════════════════════════════════════════════════
  • China (CN): Section 301 List 1–4 tariffs apply on top of Column 1 General
  • USMCA (MX, CA): Column 1 General waived if the good qualifies under USMCA RoO
  • Steel / aluminum from CN, IN, TW: Section 232 may apply
  • Other origins: Column 1 General only (unless GSP/CBI/AGOA eligible)

═══════════════════════════════════════════════════════════
OUTPUT REQUIREMENTS:
═══════════════════════════════════════════════════════════
Return STRICTLY VALID JSON matching the provided schema. No markdown, no commentary outside the JSON.

FIELD-SPECIFIC RULES:

  • "hts_10" — always 10 digits formatted XXXX.XX.XXXX. If you only know to 8 digits, pad with "00".
  • "duty_general_formatted" — "Free" if 0, otherwise "X.X%" (e.g. "2.6%"). For USMCA-originating goods from MX/CA, return "Free".
  • "section_301.applies" — true ONLY when origin is "CN" AND the heading is on List 1/2/3/4A/4B. Otherwise false with rate_pct=0 and list="".
  • "section_301.list" — exact label "List 1", "List 2", "List 3", "List 4A", or "List 4B". Empty string if not applicable.
  • "section_232.applies" — true only for steel (Ch. 72/73) or aluminum (Ch. 76) products subject to current §232 measures.
  • "total_effective_pct" — strict sum of duty_general_pct + section_301.rate_pct + section_232.rate_pct.
  • "total_formatted" — "Free" if 0, otherwise "X.X%".
  • "gri_rule" — the GRI you applied, e.g. "GRI 1", "GRI 3(b)", "GRI 1 + Note 4 to Section XVI".
  • "gri_rationale" — 3–5 sentences of professional broker prose that:
      1. Names the GRI applied
      2. Identifies the essential character of the article
      3. Cites the dispositive Section or Chapter note if one applies
      4. Explains why competing headings were rejected
      5. References the CBP CROSS ruling pattern if one is well-established
  • "alternatives" — up to 2 entries. Each is { hts, desc, reason }. Empty array if none meaningfully competing.
  • "risk_flags" — array of short audit-worthy flags, e.g. "AD/CVD scope check required", "FDA prior notice may apply", "Lithium battery — IATA shipping rules", "Country-of-origin marking under 19 CFR 134". Empty array if none.
  • "savings_tip" — ONE concrete sentence: alternative origin opportunity, USMCA qualification path, FTZ benefit, GSP/CBI eligibility, or tariff engineering. Empty string if no clear opportunity exists.

The "confidence" field is your honest self-assessment (0–100):
  • 90–100: Unambiguous, well-supported by CROSS rulings
  • 75–89:  Standard classification, minor description ambiguity
  • 60–74:  GRI 3 needed to choose between plausible headings
  • Below 60: Insufficient detail — flag in gri_rationale that more product info is needed`;

// ════════════════════════════════════════════════════════════════════════════
// STAGE 2 — AUDITOR PROMPT
// CBP Office of Regulations & Rulings legal auditor. Adversarial by design.
// Receives the broker's full classification and either CONFIRMS or CORRECTS.
// ════════════════════════════════════════════════════════════════════════════
const AUDITOR_PROMPT = `You are a CBP Legal Auditor at the Office of Regulations and Rulings (OR&R). You have personally signed binding rulings indexed in CROSS. Your job is to find errors in classifications filed by entry-filing brokers BEFORE those errors hit the importer in an audit, a Post-Summary Correction, or a 19 CFR 174 protest.

Your stance is ADVERSARIAL. Treat every broker classification as suspect until proven defensible. Brokers PREFER being corrected by you now — when the entry can still be filed cleanly — over being corrected by an ISA letter or a 28(c) Notice of Action two years from now.

═══════════════════════════════════════════════════════════
AUDIT PROCEDURE — execute IN THIS ORDER:
═══════════════════════════════════════════════════════════

STEP 1 — RE-IDENTIFY THE ARTICLE
Read the product description as if you had never seen the broker's work. Ask: "What IS this article, as bought and sold in commerce?" Do NOT yet look at the broker's chosen heading.

STEP 2 — ENUMERATE COMPETING HEADINGS
List, mentally, every 4-digit heading that could plausibly cover this article — including the broker's. For each competitor, articulate in one sentence why it could apply. The broker's heading must beat every competitor on legal grounds, not just on intuition.

STEP 3 — APPLY GRI 3(b): ESSENTIAL CHARACTER
For composite or multi-component articles, essential character is the FUNCTION the article performs in commerce — NOT the heaviest, most expensive, most visible, most powerful, or first-listed component.

Common broker errors you must hunt for:
  • Drone ≠ battery (essential character is unmanned flight, not energy storage)
  • E-bike ≠ motor (essential character is transportation, not propulsion)
  • Smartwatch ≠ watch (essential character is bidirectional data transmission per CROSS pattern → 8517.62)
  • USB / HDMI / Lightning cable ≠ copper wire (essential character is the connectorized signal cable → 8544.42)
  • Power bank ≠ battery (essential character is voltage conversion per CBP HQ H300226 → 8504.40)
  • First-aid kit ≠ its case nor its most expensive component (essential character is the assortment per GRI 3(b))
  • Toy with embedded motor ≠ motor (Chapter 95 prevails over Chapter 85)
  • Headphones ≠ speaker (8518.30 is the heading for headphones/earphones)
  • LED flashlight ≠ LED (8513 governs portable electric lamps)
  • Assembled furniture ≠ "wood" or "metal" (Chapter 94)
  • Finished garment ≠ "fabric" (Chapter 61 knitted or 62 woven)
  • Eyewear ≠ classification by lens material (9004 assembled, 9001 loose lenses)

STEP 4 — TRIGGER SECTION & CHAPTER NOTE EXCLUSIONS
Section and Chapter notes are LAW — they override the heading text. For the broker's chosen heading AND your top competing heading, identify every relevant exclusion note. If a note rejects the article from a heading, that heading is dead. Period.

Examples of dispositive notes:
  • Section XVI Note 1(p) excludes goods of Chapter 95 (toys, games, sports)
  • Section XVI Note 2 governs parts and accessories
  • Section XVII Note 1 lays out exclusions from Sections of vehicles/aircraft
  • Chapter 84 Note 5(B) defines automatic data-processing machines
  • Chapter 85 Note 6 governs prepared unrecorded media
  • Chapter 90 Note 2 governs accessories vs. complete instruments
  • Chapter 71 Note 9 defines "imitation jewelry" exclusions

STEP 5 — VERIFY DUTY OVERLAYS
  • Section 301 (CN origin): If the origin is China, does this 8-digit subheading actually appear on List 1, 2, 3, 4A, or 4B? Do not blanket-apply 25%. Do not flip "applies" to false on goods that are clearly listed.
  • Section 232: Apply ONLY to steel (Ch. 72/73) or aluminum (Ch. 76) products that fall within the active §232 measures. Do not apply to a finished consumer electronic merely because it contains an aluminum housing.
  • USMCA: For MX/CA origin, the broker's "Free" claim is defensible only if the article meets the relevant rule of origin (RVC, tariff shift, or wholly obtained). When in doubt, leave Column 1 General in place and flag the USMCA opportunity as a savings_tip rather than promising Free.

STEP 6 — DECIDE
Return EXACTLY ONE of two outcomes:

  (a) AUDIT PASSED — the broker's classification is legally defensible.
      → Set audit_passed=true.
      → audit_summary: 1 sentence explaining why the classification holds (cite the GRI and the dispositive note if any).
      → corrections_made: [] (empty array).
      → final_classification: ECHO the broker's result UNCHANGED, every field byte-for-byte.

  (b) AUDIT FAILED — the broker is wrong on a substantive point (heading error, GRI 3(b) misapplication, dispositive Note exclusion missed, material duty-overlay error).
      → Set audit_passed=false.
      → audit_summary: 1 sentence stating the corrected HTS and the reason.
      → corrections_made: array of short, specific change descriptions, e.g.:
          "HTS 8507.60.0020 → 8806.22.0000: drone, not battery, per GRI 3(b)"
          "Section 301: applies=true, List 3, 25% (broker had applies=false)"
          "gri_rule: GRI 1 → GRI 3(b)"
      → final_classification: the FULL corrected 14-field classification per the broker schema.
      → The corrected classification's gri_rationale MUST explicitly state:
          1. What the broker initially concluded (e.g., "Initially classified under heading 8507 as a lithium-ion battery...")
          2. The legal basis for the correction (e.g., "...rejected because GRI 3(b) requires classification by essential character, which here is unmanned flight per heading 8806; Section XVII Note 1 confirms aircraft classification.")
          3. The CROSS or HQ ruling pattern that supports the correction, if one exists.

═══════════════════════════════════════════════════════════
DISCIPLINE:
═══════════════════════════════════════════════════════════
  • Do NOT manufacture corrections to look thorough. False positives waste broker time and erode trust in the audit layer.
  • Do NOT flip audit_passed to false over trivial details (a single-word flag rewording, a 0.1% duty-rate variance, a synonym in the description). Only flip on substantive classification or material duty-overlay errors.
  • If the broker is correct, say so plainly and pass. Auditor approval has signal value — pad it with weak corrections and brokers will start ignoring you.
  • Your final_classification MUST be a complete, valid 14-field classification — even when audit_passed=true (echo the broker's result unchanged in that case).`;

// ════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ════════════════════════════════════════════════════════════════════════════
const CLASSIFICATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    hts_10:                 { type: 'STRING', description: '10-digit HTSUS code formatted XXXX.XX.XXXX' },
    description:            { type: 'STRING', description: 'Official HTSUS description for this code' },
    duty_general_pct:       { type: 'NUMBER', description: 'Column 1 General rate as percentage (e.g. 2.6 for 2.6%). USMCA-originating MX/CA = 0.' },
    duty_general_formatted: { type: 'STRING', description: 'Human-readable Column 1 General, e.g. "2.6%" or "Free"' },
    section_301: {
      type: 'OBJECT',
      properties: {
        applies:  { type: 'BOOLEAN', description: 'True only if origin is CN and the heading falls on a §301 list' },
        rate_pct: { type: 'NUMBER',  description: 'Section 301 rate; 0 if not applicable' },
        list:     { type: 'STRING',  description: 'List 1, List 2, List 3, List 4A, List 4B, or empty if N/A' },
      },
      required: ['applies', 'rate_pct', 'list'],
    },
    section_232: {
      type: 'OBJECT',
      properties: {
        applies:  { type: 'BOOLEAN', description: 'True if §232 steel/aluminum tariff applies to this good and origin' },
        rate_pct: { type: 'NUMBER',  description: 'Section 232 rate; 0 if not applicable' },
      },
      required: ['applies', 'rate_pct'],
    },
    total_effective_pct: { type: 'NUMBER', description: 'Sum of duty_general_pct + section_301.rate_pct + section_232.rate_pct' },
    total_formatted:     { type: 'STRING', description: 'Human-readable total, e.g. "27.5%" or "Free"' },
    gri_rule:            { type: 'STRING', description: 'Primary GRI applied, e.g. "GRI 1", "GRI 3(b)", "GRI 1 + Note 4 to Section XVI"' },
    gri_rationale:       { type: 'STRING', description: '3–5 sentence broker-grade rationale: name the GRI, identify essential character, cite Section/Chapter note if dispositive, explain why competing headings were rejected, reference CROSS pattern if applicable. If the auditor corrected the broker, MUST explain what the broker initially concluded and the legal basis for the correction.' },
    alternatives: {
      type: 'ARRAY',
      description: 'Up to 2 plausible alternatives that were rejected, each with a one-sentence reason',
      items: {
        type: 'OBJECT',
        properties: {
          hts:    { type: 'STRING', description: '10-digit alternative HTS' },
          desc:   { type: 'STRING', description: 'Short description of that heading' },
          reason: { type: 'STRING', description: 'One-sentence reason this alternative was rejected' },
        },
        required: ['hts', 'desc', 'reason'],
      },
    },
    confidence:  { type: 'NUMBER', description: 'Self-assessed confidence 0–100' },
    risk_flags:  {
      type: 'ARRAY',
      description: 'Compliance/audit flags the broker should review, e.g. "AD/CVD scope check required", "FDA prior notice may apply"',
      items: { type: 'STRING' },
    },
    savings_tip: { type: 'STRING', description: 'One-sentence actionable suggestion (alternative origin, FTZ, USMCA qualification, etc.). Empty string if none.' },
  },
  required: [
    'hts_10', 'description', 'duty_general_pct', 'duty_general_formatted',
    'section_301', 'section_232', 'total_effective_pct', 'total_formatted',
    'gri_rule', 'gri_rationale', 'alternatives', 'confidence', 'risk_flags', 'savings_tip',
  ],
};

const AUDITOR_SCHEMA = {
  type: 'OBJECT',
  properties: {
    audit_passed:  { type: 'BOOLEAN', description: 'True if the broker classification is legally defensible; false if substantive corrections were required' },
    audit_summary: { type: 'STRING',  description: '1-sentence audit conclusion. If passed, why it holds. If failed, the corrected HTS and the reason.' },
    corrections_made: {
      type: 'ARRAY',
      description: 'Each correction as a short, specific change description. Empty array if audit_passed=true.',
      items: { type: 'STRING' },
    },
    final_classification: CLASSIFICATION_SCHEMA,
  },
  required: ['audit_passed', 'audit_summary', 'corrections_made', 'final_classification'],
};

// ════════════════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res, req.headers.origin);
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
  }

  // Origin allowlist — abuse blunting until Phase B auth ships
  const reqOrigin = req.headers.origin || req.headers.referer || '';
  if (!ALLOWED_ORIGINS.some((o) => reqOrigin.startsWith(o))) {
    return res.status(403).json({ ok: false, error: 'Forbidden origin' });
  }
  setCorsHeaders(res, reqOrigin);

  // Env check
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY missing from environment');
    return res.status(500).json({ ok: false, error: 'Server configuration error' });
  }

  // Body parse + input validation
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ ok: false, error: 'Invalid JSON body' }); }
  }
  const { description, origin: countryOrigin } = body || {};

  if (!description || typeof description !== 'string' || description.trim().length < 3) {
    return res.status(400).json({ ok: false, error: 'Field "description" is required (min 3 chars)' });
  }
  if (!countryOrigin || typeof countryOrigin !== 'string' || countryOrigin.trim().length !== 2) {
    return res.status(400).json({ ok: false, error: 'Field "origin" is required (ISO 2-letter country code)' });
  }

  const desc = description.trim().slice(0, 1000);
  const ctry = countryOrigin.trim().toUpperCase();

  // ──────────────────────────────────────────────────────────────────────────
  // STAGE 1 — BROKER
  // ──────────────────────────────────────────────────────────────────────────
  const brokerUserPrompt = `Classify the following product for U.S. import:

PRODUCT DESCRIPTION:
${desc}

COUNTRY OF ORIGIN: ${ctry}

Apply the mandatory classification procedure. Return only the JSON object per the schema.`;

  const t1Start = Date.now();
  const stage1 = await callGemini({
    model: GEMINI_MODEL,
    apiKey,
    schema: CLASSIFICATION_SCHEMA,
    systemPrompt: BROKER_PROMPT,
    userPrompt: brokerUserPrompt,
    maxTokens: 4096,
  });
  const t1Ms = Date.now() - t1Start;

  if (stage1.error || !stage1.parsed) {
    console.error('Stage 1 (broker) failed', stage1.error);
    return res.status(502).json({
      ok: false,
      error: 'Classifier failed (broker stage)',
      detail: stage1.error,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STAGE 2 — AUDITOR
  // ──────────────────────────────────────────────────────────────────────────
  const auditorUserPrompt = `A licensed broker has filed the classification below. Audit it.

PRODUCT DESCRIPTION:
${desc}

COUNTRY OF ORIGIN: ${ctry}

BROKER'S CLASSIFICATION (full JSON):
${JSON.stringify(stage1.parsed, null, 2)}

Apply the audit procedure. If the broker is correct, set audit_passed=true and echo the broker's classification verbatim in final_classification. If the broker is wrong on a substantive point, set audit_passed=false and return the FULL corrected 14-field classification — its gri_rationale must explain what the broker initially concluded and the legal basis for the correction.`;

  const t2Start = Date.now();
  const stage2 = await callGemini({
    model: GEMINI_AUDITOR_MODEL,
    apiKey,
    schema: AUDITOR_SCHEMA,
    systemPrompt: AUDITOR_PROMPT,
    userPrompt: auditorUserPrompt,
    maxTokens: 4096,
  });
  const t2Ms = Date.now() - t2Start;

  // ──────────────────────────────────────────────────────────────────────────
  // SYNTHESIS — auditor result wins when valid; broker result is the fallback
  // ──────────────────────────────────────────────────────────────────────────
  let final;
  let auditMeta;
  if (stage2.error || !stage2.parsed?.final_classification) {
    console.warn('Stage 2 (auditor) unavailable; falling back to broker result', stage2.error);
    final = stage1.parsed;
    auditMeta = {
      passed: null,
      summary: 'Audit unavailable — broker classification returned without second-pass review.',
      corrections: [],
      auditor_error: stage2.error || 'no_final_classification',
    };
  } else {
    final = stage2.parsed.final_classification;
    auditMeta = {
      passed: !!stage2.parsed.audit_passed,
      summary: stage2.parsed.audit_summary || '',
      corrections: Array.isArray(stage2.parsed.corrections_made) ? stage2.parsed.corrections_made : [],
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STAGE 3 — DEFENSIVE SANITY RULES (third line of defense)
  // ──────────────────────────────────────────────────────────────────────────
  final = enforceSanityRules(final, desc);

  // ── Add derived fields (computed server-side, not by LLM) ──────────────────
  final.official_link = buildOfficialLink(final.hts_10);
  final.memo_text     = buildMemoText(final, desc, ctry, auditMeta);

  return res.status(200).json({
    ok: true,
    result: final,
    meta: {
      model: GEMINI_MODEL,
      auditor_model: GEMINI_AUDITOR_MODEL,
      audit: auditMeta,
      stage1_hts: stage1.parsed?.hts_10 || null,
      stage1_gri: stage1.parsed?.gri_rule || null,
      latency_ms: { broker: t1Ms, auditor: t2Ms, total: t1Ms + t2Ms },
      timestamp: new Date().toISOString(),
    },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

// Generic Gemini caller — wraps fetch, error handling, robust JSON extraction.
// Returns either { parsed: <object> } or { error: <string> }.
async function callGemini({ model, apiKey, schema, systemPrompt, userPrompt, maxTokens }) {
  const reqBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      maxOutputTokens: maxTokens || 4096,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  let resp;
  try {
    resp = await fetch(`${geminiUrl(model)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
  } catch (err) {
    return { error: 'fetch_failed: ' + String(err) };
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error('Gemini API error', model, resp.status, errText.slice(0, 500));
    return { error: resp.status === 429 ? 'rate_limited' : `upstream_${resp.status}` };
  }

  let data;
  try { data = await resp.json(); }
  catch { return { error: 'gemini_response_not_json' }; }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    console.error('Gemini empty response', model, JSON.stringify(data).slice(0, 500));
    return { error: 'empty_response' };
  }

  // Robust JSON extraction — strip code fences, trim, fall back to {...} substring.
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  }
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { parsed = JSON.parse(cleaned.slice(first, last + 1)); }
      catch {
        console.error('Gemini malformed JSON', model, cleaned.slice(0, 500), 'len=', cleaned.length);
        return { error: 'malformed_json' };
      }
    } else {
      console.error('Gemini no-JSON response', model, cleaned.slice(0, 500));
      return { error: 'no_json_found' };
    }
  }

  return { parsed };
}

function setCorsHeaders(res, origin) {
  if (origin && ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) {
    try { res.setHeader('Access-Control-Allow-Origin', new URL(origin).origin); } catch {}
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// Build an official USITC HTS search URL for a given 10-digit code.
// Links to the HTS heading search which opens the live schedule chapter.
function buildOfficialLink(hts10) {
  if (!hts10) return 'https://hts.usitc.gov/';
  const clean = hts10.replace(/\D/g, '');
  const heading = clean.slice(0, 4);   // e.g. "8517"
  return `https://hts.usitc.gov/reststop/searchForHeading?term=${heading}`;
}

// Build a formatted professional classification memo suitable for copy/export.
function buildMemoText(result, description, origin, auditMeta) {
  const date = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const auditLine = auditMeta?.passed === true
    ? `✓ Classification independently audited — no corrections required.`
    : auditMeta?.passed === false
    ? `⚠ Audit corrections applied: ${(auditMeta.corrections||[]).join('; ')}`
    : `Note: Single-pass classification (audit unavailable).`;

  const riskSection = result.risk_flags?.length
    ? `\nRisk & Compliance Flags:\n${result.risk_flags.map(f => `  • ${f}`).join('\n')}`
    : '';

  const altsSection = result.alternatives?.length
    ? `\nAlternative Headings Considered:\n${result.alternatives.map(a => `  • ${a.hts} — ${a.desc}: ${a.reason}`).join('\n')}`
    : '';

  const savingsSection = result.savings_tip
    ? `\nSavings Opportunity:\n  ${result.savings_tip}`
    : '';

  return `TARIFFLY — HTS CLASSIFICATION MEMO
Generated: ${date}
─────────────────────────────────────────

PRODUCT DESCRIPTION:
${description}

COUNTRY OF ORIGIN: ${origin}

CLASSIFICATION RESULT:
  HTS Code:         ${result.hts_10 || '—'}
  Description:      ${result.description || '—'}
  Confidence:       ${result.confidence || 0}%

DUTY RATES:
  Column 1 General: ${result.duty_general_formatted || '—'}
  Section 301:      ${result.section_301?.applies ? `+${result.section_301.rate_pct}% (${result.section_301.list})` : 'Not applicable'}
  Section 232:      ${result.section_232?.applies ? `+${result.section_232.rate_pct}%` : 'Not applicable'}
  TOTAL EFFECTIVE:  ${result.total_formatted || '—'} (origin: ${origin})

GRI ANALYSIS (${result.gri_rule || '—'}):
${result.gri_rationale || '—'}
${riskSection}${altsSection}${savingsSection}

OFFICIAL REFERENCE:
  ${result.official_link || 'https://hts.usitc.gov/'}

AUDIT STATUS:
  ${auditLine}

─────────────────────────────────────────
DISCLAIMER: This memo is generated by an AI classification assistant and is
provided for informational purposes only. It does not constitute a binding
CBP ruling under 19 U.S.C. § 1502, nor does it constitute legal or customs
brokerage advice. Always verify with a Licensed Customs Broker or CBP before
filing an entry.
─────────────────────────────────────────`;
}

// Catches the well-known essential-character traps — appends to risk_flags and lowers confidence.
// Does NOT silently rewrite the HTS — brokers must see the disagreement so they can override or accept.
// Runs AFTER both broker + auditor passes; guards against rare cases where both stages miss the same trap.
function enforceSanityRules(result, originalDescription) {
  const desc = (originalDescription || '').toLowerCase();
  const hts = (result.hts_10 || '').replace(/\D/g, '');
  const newFlags = [];

  const triggers = [
    { terms: ['drone', 'uav', 'quadcopter', 'unmanned aircraft', 'unmanned aerial'], expectedPrefix: '8806', note: '⚠ Essential character check: description suggests UAV/drone — verify against heading 8806.' },
    { terms: ['e-bike', 'electric bicycle', 'pedelec'],                              expectedPrefix: '8711', note: '⚠ Essential character check: description suggests e-bike — verify against heading 8711.60.' },
    { terms: ['smart watch', 'smartwatch'],                                          expectedPrefix: '8517', note: '⚠ CBP CROSS typically classifies smartwatches under 8517.62, not Chapter 91.' },
    { terms: ['power bank', 'powerbank'],                                            expectedPrefix: '8504', note: '⚠ CBP HQ H300226 classifies power banks as static converter under 8504.40.' },
    { terms: ['headphone', 'earphone', 'earbud'],                                    expectedPrefix: '8518', note: '⚠ Description suggests headphones/earphones — verify against heading 8518.30.' },
    { terms: ['usb cable', 'hdmi cable', 'lightning cable', 'charging cable'],       expectedPrefix: '8544', note: '⚠ Description suggests insulated cable with connector — verify against heading 8544.42.' },
  ];

  for (const t of triggers) {
    if (t.terms.some((term) => desc.includes(term)) && !hts.startsWith(t.expectedPrefix)) {
      newFlags.push(t.note);
    }
  }

  if (newFlags.length > 0) {
    result.risk_flags = Array.isArray(result.risk_flags) ? [...result.risk_flags, ...newFlags] : newFlags;
    result.confidence = Math.min(result.confidence ?? 70, 60);
  }

  return result;
}
