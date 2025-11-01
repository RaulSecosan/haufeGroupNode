// Express 5 + Ollama (LLM local) + fallback simplu (doar dacă LLM eșuează)
// Node 18+ recomandat (fetch nativ).
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Ping sănătate
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/* ------------------------ UTILITARE COMUNE ------------------------ */
function tryParseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

/* ------------------------ FALLBACK: REVIEW SIMPLU ------------------------ */
// folosit numai dacă LLM nu răspunde. Nu „decide”, doar ajută cu ceva minim.
function simpleStaticReview(code = "", filename = "snippet.js") {
  const findings = [];
  if (!code.trim()) {
    return {
      engine: "rules",
      filename,
      findings: [
        {
          type: "input",
          severity: "high",
          title: "Cod lipsă",
          detail: "Trimite un snippet de cod.",
          lines: [],
        },
      ],
      suggestions: [],
    };
  }
  const lines = code.split(/\r?\n/);
  const long = lines
    .map((l, i) => ({ n: i + 1, len: l.length }))
    .filter((x) => x.len > 120)
    .map((x) => x.n);
  if (long.length)
    findings.push({
      type: "style",
      severity: "info",
      title: "Linii lungi",
      detail: `${long.length} linii depășesc 120 caractere.`,
      lines: long,
    });
  const consoleLines = [];
  lines.forEach((l, i) => {
    if (/console\.(log|debug)\(/.test(l)) consoleLines.push(i + 1);
  });
  if (consoleLines.length)
    findings.push({
      type: "quality",
      severity: "low",
      title: "console.* în cod",
      detail: "În producție folosește un logger sau elimină.",
      lines: consoleLines,
    });
  return {
    engine: "rules",
    filename,
    findings,
    suggestions: [
      "Adaugă ESLint cu o configurație de bază.",
      "Scrie teste pentru funcțiile importante.",
    ],
  };
}

/* ------------------------ OLLAMA: REVIEW ------------------------ */
async function tryOllamaReview(
  code,
  filename = "snippet.js",
  model = "llama3"
) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const prompt = `
You are a strict JSON generator for code reviews.
Return ONLY a compact JSON object with this exact schema:
{
  "findings": [
    {"type":"security|quality|style|maintainability","severity":"low|medium|high","title":"...","detail":"..."}
  ],
  "suggestions": ["...", "..."]
}
No prose, no markdown fences.

Analyze file ${filename}. If no problems, use an empty "findings" array and still provide 1–3 suggestions.

CODE:
${code}`.trim();

    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });

    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const raw = String(data?.response || "").trim();
    const structured = tryParseJsonResponse(raw);
    if (!structured) return { engine: "ollama-llm", filename, raw };

    return { engine: "ollama-llm", filename, raw, structured };
  } catch {
    clearTimeout(t);
    return null;
  }
}

/* ------------------------ OLLAMA: AUTO-FIX ------------------------ */
// Cere LLM-ului să producă doar JSON cu câmpuri: fixed_code + changes[]
async function tryOllamaFix(code, filename = "snippet.js", model = "llama3") {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 25000);
  try {
    const prompt = `
You are a precise refactoring assistant.
Return ONLY JSON with the exact fields below. No markdown fences, no extra text.

Schema:
{
  "fixed_code": "<entire file after fixes>",
  "changes": [
    {"title":"...","detail":"..."}
  ]
}

Guidelines:
- Fix low-risk issues improving clarity/maintainability (template strings, remove trivial dead code, safer patterns).
- Keep original intent and behavior.
- Do NOT invent APIs or import libraries.
- If the code is fine, return "fixed_code" identical to input and one/two small suggestions in "changes".

File: ${filename}
INPUT CODE:
${code}`.trim();

    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });

    clearTimeout(t);
    if (!res.ok) return null;

    const data = await res.json();
    const raw = String(data?.response || "").trim();
    const json = tryParseJsonResponse(raw);
    if (!json || typeof json.fixed_code !== "string") {
      return { engine: "ollama-fix", filename, raw }; // raw pentru debugging în UI
    }
    const changes = Array.isArray(json.changes) ? json.changes : [];
    return {
      engine: "ollama-fix",
      filename,
      fixed_code: json.fixed_code,
      changes,
      raw,
    };
  } catch {
    clearTimeout(t);
    return null;
  }
}

/* ------------------------ ENDPOINTS PUBLICE ------------------------ */

// Review: LLM dacă este activ, altfel fallback
app.post("/api/review", async (req, res) => {
  const {
    code = "",
    filename = "snippet.js",
    useLlm = true,
    model = "llama3",
  } = req.body || {};
  if (!useLlm) return res.json(simpleStaticReview(code, filename));
  const llm = await tryOllamaReview(code, filename, model);
  if (llm) return res.json(llm);
  return res.json(simpleStaticReview(code, filename));
});

// Auto-fix: LLM produce codul final; fallback = returnează identic cu o „schimbare” informativă
app.post("/api/auto-fix", async (req, res) => {
  const {
    code = "",
    filename = "snippet.js",
    model = "llama3",
  } = req.body || {};
  const llm = await tryOllamaFix(code, filename, model);
  if (llm?.fixed_code) return res.json({ ok: true, ...llm });
  // fallback: fără hardcode de reguli; doar informăm că nu a reușit
  return res.json({
    ok: true,
    engine: "auto-fix-fallback",
    filename,
    fixed_code: code,
    changes: [
      {
        title: "No AI fix applied",
        detail: "LLM did not return valid JSON. Consider retry.",
      },
    ],
    raw: llm?.raw || "",
  });
});

// Catch-all pentru SPA (Express 5)
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Pornire + diagnostic
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server pornit pe http://localhost:${PORT}`);
});
server.on("error", (err) => console.error("Eroare server:", err));
process.on("uncaughtException", (err) =>
  console.error("uncaughtException:", err)
);
process.on("unhandledRejection", (r) =>
  console.error("unhandledRejection:", r)
);
