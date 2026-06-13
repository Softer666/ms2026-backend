const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');

// GET /api/matches — wszystkie mecze z moim typem i liczbą postawionych kuponów
router.get('/', auth, async (req, res) => {
  try {
    const [matches] = await db.execute(`
      SELECT m.*,
        b.score_home AS my_home, b.score_away AS my_away,
        b.is_hit, b.win_amount,
        COALESCE((SELECT COUNT(*) FROM bets WHERE match_id = m.id), 0) AS bet_count
      FROM matches m
      LEFT JOIN bets b ON b.match_id = m.id AND b.user_id = ?
      ORDER BY m.match_date ASC
    `, [req.user.id]);
    
    res.json(matches);
  } catch (err) {
    console.error('[MATCHES GET ALL ERROR]:', err);
    res.status(500).json({ error: 'Wystąpił błąd serwera podczas pobierania meczów.' });
  }
});

// POST /api/matches/:id/bet — Złóż typ (Zabezpieczony transakcją!)
router.post('/:id/bet', auth, async (req, res) => {
  const matchId = req.params.id;
  const userId = req.user.id;
  
  // Bezpieczne parsowanie wyników na liczby całkowite
  const score_home = parseInt(req.body.score_home, 10);
  const score_away = parseInt(req.body.score_away, 10);

  if (isNaN(score_home) || isNaN(score_away)) {
    return res.status(400).json({ error: 'Podaj prawidłowe, liczbowe wyniki meczu!' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Pobierz i zweryfikuj mecz (używamy FOR UPDATE w celu blokady wiersza na czas sprawdzania deadline'u)
    const [matchRows] = await conn.execute('SELECT * FROM matches WHERE id = ? FOR UPDATE', [matchId]);
    if (!matchRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Mecz nie istnieje.' });
    }
    const match = matchRows[0];

    if (match.status !== 'open') {
      await conn.rollback();
      return res.status(400).json({ error: 'Typowanie zamknięte dla tego meczu.' });
    }

    const now = new Date();
    const deadline = new Date(match.deadline);
    if (now >= deadline) {
      await conn.rollback();
      return res.status(400).json({ error: 'Deadline minął — typ nie może zostać przyjęty.' });
    }

    // 2. Wyciągamy aktualny status gracza prosto z bazy (unikamy przestarzałych danych z tokenu JWT)
    const [userRows] = await conn.execute('SELECT is_paused, is_child FROM users WHERE id = ?', [userId]);
    const user = userRows[0];
    
    if (user.is_paused === 1) {
      await conn.rollback();
      return res.status(400).json({ error: 'Twoje konto jest zapauzowane przez administratora — nie możesz typować.' });
    }

    // 3. Sprawdź, czy gracz już wcześniej nie wysłał typu (ochrona przed dublowaniem żądań z frontu)
    const [existing] = await conn.execute(
      'SELECT id FROM bets WHERE user_id = ? AND match_id = ?', [userId, matchId]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Już wysłałeś swój typ na ten mecz.' });
    }

    // Wyliczenie stawki: Dziecko 1 zł, Dorosły 3 zł
    const stake = user.is_child === 1 ? 1.00 : 3.00;

    // 4. Zapis kuponu
    await conn.execute(
      'INSERT INTO bets (user_id, match_id, score_home, score_away, stake) VALUES (?,?,?,?,?)',
      [userId, matchId, score_home, score_away, stake]
    );

    // 5. Powiększenie puli meczowej
    await conn.execute(
      'UPDATE matches SET pool = pool + ? WHERE id = ?', [stake, matchId]
    );

    await conn.commit();
    res.json({ ok: true, stake, message: `Typ ${score_home}:${score_away} został pomyślnie zapisany!` });
  } catch (err) {
    await conn.rollback();
    console.error(`[MATCHES BET POST ERROR] Błąd użytkownika ${userId} na meczu ${matchId}:`, err);
    
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Już typowałeś ten mecz.' });
    }
    res.status(500).json({ error: 'Wystąpił błąd podczas rejestracji zakładu w bazie danych.' });
  } finally {
    conn.release();
  }
});

// GET /api/matches/:id/all-bets — Pobiera typy wszystkich graczy dla danego meczu
router.get('/:id/all-bets', auth, async (req, res) => {
  const matchId = req.params.id;
  try {
    // 1. Sprawdzamy status meczu
    const [matchRows] = await db.execute('SELECT status FROM matches WHERE id = ?', [matchId]);
    if (!matchRows.length) return res.status(404).json({ error: 'Mecz nie istnieje' });
    
    const match = matchRows[0];
    
    // Zabezpieczenie anty-ściąganiowe: blokujemy wgląd przed startem
    if (match.status === 'upcoming' || match.status === 'open') {
      return res.json([]); 
    }

    // 2. Jeśli mecz ruszył lub się skończył — pobieramy typy użytkowników
    const [allBets] = await db.execute(`
      SELECT b.score_home, b.score_away, b.is_hit, b.win_amount, u.name AS user_name, u.is_child
      FROM bets b
      JOIN users u ON u.id = b.user_id
      WHERE b.match_id = ? AND u.role != 'admin'
      ORDER BY b.is_hit DESC, u.name ASC
    `, [matchId]);

    res.json(allBets);
  } catch (err) {
    console.error(`[MATCHES GET ALL-BETS ERROR] Mecz ID ${matchId}:`, err);
    res.status(500).json({ error: 'Błąd pobierania typów innych użytkowników.' });
  }
});

module.exports = router;