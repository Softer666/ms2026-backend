const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');

// Wszystkie trasy admina wymagają auth + adminOnly
router.use(auth, adminOnly);

// GET /api/admin/users — lista graczy z poprawnym bilansem
router.get('/users', async (req, res) => {
  try {
    const [users] = await db.execute(`
      SELECT 
        u.id, u.name, u.email, u.role, u.is_child, u.is_paused, u.cash_in, u.winnings,
        COALESCE((SELECT SUM(stake) FROM bets WHERE user_id = u.id), 0) AS total_due,
        COALESCE((SELECT SUM(amount) FROM payments WHERE user_id = u.id), 0) AS cash_in_db,
        COALESCE((SELECT COUNT(*) FROM bets WHERE user_id = u.id AND is_hit = 1), 0) AS total_won_count
      FROM users u
      WHERE u.role != 'admin'
      ORDER BY u.name ASC
    `);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Błąd pobierania użytkowników: ' + err.message });
  }
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
  
  try {
    await db.execute(`UPDATE users SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Błąd aktualizacji użytkownika: ' + err.message });
  }
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
    res.status(400).json({ error: 'Email zajęty lub błąd zapisu' });
  }
});

// GET /api/admin/payments — historia wpłat
router.get('/payments', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT p.*, u.name AS user_name, a.name AS admin_name
      FROM payments p
      JOIN users u ON u.id = p.user_id
      JOIN users a ON a.id = p.recorded_by
      ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Błąd pobierania płatności: ' + err.message });
  }
});

// POST /api/admin/payments — zarejestruj wpłatę gotówkową
router.post('/payments', async (req, res) => {
  const { user_id, amount, note } = req.body;
  if (!user_id || !amount || parseFloat(amount) <= 0)
    return res.status(400).json({ error: 'Podaj prawidłowego gracza i kwotę' });
    
  try {
    await db.execute(
      'INSERT INTO payments (user_id, amount, note, recorded_by) VALUES (?,?,?,?)',
      [user_id, amount, note || '', req.user.id]
    );
    await db.execute('UPDATE users SET cash_in = cash_in + ? WHERE id=?', [amount, user_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Błąd rejestracji wpłaty: ' + err.message });
  }
});

// PATCH /api/admin/matches/:id — Zwykła edycja parametrów meczu (status, pula, wyniki)
router.patch('/matches/:id', async (req, res) => {
  const matchId = req.params.id;
  const { status, pool, score_home, score_away } = req.body;

  try {
    // Aktualizujemy dane meczu w bazie
    await db.execute(
      `UPDATE matches 
       SET status = ?, pool = ?, score_home = ?, score_away = ? 
       WHERE id = ?`,
      [
        status, 
        pool, 
        score_home !== undefined ? score_home : null, 
        score_away !== undefined ? score_away : null, 
        matchId
      ]
    );

    res.json({ ok: true, message: 'Mecz został zaktualizowany pomyślnie.' });
  } catch (err) {
    console.error('[ADMIN PATCH MATCH ERROR]:', err);
    res.status(500).json({ error: 'Błąd bazy danych podczas edycji meczu: ' + err.message });
  }
});

// POST /api/admin/matches/:id/result — Oficjalne zamkniecie meczu i dystrybucja kasy
router.post('/matches/:id/result', async (req, res) => {
  const matchId = req.params.id;
  const { score_home, score_away } = req.body;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Pobranie danych o meczu
    const [matches] = await conn.execute('SELECT * FROM matches WHERE id = ?', [matchId]);
    if (!matches.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Mecz nie istnieje' });
    }
    const match = matches[0];

    // [BLOKADA STATUSU] Jeśli mecz był już 'ended' / 'finished', upewnij się że jej nie ma, 
    // abyśmy mogli go rozliczyć po poprawkach WhatsAppa!

    // 2. Szukanie zwycięzców, którzy idealnie trafili wynik
    const [winners] = await conn.execute(
      `SELECT b.*, u.is_child FROM bets b 
       JOIN users u ON u.id = b.user_id
       WHERE b.match_id = ? AND b.score_home = ? AND b.score_away = ?`,
      [matchId, score_home, score_away]
    );

    // Pobieramy całkowitą pulę z meczu (Twoje 40 zł)
    const totalPool = parseFloat(match.pool);
    let carryNext = 0;

    if (winners.length > 0) {
      // Dzielimy pulę równo na zwycięzców (40 zł / 5 osób = 8 zł)
      const share = totalPool / winners.length;

      for (const w of winners) {
        // AKTUALIZACJA FINANSÓW GRACZA:
        await conn.execute('UPDATE users SET cash_in = cash_in + ? WHERE id = ?', [share, w.user_id]);
        
        // --- TUTAJ JEST BRAKUJĄCY ELEMENT KODU (RANKING I STATUS KUPONU) ---
        // System musiał oznaczyć kupon jako trafiony w tabeli `bets`, żeby ranking ruszył!
        await conn.execute(
          'UPDATE bets SET is_hit = 1, win_amount = ? WHERE id = ?',
          [share, w.id]
        );
        await conn.execute('UPDATE bets SET is_hit = 0, win_amount = 0 WHERE match_id = ? AND is_hit IS NULL', [matchId]);
      }
    } else {
      // Jeśli nikt nie trafił, pula przechodzi dalej (Jackpot)
      carryNext = totalPool;
    }

    // 3. Oznaczamy wszystkie pozostałe (nietrafione) zakłady w tym meczu jako przegrane (is_hit = 0)
    await conn.execute(
      'UPDATE bets SET is_hit = 0, win_amount = 0 WHERE match_id = ? AND is_hit IS NULL',
      [matchId]
    );

    // 4. Przeniesienie kumulacji na kolejny mecz jeśli carryNext > 0...
    // 5. Zmiana statusu meczu na 'ended' i zapisanie oficjalnego wyniku...

    await conn.commit();
    res.json({ ok: true, winners: winners.length, totalPool, carryNext });

  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// GET /api/admin/stats — statystyki ogólne panelu
router.get('/stats', async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: 'Błąd pobierania statystyk: ' + err.message });
  }
});

// DELETE /api/admin/users/:id — Usuwanie gracza, jego wpłat i typów (Kaskadowo w transakcji)
router.delete('/users/:id', async (req, res) => {
  const userId = req.params.id;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute('DELETE FROM payments WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM bets WHERE user_id = ?', [userId]);
    
    const [result] = await conn.execute('DELETE FROM users WHERE id = ? AND role != "admin"', [userId]);

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Nie znaleziono użytkownika lub próba usunięcia konta administratora' });
    }

    await conn.commit();
    res.json({ ok: true, message: 'Gracz pomyślnie usunięty z systemu.' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Błąd podczas usuwania użytkownika: ' + err.message });
  } finally {
    conn.release();
  }
});

// POST /api/admin/bets/force — Wymuszenie/Dodanie/Edycja typu za gracza przez Admina wraz z kalkulacją stawki i puli!
router.post('/bets/force', async (req, res) => {
  const { user_id, match_id } = req.body;
  const score_home = parseInt(req.body.score_home, 10);
  const score_away = parseInt(req.body.score_away, 10);

  if (!user_id || !match_id || isNaN(score_home) || isNaN(score_away)) {
    return res.status(400).json({ error: 'Brakujące lub nieprawidłowe parametry (user_id, match_id, bramki)' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Sprawdzamy, czy użytkownik w ogóle istnieje i pobieramy jego status dziecka/dorosłego do wyliczenia stawki
    const [[user]] = await conn.execute('SELECT is_child FROM users WHERE id = ?', [user_id]);
    if (!user) {
      await conn.rollback();
      return res.status(404).json({ error: 'Wybrany użytkownik nie istnieje' });
    }

    // Automatyczne dopasowanie stawki: dziecko = 1.00 zł, dorosły = 3.00 zł
    const calculatedStake = user.is_child === 1 ? 1.00 : 3.00;

    // 2. Sprawdzamy czy ten gracz postawił już na ten mecz
    const [existing] = await conn.execute('SELECT id, stake FROM bets WHERE user_id = ? AND match_id = ?', [user_id, match_id]);

    if (existing.length > 0) {
      // Jeśli typ istniał, podmieniamy tylko wyniki i upewniamy się, że stawka jest prawidłowa
      const oldStake = parseFloat(existing[0].stake);
      const stakeDifference = calculatedStake - oldStake;

      await conn.execute(
        'UPDATE bets SET score_home = ?, score_away = ?, stake = ? WHERE user_id = ? AND match_id = ?',
        [score_home, score_away, calculatedStake, user_id, match_id]
      );

      // Aktualizujemy pulę meczu o ewentualną różnicę stawek
      if (stakeDifference !== 0) {
        await conn.execute('UPDATE matches SET pool = pool + ? WHERE id = ?', [stakeDifference, match_id]);
      }
    } else {
      // Jeśli typ nie istniał — wrzucamy nowy rekord do bazy
      await conn.execute(
        'INSERT INTO bets (user_id, match_id, score_home, score_away, stake, is_hit) VALUES (?, ?, ?, ?, ?, NULL)',
        [user_id, match_id, score_home, score_away, calculatedStake]
      );

      // Zwiększamy całkowitą pulę meczu o kwotę nowego zakładu
      await conn.execute('UPDATE matches SET pool = pool + ? WHERE id = ?', [calculatedStake, match_id]);
    }

    await conn.commit();
    res.json({ ok: true, message: 'Typowanie gracza zostało pomyślnie zaktualizowane, a pula meczu przeliczona.' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Błąd wymuszenia typu: ' + err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;