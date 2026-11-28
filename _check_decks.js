'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
function makeEl(tag) { return { tagName:(tag||'div').toUpperCase(), classList:{add(){},remove(){},toggle(){},contains(){return false}}, style:{}, dataset:{}, children:[], childNodes:[], innerHTML:'', textContent:'', value:'', id:'', className:'', title:'', disabled:false, checked:false, scrollTop:0, scrollHeight:0, clientHeight:0, clientWidth:0, offsetWidth:0, offsetHeight:0, getContext(){return null}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){}, appendChild(){return makeEl()}, removeChild(){}, insertBefore(){}, replaceChild(){}, append(){}, prepend(){}, before(){}, after(){}, remove(){}, replaceWith(){}, setAttribute(){}, getAttribute(){return null}, removeAttribute(){}, hasAttribute(){return false}, closest(){return null}, contains(){return false}, matches(){return false}, insertAdjacentHTML(){}, insertAdjacentText(){}, querySelector(){return makeEl()}, querySelectorAll(){return []}, getElementsByTagName(){return []}, getElementsByClassName(){return []}, focus(){}, blur(){}, click(){}, getBoundingClientRect(){return {left:0,top:0,width:0,height:0,right:0,bottom:0,x:0,y:0}} }; }
const documentStub = { documentElement:makeEl('html'), body:makeEl('body'), head:makeEl('head'), createElement:(t)=>makeEl(t), createElementNS:(n,t)=>makeEl(t), getElementById:()=>makeEl('div'), querySelector:()=>makeEl('div'), querySelectorAll:()=>[], addEventListener(){}, removeEventListener(){}, createTextNode:()=>makeEl(), getElementsByClassName:()=>[], getElementsByTagName:()=>[] };
const sandbox = { console:{log(){},info(){},warn(){},error(){},debug(){},table(){},trace(){}}, setTimeout:()=>0, clearTimeout:()=>{}, setInterval:()=>0, clearInterval:()=>{}, requestAnimationFrame:()=>0, cancelAnimationFrame:()=>{}, document:documentStub, localStorage:{getItem(){return null},setItem(){},removeItem(){},clear(){}}, sessionStorage:{getItem(){return null},setItem(){},removeItem(){},clear(){}}, location:{href:'',protocol:'file:',host:'',pathname:'',search:'',hash:''}, navigator:{userAgent:'node'}, performance:{now:()=>Date.now()}, alert(){}, confirm(){return true}, prompt(){return null}, Image:function(){}, AudioContext:function(){}, webkitAudioContext:function(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){}, scrollTo(){}, scrollBy(){}, focus(){}, blur(){}, print(){}, matchMedia(){return {matches:false,media:'',addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}}, innerWidth:1200, innerHeight:800 };
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
function extractScripts(html){ const out=[]; const re=/<script\b[^>]*>([\s\S]*?)<\/script>/gi; let m; while((m=re.exec(html)))out.push(m[1]); return out.join('\n;\n'); }
vm.runInContext(extractScripts(HTML), sandbox, {filename:'index.html'});

const CP = sandbox.CP;
const DD = sandbox.DEFAULT_DECKS;
function cardLimit(c){ return c[3]==='X' ? (c[9]||1) : (c[12]||1); }
function findCardByCn(fc,cn){ for(let i=0;i<CP.length;i++)if(CP[i][2]===fc&&CP[i][0]===cn)return CP[i]; return null; }

const factions = Object.keys(DD);
factions.forEach(fc => {
  DD[fc].forEach(d => {
    let total = 0, over = [], unknown = [];
    for (const cn in d.cards) {
      const q = d.cards[cn];
      const c = findCardByCn(fc, cn);
      if (!c) { unknown.push(cn); continue; }
      if (q > cardLimit(c)) over.push(cn + ':' + q + '>' + cardLimit(c));
      total += Math.min(q, cardLimit(c));
    }
    console.log('[' + fc + ':' + d.id + '] ' + d.name + ' 实际=' + total + (over.length ? ' 超限[' + over.join(',') + ']' : '') + (unknown.length ? ' 未知[' + unknown.join(',') + ']' : ''));
  });
});