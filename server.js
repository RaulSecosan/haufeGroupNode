// Express + Ollama + LLM docs/effort + robust auto-fix (retry) + fallback local
const express = require("express");
const cors = require("cors");
const path = require("path");

const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/ping", (_, res) => res.json({ ok: true, ts: Date.now() }));

/* ===== Utils ===== */
function tryParseJsonResponse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function isJsSyntaxValid(code) {
  try { new Function(code); return true; } catch { return false; }
}
function stripCodeFences(s) {
  if (typeof s !== "string") return s;
  const m = s.match(/^```[\s\S]*?\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}
function looksLikeSource(code) {
  if (!code || typeof code !== "string") return false;
  const t = code.trim();
  if (t.length < 25) return false;
  if (/^[\w\-. ]+\.(js|jsx|ts|tsx|json|py|java|go|rb|cs|cpp|c|txt)$/i.test(t)) return false;
  if (!/[{};()=]/.test(t) && !/\b(function|const|let|var|class|import|export|=>)\b/.test(t)) return false;
  if (t.split(/\r?\n/).length < 2) return false;
  return true;
}

/* ===== Static rules (detecție) ===== */
function simpleStaticReview(code = "", filename = "snippet.js") {
  const findings = [];
  const lines = code.split(/\r?\n/);
  const nonComment = lines
    .map((t,i)=>({t,i:i+1}))
    .filter(o=>!o.t.trim().startsWith("//") && !o.t.trim().startsWith("/*"));

  function push(nums, type, severity, title, detail) {
    if (!nums.length) return;
    findings.push({
      type, severity, title, detail,
      lines: nums,
      code_excerpt: nums.map(n => lines[n - 1]),
      effort: null,
      docs: null
    });
  }

  if (!code.trim()) {
    findings.push({
      type: "input", severity: "high",
      title: "Cod lipsă", detail: "Trimite un snippet de cod.",
      lines: [], code_excerpt: [], effort: null, docs: null
    });
    return { engine: "rules", filename, findings, suggestions: [] };
  }

  try { new Function(code); } catch (err) {
    const m = String(err.stack||"").match(/<anonymous>:(\d+):/);
    push([m ? Number(m[1]) : 1], "syntax", "high", "Eroare de sintaxă", err.message);
  }

  push(nonComment.filter(l=>l.t.length>120).map(l=>l.i), "maintainability", "medium", "Linie prea lungă", "Depășește 120 de caractere.");
  push(nonComment.filter(l=>/\beval\s*\(/.test(l.t)).map(l=>l.i), "security", "high", "Folosire eval()", "Evită eval(); poate executa cod arbitrar.");
  push(nonComment.filter(l=>/\bvar\s+/.test(l.t)).map(l=>l.i), "style", "medium", "Folosire var", "Preferă let/const.");
  push(nonComment.filter(l=>/console\.(log|debug)\(/.test(l.t)).map(l=>l.i), "quality", "low", "console.* în cod", "În producție folosește un logger.");
  push(lines.map((t,i)=>/(TODO|FIXME)/.test(t)?i+1:null).filter(Boolean), "process", "low", "Marcaje TODO/FIXME", "Planifică rezolvarea.");
  push(
    nonComment.filter(l=>!/\b(let|const|var|function|class|import|export)\b/.test(l.t) && /^\s*[A-Za-z_$][\w$]*\s*=/.test(l.t)).map(l=>l.i),
    "quality", "medium", "Asignare posibil fără declarație", "Variabilă fără let/const/var."
  );

  return { engine: "rules", filename, findings, suggestions: [] };
}

/* ===== Fallback local determinist (nu schimbă logica, ignoră comentarii) ===== */
function autoFixLocal(code) {
  const lines = code.split(/\r?\n/);
  let inBlock = false;
  const out = lines.map((line) => {
    const original = line;
    if (inBlock) { if (/\*\//.test(line)) inBlock = false; return original; }
    if (/^\s*\/\//.test(line)) return original;
    if (/\/\*/.test(line) && !/\*\//.test(line)) { inBlock = true; return original; }

    let s = line;

    // concatenări simple -> template literals
    s = s
      .replace(/"([^"]*)"\s*\+\s*([A-Za-z_$][\w$]*)/g, "`$1${$2}`")
      .replace(/([A-Za-z_$][\w$]*)\s*\+\s*"([^"]*)"/g, "`${$1}$2`")
      .replace(/'([^']*)'\s*\+\s*([A-Za-z_$][\w$]*)/g, "`$1${$2}`")
      .replace(/([A-Za-z_$][\w$]*)\s*\+\s*'([^']*)'/g, "`${$1}$2`");

    // var -> let
    s = s.replace(/\bvar\s+/g, "let ");

    return s;
  });

  const fixed_code = out.join("\n");
  if (fixed_code !== code) {
    return {
      fixed_code,
      changes: [
        { title: "template strings", detail: "Concatenări convertite la template literals." },
        { title: "let/const", detail: "Înlocuite declarările var cu let." }
      ]
    };
  }
  return null;
}

/* ===== Ollama: Review cu docs + effort ===== */
async function tryOllamaReview(code, filename, model) {
  const prompt = `
You are a static analyzer. Output ONLY valid JSON.

SCHEMA:
{
 "findings":[
   {
     "type":"security|quality|style|maintainability|process|syntax",
     "severity":"low|medium|high",
     "title":"string",
     "detail":"string",
     "lines":[1],
     "code_excerpt":["string"],
     "effort":{"bucket":"XS|S|M|L|XL|Unknown","hours":1,"rationale":"string"},
     "docs":{
        "why_it_matters":"string",
        "how_to_fix":["string"],
        "good_example":"string",
        "bad_example":"string",
        "references":["string"]
     }
   }
 ],
 "suggestions":["string"]
}

If unknown:
"effort":{"bucket":"Unknown","hours":0,"rationale":"Unknown"}
"docs":{"why_it_matters":"Unknown","how_to_fix":[],"good_example":"","bad_example":"","references":[]}

FILE:${filename}
CODE:
${code}`;
  try {
    const r = await fetch(OLLAMA_URL,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        model,
        prompt,
        format:"json",
        options:{ temperature:0, num_ctx:4096 },
        stream:false
      })
    });
    if (!r.ok) return null;
    const raw = (await r.json())?.response ?? "";
    const parsed = tryParseJsonResponse(String(raw).trim());
    if (!parsed) return { engine:"ollama-llm", filename, raw };
    return { engine:"ollama-llm", filename, raw, structured:parsed };
  } catch { return null; }
}

/* ===== Ollama: Auto-fix cu retry ===== */
async function callOllamaFix(prompt, model) {
  const r = await fetch(OLLAMA_URL,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ model, prompt, format:"json", options:{ temperature:0, num_ctx:4096 }, stream:false })
  });
  if (!r.ok) return null;
  const raw = (await r.json())?.response ?? "";
  return { raw, json: tryParseJsonResponse(String(raw).trim()) };
}

async function tryOllamaFixWithRetry(code, filename, model) {
  const basePrompt = (extra) => `
You are a precise refactoring assistant. Preserve behavior exactly.
Allowed: var→let/const, string concatenation→template literals, whitespace, semicolons.
Do NOT change logic or add/remove calls. If unsure, return the INPUT unchanged.

Return ONLY valid JSON:
{"fixed_code":"<entire file>","changes":[{"title":"string","detail":"string"}]}

Additional constraints: ${extra}

FILE:${filename}
INPUT:
${code}`;

  // Attempt 1: standard
  let attempt = await callOllamaFix(basePrompt(
    "fixed_code must contain the FULL file content, not a filename."
  ), model);

  // Attempt 2: stricter
  if (!attempt?.json || typeof attempt.json.fixed_code !== "string" || !looksLikeSource(stripCodeFences(attempt.json.fixed_code))) {
    attempt = await callOllamaFix(basePrompt(
      "Do NOT return a filename. If no change is needed, copy INPUT verbatim into fixed_code. Ensure fixed_code contains at least 2 newlines and tokens like function/const/let or braces."
    ), model);
  }

  // Attempt 3: force copy input if still wrong
  if (!attempt?.json || typeof attempt.json.fixed_code !== "string" || !looksLikeSource(stripCodeFences(attempt.json.fixed_code))) {
    attempt = { json: { fixed_code: code, changes: [{ title:"No LLM fix", detail:"Model returned invalid output; kept input verbatim." }] }, raw: attempt?.raw };
  }

  const fixed = stripCodeFences(attempt.json.fixed_code);
  if (!looksLikeSource(fixed) || !isJsSyntaxValid(fixed)) {
    return {
      engine: "auto-fix-invalid",
      filename,
      fixed_code: code,
      changes: [{ title: "Reverted", detail: "LLM a produs rezultat nevalid." }],
      raw: attempt?.raw
    };
  }
  return { engine:"ollama-fix", filename, fixed_code: fixed, changes: attempt.json.changes || [], raw: attempt?.raw };
}

/* ===== Endpoints ===== */
app.post("/api/review", async (req,res)=>{
  const { code="", filename="snippet.js", useLlm=true, model="llama3" } = req.body || {};
  const local = simpleStaticReview(code, filename);

  if (!useLlm) {
    return res.json({
      engine:"combined", filename,
      findings: local.findings, suggestions: [],
      effort_total: { bucket:"Unknown", hours:0 }
    });
  }

  const llm = await tryOllamaReview(code, filename, model);
  const llmFind = llm?.structured?.findings || [];
  const llmSug  = llm?.structured?.suggestions || [];
  const findings = [...local.findings, ...llmFind];

  const hours = findings.reduce((s,f)=> s+(f.effort?.hours||0), 0);
  const bucket = hours<0.5?"XS":hours<1.5?"S":hours<4?"M":hours<8?"L":"XL";

  return res.json({
    engine:"combined", filename,
    findings, suggestions: llmSug,
    effort_total: { bucket, hours: Number(hours.toFixed(1)) },
    engines: ["rules"].concat(llm?[llm.engine]:[])
  });
});

app.post("/api/auto-fix", async (req,res)=>{
  const { code="", filename="snippet.js", model="llama3" } = req.body || {};

  // 1) LLM cu retry
  let llm = await tryOllamaFixWithRetry(code, filename, model);
  if (llm?.fixed_code) {
    const review = simpleStaticReview(llm.fixed_code, filename);
    return res.json({ ok:true, ...llm, findings: review.findings, suggestions: review.suggestions });
  }

  // 2) Fallback local determinist
  const local = autoFixLocal(code);
  if (local && isJsSyntaxValid(local.fixed_code)) {
    const review = simpleStaticReview(local.fixed_code, filename);
    return res.json({
      ok:true, engine:"auto-fix-fallback-local", filename,
      fixed_code: local.fixed_code, changes: local.changes,
      findings: review.findings, suggestions: review.suggestions
    });
  }

  // 3) Nimic aplicabil: returnează codul inițial
  const review = simpleStaticReview(code, filename);
  return res.json({
    ok:true, engine:"auto-fix-fallback", filename,
    fixed_code: code,
    changes:[{ title:"No AI fix applied", detail:"Modelul nu a returnat cod valid, iar fallback-ul local nu a identificat modificări sigure." }],
    findings: review.findings, suggestions: review.suggestions
  });
});

/* SPA */
app.get(/.*/, (req,res)=> res.sendFile(path.join(__dirname,"public","index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server pornit pe http://localhost:${PORT}`));
