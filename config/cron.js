const cron = require('node-cron');
const axios = require('axios');
const db = require('../config/db');

const FLAG_MAP = {
  'Mexico': '🇲🇽', 'Poland': '🇵🇱', 'United States': '🇺🇸', 'Canada': '🇨🇦',
  'Argentina': '🇦🇷', 'Brazil': '🇧🇷', 'France': '🇫🇷', 'Germany': '🇩🇪',
  'England': '🏴', 'Spain': '🇪🇸', 'Netherlands': '🇳🇱', 'Portugal': '🇵🇹',
  'Belgium': '🇧🇪', 'Italy': '🇮🇹', 'Croatia': '🇭🇷', 'Morocco': '🇲🇦',
  'Japan': '🇯🇵', 'South Korea': '🇰🇷', 'Australia': '🇦🇺', 'Serbia': '🇷🇸',
  'Switzerland': '🇨🇭', 'Uruguay': '🇺🇾', 'Ecuador': '🇪🇨', 'Senegal': '🇸🇳',
  'Ghana': '🇬🇭', 'Cameroon': '🇨🇲', 'Tunisia': '🇹🇳', 'Qatar': '🇶🇦',
  'Saudi Arabia': '🇸🇦', 'Iran': '🇮🇷', 'Costa Rica': '🇨🇷', 'Panama': '🇵🇦',
  'Honduras': '🇭🇳', 'Chile': '🇨🇱', 'Colombia': '🇨🇴', 'Venezuela': '🇻🇪',
  'Peru': '🇵🇪', 'Paraguay': '🇵🇾', 'Bolivia': '🇧🇴', 'Turkey': '🇹🇷',
  'Ukraine': '🇺🇦', 'Romania': '🇷🇴', 'Hungary': '🇭🇺', 'Slovakia': '🇸🇰',
  'Czech Republic': '🇨🇿', 'Czechia': '🇨🇿', 'Denmark': '🇩🇰', 'Sweden': '🇸🇪',
  'Norway': '🇳🇴', 'Finland': '🇫🇮', 'Austria': '🇦🇹', 'Greece': '🇬🇷',
  'Algeria': '🇩🇿', 'Egypt': '🇪🇬', 'Nigeria': '🇳🇬', 'South Africa': '🇿🇦',
  'Wales': '🏴', 'Scotland': '🏴', 'Ireland': '🇮🇪', 'New Zealand': '🇳🇿',
};

const API_BASE = process.env.FOOTBALL_API_URL || 'https://api.football-data.org/v4';
const HEADERS = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };

async function fetchAndSyncMatches() {
  if (!process.env.FOOTBALL_API_KEY) {
    console.log('[CRON] Brak FOOTBALL_API_KEY w pliku .env. Synchronizacja pominięta.');
    return;
  }
  
  try {
    const { data } = await axios.get(`${API_BASE}/competitions/WC/matches`, { headers: HEADERS });
    const matches = data.matches;

    // Pobieramy z bazy mecze sfinalizowane przez admina, by ich nie modyfikować
    const [finalized] = await db.execute("SELECT api_id FROM matches WHERE status='finished'");
    const finalizedIds = new Set(finalized.map(m => m.api_id));

    for (const m of matches) {
      // Ignoruj mecze bez przypisanych zespołów
      if (!m.homeTeam?.name || !m.awayTeam?.name) continue;
      
      // Jeśli mecz został już ręcznie zamrożony i rozliczony — pomijamy
      if (finalizedIds.has(m.id)) continue;

      const homeTeam = m.homeTeam.name;
      const awayTeam = m.awayTeam.name;
      const matchDate = new Date(m.utcDate);
      
      // Dynamiczny termin zamknięcia typów: 5 minut przed oficjalnym gwizdkiem
      const deadline = new Date(matchDate.getTime() - 5 * 60 * 1000);

      let status = 'upcoming';
      if (m.status === 'SCHEDULED' || m.status === 'TIMED') {
        const hoursToMatch = (matchDate - new Date()) / 3600000;
        status = hoursToMatch <= 48 ? 'open' : 'upcoming';
      }
      if (m.status === 'IN_PLAY' || m.status === 'PAUSED') status = 'live';
      if (m.status === 'FINISHED') status = 'finished';

      const stageMap = {
        'GROUP_STAGE': 'group', 'LAST_16': 'r16', 'QUARTER_FINALS': 'qf',
        'SEMI_FINALS': 'sf', 'THIRD_PLACE': 'third', 'FINAL': 'final'
      };
      const phase = stageMap[m.stage] || 'group';
      const groupName = m.group ? m.group.replace('GROUP_', '') : null;

      const scoreHome = m.score?.fullTime?.home;
      const scoreAway = m.score?.fullTime?.away;

      const scorers = (m.goals || []).map(g => ({
        name: g.scorer?.name || '?',
        minute: g.minute,
        type: g.type,
        team: g.team?.name
      }));

      const scorersJson = JSON.stringify(scorers);

      await db.execute(`
        INSERT INTO matches (api_id, phase, group_name, home_team, home_flag, away_team, away_flag,
          match_date, deadline, status, score_home, score_away, scorers)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          status = VALUES(status), 
          score_home = VALUES(score_home), 
          score_away = VALUES(score_away),
          scorers = ?, 
          updated_at = NOW()
      `, [
        m.id, phase, groupName,
        homeTeam, FLAG_MAP[homeTeam] || '🏴',
        awayTeam, FLAG_MAP[awayTeam] || '🏴',
        matchDate, deadline, status,
        scoreHome ?? null, scoreAway ?? null,
        scorersJson, // Wstrzykujemy bezpośrednio do zapytania dla UPDATE
        scorersJson
      ]);
    }

    // Wywołanie modułu AI
    await generateMissingSummaries();

    console.log(`[CRON] Pomyślnie zsynchronizowano ${matches.length} meczów.`);
  } catch (err) {
    console.error('[CRON] Błąd krytyczny synchronizacji meczów:', err.message);
  }
}

async function generateMissingSummaries() {
  if (!process.env.ANTHROPIC_API_KEY) return;
  
  try {
    const [rows] = await db.execute(
      `SELECT * FROM matches WHERE status='finished' AND summary_ai IS NULL
       AND score_home IS NOT NULL LIMIT 2`
    );

    for (const match of rows) {
      try {
        const scorers = JSON.parse(match.scorers || '[]');
        const scorerText = scorers.length
          ? scorers.map(s => `${s.name} (${s.minute}', ${s.team})`).join(', ')
          : 'brak danych o strzelcach';

        const prompt = `Napisz krótkie podsumowanie meczu piłkarskiego po polsku (maksymalnie 3-4 zdania).
Mecz: ${match.home_team} ${match.score_home}:${match.score_away} ${match.away_team}
Strzelcy: ${scorerText}
Napisz o przebiegu meczu, bramkach i dynamice spotkania. Styl: sportowy, zwięzły, emocjonujący.`;

        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          { 
            model: 'claude-3-5-sonnet-20241022', 
            max_tokens: 300, 
            messages: [{ role: 'user', content: prompt }] 
          },
          { 
            headers: { 
              'x-api-key': process.env.ANTHROPIC_API_KEY, 
              'anthropic-version': '2023-06-01', 
              'Content-Type': 'application/json' 
            } 
          }
        );

        const summary = response.data.content[0].text;
        await db.execute('UPDATE matches SET summary_ai=? WHERE id=?', [summary, match.id]);
        console.log(`[AI] Wygenerowano opis dla spotkania: ${match.home_team} vs ${match.away_team}`);
      } catch (e) {
        console.error(`[AI] Błąd cząstkowy dla meczu ID ${match.id}:`, e.response?.data || e.message);
      }
    }
  } catch (err) {
    console.error('[AI] Błąd globalny generatora podsumowań:', err.message);
  }
}

function startCron() {
  // Synchronizacja danych z zewnętrznym API co 2 minuty
  cron.schedule('*/2 * * * *', fetchAndSyncMatches);

  // Co 2 godziny — otwarcie meczów zbliżających się do okna 48-godzinnego
  cron.schedule('0 */2 * * *', async () => {
    try {
      await db.execute(`
        UPDATE matches SET status='open'
        WHERE status='upcoming'
        AND match_date <= DATE_ADD(NOW(), INTERVAL 48 HOUR)
        AND match_date > NOW()
      `);
    } catch (err) {
      console.error('[CRON] Błąd otwierania meczów:', err.message);
    }
  });

  // Co 5 minut — automatyczne zabezpieczenie zamykania spóźnionych typowań
  cron.schedule('*/5 * * * *', async () => {
    try {
      await db.execute(`
        UPDATE matches SET status='live'
        WHERE status='open' AND match_date <= NOW()
      `);
    } catch (err) {
      console.error('[CRON] Błąd wymuszenia statusu live:', err.message);
    }
  });

  console.log('[CRON] Wszystkie zadania harmonogramu zostały załadowane.');
  // Opóźnienie startowe (3 sekundy) zapobiegające blokadom połączeń przy restarcie node
  setTimeout(fetchAndSyncMatches, 3000);
}

module.exports = { startCron, fetchAndSyncMatches };