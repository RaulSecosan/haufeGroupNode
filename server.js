// // Express 5 + Ollama local + fallback, cu:
// // - Auto-fix care păstrează comentariile (validare și revert dacă e cazul)
// // - Findings cu linii + fragmente de cod (code_excerpt)
// const express = require("express");
// const cors = require("cors");
// const path = require("path");

// const app = express();
// app.use(cors());
// app.use(express.json({ limit: "512kb" }));
// app.use(express.static(path.join(__dirname, "public")));

// // Health
// app.get("/api/ping", (req, res) => {
//   res.json({ ok: true, ts: Date.now() });
// });

// /* ------------------------ Utilitare ------------------------ */
// function tryParseJsonResponse(text) {
//   try {
//     return JSON.parse(text);
//   } catch {}
//   const fence = text.match(/```json\s*([\s\S]*?)```/i);
//   if (fence) {
//     try {
//       return JSON.parse(fence[1]);
//     } catch {}
//   }
//   const start = text.indexOf("{");
//   const end = text.lastIndexOf("}");
//   if (start !== -1 && end > start) {
//     try {
//       return JSON.parse(text.slice(start, end + 1));
//     } catch {}
//   }
//   return null;
// }

// function isJsSyntaxValid(code) {
//   try {
//     new Function(code);
//     return true;
//   } catch {
//     return false;
//   }
// }

// // extrage comentariile (pentru validare post auto-fix)
// function extractComments(code) {
//   const commentRegex = /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)/g;
//   return (code.match(commentRegex) || []).map((s) => s.trim());
// }

// /* ------------------------ Fallback local: linii + fragmente ------------------------ */
// function simpleStaticReview(code = "", filename = "snippet.js") {
//   const findings = [];
//   const lines = code.split(/\r?\n/);

//   const pushFinding = (fLines, type, severity, title, detail) => {
//     const code_excerpt = fLines
//       .slice(0, 10)
//       .map((n) => lines[n - 1]?.trim())
//       .filter(Boolean);
//     findings.push({
//       type,
//       severity,
//       title,
//       detail,
//       lines: fLines,
//       code_excerpt,
//     });
//   };

//   if (!code.trim()) {
//     findings.push({
//       type: "input",
//       severity: "high",
//       title: "Cod lipsă",
//       detail: "Trimite un snippet de cod.",
//       lines: [],
//       code_excerpt: [],
//     });
//     return { engine: "rules", filename, findings, suggestions: [] };
//   }

//   // 1) Linii > 120 caractere
//   const longLines = lines
//     .map((l, i) => ({ n: i + 1, len: l.length }))
//     .filter((x) => x.len > 120)
//     .map((x) => x.n);
//   if (longLines.length) {
//     pushFinding(
//       longLines,
//       "style",
//       "info",
//       "Linii lungi",
//       `${longLines.length} linii depășesc 120 caractere.`
//     );
//   }

//   // 2) eval()
//   const evalLines = [];
//   lines.forEach((l, i) => {
//     if (/\beval\s*\(/.test(l)) evalLines.push(i + 1);
//   });
//   if (evalLines.length) {
//     pushFinding(
//       evalLines,
//       "security",
//       "high",
//       "Folosire eval()",
//       "Evită eval(); poate executa cod arbitrar."
//     );
//   }

//   // 3) var
//   const varLines = [];
//   lines.forEach((l, i) => {
//     if (/\bvar\s+/.test(l)) varLines.push(i + 1);
//   });
//   if (varLines.length) {
//     pushFinding(
//       varLines,
//       "style",
//       "medium",
//       "Folosire var",
//       "Preferă let/const pentru scoping clar."
//     );
//   }

//   // 4) console.log/debug
//   const consoleLines = [];
//   lines.forEach((l, i) => {
//     if (/console\.(log|debug)\(/.test(l)) consoleLines.push(i + 1);
//   });
//   if (consoleLines.length) {
//     pushFinding(
//       consoleLines,
//       "quality",
//       "low",
//       "console.* în cod",
//       "În cod de producție folosește un logger sau elimină."
//     );
//   }

//   // 5) TODO/FIXME
//   const todoLines = [];
//   lines.forEach((l, i) => {
//     if (/TODO|FIXME/.test(l)) todoLines.push(i + 1);
//   });
//   if (todoLines.length) {
//     pushFinding(
//       todoLines,
//       "process",
//       "info",
//       "Marcaje TODO/FIXME",
//       "Există TODO/FIXME; planifică rezolvarea sau documentează intenția."
//     );
//   }

//   return {
//     engine: "rules",
//     filename,
//     findings,
//     suggestions: [
//       "Adaugă ESLint cu o configurație de bază.",
//       "Scrie teste pentru funcțiile importante.",
//       "Documentează API-urile publice în README.",
//     ],
//   };
// }

// /* ------------------------ Ollama: Review (cu linii + code_excerpt) ------------------------ */
// async function tryOllamaReview(
//   code,
//   filename = "snippet.js",
//   model = "llama3"
// ) {
//   const controller = new AbortController();
//   const t = setTimeout(() => controller.abort(), 20000);
//   try {
//     const prompt = `
// You are a strict JSON generator for code reviews.
// Return ONLY JSON with this exact schema:
// {
//   "findings": [
//     {
//       "type":"security|quality|style|maintainability",
//       "severity":"low|medium|high",
//       "title":"...",
//       "detail":"...",
//       "lines":[1,2,3],              // 1-based line numbers if known
//       "code_excerpt":["line text"]  // exact code lines for the issue
//     }
//   ],
//   "suggestions": ["...", "..."]
// }
// No prose outside JSON. No markdown fences.

// Analyze file ${filename}.
// When possible, include "lines" and a short "code_excerpt" with the exact offending code lines.

// CODE:
// ${code}`.trim();

//     const res = await fetch("http://localhost:11434/api/generate", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ model, prompt, stream: false }),
//       signal: controller.signal,
//     });

//     clearTimeout(t);
//     if (!res.ok) return null;
//     const data = await res.json();
//     const raw = String(data?.response || "").trim();
//     const structured = tryParseJsonResponse(raw);
//     if (!structured) return { engine: "ollama-llm", filename, raw };
//     return { engine: "ollama-llm", filename, raw, structured };
//   } catch {
//     clearTimeout(t);
//     return null;
//   }
// }

// /* ------------------------ Ollama: Auto-fix (păstrează comentariile) ------------------------ */
// async function tryOllamaFix(code, filename = "snippet.js", model = "llama3") {
//   const controller = new AbortController();
//   const t = setTimeout(() => controller.abort(), 25000);
//   try {
//     const prompt = `
// You are a precise refactoring assistant.
// Return ONLY JSON with the exact fields. No extra text, no markdown.

// Schema:
// {
//   "fixed_code": "<entire file after fixes>",
//   "changes": [{"title":"...","detail":"..."}]
// }

// Hard constraints:
// - Preserve ALL comments verbatim; DO NOT remove or rewrite comments.
// - Keep original behavior; do not invent identifiers/APIs.
// - Prefer small, mechanical improvements (e.g., use template literals, minor clarity).
// - If constraints cannot be satisfied, return "fixed_code" IDENTICAL to input and one change explaining why.

// File: ${filename}
// INPUT CODE:
// ${code}`.trim();

//     const res = await fetch("http://localhost:11434/api/generate", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ model, prompt, stream: false }),
//       signal: controller.signal,
//     });

//     clearTimeout(t);
//     if (!res.ok) return null;

//     const data = await res.json();
//     const raw = String(data?.response || "").trim();
//     const json = tryParseJsonResponse(raw);
//     if (!json || typeof json.fixed_code !== "string") {
//       return { engine: "ollama-fix", filename, raw };
//     }

//     const fixed = json.fixed_code;
//     const changes = Array.isArray(json.changes) ? json.changes : [];

//     // 1) Validare sintaxă
//     if (!isJsSyntaxValid(fixed)) {
//       return {
//         engine: "auto-fix-invalid",
//         filename,
//         fixed_code: code,
//         changes: [
//           {
//             title: "Reverted due to syntax error",
//             detail: "LLM produced invalid JavaScript; kept original file.",
//           },
//         ],
//         raw,
//       };
//     }

//     // 2) Păstrare comentarii (conservator)
//     const beforeComments = extractComments(code);
//     const afterComments = extractComments(fixed);
//     if (
//       beforeComments.length &&
//       afterComments.length < Math.floor(beforeComments.length * 0.8)
//     ) {
//       return {
//         engine: "auto-fix-reverted",
//         filename,
//         fixed_code: code,
//         changes: [
//           {
//             title: "Reverted to preserve comments",
//             detail: "Fix would remove or alter many comments.",
//           },
//         ],
//         raw,
//       };
//     }

//     return { engine: "ollama-fix", filename, fixed_code: fixed, changes, raw };
//   } catch {
//     clearTimeout(t);
//     return null;
//   }
// }

// /* ------------------------ Endpoints ------------------------ */
// app.post("/api/review", async (req, res) => {
//   const {
//     code = "",
//     filename = "snippet.js",
//     useLlm = true,
//     model = "llama3",
//   } = req.body || {};
//   if (!useLlm) return res.json(simpleStaticReview(code, filename));
//   const llm = await tryOllamaReview(code, filename, model);
//   if (llm) return res.json(llm);
//   return res.json(simpleStaticReview(code, filename));
// });

// app.post("/api/auto-fix", async (req, res) => {
//   const {
//     code = "",
//     filename = "snippet.js",
//     model = "llama3",
//   } = req.body || {};
//   const llm = await tryOllamaFix(code, filename, model);
//   if (llm?.fixed_code) return res.json({ ok: true, ...llm });
//   return res.json({
//     ok: true,
//     engine: "auto-fix-fallback",
//     filename,
//     fixed_code: code,
//     changes: [
//       {
//         title: "No AI fix applied",
//         detail: "LLM did not return valid JSON. Consider retry.",
//       },
//     ],
//     raw: llm?.raw || "",
//   });
// });

// // SPA
// app.get(/.*/, (req, res) => {
//   res.sendFile(path.join(__dirname, "public", "index.html"));
// });

// // Start
// const PORT = process.env.PORT || 3000;
// const server = app.listen(PORT, () => {
//   console.log(`Server pornit pe http://localhost:${PORT}`);
// });
// server.on("error", (err) => console.error("Eroare server:", err));
// process.on("uncaughtException", (err) =>
//   console.error("uncaughtException:", err)
// );
// process.on("unhandledRejection", (r) =>
//   console.error("unhandledRejection:", r)
// );

// Express 5 + Ollama + fallback rules combinate
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/api/ping", (_, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------------- Utilitare ---------------- */
function tryParseJsonResponse(text) {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch {} }
  return null;
}
function isJsSyntaxValid(code) { try { new Function(code); return true; } catch { return false; } }
function extractComments(code) {
  const re = /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)/g;
  return (code.match(re) || []).map(s => s.trim());
}

/* --------------- Fallback local: reguli + linii + fragmente --------------- */
function simpleStaticReview(code = "", filename = "snippet.js") {
  const findings = [];
  const lines = code.split(/\r?\n/);

  const pushFinding = (fLines, type, severity, title, detail) => {
    if (!fLines.length) return;
    const code_excerpt = fLines.slice(0, 8).map(n => lines[n - 1] ?? "").filter(Boolean);
    findings.push({ type, severity, title, detail, lines: fLines, code_excerpt });
  };

  if (!code.trim()) {
    findings.push({
      type: "input", severity: "high", title: "Cod lipsă",
      detail: "Trimite un snippet de cod.", lines: [], code_excerpt: []
    });
    return { engine: "rules", filename, findings, suggestions: [] };
  }

  // 1) Linii > 120
  pushFinding(
    lines.map((l, i) => ({ n: i + 1, len: l.length })).filter(x => x.len > 120).map(x => x.n),
    "maintainability", "medium", "Linie prea lungă", "Depășește 120 de caractere."
  );

  // 2) eval()
  pushFinding(
    lines.reduce((acc, l, i) => (/\beval\s*\(/.test(l) ? acc.concat(i + 1) : acc), []),
    "security", "high", "Folosire eval()", "Evită eval(); poate executa cod arbitrar."
  );

  // 3) var
  pushFinding(
    lines.reduce((acc, l, i) => (/\bvar\s+/.test(l) ? acc.concat(i + 1) : acc), []),
    "style", "medium", "Folosire var", "Preferă let/const pentru scoping clar."
  );

  // 4) console.log/debug
  pushFinding(
    lines.reduce((acc, l, i) => (/console\.(log|debug)\(/.test(l) ? acc.concat(i + 1) : acc), []),
    "quality", "low", "console.* în cod", "În producție folosește un logger sau elimină."
  );

  // 5) TODO/FIXME (informativ)
  pushFinding(
    lines.reduce((acc, l, i) => (/(^|[^a-z])(?:TODO|FIXME)([^a-z]|$)/i.test(l) ? acc.concat(i + 1) : acc), []),
    "process", "low", "Marcaje TODO/FIXME", "Există TODO/FIXME; planifică rezolvarea."
  );

  // 6) Asignare posibil fără declarație: nume = ...; pe linie, nu începe cu let/const/var/function/class/import/export
  const undeclared = [];
  const assignRe = /^\s*([A-Za-z_$][\w$]*)\s*=/;
  lines.forEach((l, i) => {
    if (/^\s*(let|const|var|function|class|import|export)\b/.test(l)) return;
    if (assignRe.test(l)) undeclared.push(i + 1);
  });
  pushFinding(
    undeclared,
    "quality", "medium", "Asignare posibil fără declarație",
    "Pare o variabilă folosită fără let/const/var pe această linie."
  );

  return { engine: "rules", filename, findings, suggestions: [] };
}

/* --------------- Ollama: Review (JSON strict) --------------- */
async function tryOllamaReview(code, filename = "snippet.js", model = "llama3") {
  const prompt = `
Return ONLY JSON:
{
  "findings":[
    {"type":"security|quality|style|maintainability|process","severity":"low|medium|high","title":"...","detail":"...","lines":[1,2],"code_excerpt":["..."] }
  ],
  "suggestions":[]
}
No prose. No markdown fences. If nothing found, findings = [].

File: ${filename}
Code:
${code}
`.trim();

  try {
    const r = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false })
    });
    const raw = (await r.json())?.response ?? "";
    const structured = tryParseJsonResponse(String(raw).trim());
    if (!structured) return { engine: "ollama-llm", filename, raw };
    return { engine: "ollama-llm", filename, raw, structured };
  } catch {
    return null;
  }
}

/* --------------- Ollama: Auto-fix (păstrează comentariile) --------------- */
async function tryOllamaFix(code, filename = "snippet.js", model = "llama3") {
  const prompt = `
Return ONLY JSON:
{ "fixed_code":"<entire file>", "changes":[{"title":"...","detail":"..."}] }

Constraints:
- Preserve ALL comments verbatim.
- Keep behavior; only safe mechanical improvements (template literals, let/const).
- If unsure, return original code in "fixed_code".

File: ${filename}
Input:
${code}
`.trim();

  try {
    const r = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false })
    });
    const raw = (await r.json())?.response ?? "";
    const json = tryParseJsonResponse(String(raw).trim());
    if (!json || typeof json.fixed_code !== "string") {
      return { engine: "ollama-fix", filename, raw };
    }

    const fixed = json.fixed_code;
    const changes = Array.isArray(json.changes) ? json.changes : [];

    if (!isJsSyntaxValid(fixed)) {
      return {
        engine: "auto-fix-invalid",
        filename, fixed_code: code,
        changes: [{ title: "Reverted", detail: "LLM a produs JS invalid." }],
        raw
      };
    }
    const beforeC = extractComments(code);
    const afterC = extractComments(fixed);
    if (beforeC.length && afterC.length < Math.floor(beforeC.length * 0.8)) {
      return {
        engine: "auto-fix-reverted",
        filename, fixed_code: code,
        changes: [{ title: "Reverted", detail: "Comentariile s-ar pierde." }],
        raw
      };
    }
    return { engine: "ollama-fix", filename, fixed_code: fixed, changes, raw };
  } catch {
    return null;
  }
}

/* --------------- API --------------- */
app.post("/api/review", async (req, res) => {
  const { code = "", filename = "snippet.js", useLlm = true, model = "llama3" } = req.body || {};

  const rules = simpleStaticReview(code, filename);

  if (!useLlm) {
    return res.json({
      engine: "combined",
      filename,
      findings: rules.findings,
      suggestions: rules.suggestions,
      engines: ["rules"]
    });
  }

  const llm = await tryOllamaReview(code, filename, model);

  // Combinare: fallback + ce a reușit LLM (dacă e structurat)
  const llmFindings = llm?.structured?.findings || [];
  const llmSuggestions = llm?.structured?.suggestions || [];

  const findings = [...rules.findings, ...llmFindings];
  const suggestions = [...(rules.suggestions || []), ...(llmSuggestions || [])];

  return res.json({
    engine: "combined",
    filename,
    findings,
    suggestions,
    engines: ["rules"].concat(llm ? [llm.engine] : [])
  });
});

app.post("/api/auto-fix", async (req, res) => {
  const { code = "", filename = "snippet.js", model = "llama3" } = req.body || {};
  const out = await tryOllamaFix(code, filename, model);
  if (out?.fixed_code) return res.json({ ok: true, ...out });
  return res.json({
    ok: true, engine: "auto-fix-fallback", filename,
    fixed_code: code,
    changes: [{ title: "No AI fix applied", detail: "LLM nu a returnat JSON valid." }],
    raw: out?.raw || ""
  });
});

// SPA
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server pornit pe http://localhost:${PORT}`));
