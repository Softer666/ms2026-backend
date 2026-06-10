const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');

// Wszystkie trasy admina wymagają auth + adminOnly
router.use(auth, adminOnly);

// GET /api/admin/users — lista graczy z bilansem
router.get('/users', async (req, res) => {
  const [users] = await db.execute(`
    SELECT u.*,
      COALESCE(SUM(b.stake),0) AS total_due,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE user_id=u.id) AS cash_in_db,
      (SELECT COALESCE(SUM(win_amount),0) FROM bets WHERE user_id=u.id AND is_hit=1) AS total_won
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id
    WHERE u.role != 'admin'
    GROUP BY u.id
    ORDER BY total_won DESC
  `);
  res.json(users);
});

// PATCH /api/admin/users/:id — zmień is_child / is_paused
router.patch('/users/:id', async (req, res) => {
  const { is_child, is_paused } = req.body;
  const fields = [];
  const vals = [];
  if (is_child !== undefined) { fields.push('is_child=?'); vals.push(is_child ? 1 : 0); }
  if (is_paused !== undefined) { fields.push('is_paused=?'); vals.push(is_paused ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Brak pól do aktualizacji' });
  vals.push(req.params.id);
  await db.execute(`UPDATE users SET ${fields.join(',')} WHERE id=?`, vals);
  res.json({ ok: true });
});

// POST /api/admin/users — dodaj gracza
router.post('/users', async (req, res) => {
  const { name, email, password, is_child } = req.body;
  const hash = await bcrypt.hash(password || 'Zmien123!', 10);
  try {
    const [r] = await db.execute(
      'INSERT INTO users (name, email, password, is_child) VALUES (?,?,?,?)',
      [name, email, hash, is_child ? 1 : 0]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    res.status(400).json({ error: 'Email zajęty lub błąd' });
  }
});

// GET /api/admin/payments — historia wpłat
router.get('/payments', async (req, res) => {
  const [rows] = await db.execute(`
    SELECT p.*, u.name AS user_name, a.name AS admin_name
    FROM payments p
    JOIN users u ON u.id = p.user_id
    JOIN users a ON a.id = p.recorded_by
    ORDER BY p.created_at DESC
  `);
  res.json(rows);
});

// POST /api/admin/payments — zarejestruj wpłatę gotówkową
router.post('/payments', async (req, res) => {
  const { user_id, amount, note } = req.body;
  if (!user_id || !amount || amount <= 0)
    return res.status(400).json({ error: 'Podaj gracza i kwotę' });
  await db.execute(
    'INSERT INTO payments (user_id, amount, note, recorded_by) VALUES (?,?,?,?)',
    [user_id, amount, note || '', req.user.id]
  );
  await db.execute('UPDATE users SET cash_in = cash_in + ? WHERE id=?', [amount, user_id]);
  res.json({ ok: true });
});

// POST /api/admin/matches/:id/result — wpisz wynik meczu i rozlicz
router.post('/matches/:id/result', async (req, res) => {
  const { score_home, score_away } = req.body;
  const matchId = req.params.id;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      'UPDATE matches SET score_home=?, score_away=?, status="finished" WHERE id=?',
      [score_home, score_away, matchId]
    );

    const [winners] = await conn.execute(
      `SELECT b.*, u.is_child FROM bets b JOIN users u ON u.id=b.user_id
       WHERE b.match_id=? AND b.score_home=? AND b.score_away=?`,
      [matchId, score_home, score_away]
    );

    const [[match]] = await conn.execute(
      'SELECT pool, carry_over FROM matches WHERE id=?', [matchId]
    );
    const totalPool = parseFloat(match.pool) + parseFloat(match.carry_over || 0);

    let carryNext = 0;

    if (winners.length > 0) {
      const share = Math.floor(totalPool / winners.length);
      carryNext = parseFloat((totalPool - share * winners.length).toFixed(2));

      for (const w of winners) {
        await conn.execute(
          'UPDATE bets SET is_hit=1, win_amount=? WHERE id=?', [share, w.id]
        );
        await conn.execute(
          'UPDATE users SET winnings=winnings+? WHERE id=?', [share, w.user_id]
        );
      }
    } else {
      carryNext = totalPool;
    }

    await conn.execute(
      `UPDATE bets SET is_hit=0 WHERE match_id=? AND is_hit IS NULL
       AND NOT (score_home=? AND score_away=?)`,
      [matchId, score_home, score_away]
    );

    if (carryNext > 0) {
      await conn.execute(
        `UPDATE matches SET carry_over=carry_over+?
         WHERE match_date > (SELECT match_date FROM (SELECT match_date FROM matches WHERE id=?) t)
         AND status IN ('upcoming','open') ORDER BY match_date ASC LIMIT 1`,
        [carryNext, matchId]
      );
    }

    await conn.execute(
      'INSERT INTO pool_distributions (match_id, total_pool, winners, carry_next) VALUES (?,?,?,?)',
      [matchId, totalPool, JSON.stringify(winners.map(w => ({ user_id: w.user_id, amount: Math.floor(totalPool / winners.length) }))), carryNext]
    );

    await conn.commit();
    res.json({ ok: true, winners: winners.length, totalPool, carryNext });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Błąd rozliczenia: ' + err.message });
  } finally {
    conn.release();
  }
});

// GET /api/admin/stats — statystyki ogólne
router.get('/stats', async (req, res) => {
  const [[s]] = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role='user') AS total_users,
      (SELECT COUNT(*) FROM users WHERE is_paused=1) AS paused_users,
      (SELECT COALESCE(SUM(pool+carry_over),0) FROM matches WHERE status!='finished') AS current_pool,
      (SELECT COUNT(*) FROM matches WHERE status='live') AS live_matches,
      (SELECT COUNT(*) FROM matches WHERE DATE(match_date)=CURDATE()) AS today_matches,
      (SELECT COALESCE(SUM(amount),0) FROM payments) AS total_cash_in,
      (SELECT COALESCE(SUM(winnings),0) FROM users) AS total_paid_out
  `);
  res.json(s);
});

// ==========================================================
// 🚀 NOWE ENDPOINTY DLA ADMINA (DODANE NA TWOJE ŻYCZENIE)
// ==========================================================

// DELETE /api/admin/users/:id — Usuwanie gracza, jego wpłat i typów (Transakcja)
router.delete('/users/:id', async (req, res) => {
  const userId = req.params.id;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Czyścimy powiązane dane z tabel podrzędnych
    await conn.execute('DELETE FROM payments WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM bets WHERE user_id = ?', [userId]);
    
    // 2. Usuwamy główne konto gracza
    const [result] = await conn.execute('DELETE FROM users WHERE id = ? AND role != "admin"', [userId]);

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Nie znaleziono użytkownika lub próba usunięcia admina' });
    }

    await conn.commit();
    res.json({ ok: true, message: 'Gracz i jego powiązane dane zostały usunięte.' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Błąd podczas usuwania gracza: ' + err.message });
  } finally {
    conn.release();
  }
});

// POST /api/admin/bets/force — Wymuszenie/Dodanie/Edycja typu za gracza przez Admina
router.post('/bets/force', async (req, res) => {
  const { user_id, match_id, score_home, score_away, stake } = req.body;

  if (!user_id || !match_id || score_home === undefined || score_away === undefined) {
    return res.status(400).json({ error: 'Brakujące parametry (user_id, match_id, wyniki)' });
  }

  try {
    // Sprawdzamy czy ten gracz postawił już na ten mecz
    const [existing] = await db.execute('SELECT id FROM bets WHERE user_id = ? AND match_id = ?', [user_id, match_id]);

    if (existing.length > 0) {
      // Jeśli typ już był — aktualizujemy go (wymuszona zmiana)
      await db.execute(
        'UPDATE bets SET score_home = ?, score_away = ?, stake = ? WHERE user_id = ? AND match_id = ?',
        [score_home, score_away, stake || 0, user_id, match_id]
      );
    } else {
      // Jeśli typ nie istniał — wrzucamy nowy rekord
      await db.execute(
        'INSERT INTO bets (user_id, match_id, score_home, score_away, stake, is_hit) VALUES (?, ?, ?, ?, ?, NULL)',
        [user_id, match_id, score_home, score_away, stake || 0]
      );
    }

    res.json({ ok: true, message: 'Typowanie gracza zostało zaktualizowane przez administratora.' });
  } catch (err) {
    res.status(500).json({ error: 'Błąd zapisu typowania: ' + err.message });
  }
});

module.exports = router;