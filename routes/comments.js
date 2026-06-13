const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');

// 1. POBIERZ KOMENTARZE DLA DANEGO MECZU
// GET /api/comments/:matchId
router.get('/:matchId', auth, async (req, res) => {
  const matchId = req.params.matchId;
  try {
    const [comments] = await db.execute(`
      SELECT mc.id, mc.comment_text, mc.created_at, u.name AS user_name, u.role
      FROM match_comments mc
      JOIN users u ON u.id = mc.user_id
      WHERE mc.match_id = ?
      ORDER BY mc.created_at ASC
    `, [matchId]);
    
    res.json(comments);
  } catch (err) {
    console.error(`[COMMENTS GET ERROR] Błąd pobierania komentarzy dla meczu ${matchId}:`, err);
    res.status(500).json({ error: 'Wystąpił wewnętrzny błąd serwera podczas pobierania komentarzy.' });
  }
});

// 2. DODAJ NOWY KOMENTARZ DO MECZU
// POST /api/comments/:matchId
router.post('/:matchId', auth, async (req, res) => {
  const matchId = req.params.matchId;
  const { comment_text } = req.body;
  const userId = req.user.id;

  // Zabezpieczenie 1: Walidacja pustego pola
  if (!comment_text || comment_text.trim() === '') {
    return res.status(400).json({ error: 'Treść komentarza nie może być pusta.' });
  }

  // Zabezpieczenie 2: Ochrona przed zbyt długimi wpisami (max 1000 znaków)
  if (comment_text.length > 1000) {
    return res.status(400).json({ error: 'Komentarz jest za długi. Maksymalna długość to 1000 znaków.' });
  }

  try {
    await db.execute(
      'INSERT INTO match_comments (match_id, user_id, comment_text) VALUES (?, ?, ?)',
      [matchId, userId, comment_text.trim()]
    );
    res.json({ ok: true, message: 'Komentarz został pomyślnie dodany!' });
  } catch (err) {
    console.error(`[COMMENTS POST ERROR] Błąd dodawania komentarza przez użytkownika ${userId}:`, err);
    res.status(500).json({ error: 'Wystąpił błąd systemu podczas próby zapisu komentarza.' });
  }
});

module.exports = router;