const cron = require('node-cron');
const axios = require('axios');
const db = require('../config/db');

const FLAG_MAP = {
  'Mexico': '🇲🇽', 'Poland': '🇵🇱', 'United States': '🇺🇸', 'Canada': '🇨🇦',
  'Argentina': '🇦🇷', 'Brazil': '🇧🇷', 'France': '🇫🇷', 'Germany': '🇩🇪',
  'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'Spain': '🇪🇸', 'Netherlands': '🇳🇱', 'Portugal': '🇵🇹',
  'Belgium': '🇧🇪', 'Italy': '🇮🇹', 'Croatia': '🇭🇷', 'Morocco': '🇲🇦',
  'Japan': '🇯🇵', 'South Korea': '🇰🇷', 'Australia': '🇦🇺', 'Serbia': '🇷🇸',
  'Switzerland': '🇨🇭', 'Uruguay': '🇺🇾', 'Ecuador': '🇪🇨', 'Senegal': '🇸🇳',
  'Ghana': '🇬🇭', 'Cameroon': '🇨🇲', 'Tunisia': '🇹🇳', 'Qatar': '🇶🇦',
  'Saudi Arabia': '🇸🇦', 'Iran': '🇮🇷', 'Costa Rica': '🇨🇷', 'Panama': '🇵🇦',
  'Honduras': '🇭🇳', 'Chile': '🇨🇱', 'Colombia': '🇨🇴', 'Venezuela': '🇻🇪',
  'Peru': '🇵🇪', 'Paraguay': '🇵🇾', 'Bolivia': '🇧🇴', 'Turkey': '🇹🇷',
  'Ukraine': '🇺🇦', 'Romania': '🇷🇴', 'Hungary': '🇭🇺', 'Slovakia': '🇸🇰',
  'Czech Republic': 'Czechia', 'Czechia': '🇨🇿', 'Denmark': '🇩🇰', 'Sweden': '🇸🇪',
  'Norway': '🇳🇴', 'Finland': '🇫🇮', 'Austria': '🇦🇹', 'Greece': '🇬🇷',
  'Algeria': '🇩🇿', 'Egypt': '🇪🇬', 'Nigeria': '🇳🇬', 'South Africa': '🇿🇦',
  'Wales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿', 'Scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'Ireland': '🇮🇪', 'New Zealand': '🇳🇿',
};

const API_BASE = process.env.FOOTBALL_API_URL || 'https://api.football-data.org/v4';
const HEADERS = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };

async function fetchAndSyncMatches() {
  if (!process.env.FOOTBALL_API_KEY) return;
  try {
    const { data } = await axios.get(`${API_BASE}/competitions/WC/matches`, { headers: HEADERS });
    const matches = data.matches;

    for (const m of matches) {
      const homeTeam = m.homeTeam.name;
      const awayTeam = m.awayTeam.name;
      const matchDate = new Date(m.utcDate);
      // Polska strefa czasowa: +2 w lato
      const deadline = new Date(matchDate.getTime() - 2 * 60 * 60 * 1000);

      let status = 'upcoming';
      if (m.status === 'SCHEDULED' || m.status === 'TIMED') {
        const hoursToMatch = (matchDate - new Date()) / 3600000;
        status = hoursToMatch <= 48 ? 'open' : 'upcoming';
      }
      if (m.status === 'IN_PLAY' || m.status === 'PAUSED') status = 'live';
      if (m.status === 'FINISHED') status = 'finished';

      // Mapuj fazę
      const stageMap = {
        'GROUP_STAGE': 'group', 'LAST_16': 'r16', 'QUARTER_FINALS': 'qf',
        'SEMI_FINALS': 'sf', 'THIRD_PLACE': 'third', 'FINAL': 'final'
      };
      const phase = stageMap[m.stage] || 'group';
      const groupName = m.group ? m.group.replace('GROUP_', '') : null;

      const scoreHome = m.score?.fullTime?.home;
      const scoreAway = m.score?.fullTime?.away;

      // Zbierz strzelców bramek
      const scorers = (m.goals || []).map(g => ({
        name: g.scorer?.name || '?',
        minute: g.minute,
        type: g.type,
        team: g.team?.name
      }));

      await db.execute(`
        INSERT INTO matches (api_id, phase, group_name, home_team, home_flag, away_team, away_flag,
          match_date, deadline, status, score_home, score_away, scorers)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          status=VALUES(status), score_home=VALUES(score_home), score_away=VALUES(score_away),
          scorers=VALUES(scorers), updated_at=NOW()
      `, [
        m.id, phase, groupName,
        homeTeam, FLAG_MAP[homeTeam] || '🏴',
        awayTeam, FLAG_MAP[awayTeam] || '🏴',
        matchDate, deadline, status,
        scoreHome ?? null, scoreAway ?? null,
        JSON.stringify(scorers)
      ]);
    }

    // Generuj opisy AI dla świeżo zakończonych meczów bez opisu
    await generateMissingSummaries();

    console.log(`[CRON] Zsynchronizowano ${matches.length} meczów`);
  } catch (err) {
    console.error('[CRON] Błąd sync meczów:', err.message);
  }
}

async function generateMissingSummaries() {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const [rows] = await db.execute(
    `SELECT * FROM matches WHERE status='finished' AND summary_ai IS NULL
     AND score_home IS NOT NULL LIMIT 3`
  );
  for (const match of rows) {
    try {
      const scorers = JSON.parse(match.scorers || '[]');
      const scorerText = scorers.length
        ? scorers.map(s => `${s.name} (${s.minute}', ${s.team})`).join(', ')
        : 'brak danych o strzelcach';

      const prompt = `Napisz krótkie podsumowanie meczu piłkarskiego po polsku (3-4 zdania).
Mecz: ${match.home_team} ${match.score_home}:${match.score_away} ${match.away_team}
Strzelcy: ${scorerText}
Napisz o przebiegu meczu, bramkach i jednej ciekawej akcji. Styl: sportowy, emocjonujący, zwięzły.`;

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: 'claude-sonnet-4-20250514', max_tokens: 300, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
      );

      const summary = response.data.content[0].text;
      await db.execute('UPDATE matches SET summary_ai=? WHERE id=?', [summary, match.id]);
      console.log(`[AI] Opis wygenerowany dla meczu ${match.home_team} vs ${match.away_team}`);
    } catch (e) {
      console.error('[AI] Błąd generowania opisu:', e.message);
    }
  }
}

function startCron() {
  // Co 60 sekund — aktualizuj wyniki na żywo
  cron.schedule('* * * * *', fetchAndSyncMatches);

  // Co 2 godziny — otwórz typowanie dla nadchodzących meczów
  cron.schedule('0 */2 * * *', async () => {
    await db.execute(`
      UPDATE matches SET status='open'
      WHERE status='upcoming'
      AND match_date <= DATE_ADD(NOW(), INTERVAL 48 HOUR)
      AND match_date > NOW()
    `);
  });

  // Co 5 minut — zamknij typowanie dla meczów bliskich startu
  cron.schedule('*/5 * * * *', async () => {
    await db.execute(`
      UPDATE matches SET status='live'
      WHERE status='open' AND match_date <= NOW()
    `);
    // Sprawdź graczy którzy nie wysłali typów — ustaw pauzę
    // (uproszczona wersja: admin może to też robić ręcznie)
  });

  console.log('[CRON] Zadania zaplanowane. Pierwsza synchronizacja za chwilę...');
  setTimeout(fetchAndSyncMatches, 5000); // pierwsze pobranie po 5s od startu
}

module.exports = { startCron, fetchAndSyncMatches };
