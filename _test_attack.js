'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'sim.js'), 'utf8');
const cut = src.indexOf('// ---------------- 顶层导出');
const head = src.slice(0, cut).replace(/^'use strict';\s*/, '');

const body = `
const GAME = sandbox.GAME;
const Card = sandbox.Card;

// 在最高难度下验证决策质量（该难度启用阵营差异化风格）
vm.runInContext('AI_LEVEL=4;', sandbox);
GAME._styleCache = null; GAME._styleCacheKey = null;

function mkUnit(cn, atk, hp, cost, owner, kw) {
  const c = new Card([cn, cn, 'D', 'I', atk, hp, cost, cost, 0, kw || '', '', '']);
  c.owner = owner; c.zone = 'frontline'; c.maxHp = hp;
  return c;
}

function makeSides(fcA, fcB, hpA, hpB) {
  const A = { fc: fcA || 'D', hp: hpA || 20, maxHp: 20, cmd: 10, maxCmd: 10, baseMaxCmd: 10, cmdBonus: 0,
    fl: [], support: [], hand: [], deck: [], allUnits() { return this.fl.concat(this.support); } };
  const B = { fc: fcB || 'D', hp: hpB || 20, maxHp: 20, cmd: 10, maxCmd: 10, baseMaxCmd: 10, cmdBonus: 0,
    fl: [], support: [], hand: [], deck: [], allUnits() { return this.fl.concat(this.support); } };
  GAME.player = A; GAME.enemy = B;
  return { A, B };
}

// 复用与 smartAttack 完全一致的决策：遍历所有攻击者×目标，取最高分
function decide(ai, opp, ctxOverride) {
  const attackers = ai.allUnits().filter(u => u.canStillAtk && ai.cmd >= u.effAcost);
  const myFA = GAME._calcFieldAtk(ai);
  const oppFA = GAME._calcFieldAtk(opp);
  const ctx = ctxOverride || {
    board: GAME._evalBoard(ai, opp),
    fieldLead: myFA.total - oppFA.total,
    oppHasLethal: oppFA.total >= ai.hp,
    aiHasLethal: myFA.total >= opp.hp,
    aiCanLethal: GAME._calcLethal(ai, opp),
    canKillSomething: false
  };
  if (!ctxOverride) {
    attackers.forEach(a => {
      if (ctx.canKillSomething) return;
      GAME.getTargets(a).forEach(t => {
        if (t.card && Math.max(0, a.effectiveAtk - (t.card.armor || 0)) >= t.card.hp) ctx.canKillSomething = true;
      });
    });
  }
  let best = null, bestScore = -1e9;
  const cands = [];
  attackers.forEach(a => {
    GAME.getTargets(a).forEach(t => {
      const sc = t.card === null
        ? (a.effectiveAtk >= opp.hp ? 1000 : GAME._hqScore(a, ai, opp, ctx))
        : GAME._targetScore(a, t.card, ai, opp, ctx);
      cands.push({ who: t.card === null ? 'hq' : t.card.cn, sc: +sc.toFixed(2) });
      if (sc > bestScore) { bestScore = sc; best = { atk: a, tg: t, score: sc }; }
    });
  });
  return { best, cands };
}

const R = [];
function t(name, expect, got, cands) {
  R.push({ name, expect, got, ok: got === expect, cands });
}

// 1) 4/4 对 4/4 无守护：换血不划算，应打脸
(function () {
  const s = makeSides('D', 'D');
  const mine = mkUnit('我方4/4', 4, 4, 4, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方4/4', 4, 4, 4, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('4/4 打 4/4 换血亏 → 打脸', 'hq', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 2) 4/4 对 3/3：能安全击杀，应解场
(function () {
  const s = makeSides('D', 'D');
  const mine = mkUnit('我方4/4', 4, 4, 4, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方3/3', 3, 3, 3, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('4/4 能安全杀 3/3 → 解场', '敌方3/3', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 3) 4/4 对 8/8：打不死且会被反杀，绝不碰，应打脸
(function () {
  const s = makeSides('D', 'D');
  const mine = mkUnit('我方4/4', 4, 4, 4, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方8/8', 8, 8, 8, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('4/4 打不死 8/8 → 打脸', 'hq', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 4) 2/2 对 8/8：送死无意义，应打脸
(function () {
  const s = makeSides('D', 'D');
  const mine = mkUnit('我方2/2', 2, 2, 2, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方8/8', 8, 8, 8, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('2/2 送死打 8/8 → 打脸', 'hq', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 5) 8/8 对 6/6：解场收益(28) > 打脸(23.2)，应解场
(function () {
  const s = makeSides('D', 'D');
  const mine = mkUnit('我方8/8', 8, 8, 8, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方6/6', 6, 6, 6, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('8/8 对 6/6 → 解场', '敌方6/6', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 6) 8/8 对 3/3：过杀，打脸更划算
(function () {
  const s = makeSides('D', 'D');
  const mine = mkUnit('我方8/8', 8, 8, 8, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方3/3', 3, 3, 3, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('8/8 杀 3/3 过杀 → 打脸', 'hq', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 7) 敌方 5 血，我方 4/4：一击斩杀 → 打脸
(function () {
  const s = makeSides('D', 'D', 20, 5);
  const mine = mkUnit('我方4/4', 4, 4, 4, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方3/3', 3, 3, 3, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('敌方5血 4攻打脸即斩杀 → 打脸', 'hq', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 8) 敌方 4/4 守护：破守护价值高，应解场
(function () {
  const s = makeSides('D', 'D');
  const mine = mkUnit('我方4/4', 4, 4, 4, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方守护4/4', 4, 4, 4, s.B, 'G'); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('破守护 4/4 → 解场', '敌方守护4/4', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 9) 敌方下回合可斩杀我方，但本回合能击杀其单位 → 必须先解场
(function () {
  const s = makeSides('D', 'D', 3, 20);
  const mine = mkUnit('我方4/4', 4, 4, 4, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方4/4', 4, 4, 4, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('敌方将斩杀但能击杀其单位 → 解场', '敌方4/4', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 9b) 敌方将斩杀但我方打不死任何单位 → 送死无意义，打脸搏命
(function () {
  const s = makeSides('D', 'D', 3, 20);
  const mine = mkUnit('我方4/4', 4, 4, 4, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方5/5', 5, 5, 5, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('敌方将斩杀但打不死 → 搏命打脸', 'hq', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 10) 敌方将斩杀但我方打不死任何单位 → 只能搏命打脸
(function () {
  const s = makeSides('D', 'D', 3, 20);
  const mine = mkUnit('我方2/2', 2, 2, 2, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方9/9', 9, 9, 9, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('打不死任何单位 → 搏命打脸', 'hq', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 11) 多单位：8/8 与 2/2 同时存在，2/2 不该被派去撞 8/8
(function () {
  const s = makeSides('D', 'D');
  const big = mkUnit('我方8/8', 8, 8, 8, s.A);
  const small = mkUnit('我方2/2', 2, 2, 2, s.A);
  s.A.fl = [small, big];
  const theirs = mkUnit('敌方8/8', 8, 8, 8, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('全局配对：先打脸而非小兵送死', 'hq', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 12) 日本速攻：4/4 对 4/4 应优先打脸（比德国更激进）
(function () {
  const s = makeSides('J', 'D');
  const mine = mkUnit('我方4/4', 4, 4, 4, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方3/3', 3, 3, 3, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('日本4/4 对 3/3 → 打脸', 'hq', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

// 13) 英国守护流：4/4 对 3/3 应解场（保守）
(function () {
  const s = makeSides('B', 'D');
  const mine = mkUnit('我方4/4', 4, 4, 4, s.A); s.A.fl = [mine];
  const theirs = mkUnit('敌方3/3', 3, 3, 3, s.B); s.B.fl = [theirs];
  const { best: b, cands } = decide(s.A, s.B);
  t('英国4/4 对 3/3 → 解场', '敌方3/3', b.tg.card === null ? 'hq' : b.tg.card.cn, cands);
})();

let pass = 0, fail = 0;
R.forEach(r => {
  console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + '  (got=' + r.got + ', expect=' + r.expect + ')');
  if (!r.ok) console.log('         cands: ' + JSON.stringify(r.cands));
  r.ok ? pass++ : fail++;
});
console.log('---- ' + pass + ' passed, ' + fail + ' failed ----');
return { pass, fail };
`;

const fn = new Function('require', '__dirname', head + '\n' + body);
const r = fn(require, __dirname);
process.exitCode = r.fail ? 1 : 0;