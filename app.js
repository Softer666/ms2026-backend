require('dotenv').config();
const express = require('express');
const cors = require('cors');
app.use(cors({
  origin: [
    "http://ms2026.softerstudio.pl",
    "https://ms2026.softerstudio.pl"
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

const path = require('path');

const app = express();




// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/matches', require('./routes/matches'));
app.use('/api/admin',   require('./routes/admin'));

// Ranking publiczny (zalogowani)
const { auth } = require('./middleware/auth');
const db = require('./config/db');

app.get('/api/ranking', auth, async (req, res) => {
  const [rows] = await db.execute(`
    SELECT u.id, u.name, u.is_child, u.is_paused,
      COUNT(b.id) AS total_bets,
      SUM(CASE WHEN b.is_hit=1 THEN 1 ELSE 0 END) AS hits,
      COALESCE(SUM(b.stake),0) AS total_due,
      u.cash_in,
      u.winnings
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id
    WHERE u.role = 'user'
    GROUP BY u.id
    ORDER BY hits DESC, u.winnings DESC
  `);
  res.json(rows);
});

app.get('/api/me/bets', auth, async (req, res) => {
  const [rows] = await db.execute(`
    SELECT b.*, m.home_team, m.away_team, m.home_flag, m.away_flag,
      m.match_date, m.status, m.score_home AS result_home, m.score_away AS result_away,
      m.scorers, m.summary_ai
    FROM bets b JOIN matches m ON m.id = b.match_id
    WHERE b.user_id = ?
    ORDER BY m.match_date DESC
  `, [req.user.id]);
  res.json(rows);
});

// Serwuj frontend (pliki statyczne)
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ MŚ 2026 Portal uruchomiony na porcie ${PORT}`);
  // Uruchom zadania cron (sync API, deadlines)
  require('./config/cron').startCron();
  console.log("CRON wyłączony na czas deployu");
  
});
