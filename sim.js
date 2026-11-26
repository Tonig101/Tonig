// ============================================================
// KARDS 全卡组自动模拟对抗测试 (headless)
// 用途：
//   1) 5国20套预设卡组两两对抗，量化胜率，检验平衡
//   2) 验证两处修复无回归：
//      a) 钳击解除逻辑(_releasePincer)在所有离场场景正确
//      b) AI指挥点作弊同步 maxCmd（cmd 永不 > maxCmd）
// 运行： node sim.js [gamesPerMatchup] [--verbose]
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ---------------- 参数 ----------------
const args = process.argv.slice(2);
const GAMES_PER = parseInt(args.find(a => /^\d+$/.test(a)) || '6', 10);
const VERBOSE = args.indexOf('--verbose') >= 0 || args.indexOf('-v') >= 0;

// ---------------- 同步定时器队列 ----------------
const syncQueue = [];
function queue(fn) { if (typeof fn === 'function') syncQueue.push(fn); return 0; }
function clearQueue() { syncQueue.length = 0; }
global.setTimeout = queue;
global.clearTimeout = () => {};
global.setInterval = () => 0;
global.clearInterval = () => {};
global.requestAnimationFrame = queue;
global.cancelAnimationFrame = () => {};

// ---------------- DOM 桩 ----------------
function makeEl(tag) {
  const cls = {
    add() {}, remove() {}, toggle() {}, contains() { return false; },
  };
  return {
    tagName: (tag || 'div').toUpperCase(),
    classList: cls,
    style: {},
    dataset: {},
    children: [], childNodes: [],
    innerHTML: '', textContent: '', innerText: '', value: '', id: '', className: '', title: '',
    disabled: false, checked: false,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0,
    offsetWidth: 0, offsetHeight: 0, offsetTop: 0, offsetLeft: 0,
    getContext() { return null; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    appendChild() { return makeEl(); }, removeChild() {}, insertBefore() {}, replaceChild() {},
    append() {}, prepend() {}, before() {}, after() {}, remove() {}, replaceWith() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
    closest() { return null; }, contains() { return false; }, matches() { return false; },
    insertAdjacentHTML() {}, insertAdjacentText() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }; },
  };
}
const documentStub = {
  documentElement: makeEl('html'), body: makeEl('body'), head: makeEl('head'),
  createElement: (t) => makeEl(t), createElementNS: (ns, t) => makeEl(t),
  getElementById: () => makeEl('div'),
  querySelector: () => makeEl('div'), querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  createTextNode: () => makeEl(),
  getElementsByClassName: () => [], getElementsByTagName: () => [],
};

function silentConsole() { return { log() {}, info() {}, warn() {}, error() {}, debug() {}, table() {}, trace() {} }; }

const sandbox = {
  console: VERBOSE ? console : silentConsole(),
  setTimeout: global.setTimeout, clearTimeout: global.clearTimeout,
  setInterval: global.setInterval, clearInterval: global.clearInterval,
  requestAnimationFrame: global.requestAnimationFrame, cancelAnimationFrame: global.cancelAnimationFrame,
  document: documentStub,
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} },
  location: { href: '', protocol: 'file:', host: '', pathname: '', search: '', hash: '' },
  navigator: { userAgent: 'node' },
  performance: { now: () => Date.now() },
  alert() {}, confirm() { return true; }, prompt() { return null; },
  Image: function () { this.src = ''; this.onload = null; this.onerror = null; },
  AudioContext: function () {}, webkitAudioContext: function () {},
  // 浏览器中 window 即全局对象，这些"裸"全局函数存在（如 window.addEventListener）
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  scrollTo() {}, scrollBy() {}, focus() {}, blur() {}, print() {},
  matchMedia() { return { matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }; },
  innerWidth: 1200, innerHeight: 800,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 提取 <script> 内容
function extractScripts(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out.join('\n;\n');
}

vm.runInContext(extractScripts(HTML), sandbox, { filename: 'index.html' });

// ---------------- 顶层导出 ----------------
const GAME = sandbox.GAME;
const DeckStore = sandbox.DeckStore;
const DEFAULT_DECKS = sandbox.DEFAULT_DECKS;
const checkOrderCondition = sandbox.checkOrderCondition;

// ---------------- 关闭 UI / 动画副作用 ----------------
GAME.render = function () {};
GAME.log = function (msg, type) { if (VERBOSE) console.log('[LOG:' + (type || '') + '] ' + String(msg).replace(/<[^>]*>/g, '')); };
GAME.waitAnims = function () { return Promise.resolve(); };
GAME.showDmgEffect = function () {};
GAME.cleanupBattlefield = function () {};
sandbox.SFX = { play() {}, toggle() {}, togglePanel() {}, setVolume() {} };
sandbox.showCardPlayed = function () {};
sandbox.showOrderCardPlayed = function () {};
sandbox.playDeployFX = function () {};
sandbox.playDeathrattleFX = function () {};
sandbox.floatDamage = function () {};
sandbox.floatDamageAt = function () {};
sandbox.playArmorSpark = function () {};
sandbox.playPushTrail = function () {};
sandbox.playPushTrailFromRect = function () {};
sandbox.showTurnBanner = function () {};
sandbox.toast = function () {};
sandbox.orderFlash = function () {};
// 让 doAttack / _chainDmgFX 的动画 Promise 永不 resolve，避免延迟的 cleanup/checkEnd 污染后续对局
sandbox.playAttackLine = function () { return new Promise(function () {}); };

// 让 enterTargetSelect 对双方都自动结算（玩家侧也自动选目标，钳击避开自身）
GAME.enterTargetSelect = function (code, owner, sourceCard, onComplete) {
  const targets = GAME.getEffectTargets(code, owner);
  if (!targets.length) { if (onComplete) onComplete(); return; }
  let t = null;
  if (code.indexOf('pincer') === 0) {
    const cands = targets.filter(u => u !== sourceCard && u.uid !== sourceCard.uid);
    if (cands.length) t = cands.reduce((a, b) => (a.effectiveAtk + a.hp) >= (b.effectiveAtk + b.hp) ? a : b);
  } else {
    t = GAME.aiPickTarget(code, targets);
  }
  if (!t) { if (onComplete) onComplete(); return; }
  GAME.resolveEffectOnTarget(code, owner, sourceCard, t);
  if (onComplete) onComplete();
};

// 修正：同阵营内战时 data.active[faction] 无法同时表示双方不同卡组（先设玩家、后设敌方会互相覆盖），
// 用队列重写 DeckStore.active，使 _initGame 中「玩家→敌方」两次调用各取对应卡组
(function () {
  const deckQueue = [];
  DeckStore.__queueDeck = function (d) { deckQueue.push(d); };
  const _active = DeckStore.active;
  DeckStore.active = function (fc) {
    if (deckQueue.length) return deckQueue.shift();
    return _active.call(this, fc);
  };
})();

// ---------------- 可复现随机 ----------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedGame(seed) {
  sandbox.__prng = mulberry32(seed);
  vm.runInContext('Math.random = function(){ return __prng(); }', sandbox);
}

// ---------------- 中立 AI（双方共用同一套逻辑） ----------------
function deployValue(c) {
  let v = c.atk * 1.5 + c.hp * 1.0;
  const eff = (c.atk * 1.5 + c.hp) / Math.max(1, c.cost);
  if (eff > 3) v += 3;
  if (c.hasB) v += 4;
  if (c.hasG) v += 3;
  if (c.hasA) v += 2;
  if (c.hasFr) v += 5;
  if (c.armor > 0) v += c.armor * 1.5;
  if (['draw1', 'drawOnDmg', 'chargeDraw', 'chargeDrawDR', 'furyDraw'].indexOf(c.effCode) >= 0) v += 2;
  return v;
}

function orderScore(c, side, opp) {
  const fx = c.fx || c.effCode || '';
  let s = 10 - c.cost * 0.5;
  const oppUnits = opp.allUnits().filter(u => u.hp > 0);
  if (/dmg|kill|destroy|pin|bounce/.test(fx)) s += (oppUnits.length ? 8 : -30);
  if (/draw/.test(fx)) s += (side.hand.length <= 3 ? 6 : 2);
  if (/cmd1|cmd2/.test(fx)) s += 6;
  if (/heal/.test(fx)) s += (side.hp <= side.maxHp - 4 ? 5 : -15);
  return s;
}

function botOrders(side, opp) {
  let guard = 0;
  while (guard++ < 40) {
    const orders = side.hand
      .filter(c => c.isOrder && c.cost <= side.cmd && checkOrderCondition(c, side).ok)
      .sort((a, b) => orderScore(b, side, opp) - orderScore(a, side, opp));
    if (!orders.length) break;
    const c = orders[0];
    side.hand = side.hand.filter(x => x !== c);
    side.cmd -= c.cost;
    GAME.execOrder(side, c);
    if (GAME.checkEnd()) return;
  }
}

function botDeploy(side, opp) {
  let guard = 0;
  while (guard++ < 60) {
    if (side.support.length >= 4) break;
    const units = side.hand
      .filter(c => !c.isOrder && c.cost <= side.cmd)
      .sort((a, b) => deployValue(b) - deployValue(a));
    if (!units.length) break;
    const c = units[0];
    side.hand = side.hand.filter(x => x !== c);
    side.cmd -= c.cost;
    c.zone = 'support'; c.owner = side; c.justDeployed = true; c.justPlayed = true;
    if (c.isA || c.isO) c.supSide = 'R';
    else if (opp.fl.length > 0) c.supSide = 'L';
    else c.supSide = Math.random() < 0.5 ? 'L' : 'R';
    side.support.push(c);
    const countered = GAME.checkCounterOrder(side, c);
    if (countered) {
      side.support = side.support.filter(x => x !== c);
      c.zone = 'hand'; c.justDeployed = false; c.owner = null; c.resetToBase();
      side.hand.push(c);
    } else {
      if (!c.joinedNotDeployed) GAME.triggerDeploy(c, side);
      if (!c.canActOnDeploy) { c.canAct = false; c.apSpent = 99; }
    }
    if (GAME.checkEnd()) return;
  }
}

function shouldPush(u, side, opp) {
  if (!GAME.canPush(side)) return false;
  if (u.isA || u.isF || u.isO) return false; // 远程兵种留在支援阵线即可攻击
  if (u.isT) return true;                     // 坦克 2AP：推进后仍可攻击
  if (u.hasG) return true;                    // 守护上前线挡线
  return true;                                // 步兵推进抢前线
}

function botMove(side, opp) {
  let guard = 0;
  while (guard++ < 60) {
    if (!GAME.canPush(side)) break;
    const movers = side.support
      .filter(u => u.canStillMove && side.cmd >= u.acost && shouldPush(u, side, opp))
      .sort((a, b) => (b.effectiveAtk + b.hp) - (a.effectiveAtk + a.hp));
    if (!movers.length) break;
    const m = movers[0];
    side.cmd -= m.acost;
    side.support = side.support.filter(x => x !== m);
    side.fl.push(m);
    m.zone = 'frontline';
    m.spendAP(1);
    if (m.hasS) m.smokescreenActive = false;
    if (GAME.checkEnd()) return;
  }
}

function attackScore(atk, ti, opp) {
  const target = ti.card;
  if (target === null) {
    let s = 12;
    const dmg = atk.effectiveAtk;
    if (opp.hp - dmg <= 0) s += 100; // 斩杀
    s += dmg * 0.5;
    return s;
  }
  const atkDmg = Math.max(0, atk.effectiveAtk - target.armor);
  const counterDmg = Math.max(0, target.effectiveAtk - atk.armor);
  const canKill = atkDmg >= target.hp;
  let s = target.effectiveAtk * 1.5 + target.hp;
  if (canKill) s += 100;
  if (target.hasG) s += 25;
  if (!canKill && counterDmg >= atk.hp) s -= 200; // 避免自杀式换血
  return s;
}

function botAttack(side, opp) {
  let guard = 0;
  while (guard++ < 240) {
    const attackers = side.allUnits()
      .filter(u => u.hp > 0 && u.canStillAtk && u.owner.cmd >= u.effAcost);
    if (!attackers.length) break;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < attackers.length; i++) {
      const atk = attackers[i];
      const targets = GAME.getTargets(atk);
      for (let j = 0; j < targets.length; j++) {
        const sc = attackScore(atk, targets[j], opp);
        if (sc > bestScore) { bestScore = sc; best = { atk: atk, ti: targets[j] }; }
      }
    }
    if (!best) break;
    GAME.doAttack(best.atk, best.ti);
    GAME.cleanup(side, 0);
    GAME.cleanup(opp, 0);
    if (GAME.checkEnd()) return;
  }
}

function botPlayTurn(side, opp) {
  botOrders(side, opp);
  if (GAME.gameOver) return;
  botDeploy(side, opp);
  if (GAME.gameOver) return;
  botMove(side, opp);
  if (GAME.gameOver) return;
  botAttack(side, opp);
  GAME.cleanup(side, 0);
  GAME.cleanup(opp, 0);
}

// ---------------- 不变量校验 ----------------
function checkInvariants() {
  const errs = [];
  [GAME.player, GAME.enemy].forEach((sd, si) => {
    const tag = si === 0 ? 'player' : 'enemy';
    if (sd.cmd > sd.maxCmd) errs.push(tag + ' cmd(' + sd.cmd + ') > maxCmd(' + sd.maxCmd + ')');
    if (sd.cmd < 0) errs.push(tag + ' cmd<0');
    if (sd.maxCmd > 24) errs.push(tag + ' maxCmd>24');
    sd.allUnits().forEach(u => {
      if (u.pincerPartnerUid) {
        const found = [GAME.player, GAME.enemy].some(x => x.allUnits().some(v => v.uid === u.pincerPartnerUid));
        if (!found) {
          let where = '完全消失';
          const sides = [GAME.player, GAME.enemy];
          for (let k = 0; k < sides.length; k++) {
            const s = sides[k];
            if (s.hand.some(v => v.uid === u.pincerPartnerUid)) { where = (s === sd ? '同方手牌' : '对方手牌'); break; }
            if ((s.deck || []).some(v => v.uid === u.pincerPartnerUid)) { where = (s === sd ? '同方卡组' : '对方卡组'); break; }
          }
          errs.push(tag + ' [' + u.cn + '] 钳击伙伴悬空 uid=' + u.pincerPartnerUid + '（' + where + '，自身pincerAtk=' + u.pincerAtk + ' pincerExtra=' + u.pincerExtra + '）');
        }
      }
    });
  });
  return errs;
}

// ---------------- 单局对局 ----------------
function playOneGame(playerFc, playerDeckId, enemyFc, enemyDeckId, aiLevel, seed) {
  seedGame(seed);
  sandbox.ENEMY_FC = enemyFc;
  sandbox.AI_LEVEL = aiLevel;
  // 用队列注入双方卡组，避免同阵营内战覆盖问题
  DeckStore.__queueDeck(DeckStore.byId(playerFc, playerDeckId));
  DeckStore.__queueDeck(DeckStore.byId(enemyFc, enemyDeckId));
  GAME._initGame(playerFc);
  GAME.phase = 'play';

  const violations = [];
  let turnLimit = 60;
  while (!GAME.gameOver && GAME.turn < turnLimit) {
    // 玩家回合
    GAME.turn++;
    const isPlayerTurn = (GAME.turn % 2 === 1) ? GAME.playerIsFirst : !GAME.playerIsFirst;
    const side = isPlayerTurn ? GAME.player : GAME.enemy;
    const opp = isPlayerTurn ? GAME.enemy : GAME.player;
    const skipDraw = (GAME.turn === 1) ? (isPlayerTurn ? GAME.playerIsFirst : !GAME.playerIsFirst) : false;
    GAME._startTurn(side, skipDraw);
    botPlayTurn(side, opp);
    violations.push.apply(violations, checkInvariants());
    if (GAME.gameOver) break;
    GAME.turn++;
    const isPlayerTurn2 = (GAME.turn % 2 === 1) ? GAME.playerIsFirst : !GAME.playerIsFirst;
    const side2 = isPlayerTurn2 ? GAME.player : GAME.enemy;
    const opp2 = isPlayerTurn2 ? GAME.enemy : GAME.player;
    const skipDraw2 = (GAME.turn === 1) ? (isPlayerTurn2 ? GAME.playerIsFirst : !GAME.playerIsFirst) : false;
    GAME._startTurn(side2, skipDraw2);
    botPlayTurn(side2, opp2);
    violations.push.apply(violations, checkInvariants());
    if (GAME.gameOver) break;
  }
  clearQueue();

  let winner;
  if (GAME.player.hp <= 0 && GAME.enemy.hp <= 0) winner = 'draw';
  else if (GAME.player.hp <= 0) winner = 'enemy';
  else if (GAME.enemy.hp <= 0) winner = 'player';
  else winner = 'timeout';
  return { winner, turns: GAME.turn, violations };
}

// ---------------- 主流程 ----------------
function main() {
  const factions = Object.keys(DEFAULT_DECKS);
  const decks = [];
  factions.forEach(fc => {
    DEFAULT_DECKS[fc].forEach(d => decks.push({ fc, id: d.id, name: d.name }));
  });

  // 单个调试对局
  const verboseArgs = args.filter(a => a.length <= 2 && /^[A-Z]$/.test(a));
  if (VERBOSE && verboseArgs.length >= 2) {
    const pa = decks.find(d => d.fc === verboseArgs[0] && d.id === (args[args.indexOf(verboseArgs[0]) + 1] || 'r0'));
    const eb = decks.find(d => d.fc === verboseArgs[1]);
    if (pa && eb) {
      const r = playOneGame(pa.fc, pa.id, eb.fc, eb.id, 1, 12345);
      console.log('调试对局:', pa.name, 'vs', eb.name, '=>', r.winner, '回合', r.turns);
      console.log('不变量违规:', r.violations.length ? r.violations : '无');
    }
    return;
  }

  console.log('=== KARDS 卡组平衡模拟 ===');
  console.log('卡组数:', decks.length, ' 每对阵局数:', GAMES_PER);
  console.log('');

  const stats = {};
  decks.forEach(d => {
    stats[d.fc + ':' + d.id] = { name: d.name, fc: d.fc, win: 0, loss: 0, draw: 0, games: 0 };
  });

  let totalViolations = [];
  let seed = 1;
  const start = Date.now();

  for (let i = 0; i < decks.length; i++) {
    for (let j = 0; j < decks.length; j++) {
      if (i === j) continue;
      const A = decks[i], B = decks[j];
      for (let g = 0; g < GAMES_PER; g++) {
        const r = playOneGame(A.fc, A.id, B.fc, B.id, 1, seed++);
        const ka = A.fc + ':' + A.id, kb = B.fc + ':' + B.id;
        stats[ka].games++; stats[kb].games++;
        if (r.winner === 'player') { stats[ka].win++; stats[kb].loss++; }
        else if (r.winner === 'enemy') { stats[kb].win++; stats[ka].loss++; }
        else { stats[ka].draw++; stats[kb].draw++; }
        if (r.violations.length) {
          totalViolations.push(A.name + ' vs ' + B.name + ': ' + r.violations.join('; '));
        }
      }
    }
  }

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log('用时: ' + secs + 's，总对局: ' + (decks.length * (decks.length - 1) * GAMES_PER));
  console.log('');
  console.log('=== 各卡组胜率（按胜率降序） ===');

  const rows = decks.map(d => {
    const s = stats[d.fc + ':' + d.id];
    const wr = s.win / Math.max(1, s.games);
    return { ...s, fc: d.fc, id: d.id, name: d.name, wr };
  }).sort((a, b) => b.wr - a.wr);

  const factionAgg = {};
  rows.forEach(r => {
    if (!factionAgg[r.fc]) factionAgg[r.fc] = { win: 0, games: 0, n: 0 };
    factionAgg[r.fc].win += r.win; factionAgg[r.fc].games += r.games; factionAgg[r.fc].n++;
  });

  rows.forEach(r => {
    const wrPct = (r.wr * 100).toFixed(1).padStart(5);
    console.log(
      '  ' + wrPct + '%  [' + r.fc + '] ' + r.name.padEnd(14) +
      '  胜' + String(r.win).padStart(4) + ' 负' + String(r.loss).padStart(4) +
      ' 平' + String(r.draw).padStart(3) + ' 局' + String(r.games).padStart(4)
    );
  });

  console.log('');
  console.log('=== 阵营平均胜率 ===');
  Object.keys(factionAgg).sort((a, b) => (factionAgg[b].win / factionAgg[b].games) - (factionAgg[a].win / factionAgg[a].games))
    .forEach(fc => {
      const f = factionAgg[fc];
      console.log('  [' + fc + '] ' + ((f.win / f.games) * 100).toFixed(1) + '%  (' + f.n + ' 套卡组)');
    });

  console.log('');
  console.log('=== 不变量校验（钳击/指挥点） ===');
  if (!totalViolations.length) {
    console.log('  OK — 无违规：cmd 始终 <= maxCmd，钳击伙伴无悬空引用');
  } else {
    const uniq = {};
    totalViolations.forEach(v => { uniq[v] = (uniq[v] || 0) + 1; });
    console.log('  发现 ' + totalViolations.length + ' 处违规（去重 ' + Object.keys(uniq).length + ' 种）：');
    Object.keys(uniq).slice(0, 20).forEach(k => console.log('    [' + uniq[k] + 'x] ' + k));
  }

  // 专项：地狱难度指挥点作弊同步校验
  console.log('');
  console.log('=== 专项：地狱难度(AI_LEVEL=4)指挥点同步 ===');
  let cheatViolations = 0;
  for (let t = 0; t < 40; t++) {
    const r = playOneGame(decks[0].fc, decks[0].id, decks[4].fc, decks[4].id, 4, 900000 + t);
    if (r.violations.length) { cheatViolations++; if (t === 0) console.log('  示例违规:', r.violations.slice(0, 3)); }
  }
  console.log(cheatViolations === 0
    ? '  OK — 40局地狱难度无 cmd>maxCmd 违规（+2作弊已同步 maxCmd）'
    : '  发现 ' + cheatViolations + ' 局违规');
}

main();