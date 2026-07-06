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

    // Przepisanie zwycięzców do kolejnych rund
    await advanceBracketWinners();

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

// ============================================================
// PRZEPISYWANIE ZWYCIĘZCÓW wg bracket_pos
// Siatka: pos1 winner → QF-A home, pos2 winner → QF-A away
//         pos3 winner → QF-B home, pos4 winner → QF-B away
//         pos5 winner → QF-C home, pos6 winner → QF-C away
//         pos7 winner → QF-D home, pos8 winner → QF-D away
// ============================================================
async function advanceBracketWinners() {
  try {
    const [rows] = await db.execute(`
      SELECT id, phase, home_team, away_team, score_home, score_away,
             home_flag, away_flag, status, bracket_pos, match_date
      FROM matches
      WHERE phase IN ('r16','qf','sf','final','third')
      ORDER BY bracket_pos ASC, match_date ASC
    `);

    const byPhase = (p) => rows.filter(m => m.phase === p);
    const r16 = byPhase('r16');
    const qf  = byPhase('qf').sort((a,b) => new Date(a.match_date)-new Date(b.match_date));
    const sf  = byPhase('sf').sort((a,b) => new Date(a.match_date)-new Date(b.match_date));
    const fin   = byPhase('final');
    const third = byPhase('third');

    const getWinner = (m) => {
      if (!m || m.status !== 'finished' || m.score_home === null) return null;
      if (Number(m.score_home) > Number(m.score_away)) return { name: m.home_team, flag: m.home_flag };
      if (Number(m.score_away) > Number(m.score_home)) return { name: m.away_team, flag: m.away_flag };
      return null;
    };
    const getLoser = (m) => {
      if (!m || m.status !== 'finished' || m.score_home === null) return null;
      if (Number(m.score_home) > Number(m.score_away)) return { name: m.away_team, flag: m.away_flag };
      if (Number(m.score_away) > Number(m.score_home)) return { name: m.home_team, flag: m.home_flag };
      return null;
    };

    const setTeam = async (target, slot, team) => {
      if (!target || !team) return;
      const current = slot === 'home' ? target.home_team : target.away_team;
      if (current === team.name) return;
      const col = slot === 'home' ? 'home_team' : 'away_team';
      const flagCol = slot === 'home' ? 'home_flag' : 'away_flag';
      await db.execute(`UPDATE matches SET ${col}=?, ${flagCol}=? WHERE id=?`, [team.name, team.flag, target.id]);
      console.log(`[BRACKET] ${team.name} → ${slot} meczu ID ${target.id} (${target.phase})`);
    };

    const setBracketPos = async (target, pos) => {
      if (!target || target.bracket_pos) return;
      await db.execute(`UPDATE matches SET bracket_pos=? WHERE id=?`, [pos, target.id]);
      target.bracket_pos = pos; // aktualizuj lokalnie
      console.log(`[BRACKET] bracket_pos=${pos} → mecz ID ${target.id} (${target.phase})`);
    };

    // Znajdź QF/SF wg bracket_pos lub null
    const findByPos = (arr, pos) => arr.find(m => Number(m.bracket_pos) === pos) || null;

    const byPos = (pos) => r16.find(m => Number(m.bracket_pos) === pos) || null;

    // R16 → QF wg bracket_pos
    // pos1+pos2 → QF bracket_pos=1
    // pos3+pos4 → QF bracket_pos=2
    // pos5+pos6 → QF bracket_pos=3
    // pos7+pos8 → QF bracket_pos=4
    const r16ToQf = [
      [1, 1, 'home'], [2, 1, 'away'],
      [3, 2, 'home'], [4, 2, 'away'],
      [5, 3, 'home'], [6, 3, 'away'],
      [7, 4, 'home'], [8, 4, 'away'],
    ];
    for (const [r16pos, qfPos, slot] of r16ToQf) {
      const w = getWinner(byPos(r16pos));
      if (!w) continue;
      // Najpierw znajdź QF z tym bracket_pos
      let qfMatch = findByPos(qf, qfPos);
      // Jeśli nie ma — znajdź QF bez bracket_pos i przypisz mu pozycję
      if (!qfMatch) {
        qfMatch = qf.find(m => !m.bracket_pos) || null;
        if (qfMatch) await setBracketPos(qfMatch, qfPos);
      }
      if (qfMatch) await setTeam(qfMatch, slot, w);
    }

    // QF → SF wg bracket_pos
    // QF pos1+pos2 → SF pos1, QF pos3+pos4 → SF pos2
    const qfToSf = [
      [1, 1, 'home'], [2, 1, 'away'],
      [3, 2, 'home'], [4, 2, 'away'],
    ];
    for (const [qfPos, sfPos, slot] of qfToSf) {
      const qfMatch = findByPos(qf, qfPos);
      const w = getWinner(qfMatch);
      if (!w) continue;
      let sfMatch = findByPos(sf, sfPos);
      if (!sfMatch) {
        sfMatch = sf.find(m => !m.bracket_pos) || null;
        if (sfMatch) await setBracketPos(sfMatch, sfPos);
      }
      if (sfMatch) await setTeam(sfMatch, slot, w);
    }

    // SF → Finał i mecz o 3. miejsce
    if (sf[0]) {
      const w = getWinner(sf[0]), l = getLoser(sf[0]);
      if (fin[0])   await setTeam(fin[0],   'home', w);
      if (third[0]) await setTeam(third[0], 'home', l);
    }
    if (sf[1]) {
      const w = getWinner(sf[1]), l = getLoser(sf[1]);
      if (fin[0])   await setTeam(fin[0],   'away', w);
      if (third[0]) await setTeam(third[0], 'away', l);
    }

  } catch (err) {
    console.error('[BRACKET] Błąd przepisywania zwycięzców:', err.message);
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