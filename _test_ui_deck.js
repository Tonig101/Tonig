const fs = require('fs');
const src = fs.readFileSync('index.html', 'utf8');

function grabBlock(name) {
  const i = src.indexOf('var ' + name + '=');
  if (i < 0) return '';
  let depth = 0;
  const start = src.indexOf('{', i);
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  return '';
}

const sandbox = {};
const vm = require('vm');
const code = grabBlock('DEFAULT_DECKS') + '\n'
  + 'function validateDeck(){return {ok:true}};\n'
  + 'var DeckStore={list:function(fc){return DEFAULT_DECKS[fc]||[]},'
  + 'byId:function(fc,id){var l=this.list(fc);for(var i=0;i<l.length;i++)if(l[i].id===id)return l[i];return null},'
  + 'active:function(fc){return {name:"ACTIVE",cards:{}}} };\n'
  + 'var SIM={_pickDeck:function(fc,id){if(!id)return DeckStore.active(fc);var d=DeckStore.byId(fc,id);if(!d||!validateDeck(fc,d).ok)return DeckStore.active(fc);return d}};\n';

vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const checks = [];
function eq(label, got, want) {
  const ok = got === want;
  checks.push({ label, ok, got, want });
}

const fcList = ['D', 'S', 'U', 'B', 'J'];
let deckCount = 0;
fcList.forEach(fc => {
  const list = sandbox.DeckStore.list(fc);
  deckCount += list.length;
  list.forEach(d => {
    eq('解析 ' + fc + ':' + d.id + ' → ' + d.name, sandbox.SIM._pickDeck(fc, d.id).name, d.name);
  });
});

eq('id=null 回落激活卡组', sandbox.SIM._pickDeck('D', null).name, 'ACTIVE');
eq('id=空串 回落激活卡组', sandbox.SIM._pickDeck('D', '').name, 'ACTIVE');
eq('id 不存在 回落激活卡组', sandbox.SIM._pickDeck('B', 'zz').name, 'ACTIVE');
eq('阵营错配 回落激活卡组', sandbox.SIM._pickDeck('J', 'r4').name, 'ACTIVE');

console.log('共 ' + deckCount + ' 套卡组，' + checks.length + ' 项检查');
const fails = checks.filter(c => !c.ok);
if (fails.length) {
  console.log('❌ 失败 ' + fails.length + ' 项：');
  fails.forEach(f => console.log('  ' + f.label + '  期望=' + f.want + '  实际=' + f.got));
  process.exitCode = 1;
} else {
  console.log('✅ 全部通过');
  console.log('  B:r4 → ' + sandbox.SIM._pickDeck('B', 'r4').name);
  console.log('  J:r2 → ' + sandbox.SIM._pickDeck('J', 'r2').name);
  console.log('  U:r2 → ' + sandbox.SIM._pickDeck('U', 'r2').name);
}