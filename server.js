const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Servește frontendul din folderul public
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint simplu de test backend
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Catch-all pentru orice alt route în Express 5
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server pornit pe http://localhost:${PORT}`);
});
