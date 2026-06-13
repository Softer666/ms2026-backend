const jwt = require('jsonwebtoken');

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Brak tokenu autoryzacji' });
  }

  try {
    // Weryfikacja tokenu za pomocą klucza sekretnego
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    // Zabezpieczenie: logujemy techniczny powód błędu w konsoli serwera (np. wygasł / zły klucz .env)
    console.error('[AUTH ERROR] Problem z weryfikacją tokenu:', err.message);
    
    res.status(401).json({ error: 'Token jest nieważny lub wygasł' });
  }
}

function adminOnly(req, res, next) {
  // Bezpieczne sprawdzenie roli dzięki optional chaining
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Brak wymaganych uprawnień administratora' });
  }
  next();
}

module.exports = { auth, adminOnly };