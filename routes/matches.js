const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');

// GET /api/matches — wszystkie mecze z moim typem
router.get('/', auth, async (req, res) => {
  try {
    const [matches] = await db.execute(`
      SELECT m.*,
        b.score_home AS my_home, b.score_away AS my_away,
        b.is_hit, b.win_amount,
        (SELECT COUNT(*) FROM bets WHERE match_id = m.id) AS bet_count
      FROM matches m
      LEFT JOIN bets b ON b.match_id = m.id AND b.user_id = ?
      ORDER BY m.match_date ASC
    `, [req.user.id]);
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

// POST /api/matches/:id/bet — złóż typ
router.post('/:id/bet', auth, async (req, res) => {
  const matchId = req.params.id;
  const { score_home, score_away } = req.body;
  const userId = req.user.id;

  if (score_home == null || score_away == null)
    return res.status(400).json({ error: 'Podaj wynik' });

  try {
    // Sprawdź mecz
    const [rows] = await db.execute('SELECT * FROM matches WHERE id=?', [matchId]);
    if (!rows.length) return res.status(404).json({ error: 'Mecz nie istnieje' });
    const match = rows[0];

    if (match.status !== 'open')
      return res.status(400).json({ error: 'Typowanie zamknięte dla tego meczu' });

    const now = new Date();
    const deadline = new Date(match.deadline);
    if (now >= deadline)
      return res.status(400).json({ error: 'Deadline minął — typ nie może być przyjęty' });

    // Sprawdź czy gracz jest na pauzie
    const [userRows] = await db.execute('SELECT * FROM users WHERE id=?', [userId]);
    const user = userRows[0];
    if (user.is_paused)
      return res.status(400).json({ error: 'Jesteś na pauzie — nie możesz typować' });

    // Sprawdź czy już typował
    const [existing] = await db.execute(
      'SELECT id FROM bets WHERE user_id=? AND match_id=?', [userId, matchId]
    );
    if (existing.length)
      return res.status(400).json({ error: 'Już wysłałeś typ na ten mecz' });

    const stake = user.is_child ? 1.00 : 3.00;

    await db.execute(
      'INSERT INTO bets (user_id, match_id, score_home, score_away, stake) VALUES (?,?,?,?,?)',
      [userId, matchId, score_home, score_away, stake]
    );

    // Dodaj stawkę do puli meczu
    await db.execute(
      'UPDATE matches SET pool = pool + ? WHERE id=?', [stake, matchId]
    );

    res.json({ ok: true, stake, message: `Typ ${score_home}:${score_away} przyjęty!` });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(400).json({ error: 'Już typowałeś ten mecz' });
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

module.exports = router;
