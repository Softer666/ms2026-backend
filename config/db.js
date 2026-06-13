const mysql2 = require('mysql2/promise');
require('dotenv').config();

const pool = mysql2.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // Zabezpieczenie: rzutowanie portu na liczbę całkowitą
  port: parseInt(process.env.DB_PORT || '3306', 10),
  waitForConnections: true,
  // Zabezpieczenie: elastyczny limit połączeń pobierany z .env, domyślnie 5
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '5', 10), 
  queueLimit: 0,
  timezone: '+02:00', // Polska strefa czasowa (czas letni MŚ 2026)
  charset: 'utf8mb4'
});

module.exports = pool;