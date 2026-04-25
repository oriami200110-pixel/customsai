// api/classify.js
// Tariffly — Phase A backend classification proxy
// Vercel Serverless Function (Node.js runtime)
//
// Responsibilities:
//   1. Hold the Gemini API key server-side (process.env.GEMINI_API_KEY)
//   2. Own the system prompt and the JSON output schema (IP protection)
//   3. Enforce GRI essential-character rules so we don't classify a drone as a battery
//   4. Return a clean, deterministic JSON envelope the frontend can render
//
// Phase A scope:
//   - Open endpoint, gated only by Origin/Referer allowlist (until Phase B auth ships)
//   - Cost ceiling enforced via the Google Cloud daily budget alarm, not in-process
//   - Single-shot classification; multi-pass + RAG land in Phase C

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
};

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const ALLOWED_ORIGINS = [
  'https://customsai.vercel.app',
  'https://tariffly.app',
  'https://www.tariffly.app',
  'http://localhost:3000', // for `vercel dev`
  'http://localhost:5173',
];

// ────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — the moat. Owned server-side, never shipped to the client.
// ────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a Licensed U.S. Customs Broker (LCB) with 20+ years of experience in HTSUS classification. You know the General Rules of Interpretation, every Section and Chapter note, and the patterns in CBP CROSS rulings cold. Your output is filed verbatim into CBP Form 7501 by a brokerage that submits thousands of formal entries per month — accuracy is non-negotiable.

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

// ────────────────────────────────────────────────────────────────────────────
// OUTPUT SCHEMA — Gemini's structured-output mode enforces this exactly.
// Field names match the contract that renderResult() in app.html consumes.
// ────────────────────────────────────────────────────────────────────────────
const OUTPUT_SCHEMA = {
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
    gri_rationale:       { type: 'STRING', description: '3–5 sentence broker-grade rationale: name the GRI, identify essential character, cite Section/Chapter note if dispositive, explain why competing headings were rejected, reference CROSS pattern if applicable' },
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

// ────────────────────────────────────────────────────────────────────────────
// HANDLER
// ────────────────────────────────────────────────────────────────────────────
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
  const origin = req.headers.origin || req.headers.referer || '';
  if (!ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) {
    return res.status(403).json({ ok: false, error: 'Forbidden origin' });
  }
  setCorsHeaders(res, origin);

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

  const desc = description.trim().slice(0, 1000); // hard input cap
  const ctry = countryOrigin.trim().toUpperCase();

  // Build Gemini request
  const userPrompt = `Classify the following product for U.S. import:

PRODUCT DESCRIPTION:
${desc}

COUNTRY OF ORIGIN: ${ctry}

Apply the mandatory classification procedure. Return only the JSON object per the schema.`;

  const geminiBody = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: OUTPUT_SCHEMA,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  // Call Gemini
  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });
  } catch (err) {
    console.error('Gemini fetch failed', err);
    return res.status(502).json({ ok: false, error: 'Classifier unreachable' });
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => '');
    console.error('Gemini API error', geminiRes.status, errText.slice(0, 500));
    return res.status(502).json({
      ok: false,
      error: 'Classification service temporarily unavailable',
      detail: geminiRes.status === 429 ? 'Rate limited' : `Upstream ${geminiRes.status}`,
    });
  }

  const geminiData = await geminiRes.json();
  const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    console.error('Gemini returned no text', JSON.stringify(geminiData).slice(0, 500));
    return res.status(502).json({ ok: false, error: 'Empty response from classifier' });
  }

  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch {
    console.error('Gemini returned non-JSON', rawText.slice(0, 500));
    return res.status(502).json({ ok: false, error: 'Classifier returned malformed JSON' });
  }

  // Last-line sanity rules (defense in depth — the prompt should already prevent these)
  const result = enforceSanityRules(parsed, desc);

  return res.status(200).json({
    ok: true,
    result,
    meta: {
      model: GEMINI_MODEL,
      timestamp: new Date().toISOString(),
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────────
function setCorsHeaders(res, origin) {
  if (origin && ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) {
    try { res.setHeader('Access-Control-Allow-Origin', new URL(origin).origin); } catch {}
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// Catches the well-known essential-character traps — appends to risk_flags and lowers confidence.
// Does NOT silently rewrite the HTS — brokers must see the disagreement so they can override or accept.
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
