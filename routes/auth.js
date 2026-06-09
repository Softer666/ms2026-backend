const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Wypełnij wszystkie pola' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Hasło minimum 6 znaków' });
  try {
    const [existing] = await db.execute('SELECT id FROM users WHERE email=?', [email]);
    if (existing.length) return res.status(400).json({ error: 'Ten email jest już zajęty' });
    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.execute(
      'INSERT INTO users (name, email, password) VALUES (?,?,?)',
      [name, email, hash]
    );
    const token = jwt.sign(
      { id: result.insertId, name, email, role: 'user', is_child: 0, is_paused: 0 },
      process.env.JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ token, user: { id: result.insertId, name, email, role: 'user', is_child: 0, is_paused: 0 } });
  } catch (err) {
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await db.execute('SELECT * FROM users WHERE email=?', [email]);
    if (!rows.length) return res.status(400).json({ error: 'Nieprawidłowy email lub hasło' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Nieprawidłowy email lub hasło' });
    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role,
        is_child: user.is_child, is_paused: user.is_paused },
      process.env.JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email,
      role: user.role, is_child: user.is_child, is_paused: user.is_paused } });
  } catch (err) {
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

module.exports = router;
