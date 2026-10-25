/**
 * _test_coach.js — 理财教练模式 JSDOM 冒烟测试
 * 运行：node _test_coach.js
 * 覆盖：教练说卡片 / 怎么省钱 / 怎么赚钱 / 剁手冷静法全流程 / 教练面板渲染 / Tab 切换
 */
const { JSDOM } = require('jsdom');
const path = require('path');

const APP_DIR = __dirname;
const errors = [];

JSDOM.fromFile(path.join(APP_DIR, 'index.html'), {
  runScripts: 'dangerously',
  resources: 'usable', // 本地 <script src> 也需要经资源加载器执行
  pretendToBeVisual: true,
  beforeParse(window) {
    window.addEventListener('error', (e) => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
  }
}).then(async (vdom) => {
  const win = vdom.window;
  const doc = win.document;
  win.addEventListener('error', (e) => errors.push('onerror: ' + (e.error && e.error.stack || e.message)));
  const origErr = win.console.error.bind(win.console);
  win.console.error = (...a) => { errors.push('console.error: ' + a.join(' ')); origErr(...a); };

  const wait = (t) => new Promise((r) => setTimeout(r, t));
  // 冒泡点击：聊天/面板均用事件委托，合成事件必须 bubbles
  const click = (el) => el.dispatchEvent(new win.Event('click', { bubbles: true }));
  const send = async (text) => {
    const input = doc.getElementById('chatInput');
    input.value = text;
    click(doc.getElementById('btnSend'));
    await wait(60);
  };
  const lastCard = (sel) => {
    const list = doc.querySelectorAll(sel);
    return list.length ? list[list.length - 1] : null;
  };

  // 等 init 完成（欢迎语出现），避免外部脚本加载延迟导致误判
  for (let i = 0; i < 60 && doc.querySelectorAll('#chatList .msg-row').length === 0; i++) {
    await wait(100);
  }

  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✅', name); }
    else { fail++; console.log('  ❌', name, extra === undefined ? '' : '-> ' + extra); }
  };

  console.log('===== 1. 页面初始化 =====');
  check('无脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('理财教练 Tab 存在', !!doc.querySelector('#tabbar .tab[data-view="coach"]'));
  check('教练面板存在', !!doc.getElementById('panelCoach'));

  console.log('===== 2. 教练面板渲染 =====');
  const tips = doc.querySelectorAll('#coachTips .coach-tip');
  const lessons = doc.querySelectorAll('#coachAcademy .coach-lesson');
  check('专属建议有内容', tips.length > 0, 'count=' + tips.length);
  check('理财学院 8 节课', lessons.length === 8, 'count=' + lessons.length);
  check('面板含免责声明', (doc.querySelector('.coach-disclaimer') || {}).textContent !== undefined);

  console.log('===== 3. 记账触发「💡 理财教练说」 =====');
  await send('星巴克拿铁32');
  const sayCard = lastCard('#chatList .coach-say');
  check('高溢价品牌出教练卡', !!sayCard);
  if (sayCard) {
    const body = sayCard.querySelector('.coach-say-body').textContent;
    check('教练卡标题正确', sayCard.querySelector('.coach-say-head').textContent.indexOf('理财教练说') !== -1);
    check('建议 ≤50 字', body.length <= 50, 'len=' + body.length + ' -> ' + body);
    console.log('     文案:', body);
  }
  const billCount1 = doc.querySelectorAll('#chatList .bill-card').length;
  await send('中午食堂15');
  const noCoach = !lastCard('#chatList .coach-say') || true; // 下面单独验证普通餐不出卡
  const cardsAfter = doc.querySelectorAll('#chatList .bill-card').length;
  check('普通餐饮正常入账', cardsAfter1(cardsAfter, billCount1));
  function cardsAfter1(a, b) { return a === b + 1; }
  const sayAfterNormal = doc.querySelectorAll('#chatList .msg-row');
  const lastSay = doc.querySelectorAll('#chatList .coach-say');
  check('普通餐饮不出教练卡', lastSay.length === 1, 'count=' + lastSay.length);

  console.log('===== 4. 冲动消费出教练卡 =====');
  await send('游戏皮肤充值99，心情不好想买的');
  // ≥50 元冲动消费先弹冷静期卡（既有设计），选「仍然记下这笔」后入账并出教练卡
  const cdCard = lastCard('#chatList .decision-card:not(.cool-card)');
  check('冲动消费触发冷静期卡', !!cdCard && cdCard.textContent.indexOf('冷静期提醒') !== -1);
  const buyBtn = cdCard && cdCard.querySelector('[data-act="cooldown-buy"]');
  check('冷静期卡有「仍然记下这笔」', !!buyBtn);
  click(buyBtn);
  await wait(60);
  const impulseSay = doc.querySelectorAll('#chatList .coach-say');
  check('入账后出教练卡', impulseSay.length === 2, 'count=' + impulseSay.length);
  if (impulseSay.length > 1) {
    const t = impulseSay[impulseSay.length - 1].querySelector('.coach-say-body').textContent;
    check('冲动建议 ≤50 字', t.length <= 50, 'len=' + t.length);
    console.log('     文案:', t);
  }

  console.log('===== 5. 怎么省钱 / 怎么赚钱 =====');
  await send('怎么省钱');
  const qaList = lastCard('#chatList .coach-qa-list');
  check('省钱攻略列表渲染', !!qaList);
  if (qaList) {
    const items = qaList.querySelectorAll('li');
    check('省钱建议 5 条', items.length === 5, 'count=' + items.length);
    check('含食堂平替', qaList.textContent.indexOf('食堂') !== -1);
  }
  await send('怎么赚钱');
  const moneyList = lastCard('#chatList .coach-qa-list');
  check('搞钱路子列表渲染', !!moneyList);
  if (moneyList) {
    check('含勤工俭学', moneyList.textContent.indexOf('勤工俭学') !== -1);
    check('含防骗提醒', (lastCard('#chatList .coach-bubble') || {textContent:''}).textContent.indexOf('骗子') !== -1);
  }

  console.log('===== 6. 剁手冷静法全流程 =====');
  await send('我想买个蓝牙耳机，大概900');
  const intro = lastCard('#chatList .cool-card');
  check('冷静法入口卡出现', !!intro && intro.textContent.indexOf('蓝牙耳机') !== -1);
  const startBtn = intro && intro.querySelector('[data-act="cool-next"]');
  check('有「开始冷静问答」按钮', !!startBtn);
  click(startBtn);
  await wait(30);
  const q1 = lastCard('#chatList .cool-card');
  check('第 1 问渲染', q1.textContent.indexOf('第 1 / 3 问') !== -1, q1 && q1.textContent.slice(0, 40));
  const q1opts = q1.querySelectorAll('.cool-opt');
  check('第 1 问 4 个选项', q1opts.length === 4, 'count=' + q1opts.length);
  click(q1opts[0]); // 真的需要
  await wait(30);
  const q2 = lastCard('#chatList .cool-card');
  check('第 2 问渲染', q2.textContent.indexOf('第 2 / 3 问') !== -1);
  const q2opts = q2.querySelectorAll('.cool-opt');
  check('第 2 问 3 个选项', q2opts.length === 3);
  click(q2opts[0]); // 每周都用
  await wait(30);
  const q3 = lastCard('#chatList .cool-card');
  check('第 3 问渲染', q3.textContent.indexOf('第 3 / 3 问') !== -1);
  const q3opts = q3.querySelectorAll('.cool-opt');
  click(q3opts[2]); // 咬牙/分期 -> 需要+每周+咬牙 = 4 分 -> warn
  await wait(30);
  const verdict = lastCard('#chatList .cool-card');
  check('结论卡渲染', verdict.textContent.indexOf('教练判断') !== -1);
  check('结论为「建议晾 48 小时」', verdict.textContent.indexOf('建议晾 48 小时') !== -1, verdict && verdict.textContent.slice(0, 60));
  const recordBtn = verdict.querySelector('[data-act="cool-record"]');
  check('有「仍然购买」按钮', !!recordBtn && recordBtn.textContent.indexOf('900') !== -1);
  const before = doc.querySelectorAll('#chatList .bill-card').length;
  click(recordBtn);
  await wait(60);
  const after = doc.querySelectorAll('#chatList .bill-card').length;
  check('仍购买 -> 入账 1 笔', after === before + 1, before + ' -> ' + after);

  console.log('===== 7. 冷静法「先不买」 =====');
  await send('好想买新平板，3000左右');
  const intro2 = lastCard('#chatList .cool-card');
  check('第二件商品入口卡', intro2.textContent.indexOf('新平板') !== -1);
  click(intro2.querySelector('[data-act="cool-next"]'));
  await wait(20);
  click(lastCard('#chatList .cool-card').querySelectorAll('.cool-opt')[2]); // 别人有我也要
  await wait(20);
  click(lastCard('#chatList .cool-card').querySelectorAll('.cool-opt')[2]); // 吃灰
  await wait(20);
  click(lastCard('#chatList .cool-card').querySelectorAll('.cool-opt')[2]); // 咬牙
  await wait(30);
  const verdict2 = lastCard('#chatList .cool-card');
  check('低分结论为「建议先不买」', verdict2.textContent.indexOf('建议先不买') !== -1, verdict2 && verdict2.textContent.slice(0, 60));
  const skipBtn = verdict2.querySelector('[data-act="cool-skip"]');
  check('有「先不买」按钮', !!skipBtn);
  click(skipBtn);
  await wait(60);
  const aiTexts = Array.from(doc.querySelectorAll('#chatList .bubble')).map((b) => b.textContent);
  check('省下的钱有反馈', aiTexts.some((t) => t.indexOf('省下') !== -1 && t.indexOf('3,000') !== -1), aiTexts.slice(-1)[0]);

  console.log('===== 8. Tab 切换 =====');
  const coachTab = doc.querySelector('#tabbar .tab[data-view="coach"]');
  click(coachTab);
  await wait(30);
  check('body data-view=coach', doc.body.getAttribute('data-view') === 'coach');
  check('教练 Tab 高亮', coachTab.className.indexOf('active') !== -1);

  console.log('===== 9. 理财学院折叠 =====');
  const lesson = doc.querySelector('#coachAcademy .coach-lesson');
  const head = lesson.querySelector('.coach-lesson-head');
  click(head);
  await wait(30);
  check('点击展开', lesson.className.indexOf('open') !== -1);
  click(head);
  await wait(30);
  check('再点收起', lesson.className.indexOf('open') === -1);

  console.log('===== 10. 顶栏「理财教练」按钮 =====');
  click(doc.getElementById('btnCoach'));
  await wait(30);
  check('顶栏按钮切到教练视图', doc.body.getAttribute('data-view') === 'coach');

  console.log('');
  console.log('=================================');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  console.log('运行期错误数:', errors.length);
  errors.slice(0, 5).forEach((e) => console.log('  ERR:', e.slice(0, 200)));
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
}).catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
