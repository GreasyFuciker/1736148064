const fs = require('fs');
const src = fs.readFileSync('/home/user/1736148064/microsoft-rewards-helper.user.js', 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
}
const consts = src.match(/const (DAILY_KEY|LONG_PAUSE_CHANCE|BOUNCE_CHANCE|LONG_DWELL_CHANCE|CLICK_DECAY) = [^\n]+/g).join('\n');
const names = ['gaussian', 'logNormalBetween', 'randomInterval', 'dwellSeconds', 'dailyTarget',
               'runTarget', 'shouldCheckSidebar', 'rollWalkLimit', 'pickResultLink',
               'clamp', 'today', 'readJSON', 'writeJSON'];
const code = consts + '\n' + names.map(grab).join('\n\n') + '\nmodule.exports = {' + names.join(',') + '};';

const store = {};
const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const config = { searchInterval: [12, 40], targetSearches: 40, targetJitterPercent: 20,
                 sidebarEvery: 10, walkLength: [5, 8], scrollTime: 14 };
const state = { searchCount: 0, sidebarFailures: 0, target: 0 };
const m = { exports: {} };
new Function('localStorage', 'config', 'state', 'log', 'module', code)(localStorage, config, state, () => {}, m);
const api = m.exports;

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log((ok ? 'PASS  ' : 'FAIL  ') + label); };
const sample = (fn, n = 4000) => Array.from({ length: n }, fn);

// --- 间隔：主体在区间内，且有长尾
const gaps = sample(() => api.randomInterval());
const inRange = gaps.filter(g => g >= 12 && g <= 40).length / gaps.length;
const long = gaps.filter(g => g > 40).length / gaps.length;
const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
check(inRange > 0.8 && inRange < 0.95, `intervals mostly inside [12,40] (${(inRange * 100).toFixed(0)}%)`);
check(long > 0.05 && long < 0.2, `long pauses happen sometimes (${(long * 100).toFixed(0)}%)`);
check(median < 26, `median ${median}s sits left of the uniform midpoint (26s)`);

// --- 停留：有秒退，也有长读
const dwell = sample(() => api.dwellSeconds(14));
check(dwell.filter(d => d <= 6).length / dwell.length > 0.15, 'a quarter of visits bounce quickly');
check(dwell.filter(d => d > 25).length / dwell.length > 0.08, 'some visits run long');
check(Math.min(...dwell) >= 2, `never shorter than 2s (min ${Math.min(...dwell)})`);

// --- 每天的次数：当天固定，跨天重掷，落在浮动范围内
const t1 = api.dailyTarget();
check(api.dailyTarget() === t1 && api.dailyTarget() === t1, `same target all day (${t1})`);
check(t1 >= 32 && t1 <= 48, `target within ±20% of 40 (${t1})`);
store['bing_rewards_daily_v1'] = JSON.stringify({ day: '2000-1-1', target: 99 });
const t2 = api.dailyTarget();
check(t2 !== 99, `a new day re-rolls the target (${t2})`);

// --- 奖励面板：不再每轮都查
state.target = 40;
const checks = [];
for (let i = 1; i <= 40; i++) { state.searchCount = i; if (api.shouldCheckSidebar()) checks.push(i); }
check(checks.length <= 5, `sidebar checked ${checks.length} times in 40 searches: ${JSON.stringify(checks)}`);
check(checks.includes(40), 'still checked once at the end');
state.sidebarFailures = 3; state.searchCount = 10;
check(api.shouldCheckSidebar() === false, 'gives up after repeated failures');
state.sidebarFailures = 0;

// --- 话题步数：两头都有尾巴
const walks = sample(() => api.rollWalkLimit(), 3000);
check(walks.filter(w => w === 1).length / walks.length > 0.15, 'often jumps after a single search');
check(walks.filter(w => w > 8).length / walks.length > 0.08, 'occasionally stays on one topic for a long run');

// --- 点击位置：第一条最多，但不是全部
const links = [1, 2, 3, 4, 5].map(i => ({ rank: i }));
const picks = sample(() => api.pickResultLink(links).rank, 3000);
const first = picks.filter(r => r === 1).length / picks.length;
check(first > 0.35 && first < 0.55, `rank 1 chosen ${(first * 100).toFixed(0)}% of the time`);
check(new Set(picks).size === 5, 'every position gets picked sometimes');

console.log(failures ? `\nFAILURES: ${failures}` : '\nall distribution checks passed');
process.exit(failures ? 1 : 0);
