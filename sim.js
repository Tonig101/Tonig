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
  const t = GAME.aiPickTarget(code, targets, owner, sourceCard);
  if (!t) { if (onComplete) onComplete(); return; }
  GAME.resolveEffectOnTarget(code, owner, sourceCard, t);
  if (onComplete) onComplete();
};

// 让 forecast / develop 的三选一弹窗在无头模拟下自动结算（模拟 AI 从三张中随机选一张）
GAME.forecastSelect = function (owner) {
  if (!owner || owner.hand.length >= 9) return;
  const types = ['clear', 'mist', 'storm'];
  const type = types[Math.floor(Math.random() * 3)];
  const pool = (GAME._forecastPool && GAME._forecastPool[type]) ? GAME._forecastPool[type].slice() : [];
  if (!pool.length) return;
  const picks = [];
  while (picks.length < 3 && pool.length) {
    picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  const d = picks[Math.floor(Math.random() * picks.length)];
  const c = new sandbox.Card(d);
  c.owner = owner;
  owner.hand.push(c);
};

GAME.developSelect = function (owner) {
  if (!owner || owner.hand.length >= 9) return;
  const orders = owner.deck.filter(c => c.isOrder);
  if (!orders.length) return;
  const pool = orders.slice();
  const picks = [];
  while (picks.length < 3 && pool.length) {
    picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  const pick = picks[Math.floor(Math.random() * picks.length)];
  owner.deck = owner.deck.filter(c => c !== pick);
  owner.hand.push(pick);
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
  // 针对敌方高威胁单位的对策价值（与 index.html 的 AI 评分保持一致）
  if (typeof GAME._counterValue === 'function') s += GAME._counterValue(c, side, opp);
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

function attackCtx(side, opp) {
  const myFA = GAME._calcFieldAtk(side);
  const oppFA = GAME._calcFieldAtk(opp);
  const attackers = side.allUnits().filter(u => u.hp > 0 && u.canStillAtk && side.cmd >= u.effAcost);
  const ctx = {
    board: GAME._evalBoard(side, opp),
    fieldLead: myFA.total - oppFA.total,
    oppHasLethal: oppFA.total >= side.hp,
    aiHasLethal: myFA.total >= opp.hp,
    aiCanLethal: GAME._calcLethal(side, opp),
    canKillSomething: false
  };
  for (const a of attackers) {
    if (ctx.canKillSomething) break;
    for (const t of GAME.getTargets(a)) {
      if (t.card && Math.max(0, a.effectiveAtk - (t.card.armor || 0)) >= t.card.hp) {
        ctx.canKillSomething = true; break;
      }
    }
  }
  return { attackers, ctx };
}

// 攻击评分直接复用浏览器端同一套函数，避免两端策略漂移
function attackScore(atk, ti, side, opp, ctx) {
  if (ti.card === null) return (atk.effectiveAtk >= opp.hp) ? 1000 : GAME._hqScore(atk, side, opp, ctx);
  return GAME._targetScore(atk, ti.card, side, opp, ctx);
}

function botAttack(side, opp) {
  let guard = 0;
  while (guard++ < 240) {
    const { attackers, ctx } = attackCtx(side, opp);
    if (!attackers.length) break;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < attackers.length; i++) {
      const atk = attackers[i];
      const targets = GAME.getTargets(atk);
      for (let j = 0; j < targets.length; j++) {
        const sc = attackScore(atk, targets[j], side, opp, ctx);
        if (sc > bestScore) { bestScore = sc; best = { atk: atk, ti: targets[j] }; }
      }
    }
    if (!best) break;
    // 全部动作亏本：血量安全就按兵不动，避免白送
    if (bestScore <= 0 && side.hp > side.maxHp * 0.5 && !ctx.oppHasLethal) break;
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

// ---------------- 专项测试：被抑制时钳击失效 ----------------
function runSuppressTest() {
  const Card = sandbox.Card;
  const assert = (cond, msg) => {
    if (cond) return;
    console.error('  ✗ 断言失败: ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  };

  seedGame(1);
  DeckStore.__queueDeck(DeckStore.byId('D', 'r3'));
  DeckStore.__queueDeck(DeckStore.byId('B', 'r0'));
  GAME._initGame('D');
  GAME.phase = 'play';

  // ---- 用例1：抑制指令(suppressOrder)解除钳击（pincerArmor 重甲加成）----
  const p1 = new Card(['钳击装甲兵','Pincer Panzergrenadier','D','I',4,4,4,1,0,'P','测试','pincerArmor',2]);
  const pa1 = new Card(['国民掷弹兵','Volksgrenadier','D','I',2,2,1,1,0,'','','draw1']);
  p1.owner = GAME.player; p1.zone = 'support'; p1.supSide = 'L'; p1.justDeployed = true; p1.justPlayed = true;
  pa1.owner = GAME.player; pa1.zone = 'support'; pa1.supSide = 'R'; pa1.justDeployed = true; pa1.justPlayed = true;
  GAME.player.support.push(p1, pa1);
  GAME.resolveEffectOnTarget('pincerArmor', GAME.player, p1, pa1);
  assert(pa1.atk === 3 && pa1.hp === 3 && pa1.maxHp === 3 && pa1.armor === 1,
    '钳击结对后伙伴应为3/3重甲1（实际 ' + pa1.atk + '/' + pa1.hp + ' 甲' + pa1.armor + '）');
  assert(p1.pincerPartnerUid === pa1.uid && pa1.pincerPartnerUid === p1.uid, '钳击应双向链接');

  GAME.resolveEffectOnTarget('suppressOrder', GAME.player, null, p1);
  assert(pa1.atk === 2 && pa1.hp === 2 && pa1.maxHp === 2 && pa1.armor === 0,
    '抑制后伙伴应失去+1/+1与重甲（实际 ' + pa1.atk + '/' + pa1.hp + ' 甲' + pa1.armor + '）');
  assert(pa1.pincerPartnerUid === 0 && p1.pincerPartnerUid === 0, '抑制后双方应断开钳击链接');
  assert(p1.atk === 4 && p1.hp === 4 && p1.maxHp === 4 && p1.kw === '' && p1.armor === 0,
    '被抑制单位应重置为4/4无词条无重甲（实际 ' + p1.atk + '/' + p1.hp + ' kw=' + p1.kw + ' 甲' + p1.armor + '）');

  // ---- 用例2：攻击抑制(suppress)解除钳击（pincerGuard 守护加成）----
  const p2 = new Card(['近卫钳击队','Guards Pincer Squad','S','I',2,3,2,1,0,'GP','测试','pincerGuard',2]);
  const pa2 = new Card(['动员兵','Mobilized Infantry','S','I',1,1,1,1,0,'','','dr_dmg2',4]);
  p2.owner = GAME.player; p2.zone = 'support'; p2.supSide = 'L'; p2.justDeployed = true; p2.justPlayed = true;
  pa2.owner = GAME.player; pa2.zone = 'support'; pa2.supSide = 'R'; pa2.justDeployed = true; pa2.justPlayed = true;
  GAME.player.support.push(p2, pa2);
  GAME.resolveEffectOnTarget('pincerGuard', GAME.player, p2, pa2);
  assert(pa2.atk === 2 && pa2.hp === 2 && pa2.hasG === true,
    '守护钳击结对后伙伴应为2/2且有守护（实际 ' + pa2.atk + '/' + pa2.hp + ' G=' + pa2.hasG + '）');

  const m18 = new Card(['M18地狱猫','M18 Hellcat','U','T',4,3,4,1,0,'B','','suppress',2]);
  m18.owner = GAME.enemy; m18.zone = 'support'; m18.supSide = 'L'; m18.justDeployed = true; m18.justPlayed = true;
  m18.canAct = true; m18.apSpent = 0; m18.attacksThisTurn = 0;
  GAME.enemy.support.push(m18);
  GAME.enemy.cmd = 10;
  GAME.doAttack(m18, { card: p2, zone: 'support' });
  assert(pa2.atk === 1 && pa2.hp === 1 && pa2.maxHp === 1 && pa2.hasG === false,
    '攻击抑制后伙伴应失去+1/+1与守护（实际 ' + pa2.atk + '/' + pa2.hp + ' G=' + pa2.hasG + '）');
  assert(pa2.pincerPartnerUid === 0 && p2.pincerPartnerUid === 0, '攻击抑制后双方应断开钳击链接');

  // ---- 用例3：攻击抑制解除钳击（pincerShock 冲击加成）----
  const p3 = new Card(['钳击突击队','Pincer Assault Team','J','I',3,2,2,1,0,'P','测试','pincerShock',2]);
  const pa3 = new Card(['步兵小队','Infantry Squad','J','I',2,2,1,1,0,'B','','']);
  p3.owner = GAME.player; p3.zone = 'support'; p3.supSide = 'L'; p3.justDeployed = true; p3.justPlayed = true;
  pa3.owner = GAME.player; pa3.zone = 'support'; pa3.supSide = 'R'; pa3.justDeployed = true; pa3.justPlayed = true;
  GAME.player.support.push(p3, pa3);
  GAME.resolveEffectOnTarget('pincerShock', GAME.player, p3, pa3);
  assert(pa3.atk === 3 && pa3.hp === 3 && pa3.hasC === true,
    '冲击钳击结对后伙伴应为3/3且有冲击（实际 ' + pa3.atk + '/' + pa3.hp + ' C=' + pa3.hasC + '）');

  const firefly = new Card(['萤火虫坦克','Sherman Firefly','B','T',5,5,5,2,1,'','','suppress',2]);
  firefly.owner = GAME.enemy; firefly.zone = 'support'; firefly.supSide = 'R'; firefly.justDeployed = true; firefly.justPlayed = true;
  firefly.canAct = true; firefly.apSpent = 0; firefly.attacksThisTurn = 0;
  GAME.enemy.support.push(firefly);
  GAME.enemy.cmd = 10;
  GAME.doAttack(firefly, { card: p3, zone: 'support' });
  assert(pa3.atk === 2 && pa3.hp === 2 && pa3.maxHp === 2 && pa3.hasC === false,
    '攻击抑制后伙伴应失去+1/+1与冲击（实际 ' + pa3.atk + '/' + pa3.hp + ' C=' + pa3.hasC + '）');
  assert(pa3.pincerPartnerUid === 0 && p3.pincerPartnerUid === 0, '攻击抑制后双方应断开钳击链接');

  console.log('=== 专项：被抑制时钳击失效 ===');
  console.log('  OK — 3 个用例全部通过（suppressOrder / M18攻击抑制 / 萤火虫攻击抑制，均正确解除双方钳击）');
  clearQueue();
}

// ---------------- 专项测试：动员累积血量真实生效 ----------------
function runMobilizeTest() {
  const Card = sandbox.Card;
  const applyDmg = sandbox._applyDmg;
  const assert = (cond, msg) => {
    if (cond) return;
    console.error('  ✗ 断言失败: ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  };

  seedGame(1);
  DeckStore.__queueDeck(DeckStore.byId('S', 'r0'));
  DeckStore.__queueDeck(DeckStore.byId('B', 'r0'));
  GAME._initGame('S');
  GAME.phase = 'play';

  const mob = new Card(['动员兵','Mobilized Infantry','S','I',1,1,1,1,0,'','动员（每回合累积+1/+1，受伤停止累积但数值保留）。亡计：对随机一个敌方单位造成2点伤害。','dr_dmg2',4,'mobilize']);
  mob.owner = GAME.player; mob.zone = 'support'; mob.supSide = 'L';
  GAME.player.support.push(mob);

  assert(mob.atk === 1 && mob.hp === 1 && mob.maxHp === 1,
    '初始应为1/1（实际 ' + mob.atk + '/' + mob.hp + ' max' + mob.maxHp + '）');

  // 熬过己方回合：动员累积 +1/+1 应真正落到 atk/hp/maxHp
  mob.resetTurn();
  assert(mob.atk === 2 && mob.hp === 2 && mob.maxHp === 2,
    '熬过1回合应真实 +1/+1 → 2/2（实际 ' + mob.atk + '/' + mob.hp + ' max' + mob.maxHp + '）');

  mob.resetTurn();
  assert(mob.atk === 3 && mob.hp === 3 && mob.maxHp === 3,
    '熬过2回合应 3/3（实际 ' + mob.atk + '/' + mob.hp + ' max' + mob.maxHp + '）');

  // 核心回归点：被打1点不应死，动员加的血必须有效
  applyDmg(mob, 1);
  assert(mob.hp === 2 && mob.hp > 0,
    '被打1点后应剩2血、不死（实际 hp=' + mob.hp + '）');
  assert(mob.mobStopped === true && mob.mobilized === false,
    '受伤后应停止累积（mobStopped=' + mob.mobStopped + '）');

  // 受伤后不再累积，但已获数值保留
  mob.resetTurn();
  assert(mob.atk === 3 && mob.maxHp === 3 && mob.hp === 2,
    '受伤后回合开始不应再累积，已获数值保留（实际 ' + mob.atk + '/' + mob.hp + ' max' + mob.maxHp + '）');

  // 被打致死点：3/2 再打2点 → hp=0 死亡（累计血量已真实参与结算）
  applyDmg(mob, 2);
  assert(mob.hp <= 0, '再打2点后应死亡（实际 hp=' + mob.hp + '）');

  console.log('=== 专项：动员累积血量真实生效 ===');
  console.log('  OK — 动员兵 1/1→3/3 真实叠加，被打1点不死，受伤停止累积且数值保留');
  clearQueue();
}

// ---------------- 主流程 ----------------
function main() {
  if (args.indexOf('--test-suppress') >= 0) {
    runSuppressTest();
    return;
  }
  if (args.indexOf('--test-mobilize') >= 0) {
    runMobilizeTest();
    return;
  }
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