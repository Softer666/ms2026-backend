const mysql2 = require('mysql2/promise');
require('dotenv').config();

const pool = mysql2.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 5, // cyberfolks limit: 5 połączeń spoza sieci
  queueLimit: 0,
  timezone: '+02:00',
  charset: 'utf8mb4'
});

module.exports = pool;
