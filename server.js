// const express = require('express');
// const cors = require('cors');
// const path = require('path');

// const app = express();
// app.use(cors());
// app.use(express.json({ limit: '1mb' }));

// // Servește frontendul din folderul public
// app.use(express.static(path.join(__dirname, 'public')));

// // Endpoint simplu de test backend
// app.get('/api/ping', (req, res) => {
//   res.json({ ok: true, ts: Date.now() });
// });

// // Catch-all pentru orice alt route în Express 5
// app.get(/.*/, (req, res) => {
//   res.sendFile(path.join(__dirname, 'public', 'index.html'));
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`Server pornit pe http://localhost:${PORT}`);
// });

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Servește frontendul
app.use(express.static(path.join(__dirname, "public")));

// Endpoint test
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Analizor minimal de cod (reguli simple)
function simpleStaticReview(code = "", filename = "snippet") {
  const findings = [];

  if (!code.trim()) {
    findings.push({
      type: "input",
      severity: "high",
      title: "Cod lipsă",
      detail: "Trimite un snippet de cod.",
    });
    return { engine: "rules", filename, findings, suggestions: [] };
  }

  const lines = code.split(/\r?\n/);
  const long = lines.filter((l) => l.length > 120).length;
  if (long > 0) {
    findings.push({
      type: "style",
      severity: "info",
      title: "Linii lungi",
      detail: `${long} linii depășesc 120 caractere.`,
    });
  }

  if (/\beval\s*\(/.test(code)) {
    findings.push({
      type: "security",
      severity: "high",
      title: "eval()",
      detail: "Evită eval(); poate executa cod arbitrar.",
    });
  }

  if (/\bvar\s+/.test(code)) {
    findings.push({
      type: "style",
      severity: "medium",
      title: "var",
      detail: "Preferă let/const pentru scoping clar.",
    });
  }

  if (/console\.(log|debug)\(/.test(code)) {
    findings.push({
      type: "quality",
      severity: "low",
      title: "console.*",
      detail: "În cod de producție folosește un logger sau elimină.",
    });
  }

  return {
    engine: "rules",
    filename,
    findings,
    suggestions: [
      "Adaugă ESLint cu o configurație de bază.",
      "Scrie teste pentru funcțiile importante.",
      "Documentează API-urile publice în README.",
    ],
  };
}

// API de review
app.post("/api/review", (req, res) => {
  const { code = "", filename = "snippet.js" } = req.body || {};
  const report = simpleStaticReview(code, filename);
  res.json(report);
});

// Catch-all Express 5
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server pornit pe http://localhost:${PORT}`);
});
