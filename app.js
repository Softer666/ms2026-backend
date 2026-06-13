require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const db = require('./config/db');
const { auth } = require('./middleware/auth');

const app = express();

// ==========================================
// 1. KONFIGURACJA CORS
// ==========================================
const allowedOrigins = [
  'http://ms2026.softerstudio.pl',
  'https://ms2026.softerstudio.pl',
  'http://www.ms2026.softerstudio.pl',
  'https://www.ms2026.softerstudio.pl'
];

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ==========================================
// 2. MIDDLEWARE
// ==========================================
app.use(express.json());

// ==========================================
// 3. ŚCIEŻKI API (API Routes)
// ==========================================
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/matches',  require('./routes/matches'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/comments', require('./routes/comments'));

// Ranking publiczny (zalogowani) - Wersja bezpieczna i zoptymalizowana
app.get('/api/ranking', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        u.id, 
        u.name, 
        u.is_child, 
        u.is_paused,
        u.cash_in,
        u.winnings,
        COALESCE((SELECT COUNT(*) FROM bets WHERE user_id = u.id), 0) AS total_bets,
        COALESCE((SELECT COUNT(*) FROM bets WHERE user_id = u.id AND is_hit = 1), 0) AS hits,
        COALESCE((SELECT SUM(stake) FROM bets WHERE user_id = u.id), 0) AS total_due
      FROM users u
      WHERE u.role = 'user'
      GROUP BY u.id
      ORDER BY hits DESC, u.winnings DESC, u.name ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Błąd pobierania rankingu:', err);
    res.status(500).json({ error: 'Błąd serwera podczas pobierania rankingu' });
  }
});

// Moje typy (zalogowany użytkownik)
app.get('/api/me/bets', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        b.*, 
        m.home_team, m.away_team, m.home_flag, m.away_flag,
        m.match_date, m.status, m.score_home AS result_home, m.score_away AS result_away,
        m.scorers, m.summary_ai
      FROM bets b 
      JOIN matches m ON m.id = b.match_id
      WHERE b.user_id = ?
      ORDER BY m.match_date DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('Błąd pobierania typów użytkownika:', err);
    res.status(500).json({ error: 'Błąd serwera podczas pobierania Twoich typów' });
  }
});

// ==========================================
// 4. SERWOWANIE FRONTENDU
// ==========================================
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ==========================================
// 5. START SERWERA
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ MŚ 2026 Portal uruchomiony na porcie ${PORT}`);
  // Bezpieczne uruchomienie zadań CRON
  try {
    require('./config/cron').startCron();
    console.log("🚀 Automatyzacja CRON została pomyślnie uruchomiona.");
  } catch (cronErr) {
    console.error("❌ Krytyczny błąd podczas startu CRON:", cronErr.message);
  }
});