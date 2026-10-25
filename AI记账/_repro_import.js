const { JSDOM } = require('jsdom');
const path = require('path');

const APP_DIR = 'D:/AI 智能体创新应用大赛作品/AI记账';

// 模拟微信 + 支付宝导出 CSV（UTF-8）
const wxCsv =
  '微信支付账单明细,,\n' +
  '微信昵称：[测试用户],,\n' +
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),当前状态,备注\n' +
  '2026-01-05 12:30:00,商户消费,星巴克,拿铁,支出,"¥32.00",支付成功,\n' +
  '2026-01-06 09:12:00,转账,张三,/,收入,"¥200.00",已收款,\n' +
  '2026-01-08 19:00:00,商户消费,美团,聚餐,支出,"¥88.50",支付成功,\n';
const aliCsv =
  '支付宝交易记录明细查询,,\n' +
  '账号:[test@alipay.com],,\n' +
  '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,备注\n' +
  '2026-01-07 08:00:00,餐饮,肯德基,早餐,支出,25.00,余额,\n' +
  '2026-01-09 20:00:00,转账,李四,还款,支出,300.00,余额,借给朋友\n';

const errors = [];
const logs = [];

const dom = JSDOM.fromFile(path.join(APP_DIR, 'index.html'), {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.addEventListener('error', e => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
  }
});

dom.then(async (vdom) => {
  const win = vdom.window;
  const doc = win.document;
  win.addEventListener('error', e => errors.push('onerror: ' + (e.error && e.error.stack || e.message)));
  const origErr = win.console.error.bind(win.console);
  win.console.error = (...a) => { errors.push('console.error: ' + a.join(' ')); origErr(...a); };
  win.console.log = (...a) => { logs.push(a.join(' ')); };

  // 等待脚本执行（DOMContentLoaded + init）
  await new Promise(r => setTimeout(r, 800));

  function makeFile(name, content) {
    return new win.File([content], name, { type: 'text/csv' });
  }
  function setFiles(input, files) {
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new win.Event('change'));
  }
  async function wait(t) { return new Promise(r => setTimeout(r, t)); }

  // ===== 路径 A：顶栏「导入账单」=====
  console.log('===== 路径 A：顶栏 导入账单 =====');
  // 适配当前 UI：导入入口在「更多」菜单里（data-act=import）
  doc.getElementById('btnMore').dispatchEvent(new win.Event('click', { bubbles: true }));
  const btnImport = doc.querySelector('#moreMenu [data-act="import"]');
  console.log('更多菜单-导入 存在:', !!btnImport);
  btnImport.dispatchEvent(new win.Event('click', { bubbles: true }));
  await wait(50);
  const importMask = doc.getElementById('importMask');
  console.log('importMask 可见:', importMask && importMask.hidden === false);
  const importFile = doc.getElementById('importFile');
  setFiles(importFile, [makeFile('wx.csv', wxCsv), makeFile('ali.csv', aliCsv)]);
  await wait(400); // 等 FileReader 异步
  const importReport = doc.getElementById('importReport');
  const importStatus = doc.getElementById('importStatus');
  console.log('importStatus:', importStatus && importStatus.textContent);
  console.log('importReport 非空:', importReport && importReport.innerHTML.length > 0);
  console.log('importReport 含「将导入」:', importReport && importReport.innerHTML.indexOf('将导入') !== -1);
  const btnConfirm = doc.getElementById('btnImportConfirm');
  btnConfirm.dispatchEvent(new win.Event('click'));
  await wait(200);
  // 看确认后 AI 提示语
  const aiMsgs = Array.from(doc.querySelectorAll('#chatList .bubble')).map(b => b.textContent);
  const confirmMsg = aiMsgs.filter(t => /已导入|没有可导入|导入/.test(t)).slice(-1)[0] || '(无)';
  console.log('确认后 AI 提示:', confirmMsg);
  // 打开账单分析「当前账本」模式，看记录数是否包含导入的
  doc.getElementById('btnAnalysis').dispatchEvent(new win.Event('click'));
  await wait(50);
  // 默认 current 模式
  const ar = doc.getElementById('analysisReport');
  const recMatch = ar && ar.innerHTML.match(/支出笔数<\/small><\/div><div><b>(\d+)/);
  console.log('当前账本分析 支出笔数:', recMatch ? recMatch[1] : '(未找到)');
  const ovMatch = ar && ar.innerHTML.match(/共\s*(\d+)\s*条原始记录/);
  console.log('当前账本分析 原始记录数:', ovMatch ? ovMatch[1] : '(未找到)');

  // ===== 路径 B：账单分析「导入 CSV」=====
  console.log('\n===== 路径 B：账单分析 导入CSV =====');
  const btnAnalysis = doc.getElementById('btnAnalysis');
  btnAnalysis.dispatchEvent(new win.Event('click'));
  await wait(50);
  // 切到「导入 CSV」标签
  const tabs = doc.querySelectorAll('[data-act="an-mode"]');
  let importedTab = null;
  tabs.forEach(t => { if (t.getAttribute('data-mode') === 'imported') importedTab = t; });
  console.log('导入CSV 标签存在:', !!importedTab);
  importedTab.dispatchEvent(new win.Event('click'));
  await wait(50);
  const analysisFile = doc.getElementById('analysisFile');
  setFiles(analysisFile, [makeFile('wx.csv', wxCsv)]);
  await wait(400);
  const analysisReport = doc.getElementById('analysisReport');
  const analysisStatus = doc.getElementById('analysisStatus');
  console.log('analysisStatus:', analysisStatus && analysisStatus.textContent);
  console.log('analysisReport 非空:', analysisReport && analysisReport.innerHTML.length > 0);
  console.log('analysisReport 含「总览」:', analysisReport && analysisReport.innerHTML.indexOf('总览') !== -1);
  console.log('analysisReport 含「解析情况」:', analysisReport && analysisReport.innerHTML.indexOf('解析情况') !== -1);

  console.log('\n===== 捕获到的错误 =====');
  if (errors.length === 0) console.log('(无)');
  else errors.forEach(e => console.log('  ✗', e));

  process.exit(0);
}).catch(e => { console.error('HARNESS FAIL:', e); process.exit(1); });
