'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'sim.js'), 'utf8');
const cut = src.indexOf('// ---------------- 顶层导出');
const head = src.slice(0, cut).replace(/^'use strict';\s*/, '');

const body = `
const GAME = sandbox.GAME;
const Card = sandbox.Card;

function mkUnit(cn, atk, hp, cost, owner, zone, kw) {
  const c = new Card([cn, cn, 'D', 'I', atk, hp, cost, cost, 0, kw || '', '', '']);
  c.owner = owner; c.zone = zone || 'frontline';
  c.maxHp = hp;
  return c;
}

// 构造双方阵营
function makeSides() {
  const player = { fc: 'D', hp: 20, maxHp: 20, cmd: 10, maxCmd: 10, baseMaxCmd: 10, cmdBonus: 0,
    fl: [], support: [], hand: [], deck: [], allUnits() { return this.fl.concat(this.support); } };
  const enemy = { fc: 'S', hp: 20, maxHp: 20, cmd: 10, maxCmd: 10, baseMaxCmd: 10, cmdBonus: 0,
    fl: [], support: [], hand: [], deck: [], allUnits() { return this.fl.concat(this.support); } };
  GAME.player = player; GAME.enemy = enemy;
  return { player, enemy };
}

const results = [];

// 场景1：玩家场上 8/8 巨兽(cost8) + 2/2 小兵(cost2)，AI 用 dmg2 -> 应打 2/2（能击杀）
(function () {
  const s = makeSides();
  const big = mkUnit('巨兽', 8, 8, 8, s.player);
  const small = mkUnit('小兵', 2, 2, 2, s.player);
  s.player.fl = [big, small];
  const t = GAME.aiPickTarget('dmg2', s.player.allUnits(), s.enemy);
  results.push({ name: 'dmg2 打能击杀的小兵', expect: '小兵', got: t && t.cn, ok: t && t.cn === '小兵' });
})();

// 场景2：玩家场上 5/5 高威胁(cost5) + 1/1 小兵，AI 用 dmg2t4(有坦克=4伤) -> 5/5 剩1血 vs 1/1 死
(function () {
  const s = makeSides();
  const tank = mkUnit('AI坦克', 3, 3, 3, s.enemy, 'support', 'T');
  s.enemy.support = [tank];
  const big = mkUnit('重装', 5, 5, 5, s.player);
  const small = mkUnit('杂兵', 1, 1, 1, s.player);
  s.player.fl = [big, small];
  const t = GAME.aiPickTarget('dmg2t4', s.player.allUnits(), s.enemy);
  results.push({ name: 'dmg2t4(4伤) 优先击杀', expect: '杂兵', got: t && t.cn, ok: t && t.cn === '杂兵' });
})();

// 场景3：kill2c 目标只有 8/8(cost8) 与 1/1(cost1) -> 合法目标仅 1/1
(function () {
  const s = makeSides();
  const big = mkUnit('巨兽', 8, 8, 8, s.player);
  const small = mkUnit('小兵', 1, 1, 1, s.player);
  s.player.fl = [big, small];
  const tg = GAME.getEffectTargets('kill2c', s.enemy);
  const t = GAME.aiPickTarget('kill2c', tg, s.enemy);
  results.push({ name: 'kill2c 只能杀低费', expect: '小兵', got: t && t.cn, ok: t && t.cn === '小兵' });
})();

// 场景4：dmg2 目标都是打不死的（4/6 高威胁 vs 2/4）-> 应打威胁最高的 4/6
(function () {
  const s = makeSides();
  const a = mkUnit('强敌', 4, 6, 4, s.player);
  const b = mkUnit('弱敌', 2, 4, 2, s.player);
  s.player.fl = [a, b];
  const t = GAME.aiPickTarget('dmg2', s.player.allUnits(), s.enemy);
  results.push({ name: 'dmg2 打不死时打最高威胁', expect: '强敌', got: t && t.cn, ok: t && t.cn === '强敌' });
})();

// 场景5：buff1 应给攻击力最高的己方单位（原来给最低）
(function () {
  const s = makeSides();
  const weak = mkUnit('弱兵', 1, 3, 1, s.enemy);
  const strong = mkUnit('强兵', 5, 5, 5, s.enemy);
  s.enemy.fl = [weak, strong];
  const t = GAME.aiPickTarget('buff1', s.enemy.allUnits(), s.enemy);
  results.push({ name: 'buff1 给最强单位', expect: '强兵', got: t && t.cn, ok: t && t.cn === '强兵' });
})();

// 场景6：压制 pin1 应压制威胁最高的
(function () {
  const s = makeSides();
  const a = mkUnit('巨兽', 7, 7, 7, s.player);
  const b = mkUnit('小兵', 1, 1, 1, s.player);
  s.player.fl = [a, b];
  const t = GAME.aiPickTarget('pin1', s.player.allUnits(), s.enemy);
  results.push({ name: 'pin1 压制最高威胁', expect: '巨兽', got: t && t.cn, ok: t && t.cn === '巨兽' });
})();

// 场景7：_counterValue 对能解掉高威胁的指令应给出高分
(function () {
  const s = makeSides();
  const big = mkUnit('巨兽', 8, 8, 8, s.player);
  s.player.fl = [big];
  const dmg2 = { isOrder: true, fx: 'dmg2', cost: 2, effCode: '' };
  const dmg4 = { isOrder: true, fx: 'dmg2t4', cost: 4, effCode: '' };
  const tank = mkUnit('AI坦克', 2, 2, 2, s.enemy, 'support', 'T');
  s.enemy.support = [tank];
  const cv2 = GAME._counterValue(dmg2, s.enemy, s.player);
  const cv4 = GAME._counterValue(dmg4, s.enemy, s.player);
  results.push({ name: 'counterValue dmg2(打不死8/8)', expect: '>0', got: cv2, ok: cv2 > 0 });
  results.push({ name: 'counterValue dmg2t4(4伤仍打不死8/8)', expect: '>0', got: cv4, ok: cv4 > 0 });
})();

// 场景8：无高威胁单位时 _counterValue 应为 0
(function () {
  const s = makeSides();
  const small = mkUnit('小兵', 1, 1, 1, s.player);
  s.player.fl = [small];
  const dmg2 = { isOrder: true, fx: 'dmg2', cost: 2, effCode: '' };
  const cv = GAME._counterValue(dmg2, s.enemy, s.player);
  results.push({ name: 'counterValue 低威胁不加分', expect: '0', got: cv, ok: cv === 0 });
})();

return results;
`;

const fn = new Function('require', '__dirname', head + '\n' + body);
const results = fn(require, __dirname);
let pass = 0, fail = 0;
results.forEach(r => {
  if (r.ok) { pass++; console.log('  PASS  ' + r.name + '  (got=' + r.got + ')'); }
  else { fail++; console.log('  FAIL  ' + r.name + '  (expect=' + r.expect + ', got=' + r.got + ')'); }
});
console.log('---- ' + pass + ' passed, ' + fail + ' failed ----');
process.exit(fail ? 1 : 0);