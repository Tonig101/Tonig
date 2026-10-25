/**
 * savings.js — 省钱图谱 · 引擎（纯函数 + UMD）
 *
 * 定位：把 100 条「怎么操作才省」的动作，算成「今天哪几条能用、值多少、先看哪条」。
 * 与省钱雷达的分工：
 *   deals.js    → 哪天有活动、谁更便宜（时间 + 价格口径）
 *   savings.js  → 具体怎么操作才省（动作 + 门槛 + 弊端 + 打卡）
 *
 * 对外 API（window.AJ.savings）：
 *   READY / ENTRIES                   数据是否就绪、条目列表
 *   estimateSave(entry)               可省金额估算 → number | null
 *   saveText(entry)                   「≈ 省 ¥6.10」/「省多少看用量」
 *   matchTrigger(entry, now)          今天是否命中（OR 语义，多维度任一满足）
 *   rankToday(entries, ctx)           今日清单（稳定排序，已打卡的排除）
 *   search(entries, q)                搜索（标题 / 动作 / 关键词 / 门槛）
 *   entriesForBill(cat, entries)      某账本分类关联的条目（账本联动用）
 *   summary(logs, opts)               省钱账汇总（累计 / 本周期）
 *   isChecked(logs, id, day)          某天是否已打卡
 *   toggleCheck(logs, id, day, saved) 打卡 / 取消（幂等，返回新数组）
 *   entryCardHtml / todayCardHtml     卡片 HTML
 *
 * 约定：所有日期用**本地时间**，dateKey 与 deals.dateKey 同语义（YYYY-MM-DD）。
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);
  var DATA = isNode ? require('./savings_data.js') : (global.AJ && global.AJ.savingsData);

  var READY = !!(DATA && Array.isArray(DATA.ENTRIES) && DATA.ENTRIES.length);

  var ENTRIES = READY ? DATA.ENTRIES : [];
  var CATS = READY ? DATA.CATS : [];
  var CERT_LABEL = { stable: '', varies: '力度常变', local: '以你学校为准' };

  /** 场景码 → 人话（详情页「什么时候用」那一行） */
  var SCENE_LABEL = {
    always: '随时', weekday: '工作日', 'weekday-lunch': '工作日午餐', 'weekday-dinner': '工作日晚餐',
    weekend: '周末', 'weekend-meal': '周末正餐', lunch: '午餐', dinner: '晚餐',
    'late-dinner': '晚 8 点后', meal: '正餐', morning: '早餐', night: '夜间',
    holiday: '节假日', seasonal: '换季 / 开学', monthly: '每月固定', weekly: '每周固定',
    order: '下单那一刻', emergency: '应急'
  };

  /* ================================================================== */
  /* 一、日期与格式化工具（与 deals.js 同语义）                            */
  /* ================================================================== */

  var WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toDate(d) {
    if (d instanceof Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    if (typeof d === 'string') {
      var m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) { return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); }
    }
    var t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }

  function dateKey(d) {
    var x = toDate(d);
    return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
  }

  /** 'MM-DD'，用于 mmdd / window 比较（跨年无意义，只比月日） */
  function mmddKey(d) {
    var x = toDate(d);
    return pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
  }

  /** JS getDay 0=周日；本模块统一 1=周一 … 7=周日 */
  function isoWeekday(d) {
    var w = toDate(d).getDay();
    return w === 0 ? 7 : w;
  }

  function weekdayCn(d) { return WEEK_CN[toDate(d).getDay()]; }

  /** 当前时刻 'HH:MM' */
  function hhmm(d) {
    var x = (d instanceof Date) ? d : new Date();
    return pad2(x.getHours()) + ':' + pad2(x.getMinutes());
  }

  function toMin(hhmmStr) {
    var p = String(hhmmStr || '').split(':');
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    if (!isFinite(h) || !isFinite(m)) { return NaN; }
    return h * 60 + m;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function fmt(n) {
    if (n === null || n === undefined || !isFinite(n)) { return '—'; }
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ================================================================== */
  /* 二、可省金额估算                                                     */
  /* ================================================================== */

  /**
   * estimateSave(entry) → number | null
   *   fixed  → amount
   *   ratio  → min(before × rate, cap)；缺 priceRef.before 返回 null（不是 0！）
   *   range  → (min + max) / 2
   *   none   → null（省多少看用量，不参与金额累计）
   */
  function estimateSave(entry) {
    if (!entry || !entry.save) { return null; }
    var s = entry.save;

    if (s.type === 'fixed') {
      return (typeof s.amount === 'number' && isFinite(s.amount) && s.amount >= 0) ? round2(s.amount) : null;
    }
    if (s.type === 'ratio') {
      var before = entry.priceRef && entry.priceRef.before;
      if (typeof before !== 'number' || !isFinite(before) || before <= 0) { return null; }
      var v = before * s.rate;
      if (typeof s.cap === 'number' && isFinite(s.cap) && s.cap > 0) { v = Math.min(v, s.cap); }
      return round2(v);
    }
    if (s.type === 'range') {
      if (typeof s.min !== 'number' || typeof s.max !== 'number') { return null; }
      return round2((s.min + s.max) / 2);
    }
    return null;
  }

  /** 金额展示文案：< 0.5 元不显示 ¥0.00，避免看起来「这条没用」 */
  function saveText(entry) {
    /* 总额型（once：大促总额 / 年卡 / 课程总价）：这个数不是「今天能省多少」，必须说清楚 */
    if (entry && entry.save && entry.save.once) {
      var label = entry.save.onceLabel || '一次性省';
      if (entry.save.type === 'range') {
        return label + ' ¥' + fmt(entry.save.min) + '-' + fmt(entry.save.max);
      }
      var ov = estimateSave(entry);
      return ov === null ? label : label + ' ¥' + fmt(ov);
    }
    var v = estimateSave(entry);
    if (v === null) { return '省多少看用量'; }
    if (v <= 0) { return '省心操作'; }
    if (v < 0.5) { return '≈ 几毛钱'; }
    return '≈ 省 ¥' + fmt(v);
  }

  /** 金额区间文案（详情页用） */
  /**
   * ratioText(save) → '省 12%（约 8.8 折），单次最多省 ¥20.00'
   * rate 存的是「省掉的比例」，直接写「12% 折扣」会被读成「打 12% 折」（差 8 倍），
   * 所以两个说法都给：省多少 + 相当于几折。
   */
  function ratioText(s) {
    var pct = Math.round(s.rate * 100);
    var t = '省 ' + pct + '%（约 ' + (Math.round((1 - s.rate) * 1000) / 100) + ' 折）';
    if (typeof s.cap === 'number') { t += '，单次最多省 ¥' + fmt(s.cap); }
    return t;
  }

  function saveRangeText(entry) {
    var s = entry && entry.save;
    if (!s) { return '—'; }
    if (s.type === 'range') { return '¥' + fmt(s.min) + ' - ¥' + fmt(s.max) + '（每次估算）'; }
    if (s.type === 'ratio') { return ratioText(s); }
    if (s.type === 'fixed') { return '¥' + fmt(s.amount) + '（固定省额）'; }
    return '无法量化（长期习惯型）';
  }

  /* ================================================================== */
  /* 三、今日命中判定                                                     */
  /* ================================================================== */

  /**
   * triggerText(entry) → '每周一 / 每月 8 / 18 / 28 号' / '随时可用'
   * 纯展示用，与 matchTrigger 一一对应，改了那边记得同步这里。
   */
  function triggerText(entry) {
    var t = entry && entry.trigger;
    if (!t) { return '随时可用'; }
    var parts = [], i;

    if (Array.isArray(t.weekday) && t.weekday.length) {
      parts.push('每' + t.weekday.map(function (w) { return WEEK_CN[w % 7]; }).join(' / '));
    }
    if (Array.isArray(t.monthday) && t.monthday.length) {
      parts.push('每月 ' + t.monthday.join(' / ') + ' 号');
    }
    if (Array.isArray(t.mmdd) && t.mmdd.length) {
      parts.push('每年 ' + t.mmdd.join('、'));
    }
    if (Array.isArray(t.timeRange) && t.timeRange.length === 2) {
      parts.push('每天 ' + t.timeRange[0] + '-' + t.timeRange[1]);
    }
    if (Array.isArray(t.window)) {
      var ws = [];
      for (i = 0; i < t.window.length; i++) {
        var w = t.window[i] || {};
        if (w.from && w.to) { ws.push(w.from + ' ~ ' + w.to); }
      }
      if (ws.length) { parts.push('每年 ' + ws.join('、') + ' 期间'); }
    }
    return parts.length ? parts.join(' 或 ') : '随时可用';
  }

  function sceneText(entry) {
    var s = entry && entry.scene;
    if (!s) { return '不限场景'; }
    return SCENE_LABEL[s] || '不限场景';
  }

  /**
   * matchTrigger(entry, now) → boolean
   * trigger 为 null 视为「常驻可用」，恒 true。
   * 多维度时 **任一维度满足即命中**（OR）。
   */
  function matchTrigger(entry, now) {
    var t = entry && entry.trigger;
    if (!t) { return true; }
    var d = (now instanceof Date) ? now : new Date();

    if (Array.isArray(t.weekday) && t.weekday.indexOf(isoWeekday(d)) !== -1) { return true; }
    if (Array.isArray(t.monthday) && t.monthday.indexOf(d.getDate()) !== -1) { return true; }
    if (Array.isArray(t.mmdd) && t.mmdd.indexOf(mmddKey(d)) !== -1) { return true; }

    if (Array.isArray(t.timeRange) && t.timeRange.length === 2) {
      var start = toMin(t.timeRange[0]), end = toMin(t.timeRange[1]), cur = toMin(hhmm(d));
      if (isFinite(start) && isFinite(end) && isFinite(cur)) {
        if (start <= end) { if (cur >= start && cur <= end) { return true; } }
        else { if (cur >= start || cur <= end) { return true; } }  // 跨零点
      }
    }

    if (Array.isArray(t.window)) {
      var today = mmddKey(d);
      for (var i = 0; i < t.window.length; i++) {
        var w = t.window[i] || {};
        if (!/^\d{2}-\d{2}$/.test(w.from || '') || !/^\d{2}-\d{2}$/.test(w.to || '')) { continue; }
        if (w.from <= w.to) { if (today >= w.from && today <= w.to) { return true; } }
        else { if (today >= w.from || today <= w.to) { return true; } }  // 跨年
      }
    }

    return false;
  }

  /* ================================================================== */
  /* 四、今日清单（稳定排序）                                              */
  /* ================================================================== */

  function scoreOne(entry, ctx) {
    var now = ctx.now || new Date();
    var hit = entry.trigger ? matchTrigger(entry, now) : false;
    var est = estimateSave(entry);
    var s = 0;

    if (hit) { s += 40; }
    if (ctx.topCat && entry.billCats && entry.billCats.indexOf(ctx.topCat) !== -1) { s += 25; }
    if (ctx.catSpend) {
      for (var i = 0; i < entry.billCats.length; i++) {
        if ((ctx.catSpend[entry.billCats[i]] || 0) > 0) { s += 20; break; }
      }
    }
    if (ctx.budgetStatus === 'danger' || ctx.budgetStatus === 'tight') { s += 15; }
    if (entry.certainty === 'stable') { s += 10; }
    /* 大促（once）那个数是整场活动的总额，不能拿来当「今天省多少」参与加榜 */
    if (est !== null && est > 0 && !(entry.save && entry.save.once)) { s += 5; }

    return { entry: entry, score: s, est: est, hit: hit };
  }

  /** 排序用的金额键：once 型与无法量化的都算 -1，避免大促总额霸榜 */
  function sortEst(entry, est) {
    if (est === null) { return -1; }
    if (entry.save && entry.save.once) { return -1; }
    return est;
  }

  /**
   * rankToday(entries, ctx) → 条目数组
   * ctx: { now, logs, topCat, catSpend:{餐饮:320,...}, budgetStatus:'danger'|'tight'|'safe', limit }
   *
   * 硬规则（比排序更重要）：
   *   ① **今天用不了的条目一律不进清单**——「周四肯德基」周一推给用户就是在骗人；
   *   ② 命中今天的条目优先，不限条数（受 limit）；
   *   ③ 常驻条（trigger=null）只做填充，最多 3 条，避免挤掉「今天才有」的。
   * 排序：score ↓ → estimateSave ↓（null 视为 -1）→ id 字典序 ↑（保证同日期两次渲染结果一致）
   */
  function rankToday(entries, ctx) {
    ctx = ctx || {};
    var list = Array.isArray(entries) ? entries : ENTRIES;
    var now = ctx.now || new Date();
    var day = dateKey(now);
    var limit = typeof ctx.limit === 'number' ? ctx.limit : 5;
    var logs = ctx.logs || [];
    var ALWAYS_MAX = 3;
    var rows = [], i;

    for (i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e) { continue; }
      if (isChecked(logs, e.id, day)) { continue; }
      /* ① 有 trigger 但今天不命中 → 直接排除，不参与排序 */
      if (e.trigger && !matchTrigger(e, now)) { continue; }
      rows.push(scoreOne(e, ctx));
    }

    rows.sort(function (a, b) {
      if (b.score !== a.score) { return b.score - a.score; }
      var ea = sortEst(a.entry, a.est);
      var eb = sortEst(b.entry, b.est);
      if (eb !== ea) { return eb - ea; }
      return a.entry.id < b.entry.id ? -1 : (a.entry.id > b.entry.id ? 1 : 0);
    });

    /* ②③ 先取命中今天的，再用常驻条补位（最多 3 条） */
    var out = [], alwaysUsed = 0;
    for (i = 0; i < rows.length && out.length < limit; i++) {
      if (rows[i].hit) { out.push(rows[i].entry); }
    }
    for (i = 0; i < rows.length && out.length < limit && alwaysUsed < ALWAYS_MAX; i++) {
      if (!rows[i].entry.trigger) {
        out.push(rows[i].entry);
        alwaysUsed++;
      }
    }
    return out;
  }

  /* ================================================================== */
  /* 五、搜索与分类                                                       */
  /* ================================================================== */

  /**
   * search(entries, q) → 条目数组
   * 命中范围：标题 / 动作 / 关键词 / 门槛；命中数多的排前面，同分按 id。
   */
  function search(entries, q) {
    var list = Array.isArray(entries) ? entries : ENTRIES;
    var kw = String(q || '').trim().toLowerCase();
    if (!kw) { return list.slice(); }

    var scored = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var hit = 0;
      if (String(e.title || '').toLowerCase().indexOf(kw) !== -1) { hit += 4; }
      if (String(e.action || '').toLowerCase().indexOf(kw) !== -1) { hit += 2; }
      if (String(e.gate || '').toLowerCase().indexOf(kw) !== -1) { hit += 1; }
      for (var k = 0; k < (e.keywords || []).length; k++) {
        var kk = String(e.keywords[k]).toLowerCase();
        if (kk === kw) { hit += 5; }
        else if (kk.indexOf(kw) !== -1 || kw.indexOf(kk) !== -1) { hit += 3; }
      }
      if (hit > 0) { scored.push({ e: e, hit: hit }); }
    }

    scored.sort(function (a, b) {
      if (b.hit !== a.hit) { return b.hit - a.hit; }
      return a.e.id < b.e.id ? -1 : (a.e.id > b.e.id ? 1 : 0);
    });

    return scored.map(function (x) { return x.e; });
  }

  /** 某个账本分类关联的条目（账本联动：账本说你在餐饮花最多 → 找餐饮类动作） */
  function entriesForBill(cat, entries) {
    var list = Array.isArray(entries) ? entries : ENTRIES;
    return list.filter(function (e) {
      return e.billCats && e.billCats.indexOf(cat) !== -1;
    });
  }

  function byCat(cat, entries) {
    var list = Array.isArray(entries) ? entries : ENTRIES;
    if (!cat) { return list.slice(); }
    return list.filter(function (e) { return e.cat === cat; });
  }

  /* ================================================================== */
  /* 六、打卡与省钱账                                                     */
  /* ================================================================== */

  function isChecked(logs, id, day) {
    if (!Array.isArray(logs)) { return false; }
    for (var i = 0; i < logs.length; i++) {
      if (logs[i] && logs[i].id === id && logs[i].date === day) { return true; }
    }
    return false;
  }

  /**
   * toggleCheck(logs, id, day, saved, nowMs) → { logs, action:'add'|'remove' }
   * 纯函数：不改传入数组。同一 id 同一自然日只允许一条 → 第二次点击是「取消」。
   */
  function toggleCheck(logs, id, day, saved, nowMs) {
    var next = Array.isArray(logs) ? logs.slice() : [];
    for (var i = 0; i < next.length; i++) {
      if (next[i] && next[i].id === id && next[i].date === day) {
        next.splice(i, 1);
        return { logs: next, action: 'remove' };
      }
    }
    var manual = (saved !== undefined && saved !== null && isFinite(Number(saved)));
    next.push({
      id: id,
      date: day,
      saved: manual ? round2(Number(saved)) : 0,
      manual: manual,
      at: typeof nowMs === 'number' ? nowMs : Date.now()
    });
    return { logs: next, action: 'add' };
  }

  /**
   * summary(logs, opts) → { count, totalSaved, monthSaved, monthCount, byCat }
   * opts: { cycleStart:'YYYY-MM-DD', cycleEnd:'YYYY-MM-DD' }
   *   totalSaved 不随周期清零；monthSaved 只统计落在当前预算周期内的记录。
   */
  function summary(logs, opts) {
    opts = opts || {};
    var arr = Array.isArray(logs) ? logs : [];
    var total = 0, month = 0, monthCount = 0, byCat = {};
    var cs = opts.cycleStart || '';
    var ce = opts.cycleEnd || '';

    for (var i = 0; i < arr.length; i++) {
      var r = arr[i] || {};
      var v = isFinite(r.saved) ? Number(r.saved) : 0;
      total += v;

      var inCycle = true;
      if (cs && r.date && r.date < cs) { inCycle = false; }
      if (ce && r.date && r.date > ce) { inCycle = false; }
      if (inCycle) { month += v; monthCount++; }

      var e = dataById(r.id);
      var cat = e ? e.cat : 'unknown';
      byCat[cat] = byCat[cat] || { count: 0, saved: 0 };
      byCat[cat].count += 1;
      byCat[cat].saved = round2(byCat[cat].saved + v);
    }

    return {
      count: arr.length,
      totalSaved: round2(total),
      monthSaved: round2(month),
      monthCount: monthCount,
      byCat: byCat
    };
  }

  function dataById(id) {
    for (var i = 0; i < ENTRIES.length; i++) { if (ENTRIES[i].id === id) { return ENTRIES[i]; } }
    return null;
  }

  /* ================================================================== */
  /* 七、HTML 卡片                                                        */
  /* ================================================================== */

  function catMeta(cat) {
    for (var i = 0; i < CATS.length; i++) { if (CATS[i].key === cat) { return CATS[i]; } }
    return { key: cat, name: '其他', emoji: '💡' };
  }

  function certTag(certainty) {
    var label = CERT_LABEL[certainty];
    if (!label) { return ''; }
    return '<span class="sv-tag sv-tag-' + esc(certainty) + '">' + esc(label) + '</span>';
  }

  function highlight(text, q) {
    var safe = esc(text);
    var kw = String(q || '').trim();
    if (!kw) { return safe; }
    var k = esc(kw);
    if (!k) { return safe; }
    try {
      return safe.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), function (m) {
        return '<mark>' + m + '</mark>';
      });
    } catch (e) {
      return safe;
    }
  }

  /**
   * entryCardHtml(entry, opts) → string
   * opts: { checked:boolean, q:'搜索词', compact:boolean }
   */
  function entryCardHtml(entry, opts) {
    opts = opts || {};
    if (!entry) { return ''; }
    var m = catMeta(entry.cat);
    var checked = !!opts.checked;
    var q = opts.q || '';
    var saveLabel = saveText(entry);

    var html = '<div class="sv-card' + (checked ? ' is-checked' : '') + '" data-sv-id="' + esc(entry.id) + '">';

    html += '<div class="sv-card-top">' +
      '<b class="sv-title">' + esc(m.emoji) + ' ' + highlight(entry.title, q) + '</b>' +
      '<span class="sv-save">' + esc(saveLabel) + '</span>' +
      '</div>';

    html += '<p class="sv-action">' + highlight(entry.action, q) + '</p>';

    html += '<div class="sv-meta">' +
      '<span class="sv-pill">门槛：' + esc(entry.gate) + '</span>' +
      '<span class="sv-pill">适合：' + esc(entry.who) + '</span>' +
      certTag(entry.certainty) +
      '</div>';

    html += '<div class="sv-risk">⚠️ ' + esc(entry.risk) + '</div>';

    html += '<div class="sv-acts">' +
      '<button type="button" class="btn-mini' + (checked ? '' : ' primary') + '" data-sv-act="toggle" data-sv-id="' + esc(entry.id) + '">' +
      (checked ? '✓ 今天用了（点击撤销）' : '✓ 今天用了') +
      '</button>' +
      '<button type="button" class="btn-mini" data-sv-act="detail" data-sv-id="' + esc(entry.id) + '">详情</button>' +
      '</div>';

    html += '</div>';
    return html;
  }

  /**
   * todayCardHtml(ctx) → string
   * ctx: { now, logs, topCat, catSpend, budgetStatus, limit, checked }
   */
  function todayCardHtml(ctx) {
    ctx = ctx || {};
    var now = ctx.now || new Date();
    var logs = ctx.logs || [];
    var list = rankToday(ENTRIES, ctx);
    var day = dateKey(now);
    var html = '';

    if (!list.length) {
      return '<div class="sv-empty">今天的动作都打完卡了 🎉<br><span class="hint">去「图谱」里翻翻别的分类，或者明天再来。</span></div>';
    }

    var hitN = 0, relN = 0, k;
    for (k = 0; k < list.length; k++) {
      if (list[k].trigger && matchTrigger(list[k], now)) { hitN++; }
      if (ctx.topCat && list[k].billCats && list[k].billCats.indexOf(ctx.topCat) !== -1) { relN++; }
    }

    /* 只说事实：命中几条、几条和你的大头支出相关——不承诺「第一条就是你最该看的」 */
    if (hitN > 0) {
      html += '<p class="sv-lead">今天命中 ' + hitN + ' 条踩点优惠' +
        (relN ? '，其中 ' + relN + ' 条和你的「' + esc(ctx.topCat) + '」支出相关' : '') + '。</p>';
    } else {
      html += '<p class="sv-lead sv-lead-soft">今天没有踩点的规则优惠，下面几条随时都能用。</p>';
    }

    for (var i = 0; i < list.length; i++) {
      html += entryCardHtml(list[i], { checked: isChecked(logs, list[i].id, day) });
    }
    return html;
  }

  /* ================================================================== */
  /* 六、Markdown 导出（「所有省钱大全」）                                  */
  /* ================================================================== */

  /** Markdown 里不要出现 HTML 实体；反引号要挡掉，否则会破坏行内代码块 */
  function mdText(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/`/g, '\u0060\u200b').replace(/\r/g, '').trim();
  }

  /**
   * toMarkdown(opts) → string
   * opts: { logs, now, title, withToday }
   *   把 100 条导成一份可粘贴到群聊 / 笔记 / 公众号的文档。
   *   刻意不用 Markdown 表格：做法文案里有「|」会直接炸表格结构。
   */
  function toMarkdown(opts) {
    opts = opts || {};
    var logs = Array.isArray(opts.logs) ? opts.logs : [];
    var now = opts.now instanceof Date ? opts.now : new Date();
    var sum = summary(logs, {});
    var lines = [];
    var i, k;

    /* 每条记录按 id 汇总次数，详情里就能写「我的打卡：3 次」 */
    var hits = {};
    for (i = 0; i < logs.length; i++) {
      var lid = logs[i] && logs[i].id;
      if (!lid) { continue; }
      hits[lid] = hits[lid] || { n: 0, saved: 0, manual: 0 };
      hits[lid].n++;
      hits[lid].saved += isFinite(logs[i].saved) ? Number(logs[i].saved) : 0;
      if (logs[i].manual) { hits[lid].manual++; }
    }

    lines.push('# ' + (opts.title || '所有省钱大全') + ' · ' + ENTRIES.length + ' 条');
    lines.push('');
    lines.push('> 大学生全网省钱图谱：10 类各 10 条，全部是可执行动作，不是口号。');
    lines.push('> 生成于 ' + dateKey(now) + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) +
      ' · 金额均为估算区间，**不承诺最低价**，下单前以商家当期页面为准。');
    lines.push('');

    /* ---- 概览 ---- */
    lines.push('| | |');
    lines.push('| --- | --- |');
    lines.push('| 动作总数 | ' + ENTRIES.length + ' 条 · ' + CATS.length + ' 个分类 |');
    lines.push('| 我的打卡 | ' + sum.count + ' 次，累计约省 ¥' + fmt(sum.totalSaved) + ' |');
    if (opts.withToday !== false) {
      var today = rankToday(ENTRIES, { now: now, logs: logs, limit: 5 });
      lines.push('| 今天可用 | ' + today.length + ' 条（按你的账本排序） |');
    }
    lines.push('');

    /* ---- 目录 ---- */
    lines.push('## 目录');
    lines.push('');
    for (i = 0; i < CATS.length; i++) {
      lines.push((i + 1) + '. ' + CATS[i].emoji + ' ' + CATS[i].name + '（' + byCat(CATS[i].key).length + ' 条）');
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    /* ---- 正文：按分类分组 ---- */
    for (i = 0; i < CATS.length; i++) {
      var cat = CATS[i];
      var list = byCat(cat.key);
      lines.push('## ' + (i + 1) + '. ' + cat.emoji + ' ' + cat.name + '（' + list.length + ' 条）');
      lines.push('');
      for (k = 0; k < list.length; k++) {
        var e = list[k];
        var tag = CERT_LABEL[e.certainty] || '';
        lines.push('### ' + (k + 1) + '. ' + mdText(e.title) + (tag ? '（' + tag + '）' : ''));
        lines.push('');
        /* 「≈ 省 ¥6.00」+「¥4.00 - ¥8.00（每次估算）」拼在一起会有两层括号、两个「省」，
           导出给人读的文档要合并成一句：range → 括注区间；ratio → 括注折扣；fixed/none 不再重复。 */
        var st = e.save || {};
        var amountLine = mdText(saveText(e));
        if (st.type === 'range') {
          amountLine += '（区间 ¥' + fmt(st.min) + ' - ¥' + fmt(st.max) + '，按次估算）';
        } else if (st.type === 'ratio') {
          amountLine += '（' + ratioText(st) + '）';
        }
        lines.push('- **能省多少**：' + amountLine);
        lines.push('- **什么时候能用**：' + mdText(triggerText(e)));
        lines.push('- **用在哪**：' + mdText(sceneText(e)));
        lines.push('- **怎么做**：' + mdText(e.action));
        lines.push('- **门槛**：' + mdText(e.gate));
        lines.push('- **适合谁**：' + mdText(e.who));
        lines.push('- **坑在哪**：' + mdText(e.risk));
        lines.push('- **账本分类**：' + mdText((e.billCats || []).join(' / ') || '—'));
        lines.push('- **来源**：' + mdText(e.source || '—'));
        if (hits[e.id]) {
          lines.push('- **我的打卡**：' + hits[e.id].n + ' 次' +
            (hits[e.id].saved > 0 ? '，约省 ¥' + fmt(hits[e.id].saved) : '，未计金额') +
            (hits[e.id].manual ? '（其中 ' + hits[e.id].manual + ' 次手动改过金额）' : ''));
        }
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }

    lines.push('> 由「AI 记账 · 省钱图谱」导出。金额口径：固定省额 / 折扣比 / 区间取中位 / 无法量化不计金额；');
    lines.push('> 大促与年卡型（`once`）在 App 内只计打卡次数、不计金额，避免累计虚高。');
    lines.push('');
    return lines.join('\n');
  }

  /* ================================================================== */
  /* 导出                                                                */
  /* ================================================================== */

  var API = {
    VERSION: '1.0.0',
    READY: READY,
    ENTRIES: ENTRIES,
    CATS: CATS,
    CERT_LABEL: CERT_LABEL,
    DATA: DATA,

    /* 日期 */
    toDate: toDate, dateKey: dateKey, mmddKey: mmddKey,
    isoWeekday: isoWeekday, weekdayCn: weekdayCn, hhmm: hhmm,

    /* 计算 */
    estimateSave: estimateSave, saveText: saveText, saveRangeText: saveRangeText, ratioText: ratioText,
    matchTrigger: matchTrigger, rankToday: rankToday, scoreOne: scoreOne,
    triggerText: triggerText, sceneText: sceneText,
    search: search, entriesForBill: entriesForBill, byCat: byCat, byId: dataById,

    /* 打卡 */
    isChecked: isChecked, toggleCheck: toggleCheck, summary: summary,

    /* 渲染 */
    catMeta: catMeta, entryCardHtml: entryCardHtml, todayCardHtml: todayCardHtml,
    esc: esc, fmt: fmt,

    /* 导出 */
    toMarkdown: toMarkdown
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.savings = API;
  }
})(typeof window !== 'undefined' ? window : this);
