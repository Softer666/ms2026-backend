-- ============================================
-- SCHEMAT BAZY DANYCH — MŚ 2026 Typowanie
-- Wgraj przez phpMyAdmin lub SSH na cyberfolks
-- ============================================

SET NAMES utf8mb4;
SET time_zone = '+02:00';

-- Użytkownicy
CREATE TABLE IF NOT EXISTS users (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  email       VARCHAR(150) NOT NULL UNIQUE,
  password    VARCHAR(255) NOT NULL,
  role        ENUM('user','admin') DEFAULT 'user',
  is_child    TINYINT(1) DEFAULT 0,       -- 1 = dziecko (stawka 1 zł)
  is_paused   TINYINT(1) DEFAULT 0,       -- 1 = pauza (brak typów)
  pause_pool  DECIMAL(8,2) DEFAULT 0.00,  -- pula z meczów w trakcie pauzy
  cash_in     DECIMAL(8,2) DEFAULT 0.00,  -- wpłacona gotówka
  winnings    DECIMAL(8,2) DEFAULT 0.00,  -- łączne wygrane
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mecze (pobierane z football-data.org API)
CREATE TABLE IF NOT EXISTS matches (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  api_id          INT UNIQUE,              -- ID z football-data.org
  phase           ENUM('group','r16','qf','sf','third','final') DEFAULT 'group',
  group_name      VARCHAR(5),              -- np. 'A', 'B', NULL dla fazy pucharowej
  home_team       VARCHAR(100) NOT NULL,
  home_flag       VARCHAR(10),             -- emoji flagi
  away_team       VARCHAR(100) NOT NULL,
  away_flag       VARCHAR(10),
  match_date      DATETIME NOT NULL,
  deadline        DATETIME,                -- auto: match_date - 2h
  status          ENUM('upcoming','open','live','finished') DEFAULT 'upcoming',
  score_home      TINYINT,
  score_away      TINYINT,
  scorers         TEXT,                    -- JSON array: [{"name":"Lewandowski","minute":23}]
  pool            DECIMAL(8,2) DEFAULT 0.00,
  carry_over      DECIMAL(8,2) DEFAULT 0.00, -- przeniesiona reszta z poprzednich
  summary_ai      TEXT,                    -- opis wygenerowany przez Claude
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Typy graczy
CREATE TABLE IF NOT EXISTS bets (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  match_id    INT NOT NULL,
  score_home  TINYINT NOT NULL,
  score_away  TINYINT NOT NULL,
  stake       DECIMAL(4,2) NOT NULL,       -- 3.00 lub 1.00
  is_hit      TINYINT(1) DEFAULT NULL,     -- NULL=oczekuje, 1=trafiony, 0=pudło
  win_amount  DECIMAL(8,2) DEFAULT 0.00,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_match (user_id, match_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (match_id) REFERENCES matches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Historia wpłat gotówkowych
CREATE TABLE IF NOT EXISTS payments (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  amount      DECIMAL(8,2) NOT NULL,
  note        VARCHAR(255),
  recorded_by INT NOT NULL,               -- user_id admina który wpisał
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Historia rozliczeń pul meczowych
CREATE TABLE IF NOT EXISTS pool_distributions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  match_id    INT NOT NULL,
  total_pool  DECIMAL(8,2),
  winners     TEXT,                        -- JSON: [{"user_id":1,"amount":50}]
  carry_next  DECIMAL(8,2) DEFAULT 0.00,  -- reszta przeniesiona dalej
  distributed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (match_id) REFERENCES matches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================
-- KONTO ADMINA (zmień hasło przed uruchomieniem!)
-- Hasło: admin123 — ZMIEŃ PO ZALOGOWANIU
-- ============================================
INSERT INTO users (name, email, password, role) VALUES
('Administrator', 'admin@twojadomena.pl',
 '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- hasło: password
 'admin');
