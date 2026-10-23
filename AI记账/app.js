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

  var STORAGE_KEY = DATA.STORAGE_KEY;
  var RING_R = 58;
  var RING_C = 2 * Math.PI * RING_R;

  var storageOK = true;
  var state = null;
  var highlightCategory = null;
  var flow = { queue: [], committed: [] };
  var pendingBill = null;

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
    var category = b.category && DATA.CATEGORY_KEYS.indexOf(b.category) !== -1 ? b.category : '其他';
    var date = (typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) ? b.date : ENG.formatDate(new Date());
    return {
      id: b.id ? String(b.id) : uid('b'),
      date: date,
      amount: ENG.round2(amount),
      category: category,
      note: b.note ? String(b.note) : category,
      motivation: b.motivation === '情绪' ? '情绪' : '刚需',
      want: !!b.want,
      type: b.type === 'income' ? 'income' : 'expense',
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
        cooldownThreshold: clampNumber(budget.cooldownThreshold, 0, 9999999, DATA.DEFAULT_BUDGET.cooldownThreshold)
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
      cooldownThreshold: DATA.DEFAULT_BUDGET.cooldownThreshold
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
      category: inc.category,
      note: inc.note,
      motivation: inc.motivation,
      want: false,
      type: 'income',
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
    var bill = {
      id: uid('b'),
      date: draft.date || ENG.formatDate(new Date()),
      amount: ENG.round2(draft.amount),
      category: DATA.CATEGORY_KEYS.indexOf(draft.category) !== -1 ? draft.category : '其他',
      note: draft.note || draft.category || '未命名',
      motivation: draft.motivation === '情绪' ? '情绪' : '刚需',
      want: !!draft.want,
      type: draft.type === 'income' ? 'income' : 'expense',
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
        head = aiBubble('💰 记好了，这是一笔收入，已经加进本周期，不计入支出统计。');
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
    var cycle = ENG.getCycle(today, state.budget.payday);
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
      ' · 总预算 ' + money(total) + ' · 已花 ' + money(ov.cycleAgg.expense);
    $('cycleBadge').title = '按发钱日 ' + state.budget.payday + ' 号计算的周期';

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
    var mask = $('drawerMask');
    mask.hidden = false;
    setTimeout(function () {
      mask.classList.add('show');
      $('settingsDrawer').classList.add('open');
      $('settingsDrawer').setAttribute('aria-hidden', 'false');
    }, 10);
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
    addAIMessage(aiBubble('设置已更新：生活费 ' + money(state.budget.total) + '，发钱日 ' +
      state.budget.payday + ' 号，冷静期阈值 ' + money(state.budget.cooldownThreshold) + '。看板已重算。'));
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
  /* 消息路由                                                            */
  /* ================================================================== */

  var EXACT_COMMANDS = {
    '查余额': showBalanceCard,
    '余额': showBalanceCard,
    '还能花多少': showBalanceCard,
    '本月花销饼图': showPieCard,
    '饼图': showPieCard,
    '记一笔': showEntryGuide,
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
    var billsRows = [['id', '日期', '金额', '分类', '备注', '消费动机']];
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
        b.type === 'income' ? '收入' : b.motivation
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

  function handleSend(text) {
    var raw = String(text || '').trim();
    if (!raw) { return; }
    addUserMessage(raw);
    $('chatInput').value = '';
    switchView('chat');
    setTimeout(function () { routeCommand(raw); }, 200);
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

    $('modalMask').addEventListener('click', function (e) {
      if (e.target === $('modalMask')) { closeModal(); }
    });

    DOC.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        closeModal();
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
  }

  if (DOC.readyState === 'loading') {
    DOC.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
