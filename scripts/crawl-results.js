#!/usr/bin/env node
/**
 * KBO 경기 결과 크롤러
 * - KBO 공식 API (JSON)에서 3월~현재월까지 경기 결과를 가져옴
 * - 기존 results.json과 비교하여 신규 결과만 추가
 * - 팀별 순위를 자동 계산
 */

const fs = require('fs');
const path = require('path');

const RESULTS_PATH = path.join(__dirname, '..', 'results.json');
const KBO_URL = 'https://www.koreabaseball.com/ws/Schedule.asmx/GetScheduleList';

const TEAM_CODE_MAP = {
  'HT': 'KIA', 'OB': '두산', 'LT': '롯데', 'SS': '삼성', 'SK': 'SSG',
  'WO': '키움', 'HH': '한화', 'LG': 'LG', 'NC': 'NC', 'KT': 'KT',
  'KIA': 'KIA', '두산': '두산', '롯데': '롯데', '삼성': '삼성', 'SSG': 'SSG',
  '키움': '키움', '한화': '한화',
};

const TEAM_ORDER = ['한화', '삼성', 'LG', '두산', 'KT', 'SSG', '키움', 'KIA', 'NC', '롯데'];

function mapTeam(name) {
  return TEAM_CODE_MAP[name] || name;
}

async function fetchMonth(monthStr) {
  const body = `leId=1&srId=0&srIdList=0%2C9&seasonId=2026&gameMonth=${monthStr}&teamId=`;
  const res = await fetch(KBO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function parseResults(data, monthStr) {
  const results = [];
  let currentDate = '';

  if (!data.rows) return results;

  for (const rowObj of data.rows) {
    const cells = rowObj.row;
    if (!cells || cells.length < 3) continue;

    // 날짜 셀 찾기 (Class: "day", RowSpan 있음)
    let playCell = null;

    const dayCell = cells.find(c => c.Class === 'day');
    if (dayCell) {
      const dateMatch = dayCell.Text.match(/(\d+)\.(\d+)/);
      if (dateMatch) {
        currentDate = `2026-${monthStr}-${dateMatch[2].padStart(2, '0')}`;
      }
    }

    // play 셀 찾기
    playCell = cells.find(c => c.Class === 'play');
    if (!playCell || !currentDate) continue;

    const playHtml = playCell.Text;

    // 완료된 경기만: class="win" 있어야 함
    if (!playHtml.includes('class="win"') && !playHtml.includes("class='win'")) continue;

    // 팀명 추출: <span>AWAY</span><em>...</em><span>HOME</span>
    // 최외곽 span만 팀명 (em 밖의 span)
    const withoutEm = playHtml.replace(/<em>[\s\S]*?<\/em>/, '|||');
    const teamSpans = [...withoutEm.matchAll(/<span[^>]*>([^<]+)<\/span>/g)];
    if (teamSpans.length < 2) continue;

    const awayName = mapTeam(teamSpans[0][1].trim());
    const homeName = mapTeam(teamSpans[teamSpans.length - 1][1].trim());

    // 점수 추출: class="win"/"lose" span
    const scoreRegex = /class="(win|lose|same)"[^>]*>(\d+)/g;
    const scores = [];
    let m;
    while ((m = scoreRegex.exec(playHtml)) !== null) {
      scores.push({ type: m[1], value: parseInt(m[2]) });
    }

    if (scores.length < 2) continue;
    if (scores[0].type === 'same') continue; // 진행중

    const awayScore = scores[0].value;
    const homeScore = scores[1].value;

    if (!TEAM_ORDER.includes(awayName) || !TEAM_ORDER.includes(homeName)) continue;

    results.push({
      date: currentDate,
      away: awayName,
      home: homeName,
      awayScore,
      homeScore,
    });
  }

  return results;
}

function computeStandings(allResults) {
  const stats = {};
  TEAM_ORDER.forEach(t => { stats[t] = { wins: 0, losses: 0, draws: 0 }; });

  allResults.forEach(r => {
    if (r.homeScore === r.awayScore) {
      stats[r.home].draws++;
      stats[r.away].draws++;
    } else if (r.homeScore > r.awayScore) {
      stats[r.home].wins++;
      stats[r.away].losses++;
    } else {
      stats[r.away].wins++;
      stats[r.home].losses++;
    }
  });

  const ranked = TEAM_ORDER.map(t => {
    const s = stats[t];
    const total = s.wins + s.losses;
    const pct = total > 0 ? s.wins / total : 0;
    return { team: t, ...s, pct };
  }).sort((a, b) => b.pct - a.pct || b.wins - a.wins);

  const topWins = ranked[0].wins;
  const topLosses = ranked[0].losses;

  const standings = {};
  ranked.forEach((r, i) => {
    const gb = ((topWins - r.wins) - (topLosses - r.losses)) / 2;
    standings[r.team] = {
      rank: i + 1,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
      pct: r.pct > 0 ? '.' + Math.round(r.pct * 1000).toString().padStart(3, '0') : '.000',
      gb: gb === 0 ? '-' : gb.toString(),
    };
  });

  return standings;
}

async function main() {
  let existing = { results: [], standings: {}, lastUpdate: '' };
  try {
    existing = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
  } catch (e) {
    console.log('No existing results.json, starting fresh');
  }

  const existingKeys = new Set(
    existing.results.map(r => `${r.date}_${r.home}_${r.away}`)
  );

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  let newCount = 0;

  for (let m = 3; m <= currentMonth; m++) {
    const mm = String(m).padStart(2, '0');
    console.log(`Fetching month ${mm}...`);
    try {
      const data = await fetchMonth(mm);
      const results = parseResults(data, mm);
      console.log(`  Found ${results.length} completed games`);

      for (const r of results) {
        const key = `${r.date}_${r.home}_${r.away}`;
        if (!existingKeys.has(key)) {
          existing.results.push(r);
          existingKeys.add(key);
          newCount++;
        }
      }
    } catch (e) {
      console.error(`  Error fetching month ${mm}:`, e.message);
    }
  }

  existing.results.sort((a, b) => a.date.localeCompare(b.date));
  existing.standings = computeStandings(existing.results);
  existing.lastUpdate = now.toISOString();

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(existing, null, 2), 'utf-8');
  console.log(`\nDone! ${newCount} new results added. Total: ${existing.results.length} games.`);
}

main().catch(e => { console.error(e); process.exit(1); });
