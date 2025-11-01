// Express 5 + Ollama JSON strict + auto-fix local (comentariile NU mai blochează fixul)
const express = require("express");
const cors = require("cors");
const path = require("path");

const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/ping", (_, res) => res.json({ ok: true, ts: Date.now() }));

/* ===== utilitare ===== */
function tryParseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function isJsSyntaxValid(code) {
  try {
    new Function(code);
    return true;
  } catch {
    return false;
  }
}
function filterPureCommentLines(lines) {
  return lines
    .map((t, i) => ({ n: i + 1, t }))
    .filter(
      (o) => !o.t.trim().startsWith("//") && !o.t.trim().startsWith("/*")
    );
}

/* ===== reguli locale (fallback findings) ===== */
function simpleStaticReview(code = "", filename = "snippet.js") {
  const findings = [];
  const lines = code.split(/\r?\n/);
  const codeLines = filterPureCommentLines(lines);

  const push = (fLines, type, severity, title, detail) => {
    if (!fLines || !fLines.length) return;
    const code_excerpt = fLines
      .slice(0, 8)
      .map((n) => lines[n - 1] ?? "")
      .filter(Boolean);
    findings.push({
      type,
      severity,
      title,
      detail,
      lines: fLines,
      code_excerpt,
    });
  };

  if (!code.trim()) {
    findings.push({
      type: "input",
      severity: "high",
      title: "Cod lipsă",
      detail: "Trimite un snippet de cod.",
      lines: [],
      code_excerpt: [],
    });
    return { engine: "rules", filename, findings, suggestions: [] };
  }

  // sintaxă
  try {
    new Function(code);
  } catch (err) {
    const m = String(err.stack || "").match(/<anonymous>:(\d+):(\d+)/);
    push(
      [m ? Number(m[1]) : 1],
      "syntax",
      "high",
      "Eroare de sintaxă",
      err.message || "Syntax error"
    );
  }

  // linii > 120
  push(
    codeLines.filter((l) => l.t.length > 120).map((l) => l.n),
    "maintainability",
    "medium",
    "Linie prea lungă",
    "Depășește 120 de caractere."
  );

  // eval()
  push(
    codeLines.filter((l) => /\beval\s*\(/.test(l.t)).map((l) => l.n),
    "security",
    "high",
    "Folosire eval()",
    "Evită eval(); poate executa cod arbitrar."
  );

  // var
  push(
    codeLines.filter((l) => /\bvar\s+/.test(l.t)).map((l) => l.n),
    "style",
    "medium",
    "Folosire var",
    "Preferă let/const pentru scoping clar."
  );

  // console.*
  push(
    codeLines.filter((l) => /console\.(log|debug)\(/.test(l.t)).map((l) => l.n),
    "quality",
    "low",
    "console.* în cod",
    "În producție folosește un logger sau elimină."
  );

  // TODO/FIXME
  push(
    lines.reduce(
      (a, t, i) =>
        /(^|[^a-z])(?:TODO|FIXME)([^a-z]|$)/i.test(t) ? a.concat(i + 1) : a,
      []
    ),
    "process",
    "low",
    "Marcaje TODO/FIXME",
    "Există TODO/FIXME; planifică rezolvarea."
  );

  // posibilă asignare fără declarație
  const assignRe = /^\s*([A-Za-z_$][\w$]*)\s*=/;
  push(
    codeLines
      .filter(
        (l) =>
          !/^\s*(let|const|var|function|class|import|export)\b/.test(l.t) &&
          assignRe.test(l.t)
      )
      .map((l) => l.n),
    "quality",
    "medium",
    "Asignare posibil fără declarație",
    "Pare o variabilă folosită fără let/const/var."
  );

  return { engine: "rules", filename, findings, suggestions: [] };
}

/* ===== auto-fix local determinist (nu atinge comentarii) ===== */
function autoFixLocal(code) {
  const lines = code.split(/\r?\n/);
  let inBlock = false;
  const out = lines.map((line) => {
    const original = line;

    if (inBlock) {
      if (/\*\//.test(line)) inBlock = false;
      return original;
    }
    if (/^\s*\/\//.test(line)) return original;
    if (/\/\*/.test(line) && !/\*\//.test(line)) {
      inBlock = true;
      return original;
    }

    let s = line;
    // concatenări simple -> template literals
    s = s
      .replace(/"([^"]*)"\s*\+\s*([A-Za-z_$][\w$]*)/g, "`$1${$2}`")
      .replace(/([A-Za-z_$][\w$]*)\s*\+\s*"([^"]*)"/g, "`${$1}$2`")
      .replace(/'([^']*)'\s*\+\s*([A-Za-z_$][\w$]*)/g, "`$1${$2}`")
      .replace(/([A-Za-z_$][\w$]*)\s*\+\s*'([^']*)'/g, "`${$1}$2`");

    // var -> let
    s = s.replace(/\bvar\s+/g, "let ");

    // marchează eval
    s = s.replace(/\beval\s*\(/g, "/* avoid eval */ eval(");

    return s;
  });

  const fixed_code = out.join("\n");
  const changes = [];
  if (fixed_code !== code) {
    changes.push({
      title: "string interpolation",
      detail:
        "Replaced concatenation with template strings pentru lizibilitate.",
    });
    return { fixed_code, changes };
  }
  return null;
}

/* ===== Ollama: review JSON strict ===== */
async function tryOllamaReview(
  code,
  filename = "snippet.js",
  model = "llama3"
) {
  const prompt = `You are a strict code-review JSON generator. Output MUST be valid JSON and match the schema.
Include offending line numbers in "lines" and short exact code in "code_excerpt".
If nothing to report, use empty arrays.

SCHEMA:
{"findings":[{"type":"security|quality|style|maintainability|process|syntax","severity":"low|medium|high","title":"string","detail":"string","lines":[1],"code_excerpt":["string"]}],"suggestions":["string"]}

FILE: ${filename}
CODE:
${code}`;
  try {
    const r = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        format: "json",
        options: { temperature: 0 },
        stream: false,
      }),
    });
    if (!r.ok) return null;
    const raw = (await r.json())?.response ?? "";
    const structured = tryParseJsonResponse(String(raw).trim());
    if (!structured) return { engine: "ollama-llm", filename, raw };
    return { engine: "ollama-llm", filename, raw, structured };
  } catch {
    return null;
  }
}

/* ===== Ollama: auto-fix JSON strict ===== */
async function tryOllamaFix(code, filename = "snippet.js", model = "llama3") {
  const prompt = `You are a precise refactoring assistant. Output ONLY valid JSON. Keep original behavior.
Do not invent code that changes I/O or side effects. If unsure, return the input unchanged.

RETURN:
{"fixed_code":"<entire file>","changes":[{"title":"string","detail":"string"}]}

FILE: ${filename}
INPUT:
${code}`;
  try {
    const r = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        format: "json",
        options: { temperature: 0 },
        stream: false,
      }),
    });
    if (!r.ok) return null;
    const raw = (await r.json())?.response ?? "";
    const json = tryParseJsonResponse(String(raw).trim());
    if (!json || typeof json.fixed_code !== "string")
      return { engine: "ollama-fix", filename, raw };

    const fixed = json.fixed_code;
    const changes = Array.isArray(json.changes) ? json.changes : [];

    // validare sintaxă
    if (!isJsSyntaxValid(fixed)) {
      return {
        engine: "auto-fix-invalid",
        filename,
        fixed_code: code,
        changes: [{ title: "Reverted", detail: "LLM a produs JS invalid." }],
        raw,
      };
    }

    // Notă: nu mai comparăm comentariile. Acceptăm fixul dacă sintaxa este validă.
    return { engine: "ollama-fix", filename, fixed_code: fixed, changes, raw };
  } catch {
    return null;
  }
}

/* ===== endpoints ===== */
app.post("/api/review", async (req, res) => {
  const {
    code = "",
    filename = "snippet.js",
    useLlm = true,
    model = "llama3",
  } = req.body || {};
  const rules = simpleStaticReview(code, filename);

  if (!useLlm) {
    return res.json({
      engine: "combined",
      filename,
      findings: rules.findings,
      suggestions: [],
      engines: ["rules"],
    });
  }
  const llm = await tryOllamaReview(code, filename, model);
  const llmFind = llm?.structured?.findings || [];
  const llmSug = llm?.structured?.suggestions || [];
  return res.json({
    engine: "combined",
    filename,
    findings: [...rules.findings, ...llmFind],
    suggestions: [...llmSug],
    engines: ["rules"].concat(llm ? [llm.engine] : []),
  });
});

app.post("/api/auto-fix", async (req, res) => {
  const {
    code = "",
    filename = "snippet.js",
    model = "llama3",
  } = req.body || {};

  // 1) încearcă LLM în mod JSON strict
  const llm = await tryOllamaFix(code, filename, model);
  if (llm?.fixed_code) {
    const review = simpleStaticReview(llm.fixed_code, filename);
    return res.json({
      ok: true,
      ...llm,
      findings: review.findings,
      suggestions: review.suggestions,
    });
  }

  // 2) fallback local determinist
  const local = autoFixLocal(code);
  if (local) {
    if (!isJsSyntaxValid(local.fixed_code)) {
      const reviewNo = simpleStaticReview(code, filename);
      return res.json({
        ok: true,
        engine: "auto-fix-reverted",
        filename,
        fixed_code: code,
        changes: [
          {
            title: "Reverted",
            detail: "Sintaxa ar fi afectată de fallback-ul local.",
          },
        ],
        findings: reviewNo.findings,
        suggestions: reviewNo.suggestions,
      });
    }
    const review = simpleStaticReview(local.fixed_code, filename);
    return res.json({
      ok: true,
      engine: "auto-fix-fallback",
      filename,
      fixed_code: local.fixed_code,
      changes: local.changes,
      findings: review.findings,
      suggestions: review.suggestions,
    });
  }

  // 3) nimic aplicabil
  const review = simpleStaticReview(code, filename);
  return res.json({
    ok: true,
    engine: "auto-fix-fallback",
    filename,
    fixed_code: code,
    changes: [
      {
        title: "No AI fix applied",
        detail:
          "LLM nu a returnat JSON valid, iar regula locală nu a identificat modificări sigure.",
      },
    ],
    findings: review.findings,
    suggestions: review.suggestions,
  });
});

// SPA
app.get(/.*/, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server pornit pe http://localhost:${PORT}`)
);
