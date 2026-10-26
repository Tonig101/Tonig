/**
 * wishlist.js — 心愿单（冷静期清单）数据层，UMD
 *
 * 定位：把「剁手冷静法」里放下的东西留下来，48 小时后回到用户面前问一次
 *       「还想买吗」。三态：cooling（冷静中）/ bought（已买）/ dropped（已放弃）。
 *
 * 为什么要独立模块 + 独立存储键：
 *   ① 心愿单不是账单，塞进 state.bills 会污染分类占比 / 恩格尔 / 趋势；
 *   ② 清单损坏时只该重置自己，不能让用户丢真实账单（与 piggy / 省钱图谱同策略）；
 *   ③ 「省下的钱」口径沿用既有行为：入清单即计入 state.savedMoney（由 app.js 做），
 *      所以本模块只记 savedCounted 标记，成交时由 app.js 精确回退，避免双计。
 *
 * 金额约定：元 + 两位小数（与主账本一致），不做「分」的整数运算 ——
 * 心愿单只有「加 / 改状态」没有加减闭环，不需要 piggy 那套防浮点误差机制。
 *
 * 对外 API（window.AJ.wishlist）：
 *   isReady() / load() / reset()
 *   add({title,amount,note,coolDays,source}) -> {ok,item,reason}
 *   list(status) / listCooling() / get(id)
 *   progress(item,todayKey) -> {remainingDays,elapsedDays,pct,overdue}
 *   dueItems(todayKey) / decide(id,status,opts) / extend(id,days) / stats()
 *   dateKey(v) / addDays(key,n)   导出供单测与 app.js 复用
 *   __store()                     仅单测：拿内部存储对象，注入坏存档
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);

  var KEY = 'ai_jizhang_wishlist_v1';
  var VERSION = 1;
  /** 条数上限：超过就丢最旧的「已买 / 已放弃」，还在冷静中的一条都不丢 */
  var MAX_ITEMS = 200;
  /** 默认冷静期：48 小时 = 2 天 */
  var COOL_DAYS_DEFAULT = 2;
  /** 最多延长 2 次（第 3 次拒绝），每次 3 天 */
  var EXTEND_MAX = 2;
  var EXTEND_DAYS = 3;
  /** 允许的冷静期档位 */
  var COOL_DAYS_ALLOWED = [1, 2, 3, 7];
  /** 单件上限：999.9999 万元 */
  var MAX_AMOUNT = 9999999;
  var STATUSES = ['cooling', 'bought', 'dropped'];

  var db = { v: VERSION, items: [], updatedAt: 0 };
  /** 存储不可用（隐私模式 / 配额满）时为 false —— 只读展示，写入返回 reason:'store' */
  var ready = true;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function round2(n) { return Math.round(num(n) * 100) / 100; }

  function dateKey(value) {
    var d = (value === undefined || value === null) ? new Date() : new Date(value);
    if (isNaN(d.getTime())) { d = new Date(); }
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function addDays(key, days) {
    var p = String(key).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (isNaN(d.getTime())) { return key; }
    d.setDate(d.getDate() + Number(days || 0));
    return dateKey(d);
  }

  /** 两个日期键相差几天（to - from，正数表示 to 在后） */
  function diffDays(fromKey, toKey) {
    var a = String(fromKey).split('-');
    var b = String(toKey).split('-');
    var da = new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
    var dbb = new Date(Number(b[0]), Number(b[1]) - 1, Number(b[2]));
    if (isNaN(da.getTime()) || isNaN(dbb.getTime())) { return 0; }
    return Math.round((dbb.getTime() - da.getTime()) / 86400000);
  }

  function isDateKey(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }

  function uid() {
    return 'w_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 100000).toString(36);
  }

  function clampAmount(v) {
    var n = round2(v);
    if (n < 0) { return 0; }
    if (n > MAX_AMOUNT) { return MAX_AMOUNT; }
    return n;
  }

  function normalizeCoolDays(v) {
    var n = Math.round(num(v));
    return (COOL_DAYS_ALLOWED.indexOf(n) !== -1) ? n : COOL_DAYS_DEFAULT;
  }

  function normalizeStatus(v) {
    return (STATUSES.indexOf(v) !== -1) ? v : 'cooling';
  }

  /* ------------------------------------------------------------------ */
  /* 持久化                                                              */
  /* ------------------------------------------------------------------ */

  /** 逐条归一化：坏条丢弃、不牵连整库（与 piggy / 省钱图谱同策略） */
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    var title = (typeof raw.title === 'string') ? raw.title.trim() : '';
    if (!title) { return null; }                       // 没名字的条目没有意义，直接丢
    title = title.slice(0, 40);
    var coolDays = normalizeCoolDays(raw.coolDays);
    var source = (raw.source === 'cooling') ? 'cooling' : 'manual';
    var startDate = isDateKey(raw.startDate) ? raw.startDate : dateKey(new Date());
    var dueDate = isDateKey(raw.dueDate) ? raw.dueDate : addDays(startDate, coolDays);
    var ext = Math.round(num(raw.extendCount));
    if (ext < 0) { ext = 0; }
    if (ext > EXTEND_MAX) { ext = EXTEND_MAX; }
    return {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : uid(),
      title: title,
      amount: clampAmount(raw.amount),
      note: (typeof raw.note === 'string') ? raw.note.slice(0, 60) : '',
      status: normalizeStatus(raw.status),
      startDate: startDate,
      dueDate: dueDate,
      coolDays: coolDays,
      extendCount: ext,
      source: source,
      // 归一化时只能「猜」：cooling 来源默认已计入省下的钱，其余默认不计
      savedCounted: (typeof raw.savedCounted === 'boolean') ? raw.savedCounted : (source === 'cooling'),
      billId: (typeof raw.billId === 'string') ? raw.billId : '',
      createdAt: isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
      decidedAt: isFinite(Number(raw.decidedAt)) ? Number(raw.decidedAt) : 0
    };
  }

  function normalizeDb(obj) {
    var o = (obj && typeof obj === 'object') ? obj : {};
    var src = Array.isArray(o.items) ? o.items : [];
    var out = [];
    var seen = {};
    var i;
    for (i = 0; i < src.length; i++) {
      var it = normalizeItem(src[i]);
      if (!it) { continue; }
      if (seen[it.id]) { continue; }                    // id 重复只留第一条
      seen[it.id] = 1;
      out.push(it);
    }
    return {
      v: VERSION,
      items: out,
      updatedAt: isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : 0
    };
  }

  function emptyDb() { return { v: VERSION, items: [], updatedAt: 0 }; }

  /**
   * 取存储对象：浏览器用 localStorage，Node（单测）用进程内内存库，
   * 这样 add / decide 的落盘与回滚在单测里也能真实验证。
   */
  var memStore = null;
  function storage() {
    if (isNode) {
      if (!memStore) {
        memStore = {
          _d: {},
          getItem: function (k) {
            return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null;
          },
          setItem: function (k, v) { this._d[k] = String(v); },
          removeItem: function (k) { delete this._d[k]; }
        };
      }
      return memStore;
    }
    try {
      return global.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  /** 读入：老账本没有这个键 → 空库且不写盘（首次 add 才落盘） */
  function load() {
    var ls = storage();
    if (!ls) { ready = false; db = emptyDb(); return db; }
    var raw = null;
    try {
      raw = ls.getItem(KEY);
    } catch (e) {
      ready = false;
      db = emptyDb();
      return db;
    }
    if (!raw) { db = emptyDb(); return db; }
    try {
      db = normalizeDb(JSON.parse(raw));
    } catch (e2) {
      // 存档坏了：只把心愿单清空，绝不动主账本；ready 保持 true（清空后仍能写）
      db = emptyDb();
    }
    return db;
  }

  function save() {
    var ls = storage();
    if (!ls) { ready = false; return false; }
    try {
      db.updatedAt = Date.now();
      ls.setItem(KEY, JSON.stringify(db));
      ready = true;
      return true;
    } catch (e) {
      ready = false;
      return false;
    }
  }

  function reset() {
    db = emptyDb();
    return save();
  }

  /* ------------------------------------------------------------------ */
  /* 读写                                                                */
  /* ------------------------------------------------------------------ */

  function failResult(reason) {
    return { ok: false, item: null, reason: reason };
  }

  /** 清位：超上限时优先丢最旧的「已买 / 已放弃」，仍在冷静期的一条都不动 */
  function makeRoom() {
    if (db.items.length < MAX_ITEMS) { return true; }
    var idx = -1;
    for (var i = 0; i < db.items.length; i++) {
      var it = db.items[i];
      if (it.status === 'cooling') { continue; }
      if (idx === -1) { idx = i; continue; }
      if ((it.createdAt || 0) < (db.items[idx].createdAt || 0)) { idx = i; }
    }
    if (idx === -1) { return false; }
    db.items.splice(idx, 1);
    return db.items.length < MAX_ITEMS;
  }

  /**
   * 新增一条心愿。
   * @param {{title:string, amount:number, note:string, coolDays:number, source:string}} o
   * @return {{ok:boolean, item:?Object, reason:?string}} reason: title|full|store
   */
  function add(o) {
    var src = o || {};
    var title = (typeof src.title === 'string') ? src.title.trim() : '';
    if (!title) { return failResult('title'); }
    if (!makeRoom()) { return failResult('full'); }

    var coolDays = normalizeCoolDays(src.coolDays);
    var startDate = dateKey(new Date());
    var item = {
      id: uid(),
      title: title.slice(0, 40),
      amount: clampAmount(src.amount),
      note: (typeof src.note === 'string') ? src.note.slice(0, 60) : '',
      status: 'cooling',
      startDate: startDate,
      dueDate: addDays(startDate, coolDays),
      coolDays: coolDays,
      extendCount: 0,
      source: (src.source === 'cooling') ? 'cooling' : 'manual',
      savedCounted: (src.source === 'cooling'),
      billId: '',
      createdAt: Date.now(),
      decidedAt: 0
    };
    db.items.push(item);
    if (!save()) {
      // 写不进去就撤回来，避免「界面显示加了、刷新后没了」
      db.items.pop();
      return failResult('store');
    }
    return { ok: true, item: item, reason: null };
  }

  /** 列表：省略 status 返回全部；统一 createdAt 倒序（新的在前） */
  function list(status) {
    var arr = db.items.slice();
    if (status) {
      arr = arr.filter(function (it) { return it.status === status; });
    }
    arr.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return arr;
  }

  function listCooling() { return list('cooling'); }

  function get(id) {
    for (var i = 0; i < db.items.length; i++) {
      if (db.items[i].id === id) { return db.items[i]; }
    }
    return null;
  }

  /**
   * 冷静期进度。
   * @return {{remainingDays:number, elapsedDays:number, pct:number, overdue:boolean}}
   *   remainingDays 正数=还剩几天，0=今天到期，负数=已逾期
   */
  function progress(item, todayKey) {
    var it = (item && typeof item === 'object') ? item : {};
    var today = isDateKey(todayKey) ? todayKey : dateKey(new Date());
    var due = isDateKey(it.dueDate) ? it.dueDate : today;
    var start = isDateKey(it.startDate) ? it.startDate : today;
    var coolDays = Math.max(1, Math.round(num(it.coolDays) || COOL_DAYS_DEFAULT));
    var remainingDays = diffDays(today, due);
    var elapsedDays = diffDays(start, today);
    var pct = Math.round(elapsedDays / coolDays * 100);
    if (pct < 0) { pct = 0; }
    if (pct > 100) { pct = 100; }
    return {
      remainingDays: remainingDays,
      elapsedDays: elapsedDays,
      pct: pct,
      overdue: remainingDays < 0
    };
  }

  /** 已到期（dueDate <= 今天）且仍在冷静中的条目 */
  function dueItems(todayKey) {
    var today = isDateKey(todayKey) ? todayKey : dateKey(new Date());
    return listCooling().filter(function (it) { return it.dueDate <= today; });
  }

  /**
   * 做决策：bought（买了）/ dropped（算了不买了）。
   * 只有仍在 cooling 的条目能决策，重复决策返回 reason:'state'。
   * @param {string} id
   * @param {string} status bought|dropped
   * @param {{billId:string}} [opts] 成交时关联的账单 id
   */
  function decide(id, status, opts) {
    if (status !== 'bought' && status !== 'dropped') { return failResult('state'); }
    var it = get(id);
    if (!it || it.status !== 'cooling') { return failResult('state'); }
    var prevStatus = it.status;
    var prevAt = it.decidedAt;
    var prevBill = it.billId;
    it.status = status;
    it.decidedAt = Date.now();
    it.billId = (opts && typeof opts.billId === 'string') ? opts.billId : '';
    if (!save()) {
      it.status = prevStatus;
      it.decidedAt = prevAt;
      it.billId = prevBill;
      return failResult('store');
    }
    return { ok: true, item: it, reason: null };
  }

  /**
   * 再冷静几天。
   * @param {string} id
   * @param {number} [days] 默认 EXTEND_DAYS
   * @return {{ok:boolean, item:?Object, reason:?string}} reason: max|state|store
   */
  function extend(id, days) {
    var it = get(id);
    if (!it || it.status !== 'cooling') { return failResult('state'); }
    if (it.extendCount >= EXTEND_MAX) { return failResult('max'); }
    var n = Math.round(num(days));
    if (!(n > 0)) { n = EXTEND_DAYS; }
    var prevDue = it.dueDate;
    var prevCount = it.extendCount;
    it.dueDate = addDays(it.dueDate, n);
    it.extendCount = prevCount + 1;
    if (!save()) {
      it.dueDate = prevDue;
      it.extendCount = prevCount;
      return failResult('store');
    }
    return { ok: true, item: it, reason: null };
  }

  /**
   * 删除一条心愿（「清理痕迹」，不是决策 —— 状态机不变，只把条目拿掉）。
   * 冷静中的条目被删除后，调用方若已把金额计入「省下的钱」必须自己回退，
   * 所以返回被删掉的条目，让上层按 savedCounted 决定怎么冲账。
   * @param {string} id
   * @return {{ok:boolean, item:?Object, reason:?string}} reason: notfound|store
   */
  function remove(id) {
    if (typeof id !== 'string' || !id) { return { ok: false, item: null, reason: 'notfound' }; }
    var idx = -1;
    for (var i = 0; i < db.items.length; i++) {
      if (db.items[i].id === id) { idx = i; break; }
    }
    if (idx === -1) { return { ok: false, item: null, reason: 'notfound' }; }
    var removed = db.items.splice(idx, 1)[0];
    if (!save()) {
      db.items.splice(idx, 0, removed);
      return { ok: false, item: null, reason: 'store' };
    }
    return { ok: true, item: removed, reason: null };
  }

  /**
   * 汇总：省下的钱只算「已放弃 且 当初已计入 savedMoney」的那些，
   * 买了的（savedCounted 已在成交时回退）与手工加的一条都不算，避免双计。
   */  function stats() {
    var st = {
      cooling: 0, bought: 0, dropped: 0,
      coolingAmount: 0, droppedAmount: 0, boughtAmount: 0, savedAmount: 0
    };
    for (var i = 0; i < db.items.length; i++) {
      var it = db.items[i];
      var amount = round2(it.amount);
      if (it.status === 'cooling') {
        st.cooling++;
        st.coolingAmount = round2(st.coolingAmount + amount);
      } else if (it.status === 'bought') {
        st.bought++;
        st.boughtAmount = round2(st.boughtAmount + amount);
      } else if (it.status === 'dropped') {
        st.dropped++;
        st.droppedAmount = round2(st.droppedAmount + amount);
        if (it.savedCounted) { st.savedAmount = round2(st.savedAmount + amount); }
      }
    }
    return st;
  }

  var API = {
    KEY: KEY,
    VERSION: VERSION,
    MAX_ITEMS: MAX_ITEMS,
    COOL_DAYS_DEFAULT: COOL_DAYS_DEFAULT,
    EXTEND_MAX: EXTEND_MAX,
    EXTEND_DAYS: EXTEND_DAYS,

    isReady: function () { return ready && !!storage(); },
    load: load,
    reset: reset,

    add: add,
    list: list,
    listCooling: listCooling,
    get: get,
    progress: progress,
    dueItems: dueItems,
    decide: decide,
    extend: extend,
    remove: remove,
    stats: stats,

    dateKey: dateKey,
    addDays: addDays,
    /* 仅供单测：拿到内部存储对象，用于注入坏存档验证容错（生产代码请勿调用） */
    __store: storage
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.wishlist = API;
  }
})(typeof window !== 'undefined' ? window : this);
