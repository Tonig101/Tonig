/**
 * app.js — UI 状态、渲染、事件、持久化、CSV 导出
 *
 * 依赖（按 index.html 中的加载顺序）：
 *   data.js  -> window.AJ.data
 *   nlp.js   -> window.AJ.nlp
 *   engine.js-> window.AJ.engine
 */
(function (global) {
  'use strict';

  var DOC = global.document;
  var DATA = global.AJ.data;
  var NLP = global.AJ.nlp;
  var ENG = global.AJ.engine;
  var ANA = global.AJ.analysis;
  var OCR = global.AJ.ocr;

  /* 让 ocr.js 的云识别走后端 /api/ocr（服务端签名，密钥不进浏览器）。
     用 file:// 直接打开页面时后端不可达，ocr.js 会自动回退到本地 detectCloud。 */
  global.AJ_BACKEND_OCR = true;

  /* 后端实际可用能力（由 /api/capabilities 异步填充）。
     前端本地 OCR.capabilities() 不知道后端有没有配 OCR，必须问后端才能准确提示。 */
  var backendCaps = { ready: false, chat: false, ocr: 'none' };

  var STORAGE_KEY = DATA.STORAGE_KEY;
  var RING_R = 58;
  var RING_C = 2 * Math.PI * RING_R;

  var storageOK = true;
  var state = null;
  var highlightCategory = null;
  var flow = { queue: [], committed: [] };
  var pendingBill = null;

  /** 账单分析：最近一次导入的原始结果（默认不写入账本） */
  var analysisData = null;

  /** 截屏记账：当前图片 dataURL / 当前待确认结果 */
  var ocrImageDataUrl = '';
  var ocrDraft = null;

  /* ================================================================== */
  /* 通用工具                                                            */
  /* ================================================================== */

  function $(id) {
    return DOC.getElementById(id);
  }

  function esc(text) {
    return String(text === undefined || text === null ? '' : text).replace(/[&<>"']/g, function (c) {
      if (c === '&') { return '&amp;'; }
      if (c === '<') { return '&lt;'; }
      if (c === '>') { return '&gt;'; }
      if (c === '"') { return '&quot;'; }
      return '&#39;';
    });
  }

  function money(n) {
    return ENG.fmtMoney(n);
  }

  function nowHM() {
    var d = new Date();
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
  }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 100000).toString(36);
  }

  function clampNumber(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) { return fallback; }
    if (n < min) { return min; }
    if (n > max) { return max; }
    return n;
  }

  function categoryColor(key) {
    return DATA.getCategoryColor(key);
  }

  /* ================================================================== */
  /* 持久化                                                              */
  /* ================================================================== */

  function normalizeBill(b) {
    if (!b || typeof b !== 'object') { return null; }
    var amount = Number(b.amount);
    if (!isFinite(amount) || amount <= 0) { return null; }
    var isIncome = b.type === 'income';
    var category;
    if (isIncome) {
      category = DATA.INCOME_CATEGORY;
    } else {
      category = (b.category && DATA.CATEGORY_KEYS.indexOf(b.category) !== -1) ? b.category : '其他';
    }
    var date = (typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) ? b.date : ENG.formatDate(new Date());
    return {
      id: b.id ? String(b.id) : uid('b'),
      date: date,
      amount: ENG.round2(amount),
      category: category,
      note: b.note ? String(b.note) : category,
      motivation: b.motivation === '情绪' ? '情绪' : '刚需',
      want: !!b.want,
      type: isIncome ? 'income' : 'expense',
      source: isIncome ? String(b.source || '') : '',
      askedCycle: !!b.askedCycle,
      imported: !!b.imported,
      createdAt: isFinite(Number(b.createdAt)) ? Number(b.createdAt) : Date.now()
    };
  }

  function normalizeGoal(g) {
    if (!g || typeof g !== 'object') { return null; }
    var target = Number(g.target);
    if (!isFinite(target) || target <= 0) { return null; }
    var saved = Number(g.saved);
    return {
      id: g.id ? String(g.id) : uid('goal'),
      name: g.name ? String(g.name) : '未命名目标',
      target: ENG.round2(target),
      saved: isFinite(saved) && saved >= 0 ? ENG.round2(saved) : 0,
      deadline: (typeof g.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(g.deadline)) ? g.deadline : ''
    };
  }

  function normalizeState(obj) {
    var s = obj || {};
    var budget = (s.budget && typeof s.budget === 'object') ? s.budget : {};
    var bills = [];
    var goals = [];
    var i;
    if (Array.isArray(s.bills)) {
      for (i = 0; i < s.bills.length; i++) {
        var nb = normalizeBill(s.bills[i]);
        if (nb) { bills.push(nb); }
      }
    }
    if (Array.isArray(s.goals)) {
      for (i = 0; i < s.goals.length; i++) {
        var ng = normalizeGoal(s.goals[i]);
        if (ng) { goals.push(ng); }
      }
    }
    return {
      bills: bills,
      budget: {
        total: clampNumber(budget.total, 0, 9999999, DATA.DEFAULT_BUDGET.total),
        payday: Math.round(clampNumber(budget.payday, 1, 28, DATA.DEFAULT_BUDGET.payday)),
        cooldownThreshold: clampNumber(budget.cooldownThreshold, 0, 9999999, DATA.DEFAULT_BUDGET.cooldownThreshold),
        cycleStart: (typeof budget.cycleStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(budget.cycleStart))
          ? budget.cycleStart : ''
      },
      goals: goals,
      savedMoney: clampNumber(s.savedMoney, 0, 99999999, 0),
      blockedCount: Math.round(clampNumber(s.blockedCount, 0, 999999, 0))
    };
  }

  function seedState() {
    var today = new Date();
    var budget = {
      total: DATA.DEFAULT_BUDGET.total,
      payday: DATA.DEFAULT_BUDGET.payday,
      cooldownThreshold: DATA.DEFAULT_BUDGET.cooldownThreshold,
      cycleStart: ''
    };
    var cycle = ENG.getCycle(today, budget.payday);
    var bills = [];
    var i;

    for (i = 0; i < DATA.SEED_BILLS.length; i++) {
      var seed = DATA.SEED_BILLS[i];
      var d = new Date(today.getTime());
      d.setDate(d.getDate() - seed.offset);
      var ds = ENG.formatDate(d);
      if (ds < cycle.start) { ds = cycle.start; }
      bills.push({
        id: 'seed_b' + i,
        date: ds,
        amount: ENG.round2(seed.amount),
        category: seed.category,
        note: seed.note,
        motivation: seed.motivation,
        want: !!seed.want,
        type: 'expense',
        createdAt: d.getTime() + i * 1000
      });
    }

    var inc = DATA.SEED_INCOME;
    var di = new Date(today.getTime());
    di.setDate(di.getDate() - inc.offset);
    var dis = ENG.formatDate(di);
    if (dis < cycle.start) { dis = cycle.start; }
    bills.push({
      id: 'seed_income',
      date: dis,
      amount: ENG.round2(inc.amount),
      category: DATA.INCOME_CATEGORY,
      note: inc.note,
      motivation: inc.motivation,
      want: false,
      type: 'income',
      source: inc.source || '生活费',
      askedCycle: true,
      imported: false,
      createdAt: di.getTime() + 900000
    });

    var goals = [];
    for (i = 0; i < DATA.DEFAULT_GOALS.length; i++) {
      goals.push({
        id: DATA.DEFAULT_GOALS[i].id,
        name: DATA.DEFAULT_GOALS[i].name,
        target: DATA.DEFAULT_GOALS[i].target,
        saved: DATA.DEFAULT_GOALS[i].saved,
        deadline: DATA.DEFAULT_GOALS[i].deadline
      });
    }

    return {
      bills: bills,
      budget: budget,
      goals: goals,
      savedMoney: 0,
      blockedCount: 0
    };
  }

  function loadState() {
    var raw = null;
    try {
      raw = global.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageOK = false;
      raw = null;
    }
    if (!raw) {
      state = seedState();
      saveState();
      return;
    }
    try {
      state = normalizeState(JSON.parse(raw));
    } catch (e2) {
      state = seedState();
    }
  }

  function saveState() {
    if (!storageOK) { return; }
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      storageOK = false;
      showStorageTip();
    }
  }

  function showStorageTip() {
    var tip = $('storageTip');
    if (tip) { tip.hidden = false; }
  }

  /* ================================================================== */
  /* 聊天渲染                                                            */
  /* ================================================================== */

  function chatListEl() {
    return $('chatList');
  }

  function scrollChat() {
    var list = chatListEl();
    if (list) { list.scrollTop = list.scrollHeight; }
  }

  function timeHtml() {
    return '<div class="msg-time">' + nowHM() + '</div>';
  }

  function appendRow(role, innerHtml) {
    var list = chatListEl();
    var row = DOC.createElement('div');
    row.className = 'msg-row' + (role === 'me' ? ' me' : '');
    var av = DOC.createElement('div');
    av.className = 'avatar ' + (role === 'me' ? 'me' : 'ai');
    av.textContent = role === 'me' ? '我' : '账';
    var body = DOC.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = innerHtml;
    row.appendChild(av);
    row.appendChild(body);
    list.appendChild(row);
    scrollChat();
    return body;
  }

  function addAIMessage(innerHtml) {
    return appendRow('ai', innerHtml + timeHtml());
  }

  function addUserMessage(text) {
    var body = appendRow('me', timeHtml());
    var bubble = DOC.createElement('div');
    bubble.className = 'bubble me';
    bubble.textContent = text;
    body.insertBefore(bubble, body.firstChild);
  }

  function aiBubble(text) {
    return '<div class="bubble ai">' + text + '</div>';
  }

  function tagHtml(text, cls) {
    return '<span class="tag' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>';
  }

  /** 单笔账单卡片 HTML */
  function billCardHtml(bill) {
    var isIncome = bill.type === 'income';
    var sign = isIncome ? '+' : '-';
    var cls = isIncome ? 'income' : 'expense';
    var tags = '';
    tags += tagHtml(bill.category, isIncome ? 'green' : '');
    if (isIncome) {
      tags += tagHtml('收入', 'green');
    } else {
      tags += tagHtml(bill.motivation, bill.motivation === '情绪' ? 'orange' : '');
      tags += tagHtml(bill.want ? '想要' : '需要', bill.want ? 'orange' : '');
    }
    tags += '<span class="tag">' + esc(bill.date) + '</span>';

    return '' +
      '<div class="bill-card">' +
      '  <div class="bill-card-head"><span>' + (isIncome ? '收入入账' : '支出记账') + '</span><span>' + esc(bill.date) + '</span></div>' +
      '  <div class="bill-card-main">' +
      '    <span class="bill-card-note">' + esc(bill.note) + '</span>' +
      '    <span class="bill-card-amount ' + cls + '">' + sign + money(bill.amount) + '</span>' +
      '  </div>' +
      '  <div class="bill-card-tags">' + tags + '</div>' +
      '</div>';
  }

  /* ================================================================== */
  /* 业务动作                                                            */
  /* ================================================================== */

  function isImpulse(draft) {
    if (!draft || draft.type !== 'expense') { return false; }
    return draft.motivation === '情绪' || draft.want === true;
  }

  function needsCooldown(draft) {
    if (!isImpulse(draft)) { return false; }
    var threshold = Number(state.budget.cooldownThreshold);
    if (!isFinite(threshold) || threshold <= 0) { return false; }
    return Number(draft.amount) >= threshold;
  }

  function commitBill(draft) {
    var isIncome = draft.type === 'income';
    var bill = {
      id: uid('b'),
      date: draft.date || ENG.formatDate(new Date()),
      amount: ENG.round2(draft.amount),
      category: isIncome ? DATA.INCOME_CATEGORY
        : (DATA.CATEGORY_KEYS.indexOf(draft.category) !== -1 ? draft.category : '其他'),
      note: draft.note || draft.category || '未命名',
      motivation: draft.motivation === '情绪' ? '情绪' : '刚需',
      want: !!draft.want,
      type: isIncome ? 'income' : 'expense',
      source: isIncome ? String(draft.source || '') : '',
      askedCycle: !!draft.askedCycle,
      imported: !!draft.imported,
      createdAt: Date.now()
    };
    state.bills.push(bill);
    saveState();
    return bill;
  }

  /** 开始处理一批解析结果 */
  function startFlow(drafts) {
    flow.queue = drafts.slice();
    flow.committed = [];
    stepFlow();
  }

  /** 逐笔入账，遇到需要冷静期的就暂停 */
  function stepFlow() {
    while (flow.queue.length > 0) {
      var draft = flow.queue.shift();
      if (needsCooldown(draft)) {
        pendingBill = draft;
        showCooldownCard(draft);
        renderAll();
        return;
      }
      flow.committed.push(commitBill(draft));
    }
    finishFlow();
  }

  function finishFlow() {
    var list = flow.committed;
    flow.committed = [];
    pendingBill = null;
    renderAll();
    if (list.length === 0) { return; }
    reportCommitted(list);
  }

  /** 汇报本次记账结果 */
  function reportCommitted(list) {
    var i;
    var totalExpense = 0;
    for (i = 0; i < list.length; i++) {
      if (list[i].type === 'expense') { totalExpense += list[i].amount; }
    }

    for (i = 0; i < list.length; i++) {
      var bill = list[i];
      var head;
      if (bill.type === 'income') {
        head = aiBubble('💰 记好了，这是一笔收入（' + esc(bill.source || '其他') + '），已经加进本周期，不计入支出统计。');
      } else {
        head = aiBubble('记好啦～已归类为 <span class="hl">' + esc(bill.category) + '</span>' +
          (bill.motivation === '情绪' ? '（情绪消费，我盯着你呢）' : '') + '。');
      }
      var html = head + billCardHtml(bill);

      var alt = bill.type === 'expense' ? ENG.getAlternative(bill) : null;
      if (alt && alt.save > 0) {
        html += aiBubble('💡 校园平替：<span class="hl">' + esc(alt.altName) + '</span>只要 ' +
          money(alt.altPrice) + '，' + esc(alt.tip) + '能省 ' +
          money(alt.weeklySave || alt.save * (alt.times || 1)) + '。');
      }
      addAIMessage(html);
      if (bill.type === 'income') {
        maybeAskCycleReset(bill);
      }
    }

    if (totalExpense > 0) {
      var overview = getOverview();
      addAIMessage(aiBubble(overview.sentence));
    }
  }

  /** 冷静期警示卡 */
  function showCooldownCard(draft) {
    var percent = state.budget.total > 0 ? (draft.amount / state.budget.total * 100) : 0;
    var overview = getOverview();
    var sim = ENG.simulatePurchase({
      amount: draft.amount,
      state: overview.budgetState,
      remainingDays: overview.cycle.remainingDays
    });

    var html = '' +
      '<div class="warn-card">' +
      '  <div class="warn-title">⚠️ 这笔超线了，先冷静 24 小时？</div>' +
      '  <div class="warn-text">这笔 <b>' + money(draft.amount) + '</b> 的「' + esc(draft.category) + ' · ' + esc(draft.note) +
      '」占你本周期生活费的 <b>' + percent.toFixed(1) + '%</b>，已超过单笔 ' + money(state.budget.cooldownThreshold) +
      ' 的冷静线。建议先放进购物车，冷静 24 小时。</div>' +
      '  <div class="warn-sim">📉 ' + esc(sim.message) + '</div>' +
      '  <div class="warn-actions">' +
      '    <button type="button" class="btn-mini warn" data-act="cooldown-buy">坚持购买</button>' +
      '    <button type="button" class="btn-mini" data-act="cooldown-skip">算了，不买了</button>' +
      '  </div>' +
      '</div>';
    addAIMessage(html);
  }

  var PUSH_BACK_LINES = [
    '好的，那这笔就记上了～下不为例哦。',
    '行吧，快乐也是刚需，但我先记在小本本上了。',
    '记好了。下次看到「限时」两个字，先深呼吸三次。'
  ];

  function resolveCooldown(keep) {
    var draft = pendingBill;
    if (!draft) { return; }
    pendingBill = null;

    if (keep) {
      var bill = commitBill(draft);
      flow.committed.push(bill);
      var line = PUSH_BACK_LINES[Math.floor(Math.random() * PUSH_BACK_LINES.length)];
      addAIMessage(aiBubble(esc(line) + '<br>这笔 ' + money(bill.amount) + ' 已标记为「情绪消费」。'));
    } else {
      state.savedMoney = ENG.round2(state.savedMoney + draft.amount);
      state.blockedCount = state.blockedCount + 1;
      saveState();
      addAIMessage(aiBubble('这波省下 ' + money(draft.amount) + '，已记进你的「省下的钱」成就（累计 ' +
        money(state.savedMoney) + '）。👏'));
      renderAll();
    }
    stepFlow();
  }

  /* ================================================================== */
  /* 概览计算                                                            */
  /* ================================================================== */

  function getOverview() {
    var today = new Date();
    var todayStr = ENG.formatDate(today);
    var cycle = ENG.getCycle(today, state.budget.payday, null, state.budget.cycleStart);
    var cycleAgg = ENG.aggregate(state.bills, cycle.start, cycle.end);
    var allAgg = ENG.aggregate(state.bills, null, null);
    var todaySpent = ENG.round2(cycleAgg.dailyMap[todayStr] || 0);
    var budgetState = ENG.getBudgetState({
      total: state.budget.total,
      spent: cycleAgg.expense,
      remainingDays: cycle.remainingDays,
      todaySpent: todaySpent
    });
    var engel = ENG.getEngel(cycleAgg.byCategory, cycleAgg.expense);
    var incomeStats = ENG.getIncomeStats(state.bills, cycle);
    var monthlySurplus = cycle.remainingDays > 0
      ? Math.max(0, ENG.round2(budgetState.remaining / cycle.remainingDays * 30))
      : 0;
    var sentence;
    if (budgetState.isOver) {
      sentence = '📉 本周期已经超支 ' + money(budgetState.overBy) + '，接下来 ' +
        cycle.remainingDays + ' 天建议只吃食堂，先把窟窿补上。';
    } else if (budgetState.status === 'danger') {
      sentence = '📉 本周期还剩 ' + money(budgetState.remaining) + '，日均可用只有 ' +
        money(budgetState.dailyAllowance) + '，进入吃土预警状态。';
    } else if (budgetState.status === 'tight') {
      sentence = '📊 本周期还剩 ' + money(budgetState.remaining) + '，日均可用 ' +
        money(budgetState.dailyAllowance) + '，稍微收着点花。';
    } else {
      sentence = '📊 本周期还剩 ' + money(budgetState.remaining) + '，日均可用 ' +
        money(budgetState.dailyAllowance) + '，节奏还不错，继续保持。';
    }
    return {
      today: today,
      todayStr: todayStr,
      cycle: cycle,
      cycleAgg: cycleAgg,
      allAgg: allAgg,
      budgetState: budgetState,
      engel: engel,
      incomeStats: incomeStats,
      monthlySurplus: monthlySurplus,
      sentence: sentence
    };
  }

  /* ================================================================== */
  /* 看板渲染                                                            */
  /* ================================================================== */

  function renderAll() {
    renderDashboard();
    renderGoals();
  }

  /**
   * 看板「收支概览」卡：本周期 收入 / 支出 / 结余 / 储蓄率。
   * 收入为 0 时储蓄率显示「—」，避免 NaN / Infinity。
   * @param {Object} ov getOverview() 结果
   */
  function renderIncomeCard(ov) {
    var stats = ov.incomeStats || { income: 0, expense: 0, balance: 0, savingsRate: null };
    var incomeEl = $('incIncome');
    var expenseEl = $('incExpense');
    var balanceEl = $('incBalance');
    var rateEl = $('incRate');
    if (!incomeEl || !expenseEl || !balanceEl || !rateEl) { return; }

    incomeEl.textContent = money(stats.income);
    expenseEl.textContent = money(stats.expense);
    balanceEl.textContent = money(stats.balance);
    balanceEl.className = stats.balance < 0 ? 'neg' : '';
    rateEl.textContent = stats.savingsRate === null ? '—' : stats.savingsRate.toFixed(1) + '%';
    rateEl.className = (stats.savingsRate !== null && stats.savingsRate < 0) ? 'neg' : '';

    var hint = $('incomeHint');
    if (hint) {
      hint.textContent = stats.hasIncome
        ? '收入 ' + stats.incomeCount + ' 笔'
        : '还没记收入';
    }
  }

  function renderDashboard() {
    var ov = getOverview();
    var bs = ov.budgetState;
    var total = state.budget.total;

    /* ---- 预算环 ---- */
    var ring = $('ringBar');
    var ratio = total > 0 ? Math.max(0, Math.min(1, bs.remaining / total)) : 0;
    if (ring) {
      ring.style.strokeDasharray = RING_C + ' ' + RING_C;
      ring.style.strokeDashoffset = String(RING_C * (1 - ratio));
      ring.style.stroke = bs.status === 'danger' ? '#EF5350' : (bs.status === 'tight' ? '#FF8A3D' : '#07C160');
    }
    $('ringRemaining').textContent = money(bs.remaining);
    $('ringPercent').textContent = '剩余 ' + Math.round(ratio * 100) + '%';

    var badge = $('cycleBadge');
    badge.textContent = '第 ' + ov.cycle.passedDays + ' / ' + ov.cycle.totalDays + ' 天';
    badge.className = 'badge' + (bs.status === 'danger' ? ' danger' : (bs.status === 'tight' ? ' warn' : ''));

    $('statDaily').textContent = money(bs.dailyAllowance);
    $('statToday').textContent = money(bs.todaySpent);
    $('statDays').textContent = ov.cycle.remainingDays + ' 天';
    $('budgetCycle').textContent = '周期 ' + ov.cycle.start + ' ~ ' + ov.cycle.end +
      (ov.cycle.isCustom ? '（自定义起点）' : '') +
      ' · 总预算 ' + money(total) + ' · 已花 ' + money(ov.cycleAgg.expense);
    $('cycleBadge').title = ov.cycle.isCustom
      ? '当前周期从 ' + ov.cycle.start + ' 起算（生活费到账日）'
      : '按发钱日 ' + state.budget.payday + ' 号计算的周期';

    /* ---- 收支概览 ---- */
    renderIncomeCard(ov);

    /* ---- 恩格尔 ---- */
    var engelCard = $('engelCard');
    var engelPercent = Math.round(ov.engel.percent);
    $('engelBadge').textContent = '餐饮占比 ' + engelPercent + '%';
    $('engelFill').style.width = Math.min(100, engelPercent) + '%';
    if (ov.engel.alert) {
      engelCard.className = 'card card-engel alert';
      $('engelBadge').className = 'badge badge-soft warn';
      var food = ENG.round2(ov.cycleAgg.byCategory['餐饮'] || 0);
      $('engelText').textContent = '餐饮占比 ' + engelPercent +
        '%，属于偏高，注意别把社交预算吃掉。本月餐饮已花 ' + money(food) +
        '，把外卖和奶茶压掉两成，还能省回约 ' + money(food * 0.2) + '。';
    } else {
      engelCard.className = 'card card-engel';
      $('engelBadge').className = 'badge badge-soft';
      $('engelText').textContent = ov.cycleAgg.expense > 0
        ? '餐饮占比 ' + engelPercent + '%，还在健康区间。囤一点食堂早餐券，能把这个数字再压下去。'
        : '本周期还没有支出记录，先记一笔试试？';
    }

    /* ---- 分类占比 ---- */
    renderDonut(ov);

    /* ---- 近 7 日趋势 ---- */
    renderTrend(ov);

    /* ---- 流水 ---- */
    renderBillList();

    /* ---- 成就 ---- */
    renderAchievement();
  }

  function donutSvgHtml(slices, size, strokeWidth, viewBoxSize) {
    var vb = viewBoxSize || 100;
    var cx = vb / 2;
    var cy = vb / 2;
    var r = (vb - strokeWidth) / 2;
    var c = 2 * Math.PI * r;
    var total = 0;
    var i;
    for (i = 0; i < slices.length; i++) { total += slices[i].value; }
    if (total <= 0) { return ''; }
    var parts = [];
    var offset = 0;
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" stroke="#EEF1F4" stroke-width="' + strokeWidth + '"></circle>');
    for (i = 0; i < slices.length; i++) {
      var len = slices[i].value / total * c;
      if (len <= 0) { continue; }
      var opacity = 1;
      if (highlightCategory && slices[i].key && slices[i].key !== highlightCategory) { opacity = 0.22; }
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" stroke="' + slices[i].color +
        '" stroke-width="' + strokeWidth + '" stroke-dasharray="' + len + ' ' + (c - len) +
        '" stroke-dashoffset="' + (-offset) + '" opacity="' + opacity + '"></circle>');
      offset += len;
    }
    return parts.join('');
  }

  function getCategorySlices(byCategory) {
    var slices = [];
    var i;
    for (i = 0; i < DATA.CATEGORIES.length; i++) {
      var key = DATA.CATEGORIES[i].key;
      var value = ENG.round2(byCategory[key] || 0);
      if (value > 0) {
        slices.push({ key: key, value: value, color: DATA.CATEGORIES[i].color });
      }
    }
    slices.sort(function (a, b) { return b.value - a.value; });
    return slices;
  }

  function renderDonut(ov) {
    var svg = $('donutChart');
    var legend = $('legendList');
    var slices = getCategorySlices(ov.cycleAgg.byCategory);
    var totalValue = ov.cycleAgg.expense;

    if (slices.length === 0) {
      svg.innerHTML = '<circle cx="80" cy="80" r="70" stroke="#EEF1F4" stroke-width="20"></circle>';
      $('donutTotal').textContent = money(0);
      legend.innerHTML = '<li class="empty">本周期还没有支出记录</li>';
      return;
    }

    svg.innerHTML = donutSvgHtml(slices, 160, 20, 160);
    $('donutTotal').textContent = money(totalValue);

    var html = '';
    var i;
    for (i = 0; i < slices.length; i++) {
      var pct = totalValue > 0 ? (slices[i].value / totalValue * 100) : 0;
      html += '<li data-cat="' + esc(slices[i].key) + '"' +
        (highlightCategory === slices[i].key ? ' class="active"' : '') + '>' +
        '<span class="dot" style="background:' + slices[i].color + '"></span>' +
        '<span class="lg-name">' + esc(slices[i].key) + '</span>' +
        '<span class="lg-amount">' + money(slices[i].value) + '</span>' +
        '<span class="lg-percent">' + pct.toFixed(0) + '%</span>' +
        '</li>';
    }
    legend.innerHTML = html;
  }

  function renderTrend(ov) {
    var svg = $('trendChart');
    var days = [];
    var i;
    var sum = 0;
    var max = 1;
    for (i = 6; i >= 0; i--) {
      var d = ENG.addDays(ov.today, -i);
      var ds = ENG.formatDate(d);
      var value = ENG.round2(ov.allAgg.dailyMap[ds] || 0);
      days.push({ date: ds, label: ds.slice(5), value: value, isToday: i === 0 });
      sum += value;
      if (value > max) { max = value; }
    }
    $('trendSum').textContent = '合计 ' + money(sum);

    var W = 320;
    var H = 150;
    var padL = 6;
    var padR = 6;
    var padT = 18;
    var padB = 24;
    var chartW = W - padL - padR;
    var chartH = H - padT - padB;
    var step = chartW / days.length;
    var barW = Math.min(20, step * 0.46);
    var scaleMax = max * 1.15;

    var parts = [];
    parts.push('<line x1="' + padL + '" y1="' + (padT + chartH) + '" x2="' + (W - padR) + '" y2="' + (padT + chartH) +
      '" stroke="#EEF1F4" stroke-width="1"></line>');

    for (i = 0; i < days.length; i++) {
      var day = days[i];
      var cx = padL + step * i + step / 2;
      var h = day.value > 0 ? Math.max(3, day.value / scaleMax * chartH) : 2;
      var y = padT + chartH - h;
      var color = day.isToday ? '#07C160' : '#D7DDE5';
      if (day.isToday && day.value > max * 0.6) { color = '#FF8A3D'; }
      parts.push('<rect x="' + (cx - barW / 2) + '" y="' + y + '" width="' + barW + '" height="' + h +
        '" rx="4" fill="' + color + '"></rect>');
      if (day.value > 0) {
        parts.push('<text x="' + cx + '" y="' + (y - 5) + '" text-anchor="middle" font-size="8.5" fill="#8A93A0">' +
          (day.value >= 1000 ? Math.round(day.value / 100) / 10 + 'k' : Math.round(day.value)) + '</text>');
      }
      parts.push('<text x="' + cx + '" y="' + (H - 7) + '" text-anchor="middle" font-size="9" fill="' +
        (day.isToday ? '#07C160' : '#A9B1BC') + '"' + (day.isToday ? ' font-weight="600"' : '') + '>' +
        (day.isToday ? '今天' : day.label) + '</text>');
    }
    svg.innerHTML = parts.join('');
  }

  function renderBillList() {
    var list = $('billList');
    var sorted = state.bills.slice().sort(function (a, b) {
      if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    var recent = sorted.slice(0, 8);
    if (recent.length === 0) {
      list.innerHTML = '<li class="empty">还没有账单，去左边说一句话吧</li>';
      return;
    }
    var html = '';
    var i;
    for (i = 0; i < recent.length; i++) {
      var b = recent[i];
      var isIncome = b.type === 'income';
      html += '<li class="bill-item">' +
        '<span class="bill-dot" style="background:' + (isIncome ? '#07C160' : categoryColor(b.category)) + '"></span>' +
        '<span class="bill-main">' +
        '<span class="bill-note">' + esc(b.note) + '</span>' +
        '<span class="bill-meta">' + esc(b.date) + ' · ' + esc(isIncome ? '收入' : b.category) + '</span>' +
        '</span>' +
        '<span class="bill-amount' + (isIncome ? ' income' : '') + '">' +
        (isIncome ? '+' : '-') + money(b.amount) + '</span>' +
        '</li>';
    }
    list.innerHTML = html;
  }

  function renderAchievement() {
    var box = $('achieveCard');
    box.innerHTML = '' +
      '<div class="card-head"><h3>我的成就</h3><span class="hint">一点一点攒出来的</span></div>' +
      '<div class="achieve-grid">' +
      '  <div><b>' + state.bills.length + '</b><small>累计记账笔数</small></div>' +
      '  <div><b>' + state.blockedCount + '</b><small>冷静期拦下</small></div>' +
      '  <div><b>' + money(state.savedMoney) + '</b><small>省下的钱</small></div>' +
      '</div>';
  }

  /* ================================================================== */
  /* 目标池                                                              */
  /* ================================================================== */

  function renderGoals() {
    var list = $('goalList');
    var ov = getOverview();
    if (state.goals.length === 0) {
      list.innerHTML = '<div class="empty">还没有目标，点右上角「+ 新目标」加一个吧</div>';
      return;
    }
    var html = '';
    var i;
    for (i = 0; i < state.goals.length; i++) {
      var g = state.goals[i];
      var p = ENG.getGoalProjection(g, ov.monthlySurplus, ov.today);
      var tip;
      var warnCls = '';
      if (p.need <= 0) {
        tip = '🎉 已达成目标，还多存了 ' + money(Math.max(0, g.saved - g.target)) + '。';
      } else if (p.monthsLeft === null) {
        tip = '当前月结余为负，先让结余转正，再谈攒钱。';
        warnCls = ' warn';
      } else {
        tip = '按当前速度还需约 ' + p.monthsLeft + ' 个月';
        if (p.monthsToDeadline !== null) {
          tip += '（距目标日还有 ' + p.monthsToDeadline + ' 个月）';
        }
        if (p.lateMonths !== null && p.lateMonths > 0) {
          tip += '，按当前速度会晚 ' + p.lateMonths + ' 个月，建议每月多存 ' + money(p.extraPerMonth) + '。';
          warnCls = ' warn';
        } else {
          tip += '，节奏刚好。';
        }
      }

      html += '<div class="goal-item">' +
        '<div class="goal-top">' +
        '<span class="goal-name">' + esc(g.name) + '</span>' +
        '<span class="goal-actions">' +
        '<button type="button" class="btn-mini" data-goal-add="' + esc(g.id) + '">+ 存钱</button>' +
        '<button type="button" class="goal-del" data-goal-del="' + esc(g.id) + '" title="删除目标">✕</button>' +
        '</span>' +
        '</div>' +
        '<div class="goal-bar"><i style="width:' + p.percent + '%"></i></div>' +
        '<div class="goal-meta">' +
        '<span><b>' + money(g.saved) + '</b> / ' + money(g.target) + '</span>' +
        '<span>' + p.percent.toFixed(1) + '%</span>' +
        '</div>' +
        '<div class="goal-tip' + warnCls + '">' + esc(tip) + '</div>' +
        '</div>';
    }
    list.innerHTML = html;
  }

  function findGoal(id) {
    var i;
    for (i = 0; i < state.goals.length; i++) {
      if (state.goals[i].id === id) { return state.goals[i]; }
    }
    return null;
  }

  /* ================================================================== */
  /* 弹窗                                                                */
  /* ================================================================== */

  function openModal(html) {
    var mask = $('modalMask');
    var box = $('modalBox');
    box.innerHTML = html;
    mask.hidden = false;
    return box;
  }

  function closeModal() {
    var mask = $('modalMask');
    var box = $('modalBox');
    mask.hidden = true;
    box.innerHTML = '';
  }

  function openGoalModal() {
    var todayStr = ENG.formatDate(new Date());
    var box = openModal('' +
      '<h4>新的理财目标</h4>' +
      '<p>给它一个名字，设定金额和日期，我帮你算每月该存多少。</p>' +
      '<label class="field"><span>目标名称</span><input id="gName" type="text" placeholder="例如：相机 / 旅行 / iPad" /></label>' +
      '<label class="field"><span>目标金额（¥）</span><input id="gTarget" type="number" min="1" step="10" inputmode="decimal" /></label>' +
      '<label class="field"><span>已攒金额（¥）</span><input id="gSaved" type="number" min="0" step="10" inputmode="decimal" value="0" /></label>' +
      '<label class="field"><span>目标日期</span><input id="gDeadline" type="date" min="' + todayStr + '" value="' + todayStr + '" /></label>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-ok" data-act="goal-save">保存</button>' +
      '</div>');

    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="goal-save"]').addEventListener('click', function () {
      var name = box.querySelector('#gName').value.trim();
      var target = Number(box.querySelector('#gTarget').value);
      var saved = Number(box.querySelector('#gSaved').value);
      var deadline = box.querySelector('#gDeadline').value;
      if (!name) {
        box.querySelector('#gName').focus();
        return;
      }
      if (!isFinite(target) || target <= 0) {
        box.querySelector('#gTarget').focus();
        return;
      }
      state.goals.push({
        id: uid('goal'),
        name: name,
        target: ENG.round2(target),
        saved: isFinite(saved) && saved > 0 ? ENG.round2(saved) : 0,
        deadline: /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : ''
      });
      saveState();
      closeModal();
      renderGoals();
      addAIMessage(aiBubble('目标「' + esc(name) + '」已建好，目标 ' + money(target) + '。我会在每个记账日帮你盯着进度。'));
    });
    var nameInput = box.querySelector('#gName');
    if (nameInput) { nameInput.focus(); }
  }

  function openDepositModal(goalId) {
    var goal = findGoal(goalId);
    if (!goal) { return; }
    var need = ENG.round2(Math.max(0, goal.target - goal.saved));
    var box = openModal('' +
      '<h4>给「' + esc(goal.name) + '」存一笔</h4>' +
      '<p>还差 ' + money(need) + ' 就能达成目标。</p>' +
      '<label class="field"><span>本次存入金额（¥）</span><input id="dAmount" type="number" min="1" step="10" inputmode="decimal" /></label>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-ok" data-act="deposit-save">存入</button>' +
      '</div>');

    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="deposit-save"]').addEventListener('click', function () {
      var amount = Number(box.querySelector('#dAmount').value);
      if (!isFinite(amount) || amount <= 0) {
        box.querySelector('#dAmount').focus();
        return;
      }
      goal.saved = ENG.round2(goal.saved + amount);
      saveState();
      closeModal();
      renderGoals();
      var left = ENG.round2(Math.max(0, goal.target - goal.saved));
      addAIMessage(aiBubble('已存入 ' + money(amount) + '，目标「' + esc(goal.name) + '」现在攒到 ' +
        money(goal.saved) + '，' + (left > 0 ? '还差 ' + money(left) + '。' : '已经达成啦 🎉')));
    });
    var input = box.querySelector('#dAmount');
    if (input) { input.focus(); }
  }

  function confirmReset() {
    var box = openModal('' +
      '<h4>重置演示数据？</h4>' +
      '<p>会清空当前所有账单、目标与成就，并重新灌入一套演示数据。此操作不可撤销。</p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-danger" data-act="reset-ok">确认重置</button>' +
      '</div>');
    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="reset-ok"]').addEventListener('click', function () {
      state = seedState();
      highlightCategory = null;
      saveState();
      closeModal();
      renderAll();
      addAIMessage(aiBubble('演示数据已经重置好了，账单、目标、成就都回到了初始状态。'));
    });
  }

  /* ================================================================== */
  /* 设置抽屉                                                            */
  /* ================================================================== */

  function openDrawer() {
    $('setTotal').value = String(state.budget.total);
    $('setPayday').value = String(state.budget.payday);
    $('setCooldown').value = String(state.budget.cooldownThreshold);
    renderCycleInfo();
    var cred = OCR.getCredentials();
    $('setOcrId').value = cred.secretId || '';
    $('setOcrKey').value = cred.secretKey || '';
    $('setOcrRegion').value = cred.region || 'ap-guangzhou';
    renderOcrState();
    var mask = $('drawerMask');
    mask.hidden = false;
    setTimeout(function () {
      mask.classList.add('show');
      $('settingsDrawer').classList.add('open');
      $('settingsDrawer').setAttribute('aria-hidden', 'false');
    }, 10);
  }

  /** 设置抽屉顶部的周期说明 */
  function renderCycleInfo() {
    var ov = getOverview();
    var el = $('cycleInfo');
    if (el) {
      el.textContent = '本周期：' + ov.cycle.start + ' ~ ' + ov.cycle.end +
        (ov.cycle.isCustom ? '（自定义起点）' : '（按发钱日 ' + state.budget.payday + ' 号）');
    }
    var resetBtn = $('btnCycleReset');
    if (resetBtn) {
      if (ov.cycle.isCustom) {
        resetBtn.removeAttribute('hidden');
      } else {
        resetBtn.setAttribute('hidden', 'hidden');
      }
    }
  }

  /** 云 OCR 凭据状态文案 */
  function renderOcrState() {
    var el = $('ocrState');
    if (!el) { return; }
    var cap = OCR.capabilities();
    el.textContent = cap.cloud
      ? '当前：已配置云 OCR（' + (OCR.getCredentials().region || 'ap-guangzhou') + '）'
      : '当前：未配置云 OCR（不会发网络请求）。不配置时，截屏识别只能用示例小票或手动录入。';
  }

  function saveOcrCredentials() {
    var id = String($('setOcrId').value || '').trim();
    var key = String($('setOcrKey').value || '').trim();
    var region = String($('setOcrRegion').value || '').trim() || 'ap-guangzhou';
    if (!id || !key) {
      $('ocrState').textContent = 'SecretId 与 SecretKey 都要填，否则云端识别不可用。';
      return;
    }
    var ok = OCR.saveCredentials({ secretId: id, secretKey: key, region: region });
    renderOcrState();
    if (!ok) {
      $('ocrState').textContent = '已存在内存里，但写入 localStorage 失败（可能是隐私模式），关掉页面就失效。';
    }
  }

  function clearOcrCredentials() {
    OCR.clearCredentials();
    $('setOcrId').value = '';
    $('setOcrKey').value = '';
    $('setOcrRegion').value = '';
    renderOcrState();
  }

  function closeDrawer() {
    var mask = $('drawerMask');
    mask.classList.remove('show');
    $('settingsDrawer').classList.remove('open');
    $('settingsDrawer').setAttribute('aria-hidden', 'true');
    setTimeout(function () { mask.hidden = true; }, 220);
  }

  function saveSettings() {
    var total = Number($('setTotal').value);
    var payday = Number($('setPayday').value);
    var cooldown = Number($('setCooldown').value);
    state.budget.total = clampNumber(total, 0, 9999999, state.budget.total);
    state.budget.payday = Math.round(clampNumber(payday, 1, 28, state.budget.payday));
    state.budget.cooldownThreshold = clampNumber(cooldown, 0, 9999999, state.budget.cooldownThreshold);
    saveState();
    closeDrawer();
    renderAll();
    var ov = getOverview();
    addAIMessage(aiBubble('设置已更新：生活费 ' + money(state.budget.total) + '，发钱日 ' +
      state.budget.payday + ' 号，冷静期阈值 ' + money(state.budget.cooldownThreshold) +
      '。当前周期 ' + esc(ov.cycle.start) + ' ~ ' + esc(ov.cycle.end) +
      (ov.cycle.isCustom ? '（自定义起点）' : '') + '，看板已重算。'));
  }

  /* ================================================================== */
  /* 快捷指令响应                                                        */
  /* ================================================================== */

  function showBalanceCard() {
    var ov = getOverview();
    var bs = ov.budgetState;
    var ratio = state.budget.total > 0 ? Math.max(0, Math.min(100, bs.remaining / state.budget.total * 100)) : 0;
    var barColor = bs.status === 'danger' ? '#EF5350' : (bs.status === 'tight' ? '#FF8A3D' : '#07C160');
    var html = '' +
      '<div class="bubble ai">帮你查了下这个周期（' + esc(ov.cycle.start) + ' ~ ' + esc(ov.cycle.end) + '）👇</div>' +
      '<div class="bill-card">' +
      '  <div class="bill-card-head"><span>周期剩余 / 总预算</span><span>还剩 ' + ov.cycle.remainingDays + ' 天</span></div>' +
      '  <div class="bill-card-main">' +
      '    <span class="bill-card-note">' + money(bs.remaining) + ' / ' + money(state.budget.total) + '</span>' +
      '  </div>' +
      '  <div class="engel-bar" style="margin-top:9px"><i style="width:' + ratio + '%;background:' + barColor + '"></i></div>' +
      '  <div class="bill-card-tags">' +
      '    <span class="tag green">日均可用 ' + money(bs.dailyAllowance) + '</span>' +
      '    <span class="tag">今日已花 ' + money(bs.todaySpent) + '</span>' +
      '    <span class="tag">今天还能花 ' + money(bs.todayRemain) + '</span>' +
      '  </div>' +
      '</div>';
    addAIMessage(html);
    addAIMessage(aiBubble(ov.sentence));
  }

  function showPieCard() {
    var ov = getOverview();
    var slices = getCategorySlices(ov.cycleAgg.byCategory);
    if (slices.length === 0) {
      addAIMessage(aiBubble('本周期还没记账呢，先记一笔我就能画饼图了。'));
      return;
    }
    var svg = '<svg viewBox="0 0 100 100">' +
      '<g transform="rotate(-90 50 50)">' + donutSvgHtml(slices, 100, 20, 100) + '</g></svg>';
    var legend = '';
    var i;
    for (i = 0; i < slices.length && i < 6; i++) {
      var pct = ov.cycleAgg.expense > 0 ? (slices[i].value / ov.cycleAgg.expense * 100) : 0;
      legend += '<div><i style="background:' + slices[i].color + '"></i>' + esc(slices[i].key) +
        ' ' + money(slices[i].value) + '（' + pct.toFixed(0) + '%）</div>';
    }
    var html = '<div class="mini-pie">' + svg + '<div class="mini-pie-legend">' + legend + '</div></div>';
    addAIMessage(html);

    var top = slices[0];
    var topPct = ov.cycleAgg.expense > 0 ? (top.value / ov.cycleAgg.expense * 100) : 0;
    addAIMessage(aiBubble('本周期一共花了 ' + money(ov.cycleAgg.expense) + '，最大头是 <span class="hl">' +
      esc(top.key) + '</span>（' + money(top.value) + '，占 ' + topPct.toFixed(0) + '%）。' +
      (ov.engel.alert ? '餐饮占比偏高，注意别把社交预算吃掉。' : '结构还算健康。')));
  }

  function showEntryGuide() {
    var html = '' +
      '<div class="bubble ai">直接说一句话就行，比如这几句 👇</div>' +
      '<div class="msg-actions">' +
      '  <button type="button" class="btn-mini" data-cmd="午饭食堂 15">午饭食堂 15</button>' +
      '  <button type="button" class="btn-mini" data-cmd="昨天打车15，奶茶12">昨天打车15，奶茶12</button>' +
      '  <button type="button" class="btn-mini" data-cmd="买了杯星巴克32">买了杯星巴克32</button>' +
      '</div>';
    addAIMessage(html);
  }

  function showParseFailure(text) {
    var html = '' +
      '<div class="bubble ai">我没听清金额，换个说法？比如「午饭食堂 15」。</div>' +
      '<div class="msg-actions">' +
      '  <button type="button" class="btn-mini" data-cmd="午饭食堂 15">午饭食堂 15</button>' +
      '  <button type="button" class="btn-mini" data-cmd="昨天打车 15">昨天打车 15</button>' +
      '  <button type="button" class="btn-mini" data-cmd="游戏皮肤 99">游戏皮肤 99</button>' +
      '</div>';
    addAIMessage(html);
    var hint = String(text || '').trim();
    if (hint) {
      addAIMessage(aiBubble('（你刚才说的是「' + esc(hint) + '」，我在里面没找到金额。）'));
    }
  }

  function showGoalGuide() {
    addAIMessage(aiBubble('想攒钱买点什么？点下面按钮填一下，我帮你算每月该存多少。'));
    openGoalModal();
  }

  /* ================================================================== */
  /* 收入录入 & 周期重置                                                 */
  /* ================================================================== */

  /** 按 id 找账单 */
  function billById(id) {
    var i;
    for (i = 0; i < state.bills.length; i++) {
      if (state.bills[i].id === id) { return state.bills[i]; }
    }
    return null;
  }

  /** 记收入表单 */
  function openIncomeModal() {
    var todayStr = ENG.formatDate(new Date());
    var radios = '';
    var i;
    for (i = 0; i < DATA.INCOME_SOURCES.length; i++) {
      var s = DATA.INCOME_SOURCES[i];
      radios += '<label class="radio-item">' +
        '<input type="radio" name="incomeSource" value="' + esc(s) + '"' + (i === 0 ? ' checked' : '') + ' />' +
        '<span>' + esc(s) + '</span>' +
        '</label>';
    }

    var box = openModal('' +
      '<h4>记一笔收入</h4>' +
      '<p>生活费、兼职、奖学金都记在这里，不会算进支出统计。</p>' +
      '<label class="field"><span>金额（¥）</span>' +
      '<input data-field="amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="例如 2000" /></label>' +
      '<div class="field"><span>来源</span><div class="radio-group">' + radios + '</div></div>' +
      '<label class="field"><span>日期</span>' +
      '<input data-field="date" type="date" max="' + todayStr + '" value="' + todayStr + '" /></label>' +
      '<label class="field"><span>备注（可选）</span>' +
      '<input data-field="note" type="text" placeholder="例如 10 月生活费" /></label>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-ok" data-act="income-save">确认入账</button>' +
      '</div>');

    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="income-save"]').addEventListener('click', function () {
      var amountInput = box.querySelector('[data-field="amount"]');
      var amount = Number(amountInput.value);
      if (!isFinite(amount) || amount <= 0) {
        amountInput.focus();
        return;
      }
      var checked = box.querySelector('input[name="incomeSource"]:checked');
      var source = checked ? checked.value : '其他';
      var date = box.querySelector('[data-field="date"]').value;
      var note = box.querySelector('[data-field="note"]').value.trim();
      closeModal();
      switchView('chat');
      startFlow([{
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayStr,
        amount: ENG.round2(amount),
        category: DATA.INCOME_CATEGORY,
        source: source,
        note: note || (source + '到账'),
        motivation: '刚需',
        want: false,
        type: 'income'
      }]);
    });

    var focusInput = box.querySelector('[data-field="amount"]');
    if (focusInput) { focusInput.focus(); }
  }

  /**
   * 是否要追问「这笔是新的生活费到账吗」。
   * 条件：收入 && 金额 ≥ 300 &&（来源是生活费 或 备注含 生活费/到账/打钱/给我转）
   * 且同一笔只问一次（askedCycle）。
   */
  function shouldAskCycleReset(bill) {
    if (!bill || bill.type !== 'income') { return false; }
    if (bill.askedCycle) { return false; }
    if (Number(bill.amount) < 300) { return false; }
    var note = String(bill.note || '');
    if (bill.source === '生活费') { return true; }
    return /生活费|到账|打钱|给我转/.test(note);
  }

  /** 入账后追问（大白话），同一笔只问一次 */
  function maybeAskCycleReset(bill) {
    if (!shouldAskCycleReset(bill)) { return; }
    bill.askedCycle = true;
    saveState();

    var html = '' +
      '<div class="ask-card" data-bill="' + esc(bill.id) + '">' +
      '  <div class="ask-title">这笔 ' + money(bill.amount) + ' 是新的生活费到账吗？</div>' +
      '  <div class="ask-text">要不要<b>从现在起重新算一个周期</b>？（就是把预算也换成这笔钱，日均重新算一遍）</div>' +
      '  <div class="ask-actions">' +
      '    <button type="button" class="btn-mini primary" data-act="cycle-yes" data-bill="' + esc(bill.id) + '">要，从现在重新算</button>' +
      '    <button type="button" class="btn-mini" data-act="cycle-no" data-bill="' + esc(bill.id) + '">不用，只记这一笔</button>' +
      '  </div>' +
      '</div>';
    addAIMessage(aiBubble('🤔 多问一句：') + html);
  }

  /**
   * 处理「重新算周期 / 只记流水」。
   * @param {string} billId
   * @param {boolean} yes
   */
  function resolveCycleReset(billId, yes) {
    var bill = billById(billId);
    if (!bill) { return; }
    if (!yes) {
      addAIMessage(aiBubble('行，这笔只当流水记着，预算没动。'));
      return;
    }
    var todayStr = ENG.formatDate(new Date());
    // 起点不能晚于今天，否则 getCycle 会忽略（回退发钱日）
    var start = bill.date > todayStr ? todayStr : bill.date;
    state.budget.cycleStart = start;
    state.budget.total = ENG.round2(bill.amount);
    saveState();
    var ov = getOverview();
    renderAll();
    addAIMessage(aiBubble('好，新一轮开始：' + money(state.budget.total) + ' 从 ' +
      esc(ov.cycle.start) + ' 用到 ' + esc(ov.cycle.end) + '，还有 ' + ov.cycle.remainingDays +
      ' 天，日均 ' + money(ov.budgetState.dailyAllowance) + '。'));
  }

  /** 恢复按发钱日推算 */
  function restorePaydayCycle() {
    state.budget.cycleStart = '';
    saveState();
    renderAll();
    renderCycleInfo();
    var ov = getOverview();
    addAIMessage(aiBubble('已经恢复按发钱日 ' + state.budget.payday + ' 号算周期：' +
      esc(ov.cycle.start) + ' ~ ' + esc(ov.cycle.end) + '，还剩 ' + ov.cycle.remainingDays + ' 天。'));
  }

  /* ================================================================== */
  /* 账单分析                                                            */
  /* ================================================================== */

  function openAnalysisSheet() {
    $('analysisMask').hidden = false;
    renderAnalysis();
  }

  function closeAnalysisSheet() {
    $('analysisMask').hidden = true;
  }

  /** 把文件读成 ArrayBuffer 再交给 analysis.parseFile（解码在纯函数里完成） */
  function handleAnalysisFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (files.length === 0) { return; }
    var metas = [];
    var pending = files.length;
    var statusEl = $('analysisStatus');
    if (statusEl) { statusEl.textContent = '正在解析 ' + files.length + ' 个文件…'; }

    function done() {
      pending -= 1;
      if (pending > 0) { return; }
      var built = ANA.buildRows(metas);
      var monthCount = {};
      var i;
      for (i = 0; i < built.rows.length; i++) {
        var mk = built.rows[i].month || built.rows[i].date.slice(0, 7);
        monthCount[mk] = (monthCount[mk] || 0) + 1;
      }
      var monthList = Object.keys(monthCount).sort();
      // 默认看「记录最多的那个月」（平手取较新的月份），避免默认落到只有 1 条记录的月份
      var month = monthList.length > 0 ? monthList[monthList.length - 1] : ENG.formatDate(new Date()).slice(0, 7);
      var bestCount = -1;
      for (i = 0; i < monthList.length; i++) {
        if (monthCount[monthList[i]] >= bestCount) {
          bestCount = monthCount[monthList[i]];
          month = monthList[i];
        }
      }
      analysisData = {
        rows: built.rows,
        files: built.files,
        duplicates: built.duplicates,
        months: monthList,
        month: month
      };
      renderAnalysis();
    }

    files.forEach(function (file, index) {
      var reader = new FileReader();
      reader.onload = function () {
        var parsed;
        try {
          parsed = ANA.parseFile({ name: file.name, bytes: reader.result });
        } catch (e) {
          parsed = { name: file.name, ok: false, reason: '解析失败：' + (e && e.message ? e.message : '未知错误'), records: [], skipped: 0 };
        }
        metas[index] = parsed;
        done();
      };
      reader.onerror = function () {
        metas[index] = { name: file.name, ok: false, reason: '读取文件失败', records: [], skipped: 0 };
        done();
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /** 折叠区块 */
  function reportSection(title, inner, open) {
    return '<details class="report-sec"' + (open ? ' open' : '') + '>' +
      '<summary>' + title + '</summary>' +
      '<div class="sec-body">' + inner + '</div>' +
      '</details>';
  }

  function emptyLine(text) {
    return '<div class="sec-empty">' + esc(text) + '</div>';
  }

  function barHtml(label, value, max, color) {
    var pct = max > 0 ? Math.max(2, value / max * 100) : 0;
    return '<div class="bar-row">' +
      '<span class="bar-label">' + esc(label) + '</span>' +
      '<span class="bar-track"><i style="width:' + pct.toFixed(1) + '%;background:' + color + '"></i></span>' +
      '<span class="bar-value">' + money(value) + '</span>' +
      '</div>';
  }

  /** 渲染整个分析 sheet */
  function renderAnalysis() {
    var reportEl = $('analysisReport');
    var statusEl = $('analysisStatus');
    var toolbar = $('analysisToolbar');
    if (!reportEl) { return; }

    if (!analysisData || !analysisData.rows || analysisData.rows.length === 0) {
      reportEl.innerHTML = '';
      if (statusEl) {
        var failLines = '';
        if (analysisData && analysisData.files) {
          var bad = analysisData.files.filter(function (f) { return !f.ok; });
          if (bad.length > 0) {
            failLines = bad.map(function (f) { return f.name + '：' + (f.reason || '解析失败'); }).join('；');
          }
        }
        statusEl.textContent = failLines
          ? '没有解析出有效记录。' + failLines
          : '还没有导入文件。导出账单时请选择「CSV」，不要用 PDF。';
      }
      if (toolbar) { toolbar.hidden = true; }
      return;
    }

    if (toolbar) { toolbar.hidden = false; }
    var excludeDup = !!($('analysisExcludeDup') && $('analysisExcludeDup').checked);
    var rep = ANA.report(analysisData.rows, {
      month: analysisData.month,
      excludeDuplicates: excludeDup,
      files: analysisData.files
    });
    analysisData.report = rep;

    if (statusEl) {
      var okCount = analysisData.files.filter(function (f) { return f.ok; }).length;
      var extraNotes = [];
      if (rep.parseInfo.excludedTransfer > 0) {
        extraNotes.push(rep.parseInfo.excludedTransfer + ' 条转账/还款不计入统计');
      }
      if (rep.parseInfo.excludedDuplicate > 0) {
        extraNotes.push(rep.parseInfo.excludedDuplicate + ' 条疑似重复' +
          (excludeDup ? '已排除' : '仅标记未排除'));
      }
      var statusText = '已解析 ' + okCount + ' / ' + analysisData.files.length + ' 个文件，' +
        rep.meta.validCount + ' 条有效记录' +
        (extraNotes.length ? '（另有 ' + extraNotes.join('、') + '）' : '') +
        '。';
      if (rep.parseInfo.transferIncomeCount > 0) {
        statusText += '其中 ' + rep.parseInfo.transferIncomeCount +
          ' 条为转账型收入，已计入；若为本人账户互转请手动排除。';
      }
      statusEl.textContent = statusText + '数据只在本机，没有上传。';
    }

    var ov = rep.overview;
    var monthOptions = (analysisData.months || [ov.month]).map(function (m) {
      return '<option value="' + esc(m) + '"' + (m === ov.month ? ' selected' : '') + '>' + esc(m) + '</option>';
    }).join('');

    var hintEl = $('analysisMonthHint');
    if (hintEl) {
      hintEl.textContent = '统计月份 ' + ov.month + ' · 与上月 ' + ov.prevMonth + ' 对比';
    }

    var html = '<div class="report-top">' +
      '<label class="month-pick">统计月份 <select data-act="analysis-month">' + monthOptions + '</select></label>' +
      '<span class="hint">共 ' + rep.meta.rowCount + ' 条原始记录</span>' +
      '</div>';

    /* ---- 建议 ---- */
    var budgetState = ENG.getBudgetState({
      total: state.budget.total,
      spent: ov.expense,
      remainingDays: getOverview().cycle.remainingDays,
      todaySpent: 0
    });
    var insightList = ANA.insights(rep, budgetState);
    if (insightList.length > 0) {
      html += '<div class="insight-box"><div class="insight-title">给你的 ' + insightList.length + ' 条建议</div>';
      insightList.forEach(function (it) {
        html += '<div class="insight-item ' + (it.level === 'warn' ? 'warn' : 'tip') + '">' +
          '<div class="insight-head">' + (it.level === 'warn' ? '⚠️ ' : '💡 ') + esc(it.title) + '</div>' +
          '<div class="insight-evidence">' + esc(it.evidence) + '</div>' +
          '<div class="insight-action">' + esc(it.action) + '</div>' +
          '</div>';
      });
      html += '</div>';
    }

    /* ---- 1. 总览 ---- */
    var prevText = '—';
    if (ov.hasPrev) {
      prevText = ov.expenseDeltaPercent === null
        ? '—'
        : (ov.expenseDeltaPercent >= 0 ? '+' : '') + ov.expenseDeltaPercent.toFixed(1) + '%';
    }
    html += reportSection('1. 总览', '' +
      '<div class="stat-grid">' +
      '  <div><b>' + money(ov.expense) + '</b><small>总支出</small></div>' +
      '  <div><b class="pos">' + money(ov.income) + '</b><small>总收入</small></div>' +
      '  <div><b class="' + (ov.balance < 0 ? 'neg' : '') + '">' + money(ov.balance) + '</b><small>结余</small></div>' +
      '  <div><b>' + ov.count + '</b><small>支出笔数</small></div>' +
      '</div>' +
      '<div class="kv-list">' +
      '  <div class="kv"><span>笔均</span><b>' + money(ov.avgPerTx) + '</b></div>' +
      '  <div class="kv"><span>日均（' + ov.activeDays + ' 个有记录的天）</span><b>' + money(ov.avgPerDay) + '</b></div>' +
      '  <div class="kv"><span>与上月（' + ov.prevMonth + '）支出对比</span><b>' + prevText + '</b></div>' +
      '  <div class="kv"><span>储蓄率</span><b>' + (ov.savingsRate === null ? '—' : ov.savingsRate.toFixed(1) + '%') + '</b></div>' +
      '</div>', true);

    /* ---- 2. 分类占比与环比 ---- */
    var cats = rep.categories || [];
    var catBody = '';
    if (cats.length === 0) {
      catBody = emptyLine('本月没有支出记录');
    } else {
      var maxCat = cats[0].amount;
      var i;
      for (i = 0; i < cats.length; i++) {
        var c = cats[i];
        catBody += barHtml(c.category, c.amount, maxCat, categoryColor(c.category));
      }
      catBody += '<table class="report-table"><thead><tr>' +
        '<th>分类</th><th>金额</th><th>占比</th><th>笔数</th><th>笔均</th><th>环比</th>' +
        '</tr></thead><tbody>';
      for (i = 0; i < cats.length; i++) {
        var cc = cats[i];
        catBody += '<tr><td>' + esc(cc.category) + '</td>' +
          '<td>' + money(cc.amount) + '</td>' +
          '<td>' + cc.percent.toFixed(1) + '%</td>' +
          '<td>' + cc.count + '</td>' +
          '<td>' + money(cc.avg) + '</td>' +
          '<td class="' + (cc.deltaPercent === null ? '' : (cc.deltaPercent > 0 ? 'neg' : 'pos')) + '">' +
          (cc.deltaPercent === null ? '—' : (cc.deltaPercent >= 0 ? '+' : '') + cc.deltaPercent.toFixed(1) + '%') +
          '</td></tr>';
      }
      catBody += '</tbody></table>';
    }
    html += reportSection('2. 分类占比与环比', catBody, true);

    /* ---- 3. Top 10 单笔大额 ---- */
    var topBody = '';
    if (rep.topExpenses.length === 0) {
      topBody = emptyLine('本月没有支出记录');
    } else {
      topBody = '<table class="report-table"><thead><tr><th>日期</th><th>对方</th><th>说明</th><th>金额</th></tr></thead><tbody>';
      rep.topExpenses.forEach(function (x) {
        topBody += '<tr><td>' + esc(x.date) + '</td>' +
          '<td>' + esc(x.counterparty || '—') + '</td>' +
          '<td>' + esc(x.desc || '—') + '</td>' +
          '<td>' + money(x.amount) + '</td></tr>';
      });
      topBody += '</tbody></table>';
    }
    html += reportSection('3. Top 10 单笔大额', topBody, false);

    /* ---- 4. Top 10 高频商户 ---- */
    var merBody = '';
    if (rep.topMerchants.length === 0) {
      merBody = emptyLine('没有可统计的商户');
    } else {
      merBody = '<table class="report-table"><thead><tr><th>商户</th><th>笔数</th><th>金额</th><th>笔均</th></tr></thead><tbody>';
      rep.topMerchants.forEach(function (x) {
        merBody += '<tr><td>' + esc(x.name) + '</td><td>' + x.count + '</td>' +
          '<td>' + money(x.amount) + '</td><td>' + money(x.avg) + '</td></tr>';
      });
      merBody += '</tbody></table>';
    }
    html += reportSection('4. Top 10 高频商户', merBody, false);

    /* ---- 5. 周末 vs 工作日 ---- */
    var wv = rep.weekendVsWeekday;
    html += reportSection('5. 周末 vs 工作日', '' +
      '<table class="report-table"><thead><tr><th>口径</th><th>笔数</th><th>合计</th><th>天数</th><th>日均</th></tr></thead><tbody>' +
      '<tr><td>周末</td><td>' + wv.weekend.count + '</td><td>' + money(wv.weekend.amount) +
      '</td><td>' + wv.weekend.days + '</td><td><b>' + money(wv.weekend.avg) + '</b></td></tr>' +
      '<tr><td>工作日</td><td>' + wv.weekday.count + '</td><td>' + money(wv.weekday.amount) +
      '</td><td>' + wv.weekday.days + '</td><td><b>' + money(wv.weekday.avg) + '</b></td></tr>' +
      '</tbody></table>' +
      '<div class="sec-note">周末日均 / 工作日日均 = ' +
      (wv.ratio === null ? '—' : wv.ratio.toFixed(2) + ' 倍') + '（比的是日均，不是总额）</div>', false);

    /* ---- 6. 订阅型支出 ---- */
    var subBody = '';
    if (rep.subscriptions.length === 0) {
      subBody = emptyLine('未发现连续 3 个月「同商户 + 同金额」的固定扣款');
    } else {
      subBody = '<table class="report-table"><thead><tr><th>商户</th><th>月扣</th><th>连续月数</th><th>本月仍在扣</th><th>折合一年</th></tr></thead><tbody>';
      rep.subscriptions.forEach(function (s) {
        subBody += '<tr><td>' + esc(s.name) + '</td><td>' + money(s.amount) + '</td>' +
          '<td>' + s.months + '</td><td>' + (s.activeThisMonth ? '是' : '否') + '</td>' +
          '<td>' + money(s.annual) + '</td></tr>';
      });
      subBody += '</tbody></table>';
    }
    html += reportSection('6. 订阅型支出', subBody, false);

    /* ---- 7. 异常大额 ---- */
    var anomBody = '';
    if (rep.anomalies.length === 0) {
      anomBody = emptyLine('没有单笔超过该分类笔均 3 倍的支出');
    } else {
      anomBody = '<table class="report-table"><thead><tr><th>日期</th><th>对方</th><th>分类</th><th>金额</th><th>其余笔均</th><th>倍数</th></tr></thead><tbody>';
      rep.anomalies.forEach(function (a) {
        anomBody += '<tr><td>' + esc(a.date) + '</td><td>' + esc(a.counterparty || '—') + '</td>' +
          '<td>' + esc(a.category) + '</td><td>' + money(a.amount) + '</td>' +
          '<td>' + money(a.othersAvg) + '</td><td>' + a.times.toFixed(1) + '×</td></tr>';
      });
      anomBody += '</tbody></table>';
    }
    html += reportSection('7. 异常大额', anomBody, false);

    /* ---- 8. 疑似重复 ---- */
    var dupBody = '';
    if (rep.duplicates.length === 0) {
      dupBody = emptyLine('未发现同日期 + 同金额 + 同对方的重复记录');
    } else {
      dupBody = '<div class="sec-note">共 ' + rep.duplicates.length + ' 组疑似重复，默认只标记不删除；勾选上方开关可排除后重新统计。</div>';
      rep.duplicates.forEach(function (g) {
        dupBody += '<div class="dup-item"><b>' + esc(g.date) + '　' + money(g.amount) + '　' +
          esc(g.counterparty || '—') + '</b><ul>';
        g.items.forEach(function (it) {
          dupBody += '<li>' + esc(it.file) + ' 第 ' + it.row + ' 行：' + esc(it.desc || '—') + '</li>';
        });
        dupBody += '</ul></div>';
      });
    }
    html += reportSection('8. 疑似重复', dupBody, false);

    /* ---- 9. 解析情况 ---- */
    var fileBody = '<table class="report-table"><thead><tr><th>文件</th><th>编码</th><th>表头行</th><th>有效</th><th>前置说明行</th><th>无效数据行</th><th>列映射</th></tr></thead><tbody>';
    rep.parseInfo.files.forEach(function (f) {
      fileBody += '<tr><td>' + esc(f.name) + '</td><td>' + esc(f.encoding || '—') + '</td>' +
        '<td>' + (f.headerRow || '—') + '</td><td>' + f.records + '</td>' +
        '<td>' + (f.skippedBefore || 0) + '</td><td>' + (f.skipped || 0) + '</td>' +
        '<td class="col-map">' + esc(ANA.columnMapText(f.columns, true)) + '</td></tr>';
    });
    fileBody += '</tbody></table>';
    if (rep.parseInfo.files.some(function (f) { return !f.ok; })) {
      fileBody += '<div class="sec-note warn-text">未解析成功的文件：' +
        rep.parseInfo.files.filter(function (f) { return !f.ok; })
          .map(function (f) { return esc(f.name + '（' + (f.reason || '未知原因') + '）'); }).join('、') + '</div>';
    }
    html += reportSection('9. 解析情况', fileBody, false);

    reportEl.innerHTML = html;
  }

  /** 导出分析报告 Markdown */
  function exportAnalysisMarkdown() {
    if (!analysisData || !analysisData.report) {
      addAIMessage(aiBubble('还没有可以导出的分析结果，先导入一份账单 CSV 吧。'));
      return;
    }
    var text = ANA.toMarkdown(analysisData.report);
    downloadText('账单分析_' + (analysisData.report.overview.month || 'report') + '.md', text, 'text/markdown;charset=utf-8');
  }

  /** 把导入记录并入账本（二次确认） */
  function confirmImportAnalysis() {
    if (!analysisData || !analysisData.rows || analysisData.rows.length === 0) {
      addAIMessage(aiBubble('还没有可并入的导入记录。'));
      return;
    }
    var excludeDup = !!($('analysisExcludeDup') && $('analysisExcludeDup').checked);
    var drafts = ANA.rowsToBills(analysisData.rows, {
      month: analysisData.month,
      excludeDuplicates: excludeDup
    });
    if (drafts.length === 0) {
      addAIMessage(aiBubble('这个月没有可并入的支出/收入记录。'));
      return;
    }
    var box = openModal('' +
      '<h4>把 ' + drafts.length + ' 条记录并入账本？</h4>' +
      '<p><b>这会让本周期预算统计发生变化</b>：并入的支出会立刻占用预算额度，日均可用会重新计算。</p>' +
      '<p>只并入 ' + esc(analysisData.month) + ' 的记录，转账 / 还款类已在导入时排除。此操作不会自动去重，重复导入会产生重复账单。</p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">再想想</button>' +
      '<button type="button" class="btn-ok" data-act="import-ok">确认并入</button>' +
      '</div>');
    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="import-ok"]').addEventListener('click', function () {
      var i;
      var count = 0;
      for (i = 0; i < drafts.length; i++) {
        commitBill(drafts[i]);
        count += 1;
      }
      closeModal();
      renderAll();
      closeAnalysisSheet();
      addAIMessage(aiBubble('已把 ' + count + ' 条记录并入账本（' + esc(analysisData.month) +
        '），预算统计已重新计算。如果数字不对，可以用「重置演示数据」回到初始状态。'));
    });
  }

  /** 清空导入（只清分析缓存，不动账本） */
  function clearAnalysis() {
    analysisData = null;
    var statusEl = $('analysisStatus');
    if (statusEl) { statusEl.textContent = '还没有导入文件。导出账单时请选择「CSV」，不要用 PDF。'; }
    var fileInput = $('analysisFile');
    if (fileInput) { fileInput.value = ''; }
    var toolbar = $('analysisToolbar');
    if (toolbar) { toolbar.hidden = true; }
    var reportEl = $('analysisReport');
    if (reportEl) { reportEl.innerHTML = ''; }
  }

  /* ================================================================== */
  /* 截屏记账（三层降级）                                                */
  /* ================================================================== */

  var ocrPendingFile = null;
  var ocrDemoIndex = -1;
  /** 演示结果与用户图片并存时置 true：禁止预览图再被"读图完成"回调重新显示 */
  var ocrPreviewSuppressed = false;

  function ocrSourceText(source) {
    if (source === 'native') { return '本地识别（零网络）'; }
    if (source === 'cloud') { return '云端 OCR'; }
    if (source === 'demo') { return '演示样例'; }
    return '未知来源';
  }

  /**
   * 打开弹窗时就把「这台设备能做什么」说清楚，别让用户点了「开始识别」才发现不行。
   * @return {string}
   */
  function refreshBackendCaps() {
    if (typeof global.fetch !== 'function' || !global.AJ_BACKEND_OCR) { return; }
    global.fetch('/api/capabilities', { method: 'POST' }).then(function (r) {
      return r.json();
    }).then(function (j) {
      if (!j || typeof j !== 'object') { return; }
      backendCaps.ready = true;
      backendCaps.chat = !!j.chat;
      backendCaps.ocr = j.ocr || 'none';
      /* 若 OCR 弹窗正开着，能力变化后刷新提示与按钮状态 */
      if ($('ocrMask') && !$('ocrMask').hidden) {
        $('ocrStatus').className = ocrCapabilityClass();
        $('ocrStatus').textContent = ocrCapabilityText();
      }
    }).catch(function () { /* 后端不可达（如 file:// 直接打开）：维持本地判断 */ });
  }

  function ocrCapabilityText() {
    var cap = OCR.capabilities();
    if (cap.native) { return '可以离线识别：这台设备支持本地文字识别，截图不会离开这台设备。'; }
    if (backendCaps.ready && backendCaps.ocr === 'tencent') {
      return '将用后端云识别（腾讯云，需要联网）：截图会发给服务端识别。';
    }
    if (backendCaps.ready && backendCaps.ocr === 'vision') {
      return '将用后端视觉大模型识别（需要联网）：截图会发给已配置的 LLM 识别，金额/分类仍需你确认。';
    }
    if (cap.cloud) { return '将用云端识别（需要联网）：会调用已配置的云 OCR，图片会上传。'; }
    return '当前只能用示例小票或手动录入：这台设备不支持离线识别，后端也没配置可用的识别服务（在 .env 配置 LLM_API_KEY 或腾讯云 OCR 即可开启）。';
  }

  /** 能力不足时状态行用警示色，避免用户以为"点一下就好" */
  function ocrCapabilityClass() {
    var cap = OCR.capabilities();
    var backendOk = backendCaps.ready && backendCaps.ocr !== 'none';
    return (cap.native || cap.cloud || backendOk) ? 'ocr-status' : 'ocr-status warn';
  }

  /**
   * 把 detect() 内部（面向开发）的 reason 翻译成人话，只影响展示层。
   * 典型场景：显式 native / cloud 模式失败时会把底层 reason 直接冒到 UI 上。
   * @param {string} reason
   * @return {string}
   */
  function humanizeOcrReason(reason) {
    var s = String(reason === undefined || reason === null ? '' : reason);
    if (!s) { return '识别没有成功，可以直接手动录入。'; }
    var pairs = [
      [/当前浏览器不支持本地文字识别（TextDetector）/g, '这台设备的浏览器不支持离线识别文字'],
      [/当前浏览器不支持本地文字识别\(TextDetector\)/g, '这台设备的浏览器不支持离线识别文字'],
      [/无法读取图片（需要可用的图片文件）/g, '没能读到这张图片，请重新选一张截图'],
      [/本地识别没有读到文字/g, '这台设备的本地识别没有从图片里读到文字（图片可能太模糊、字太小）'],
      [/本地识别没有返回结果/g, '这台设备的本地识别没有返回结果'],
      [/还没有配置云 OCR 凭据/g, '还没有配置云 OCR'],
      [/当前浏览器不支持 Web Crypto，无法签名/g, '这台设备的浏览器缺少云 OCR 需要的加密能力'],
      [/当前环境不支持网络请求/g, '这台设备当前不允许发起网络请求']
    ];
    var i;
    for (i = 0; i < pairs.length; i++) {
      s = s.replace(pairs[i][0], pairs[i][1]);
    }
    return s;
  }

  function renderOcrSamples() {
    var host = $('ocrDemoList');
    if (!host) { return; }
    var html = '<span class="ocr-demo-label">演示样例：</span>';
    OCR.SAMPLES.forEach(function (s, i) {
      html += '<button type="button" class="chip" data-act="ocr-sample" data-index="' + i + '">' +
        esc(s.title) + '</button>';
    });
    host.innerHTML = html;
  }

  function openOcrModal() {
    ocrPendingFile = null;
    ocrImageDataUrl = '';
    ocrDraft = null;
    ocrDemoIndex = -1;
    ocrPreviewSuppressed = false;
    $('ocrMask').hidden = false;
    var preview = $('ocrPreview');
    preview.hidden = true;
    preview.removeAttribute('src');
    $('ocrResult').innerHTML = '';
    $('ocrStatus').className = ocrCapabilityClass();
    $('ocrStatus').textContent = ocrCapabilityText();
    var fileInput = $('ocrFile');
    if (fileInput) { fileInput.value = ''; }
    renderOcrSamples();
    var runBtn = $('btnOcrRun');
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '开始识别'; }
  }

  function closeOcrModal() {
    $('ocrMask').hidden = true;
    ocrPendingFile = null;
    ocrImageDataUrl = '';
    ocrDraft = null;
    ocrPreviewSuppressed = false;
  }

  function handleOcrFile(file) {
    if (!file) { return; }
    if (String(file.type || '').indexOf('image') === -1) {
      $('ocrStatus').textContent = '这个文件不是图片，请选择截图（png / jpg）。';
      return;
    }
    ocrPendingFile = file;
    ocrDemoIndex = -1;
    ocrPreviewSuppressed = false;
    /* 换了新图：清掉上一次的结果卡，避免"旧结果（可能是示例）"和新图片同时在场 */
    $('ocrResult').innerHTML = '';
    var reader = new FileReader();
    reader.onload = function () {
      ocrImageDataUrl = String(reader.result || '');
      var preview = $('ocrPreview');
      preview.src = ocrImageDataUrl;
      preview.hidden = ocrPreviewSuppressed;
      var cap = OCR.capabilities();
      var backendOk = backendCaps.ready && backendCaps.ocr !== 'none';
      var canOcr = cap.native || cap.cloud || backendOk;
      $('ocrStatus').className = ocrCapabilityClass();
      $('ocrStatus').textContent = canOcr
        ? '图片已就绪，点「开始识别」。'
        : '图片已就绪，但这台设备/后端都没有可用的文字识别能力 —— 你可以直接用示例小票演示或手动录入。';
    };
    reader.onerror = function () {
      $('ocrStatus').textContent = '读取图片失败，请重新选择。';
    };
    reader.readAsDataURL(file);
  }

  /**
   * 失败原因归到哪一层：读不到图 / 云端失败 / 本地失败 / 设备没能力。
   * 文案不能写死 —— 已配置云 OCR、只是云端请求失败（跨域/断网）的用户，
   * 不该被告知"缺少本地识别能力"再被建议"去配置云 OCR"。
   * @param {Object} result detect() 的失败结果（含 reason / tried / details）
   * @return {{title:string, status:string}}
   */
  function ocrFailureAttribution(result) {
    var reason = String((result && result.reason) || '');
    var tried = (result && result.tried) ? result.tried : [];
    var cap = OCR.capabilities();
    /* 「云端被尝试过」判定：优先看 tried，退回看 reason 里是否带云端原因 */
    var cloudTried = tried.indexOf('cloud') !== -1 || tried.indexOf('backend') !== -1 ||
      reason.indexOf('云端') !== -1 || reason.indexOf('后端') !== -1 || reason.indexOf('视觉') !== -1;

    if (reason.indexOf('没有可用的图片数据') !== -1 || reason.indexOf('重新选一张截图') !== -1) {
      return {
        title: '没能读到这张截图 —— 请重新选一张图片',
        status: '这张图没能读到，重新选一张截图再试，或者直接手动录入。'
      };
    }
    if (cap.cloud && cloudTried) {
      return {
        title: '云端识别没成功 —— 凭据已配置，但这次请求失败',
        status: '没识别成功。不是你操作错了：凭据已配置，但这次云端请求失败了 —— ' +
          '检查一下网络或跨域限制，也可以核对凭据是否正确，或直接手动录入。'
      };
    }
    if (cap.native) {
      return {
        title: '本地识别没成功 —— 不是你操作的问题，这张图可能太模糊',
        status: '没识别成功。不是你操作错了：这台设备的本地识别没从图片里读出文字，' +
          '换一张更清晰的截图，或直接手动录入。'
      };
    }
    return {
      title: '没识别成功 —— 不是你操作的问题，是这台设备缺少本地识别能力',
      status: '没识别成功。不是你操作错了：这台设备没有可用的文字识别能力，' +
        '可以看示例小票，或配置云 OCR 后再试，也可以直接手动录入。'
    };
  }

  /**
   * 失败态卡片：一定要给出「下一步能做什么」，且第一条动作就是示例演示。
   * @param {string} reason 失败原因（会自动翻译成人话）
   * @param {string} [title] 卡片标题
   */
  function showOcrError(reason, title) {
    var host = $('ocrResult');
    var cloudLabel = OCR.hasCredentials() ? '检查云 OCR 设置' : '配置云 OCR';
    host.innerHTML = '<div class="ocr-error">' +
      '<div class="ocr-error-title">' + esc(title || '这次没成功') + '</div>' +
      '<div class="ocr-error-text">' + esc(humanizeOcrReason(reason || '识别失败')) + '</div>' +
      '<div class="ocr-actions">' +
      '<button type="button" class="btn-mini primary" data-act="ocr-sample" data-index="0">用示例小票演示</button>' +
      '<button type="button" class="btn-mini" data-act="ocr-cloud-config">' + esc(cloudLabel) + '</button>' +
      '<button type="button" class="btn-mini" data-act="ocr-manual">手动录入</button>' +
      '</div></div>';
  }

  /**
   * 失败态「配置云 OCR」：关掉识别弹窗，打开设置抽屉并滚到云 OCR 区。
   * 抽屉里输入框有 id，用 closest 找区块，避免为了锚点多加 DOM 结构。
   */
  function openOcrCloudSettings() {
    closeOcrModal();
    openDrawer();
    var idInput = $('setOcrId');
    var section = idInput && idInput.closest ? idInput.closest('.drawer-section') : null;
    var target = section || idInput;
    if (!target) { return; }
    setTimeout(function () {
      if (typeof target.scrollIntoView === 'function') {
        try {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (e) {
          target.scrollIntoView();
        }
      }
      if (section) {
        section.classList.add('flash');
        setTimeout(function () { section.classList.remove('flash'); }, 1400);
      }
      if (idInput) { idInput.focus(); }
    }, 180);
  }

  function ocrConfidenceText(c) {
    if (c === 'high') { return { text: '置信度 高', cls: 'conf-high' }; }
    if (c === 'medium') { return { text: '置信度 中', cls: 'conf-medium' }; }
    return { text: '置信度 低', cls: 'conf-low' };
  }

  function renderOcrConfirm(result, parsed) {
    var conf = ocrConfidenceText(parsed.confidence);
    var categoryGuess = NLP.classify((parsed.merchant || '') + ' ' + (parsed.raw || ''));
    if (DATA.CATEGORY_KEYS.indexOf(categoryGuess) === -1) { categoryGuess = '其他'; }
    var options = DATA.CATEGORIES.map(function (c) {
      return '<option value="' + esc(c.key) + '"' + (c.key === categoryGuess ? ' selected' : '') + '>' +
        esc(c.key) + '</option>';
    }).join('');
    var todayStr = ENG.formatDate(new Date());
    var minStr = ENG.formatDate(new Date(Date.now() - 365 * 24 * 3600 * 1000));
    var dateValue = parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : todayStr;

    var html = '<div class="ocr-card">';

    /* 双保险：演示结果绝不能和用户上传的图片并存，否则用户会以为
       "我这张图被识别成了示例里的金额"。真的出现这种组合时，
       收起预览图并明确告知这是内置示例。 */
    if (result.source === 'demo' && ocrImageDataUrl) {
      var previewEl = $('ocrPreview');
      ocrPreviewSuppressed = true;
      if (previewEl) { previewEl.hidden = true; }
      html += '<div class="ocr-warn ocr-warn-demo">⚠️ 这是内置示例，不是你上传的截图，仅用于演示流程</div>';
    }

    html += '<div class="ocr-card-head">' +
      '<span class="conf ' + conf.cls + '">' + conf.text + '</span>' +
      '<span class="hint">' + esc(ocrSourceText(result.source)) + '</span>' +
      '</div>';

    if (parsed.confidence === 'low') {
      html += '<div class="ocr-warn">识别可能不准，请核对金额再确认。</div>';
    }
    if (parsed.dateWarn) {
      html += '<div class="ocr-warn">' + esc(parsed.dateWarn) + '</div>';
    }

    html += '<div class="ocr-grid">' +
      '<label class="field"><span>金额（¥）</span>' +
      '<input data-field="amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="' +
      parsed.amount.toFixed(2) + '" /></label>' +
      '<label class="field"><span>分类</span>' +
      '<select data-field="category">' + options + '</select></label>' +
      '<label class="field"><span>日期</span>' +
      '<input data-field="date" type="date" min="' + minStr + '" max="' + todayStr + '" value="' + dateValue + '" /></label>' +
      '<label class="field"><span>备注</span>' +
      '<input data-field="note" type="text" value="' + esc(parsed.merchant || '截图记账') + '" /></label>' +
      '</div>';

    if (parsed.payMethod) {
      html += '<div class="ocr-meta">支付方式：' + esc(parsed.payMethod) + '</div>';
    }

    html += '<details class="ocr-raw"><summary>识别原文</summary><pre>' + esc(parsed.raw) + '</pre></details>' +
      '<div class="ocr-actions">' +
      '<button type="button" class="btn-mini primary" data-act="ocr-confirm">确认记账</button>' +
      '<button type="button" class="btn-mini" data-act="ocr-retry">重新识别</button>' +
      '</div></div>';

    $('ocrResult').innerHTML = html;
    $('ocrStatus').textContent = '识别完成，核对下面的金额和分类，确认后会走正常入账流程。';
  }

  function handleOcrResult(result) {
    if (!result || !result.ok) {
      var attribution = ocrFailureAttribution(result);
      showOcrError(
        (result && result.reason) || '识别失败，可以直接手动录入。',
        attribution.title
      );
      $('ocrStatus').className = 'ocr-status warn';
      $('ocrStatus').textContent = attribution.status;
      return;
    }
    var parsed = OCR.parseReceipt(result.text, new Date());
    if (!parsed.ok) {
      showOcrError(parsed.reason + '。这张图可能是菜单、聊天记录或者太模糊了，建议手动录入。',
        '没读到金额 —— 这张图可能不是消费凭证');
      $('ocrStatus').className = 'ocr-status warn';
      $('ocrStatus').textContent = '没有读到金额。';
      return;
    }
    ocrDraft = parsed;
    renderOcrConfirm(result, parsed);
  }

  function runOcr() {
    if (!ocrPendingFile && !ocrImageDataUrl && ocrDemoIndex < 0) {
      $('ocrStatus').textContent = '先选一张截图（或点下面的示例小票）再识别。';
      return;
    }
    var runBtn = $('btnOcrRun');
    if (runBtn) { runBtn.disabled = true; }
    $('ocrResult').innerHTML = '';
    $('ocrStatus').className = 'ocr-status loading';
    $('ocrStatus').textContent = '识别中…';

    var task;
    if (ocrDemoIndex >= 0) {
      task = OCR.detect({ mode: 'demo', demoIndex: ocrDemoIndex });
    } else {
      /* auto 模式：没有可用识别能力时返回失败，由 UI 引导下一步；
         这里不再传 demoIndex —— 传了就给了"静默回落示例"的口子。 */
      task = OCR.detect({ mode: 'auto', file: ocrPendingFile, dataUrl: ocrImageDataUrl });
    }

    task.then(function (result) {
      if (runBtn) { runBtn.disabled = false; }
      $('ocrStatus').className = 'ocr-status';
      handleOcrResult(result);
    }).catch(function (err) {
      if (runBtn) { runBtn.disabled = false; }
      $('ocrStatus').className = 'ocr-status';
      showOcrError('识别流程异常：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  /** 确认截图记账：金额/分类/备注可编辑，最终仍走既有入账 + 冷静期流程 */
  function confirmOcrBill() {
    var host = $('ocrResult');
    var amountInput = host.querySelector('[data-field="amount"]');
    var amount = Number(amountInput ? amountInput.value : 0);
    if (!isFinite(amount) || amount <= 0) {
      if (amountInput) {
        amountInput.focus();
        $('ocrStatus').textContent = '金额需要大于 0。';
      }
      return;
    }
    var category = host.querySelector('[data-field="category"]').value;
    var date = host.querySelector('[data-field="date"]').value;
    var note = host.querySelector('[data-field="note"]').value.trim();
    var motive = NLP.detectMotivation(note + ' ' + (ocrDraft ? ocrDraft.raw : ''));
    var draft = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ENG.formatDate(new Date()),
      amount: ENG.round2(amount),
      category: DATA.CATEGORY_KEYS.indexOf(category) !== -1 ? category : '其他',
      note: note || category,
      motivation: motive.motivation,
      want: motive.want,
      type: 'expense'
    };
    closeOcrModal();
    switchView('chat');
    startFlow([draft]);
  }

  /** 下载文本文件 */
  function downloadText(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      var url = global.URL.createObjectURL(blob);
      var a = DOC.createElement('a');
      a.href = url;
      a.download = filename;
      DOC.body.appendChild(a);
      a.click();
      DOC.body.removeChild(a);
      setTimeout(function () { global.URL.revokeObjectURL(url); }, 5000);
      return true;
    } catch (e) {
      addAIMessage(aiBubble('导出失败了：当前浏览器可能不支持文件下载。'));
      return false;
    }
  }

  /* ================================================================== */
  /* 消息路由                                                            */
  /* ================================================================== */

  var EXACT_COMMANDS = {
    '查余额': showBalanceCard,
    '余额': showBalanceCard,
    '还能花多少': showBalanceCard,
    '本月花销饼图': showPieCard,
    '饼图': showPieCard,
    '记一笔': showEntryGuide,
    '记收入': openIncomeModal,
    '记一笔收入': openIncomeModal,
    '账单分析': openAnalysisSheet,
    '导入账单': openAnalysisSheet,
    '截屏记账': openOcrModal,
    '截图记账': openOcrModal,
    '我想攒钱': showGoalGuide,
    '我想攒钱买': showGoalGuide,
    '设置预算': openDrawer
  };

  function routeCommand(raw) {
    var text = String(raw || '').trim();
    if (!text) { return; }

    if (Object.prototype.hasOwnProperty.call(EXACT_COMMANDS, text)) {
      EXACT_COMMANDS[text]();
      return;
    }

    var compact = text.replace(/\s+/g, '');
    if (compact === '查余额' || compact === '余额' || compact === '还能花多少' || compact === '还能花多少钱' ||
      compact === '我还剩多少' || compact === '看余额') {
      showBalanceCard();
      return;
    }
    if (compact.indexOf('饼图') !== -1 || compact === '本月花销' || compact === '花销占比') {
      showPieCard();
      return;
    }
    if (compact.indexOf('设置预算') !== -1 || compact === '预算设置') {
      openDrawer();
      return;
    }
    if (compact.indexOf('我想攒钱') !== -1 || compact.indexOf('攒钱买') !== -1) {
      showGoalGuide();
      return;
    }
    if (compact.indexOf('记收入') !== -1 || compact.indexOf('记一笔收入') !== -1) {
      openIncomeModal();
      return;
    }
    if (compact.indexOf('账单分析') !== -1 || compact.indexOf('导入账单') !== -1) {
      openAnalysisSheet();
      return;
    }
    if (compact.indexOf('截屏记账') !== -1 || compact.indexOf('截图记账') !== -1) {
      openOcrModal();
      return;
    }

    var parsed = NLP.parseBill(text);
    if (parsed.items.length === 0) {
      showParseFailure(text);
      return;
    }
    startFlow(parsed.items);
  }

  /* ================================================================== */
  /* CSV 导出                                                            */
  /* ================================================================== */

  function csvCell(value) {
    var s = String(value === undefined || value === null ? '' : value);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function toCsv(rows) {
    var lines = [];
    var i;
    for (i = 0; i < rows.length; i++) {
      var cells = [];
      var j;
      for (j = 0; j < rows[i].length; j++) {
        cells.push(csvCell(rows[i][j]));
      }
      lines.push(cells.join(','));
    }
    return '\ufeff' + lines.join('\r\n');
  }

  function downloadCsv(filename, rows) {
    var content = toCsv(rows);
    try {
      var blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
      var url = global.URL.createObjectURL(blob);
      var a = DOC.createElement('a');
      a.href = url;
      a.download = filename;
      DOC.body.appendChild(a);
      a.click();
      DOC.body.removeChild(a);
      setTimeout(function () { global.URL.revokeObjectURL(url); }, 5000);
    } catch (e) {
      addAIMessage(aiBubble('导出失败了：当前浏览器可能不支持文件下载。'));
    }
  }

  function exportAllCsv() {
    var ov = getOverview();
    // 前 6 列顺序保持与 v1 完全一致，只在末尾追加「收支」列，避免破坏既有消费方
    var billsRows = [['id', '日期', '金额', '分类', '备注', '消费动机', '收支']];
    var sorted = state.bills.slice().sort(function (a, b) {
      if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    var i;
    for (i = 0; i < sorted.length; i++) {
      var b = sorted[i];
      billsRows.push([
        b.id,
        b.date,
        b.amount.toFixed(2),
        b.category,
        b.note,
        b.type === 'income' ? '收入' : b.motivation,
        b.type === 'income' ? '收入' : '支出'
      ]);
    }

    var budgetsRows = [['分类', '预算金额', '已花金额']];
    for (i = 0; i < DATA.CATEGORIES.length; i++) {
      var key = DATA.CATEGORIES[i].key;
      var ratio = DATA.CATEGORY_BUDGET_RATIO[key] || 0;
      budgetsRows.push([
        key,
        ENG.round2(state.budget.total * ratio).toFixed(2),
        ENG.round2(ov.cycleAgg.byCategory[key] || 0).toFixed(2)
      ]);
    }

    var goalsRows = [['目标名称', '目标金额', '已攒金额']];
    for (i = 0; i < state.goals.length; i++) {
      goalsRows.push([
        state.goals[i].name,
        state.goals[i].target.toFixed(2),
        state.goals[i].saved.toFixed(2)
      ]);
    }

    downloadCsv('bills.csv', billsRows);
    setTimeout(function () { downloadCsv('budgets.csv', budgetsRows); }, 350);
    setTimeout(function () { downloadCsv('goals.csv', goalsRows); }, 700);

    addAIMessage(aiBubble('已导出 3 个 CSV：bills.csv、budgets.csv、goals.csv（带 UTF-8 BOM，Excel 打开不会乱码）。'));
  }

  /* ================================================================== */
  /* 语音输入                                                            */
  /* ================================================================== */

  function setupVoice() {
    var btn = $('btnMic');
    var SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    if (!SR) {
      btn.classList.add('disabled');
      btn.disabled = true;
      btn.title = '当前浏览器不支持语音';
      return;
    }
    var rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = function (event) {
      var text = event.results[0][0].transcript;
      if (text) { handleSend(text); }
    };
    rec.onerror = function () {
      btn.classList.remove('listening');
    };
    rec.onend = function () {
      btn.classList.remove('listening');
    };
    btn.addEventListener('click', function () {
      try {
        btn.classList.add('listening');
        rec.start();
      } catch (e) {
        btn.classList.remove('listening');
      }
    });
  }

  /* ================================================================== */
  /* 事件绑定                                                            */
  /* ================================================================== */

  /* ================================================================== */
  /* 后端对话（fetch('/api/chat')，失败回退本地 routeCommand）           */
  /* ================================================================== */

  /**
   * 构造给大模型的精简上下文快照（只取展示/记账需要的最小字段）。
   * @return {Object|null}
   */
  function buildContext() {
    if (!state) { return null; }
    var ov = getOverview();
    var i;
    var recent = state.bills.slice().sort(function (a, b) {
      if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
      return (b.createdAt || 0) - (a.createdAt || 0);
    }).slice(0, 5).map(function (b) {
      return { category: b.category, amount: b.amount, note: b.note, date: b.date };
    });
    var goals = (state.goals || []).map(function (g) {
      return { name: g.name, target: g.target, saved: g.saved };
    });
    return {
      budgetTotal: state.budget ? state.budget.total : null,
      remaining: ov ? ov.remaining : null,
      todaySpent: ov ? ov.todaySpent : null,
      cycleStart: ov ? ov.cycleStart : null,
      cycleEnd: ov ? ov.cycleEnd : null,
      billCount: state.bills.length,
      recentBills: recent,
      goals: goals
    };
  }

  /** 把后端返回的 action 映射到本地的命令函数 */
  var COMMAND_MAP = {
    balance: showBalanceCard,
    pie: showPieCard,
    income: openIncomeModal,
    ocr: openOcrModal,
    analysis: openAnalysisSheet,
    goals: showGoalGuide,
    settings: openDrawer
  };

  /**
   * 把一条消息发给后端 /api/chat，渲染回复并执行 actions；
   * 任何失败都回退到本地 routeCommand，保证「开箱即用」。
   * @param {string} text
   */
  function sendToAssistant(text) {
    var raw = String(text || '').trim();
    if (!raw) { return; }

    // 先插一个「思考中」气泡，拿到结果后只替换气泡里的文字（保留时间戳）
    addAIMessage(aiBubble('账小助正在思考…'));
    var thinkingRow = chatListEl().lastElementChild;

    function setReply(text) {
      if (thinkingRow && thinkingRow.parentNode) {
        var bubble = thinkingRow.querySelector ? thinkingRow.querySelector('.bubble') : null;
        if (bubble) { bubble.textContent = text; return; }
      }
      addAIMessage(aiBubble(esc(text)));
    }

    function clearThinking() {
      if (thinkingRow && thinkingRow.parentNode) {
        thinkingRow.parentNode.removeChild(thinkingRow);
      }
    }

    function fallback() {
      clearThinking();
      routeCommand(raw);
    }

    if (typeof global.fetch !== 'function') { fallback(); return; }

    global.fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: raw, context: buildContext() })
    }).then(function (r) {
      return r.json();
    }).then(function (json) {
      if (!json || json.fallback === true) {
        // 后端未配置或上游失败 -> 本地兜底
        fallback();
        return;
      }
      var reply = json.reply;
      var actions = Array.isArray(json.actions) ? json.actions : [];

      if (reply) {
        setReply(reply);
      } else {
        // 没有文字回复时把「思考中」气泡去掉，避免残留
        clearThinking();
      }

      if (actions.length === 0 && !reply) {
        // 后端既没文字也没动作 -> 本地兜底
        fallback();
        return;
      }

      actions.forEach(function (a) {
        if (!a || !a.type) { return; }
        if (a.type === 'add_bill') {
          var category = (DATA.CATEGORY_KEYS.indexOf(a.category) !== -1) ? a.category : '其他';
          var dateOk = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || ''));
          var draft = {
            amount: Number(a.amount),
            category: category,
            note: a.note || category || '记账',
            date: dateOk ? a.date : ENG.formatDate(new Date()),
            motivation: (a.motivation === '情绪') ? '情绪' : '刚需',
            want: !!a.want,
            type: 'expense'
          };
          startFlow([draft]);
        } else if (a.type === 'command') {
          var fn = COMMAND_MAP[a.name];
          if (fn) { fn(); }
        }
      });
    }).catch(function () {
      fallback();
    });
  }

  function handleSend(text) {
    var raw = String(text || '').trim();
    if (!raw) { return; }
    addUserMessage(raw);
    $('chatInput').value = '';
    switchView('chat');
    // 改为请求后端；后端不可用或返回 fallback 时，sendToAssistant 内部回退到本地逻辑
    sendToAssistant(raw);
  }

  function switchView(view) {
    if (view !== 'chat' && view !== 'dash' && view !== 'goals') { return; }
    DOC.body.setAttribute('data-view', view);
    var tabs = DOC.querySelectorAll('#tabbar .tab');
    var i;
    for (i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('data-view') === view) {
        tabs[i].className = 'tab active';
      } else {
        tabs[i].className = 'tab';
      }
    }
  }

  function bindEvents() {
    $('btnSend').addEventListener('click', function () {
      handleSend($('chatInput').value);
    });

    $('chatInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        handleSend($('chatInput').value);
      }
    });

    $('quickChips').addEventListener('click', function (e) {
      var target = e.target.closest ? e.target.closest('[data-cmd]') : null;
      if (target) {
        handleSend(target.getAttribute('data-cmd'));
      }
    });

    chatListEl().addEventListener('click', function (e) {
      var target = e.target.closest ? e.target.closest('[data-cmd]') : null;
      if (target) {
        handleSend(target.getAttribute('data-cmd'));
        return;
      }
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!act) { return; }
      var name = act.getAttribute('data-act');
      if (name === 'cycle-yes' || name === 'cycle-no') {
        var billId = act.getAttribute('data-bill') || '';
        var yes = name === 'cycle-yes';
        var askCard = act.closest ? act.closest('.ask-card') : null;
        if (askCard) {
          askCard.innerHTML = '<div class="ask-done">' +
            (yes ? '已选择：从现在重新算周期' : '已选择：只记这一笔') + '</div>';
        }
        resolveCycleReset(billId, yes);
        return;
      }
      if (name === 'cooldown-buy') {
        act.parentNode.innerHTML = '<span class="tag">已选择：坚持购买</span>';
        resolveCooldown(true);
      } else if (name === 'cooldown-skip') {
        act.parentNode.innerHTML = '<span class="tag green">已选择：算了，不买了</span>';
        resolveCooldown(false);
      }
    });

    $('legendList').addEventListener('click', function (e) {
      var li = e.target.closest ? e.target.closest('li[data-cat]') : null;
      if (!li) { return; }
      var cat = li.getAttribute('data-cat');
      highlightCategory = (highlightCategory === cat) ? null : cat;
      renderDonut(getOverview());
    });

    $('goalList').addEventListener('click', function (e) {
      var addBtn = e.target.closest ? e.target.closest('[data-goal-add]') : null;
      if (addBtn) {
        openDepositModal(addBtn.getAttribute('data-goal-add'));
        return;
      }
      var delBtn = e.target.closest ? e.target.closest('[data-goal-del]') : null;
      if (delBtn) {
        var id = delBtn.getAttribute('data-goal-del');
        var goal = findGoal(id);
        if (!goal) { return; }
        var next = [];
        var i;
        for (i = 0; i < state.goals.length; i++) {
          if (state.goals[i].id !== id) { next.push(state.goals[i]); }
        }
        state.goals = next;
        saveState();
        renderGoals();
        addAIMessage(aiBubble('目标「' + esc(goal.name) + '」已删除。想重新开始随时告诉我。'));
      }
    });

    $('btnAddGoal').addEventListener('click', openGoalModal);
    $('btnSettings').addEventListener('click', openDrawer);
    $('btnCloseDrawer').addEventListener('click', closeDrawer);
    $('drawerMask').addEventListener('click', closeDrawer);
    $('btnSaveSettings').addEventListener('click', saveSettings);
    $('btnExport').addEventListener('click', exportAllCsv);
    $('btnReset').addEventListener('click', confirmReset);
    $('btnCycleReset').addEventListener('click', restorePaydayCycle);
    $('btnSaveOcr').addEventListener('click', saveOcrCredentials);
    $('btnClearOcr').addEventListener('click', clearOcrCredentials);

    /* ---- 顶部工具栏：截屏记账 / 账单分析 / 更多菜单 ---- */
    $('btnOcr').addEventListener('click', openOcrModal);
    $('btnAnalysis').addEventListener('click', openAnalysisSheet);
    $('btnMore').addEventListener('click', function (e) {
      e.stopPropagation();
      var menu = $('moreMenu');
      menu.hidden = !menu.hidden;
      $('btnMore').classList.toggle('active', !menu.hidden);
    });
    $('moreMenu').addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('[data-act]') : null;
      $('moreMenu').hidden = true;
      $('btnMore').classList.remove('active');
      if (!item) { return; }
      var act = item.getAttribute('data-act');
      if (act === 'export') { exportAllCsv(); }
      if (act === 'reset') { confirmReset(); }
    });
    DOC.addEventListener('click', function (e) {
      var menu = $('moreMenu');
      if (!menu || menu.hidden) { return; }
      if (e.target === $('btnMore') || (e.target.closest && e.target.closest('#moreMenu'))) { return; }
      menu.hidden = true;
      $('btnMore').classList.remove('active');
    });

    /* ---- 账单分析 sheet ---- */
    $('btnCloseAnalysis').addEventListener('click', closeAnalysisSheet);
    $('analysisMask').addEventListener('click', function (e) {
      if (e.target === $('analysisMask')) { closeAnalysisSheet(); }
    });
    $('analysisDrop').addEventListener('click', function () {
      $('analysisFile').click();
    });
    $('analysisFile').addEventListener('change', function () {
      handleAnalysisFiles(this.files);
      this.value = '';
    });
    $('analysisExcludeDup').addEventListener('change', renderAnalysis);
    $('analysisReport').addEventListener('change', function (e) {
      var sel = e.target.closest ? e.target.closest('[data-act="analysis-month"]') : null;
      if (!sel || !analysisData) { return; }
      analysisData.month = sel.value;
      renderAnalysis();
    });
    $('btnAnalysisExport').addEventListener('click', exportAnalysisMarkdown);
    $('btnAnalysisImport').addEventListener('click', confirmImportAnalysis);
    $('btnAnalysisClear').addEventListener('click', clearAnalysis);

    /* 拖拽上传（分析 + 截图共用视觉语言） */
    ['analysisDrop'].forEach(function (id) {
      var zone = $(id);
      ['dragenter', 'dragover'].forEach(function (evt) {
        zone.addEventListener(evt, function (e) {
          e.preventDefault();
          zone.classList.add('dragging');
        });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        zone.addEventListener(evt, function (e) {
          e.preventDefault();
          zone.classList.remove('dragging');
        });
      });
      zone.addEventListener('drop', function (e) {
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
          handleAnalysisFiles(dt.files);
        }
      });
    });

    /* ---- 截屏记账弹窗 ---- */
    $('btnCloseOcr').addEventListener('click', closeOcrModal);
    $('btnOcrCancel').addEventListener('click', closeOcrModal);
    $('btnOcrRun').addEventListener('click', runOcr);
    $('ocrMask').addEventListener('click', function (e) {
      if (e.target === $('ocrMask')) { closeOcrModal(); }
    });
    $('ocrDrop').addEventListener('click', function () {
      $('ocrFile').click();
    });
    $('ocrFile').addEventListener('change', function () {
      if (this.files && this.files.length > 0) { handleOcrFile(this.files[0]); }
    });
    ['dragenter', 'dragover'].forEach(function (evt) {
      $('ocrDrop').addEventListener(evt, function (e) {
        e.preventDefault();
        $('ocrDrop').classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      $('ocrDrop').addEventListener(evt, function (e) {
        e.preventDefault();
        $('ocrDrop').classList.remove('dragging');
      });
    });
    $('ocrDrop').addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) { handleOcrFile(dt.files[0]); }
    });
    $('ocrDemoList').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act="ocr-sample"]') : null;
      if (!btn) { return; }
      ocrDemoIndex = Number(btn.getAttribute('data-index'));
      ocrPendingFile = null;
      ocrImageDataUrl = '';
      ocrPreviewSuppressed = false;
      $('ocrPreview').hidden = true;
      $('ocrResult').innerHTML = '';
      $('ocrStatus').className = 'ocr-status';
      $('ocrStatus').textContent = '已选择示例小票「' + OCR.SAMPLES[ocrDemoIndex].title + '」，点「开始识别」看结果。';
    });
    $('ocrResult').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) { return; }
      var act = btn.getAttribute('data-act');
      if (act === 'ocr-confirm') {
        confirmOcrBill();
      } else if (act === 'ocr-retry') {
        $('ocrResult').innerHTML = '';
        $('ocrStatus').textContent = '可以重新选图，或再点一次「开始识别」。';
      } else if (act === 'ocr-cloud-config') {
        openOcrCloudSettings();
      } else if (act === 'ocr-giveup' || act === 'ocr-manual') {
        closeOcrModal();
        switchView('chat');
        addAIMessage(aiBubble('行，直接在下面输入就行，比如「午饭食堂 15」，我马上给你记上。'));
        var input = $('chatInput');
        if (input) { input.focus(); }
      } else if (act === 'ocr-sample') {
        var idx = Number(btn.getAttribute('data-index') || 0);
        ocrDemoIndex = idx;
        ocrPendingFile = null;
        ocrImageDataUrl = '';
        ocrPreviewSuppressed = false;
        $('ocrPreview').hidden = true;
        runOcr();
      }
    });

    /* Ctrl+V 粘贴截图 */
    DOC.addEventListener('paste', function (e) {
      if ($('ocrMask').hidden) { return; }
      var cd = e.clipboardData || global.clipboardData;
      if (!cd || !cd.items) { return; }
      var i;
      for (i = 0; i < cd.items.length; i++) {
        if (cd.items[i].type && cd.items[i].type.indexOf('image') === 0) {
          var file = cd.items[i].getAsFile();
          if (file) {
            e.preventDefault();
            handleOcrFile(file);
            return;
          }
        }
      }
    });

    $('modalMask').addEventListener('click', function (e) {
      if (e.target === $('modalMask')) { closeModal(); }
    });

    DOC.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        closeModal();
        if (!$('analysisMask').hidden) { closeAnalysisSheet(); }
        if (!$('ocrMask').hidden) { closeOcrModal(); }
        if ($('settingsDrawer').classList.contains('open')) { closeDrawer(); }
      }
    });

    $('tabbar').addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('.tab[data-view]') : null;
      if (tab) { switchView(tab.getAttribute('data-view')); }
    });
  }

  /* ================================================================== */
  /* 欢迎语 & 启动                                                       */
  /* ================================================================== */

  function addWelcome() {
    var ov = getOverview();
    addAIMessage(aiBubble('你好呀，我是账小助 👋<br>一句话就能记账，试试「中午食堂 15」，或者直接点下面的快捷指令。'));
    addAIMessage(aiBubble('当前周期 ' + esc(ov.cycle.start) + ' ~ ' + esc(ov.cycle.end) + '，总预算 ' +
      money(state.budget.total) + '，已花 ' + money(ov.cycleAgg.expense) + '。' + ov.sentence));
  }

  function init() {
    loadState();
    if (!storageOK) { showStorageTip(); }
    var ring = $('ringBar');
    if (ring) {
      ring.style.strokeDasharray = RING_C + ' ' + RING_C;
      ring.style.strokeDashoffset = String(RING_C);
    }
    setupVoice();
    bindEvents();
    renderAll();
    addWelcome();
    switchView('chat');
    refreshBackendCaps();
  }

  if (DOC.readyState === 'loading') {
    DOC.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
