const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

// POST /api/auth/register — Rejestracja nowego użytkownika
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Wypełnij wszystkie pola formularza' });
    
  if (password.length < 6)
    return res.status(400).json({ error: 'Hasło musi składać się z minimum 6 znaków' });
    
  try {
    // Sprawdzenie unikalności adresu e-mail
    const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) return res.status(400).json({ error: 'Ten email jest już zajęty' });
    
    // Szyfrowanie hasła
    const hash = await bcrypt.hash(password, 10);
    
    const [result] = await db.execute(
      'INSERT INTO users (name, email, password) VALUES (?,?,?)',
      [name, email, hash]
    );
    
    // W tokenie trzymamy tylko niezmienne minimum (id, name, role)
    const token = jwt.sign(
      { id: result.insertId, name, role: 'user' },
      process.env.JWT_SECRET, 
      { expiresIn: '30d' }
    );
    
    res.json({ 
      token, 
      user: { id: result.insertId, name, email, role: 'user', is_child: 0, is_paused: 0 } 
    });
  } catch (err) {
    console.error('[AUTH REGISTER ERROR]:', err);
    res.status(500).json({ error: 'Wystąpił wewnętrzny błąd serwera podczas rejestracji' });
  }
});

// POST /api/auth/login — Logowanie użytkownika
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Podaj adres email oraz hasło' });
  }
  
  try {
    const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows.length) return res.status(400).json({ error: 'Nieprawidłowy email lub hasło' });
    
    const user = rows[0];
    
    // Weryfikacja hasła kryptograficznego
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Nieprawidłowy email lub hasło' });
    
    // Generowanie tokenu bez podatnych na zmiany w locie flag (is_child, is_paused wyciągamy na żywo)
    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role },
      process.env.JWT_SECRET, 
      { expiresIn: '30d' }
    );
    
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email,
        role: user.role, 
        is_child: user.is_child, 
        is_paused: user.is_paused 
      } 
    });
  } catch (err) {
    console.error('[AUTH LOGIN ERROR]:', err);
    res.status(500).json({ error: 'Wystąpił wewnętrzny błąd serwera podczas logowania' });
  }
});

module.exports = router;
// POST /api/auth/change-password — Zmiana własnego hasła przez zalogowanego użytkownika
const { auth } = require('../middleware/auth');
router.post('/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Podaj aktualne i nowe hasło' });
  if (new_password.length < 6)
    return res.status(400).json({ error: 'Nowe hasło musi mieć minimum 6 znaków' });

  try {
    const [rows] = await db.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Użytkownik nie istnieje' });

    const ok = await bcrypt.compare(current_password, rows[0].password);
    if (!ok) return res.status(400).json({ error: 'Aktualne hasło jest nieprawidłowe' });

    const hash = await bcrypt.hash(new_password, 10);
    await db.execute('UPDATE users SET password = ? WHERE id = ?', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[CHANGE PASSWORD ERROR]:', err);
    res.status(500).json({ error: 'Błąd serwera podczas zmiany hasła' });
  }
});
