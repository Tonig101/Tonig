'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

global.setTimeout = () => 0; global.clearTimeout = () => {};
global.setInterval = () => 0; global.clearInterval = () => {};
global.requestAnimationFrame = () => 0; global.cancelAnimationFrame = () => {};

function makeEl(tag) {
  const cls = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  return {
    tagName: (tag || 'div').toUpperCase(), classList: cls, style: {}, dataset: {},
    children: [], childNodes: [], innerHTML: '', textContent: '', innerText: '', value: '',
    id: '', className: '', title: '', disabled: false, checked: false,
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
  getElementById: () => makeEl('div'), querySelector: () => makeEl('div'), querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  createTextNode: () => makeEl(), getElementsByClassName: () => [], getElementsByTagName: () => [],
};
const silentConsole = () => ({ log() {}, info() {}, warn() {}, error() {}, debug() {}, table() {}, trace() {} });
const sandbox = {
  console: silentConsole(),
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
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  scrollTo() {}, scrollBy() {}, focus() {}, blur() {}, print() {},
  matchMedia() { return { matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }; },
  innerWidth: 1200, innerHeight: 800,
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function extractScripts(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out.join('\n;\n');
}
vm.runInContext(extractScripts(HTML), sandbox, { filename: 'index.html' });

const SIM = sandbox.SIM;
if (!SIM) { console.error('SIM 未定义'); process.exit(1); }
const GAME = sandbox.GAME;
console.log('[初始] gameOver=' + GAME.gameOver + ' player=' + GAME.player + ' enemy=' + GAME.enemy + ' phase=' + GAME.phase);
SIM.playGame('D', 'S');
console.log('[第1局后] gameOver=' + GAME.gameOver + ' player=' + GAME.player + ' enemy=' + GAME.enemy + ' phase=' + GAME.phase);
SIM.playGame('D', 'S');
console.log('[第2局后] gameOver=' + GAME.gameOver + ' player=' + GAME.player + ' enemy=' + GAME.enemy + ' phase=' + GAME.phase);

const matchups = [['D', 'S'], ['U', 'J'], ['B', 'D'], ['S', 'U'], ['J', 'B'], ['D', 'D']];
let totalErr = 0;
matchups.forEach(([a, b]) => {
  const res = { player: 0, enemy: 0, draw: 0, timeout: 0 };
  let errs = 0;
  for (let i = 0; i < 30; i++) {
    try {
      const r = SIM.playGame(a, b);
      res[r.winner]++;
    } catch (e) {
      errs++;
      if (errs <= 2) console.error('[' + a + ' vs ' + b + '] 第' + i + '局异常: ' + e.message);
    }
  }
  totalErr += errs;
  console.log('[' + a + ' vs ' + b + '] ' + JSON.stringify(res) + (errs ? ' 异常=' + errs : ''));
});

console.log('restore 后 GAME.player=' + GAME.player + ' GAME.enemy=' + GAME.enemy + ' gameOver=' + GAME.gameOver);
console.log(totalErr === 0 ? '=== 全部通过 ===' : '=== 存在异常 ===');
process.exit(totalErr === 0 ? 0 : 1);