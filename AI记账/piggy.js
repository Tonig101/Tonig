/**
 * piggy.js — 存钱罐模块（纯逻辑 + 鼓励话术，UMD）
 *
 * 定位：把「账面可用余额」里的一部分钱挪进罐子锁起来，
 *       与账单流水（state.bills）**完全解耦**，不写账单、不改分类统计。
 *
 * 为什么要独立一个模块 + 独立存储键：
 *   ① 存钱不是消费，塞进 state.bills 会污染分类占比 / 恩格尔系数 / 近 7 日趋势；
 *   ② 罐子数据损坏时只应重置自己，不能让用户丢掉真实账单（与省钱图谱同理）；
 *   ③ 主账本对存钱罐只有「读余额」这一个依赖点，删掉本文件主程序照样能跑。
 *
 * 金额约定：**内部一律用「分」的整数**存储与计算（避免 0.1+0.2 这类浮点误差），
 * 对外展示时才转成元。这与主账本（元 + round2）不同，是刻意选择：
 * 罐子要做「存入 / 取出」的加减闭环，整数分能保证存满再取空后余额精确回到 0。
 *
 * 对外 API（window.AJ.piggy）：
 *   isReady()                     存储是否可用（隐私模式下为 false）
 *   load()                        从 localStorage 读入，失败时降级为空库
 *   getBalanceCents() / getBalance()   当前罐内余额（分 / 元）
 *   deposit(cents, note)          存入 → {ok,log,balanceCents}|{ok:false,reason}
 *   withdraw(cents, note)         取出 → 同上
 *   listLogs(limit)               流水（新的在前）
 *   stats()                       {balanceCents,count,depositCount,days,streak,todayCents,biggestCents,firstDate,lastDate}
 *   cheer(ctx)                    鼓励话术 → {emoji,title,text}（emoji 字段现在存 #i-xxx 的 symbol 名）
 *   parseAmount(text)             '50' / '50.5' / '￥50元' → 5000（分），非法返回 null
 *   fmtCents(cents)               5000 → '¥50.00'
 *   reset()                       清空罐子（供「重置演示数据」调用）
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);

  var KEY = 'ai_jizhang_piggy_v1';
  var VERSION = 1;
  /** 流水上限：超过后丢最旧的，防止无界增长 */
  var MAX_LOGS = 500;
  /** 单笔上限：100 万元（分） */
  var MAX_CENTS = 100000000;
  /** 单笔下限：0.01 元 */
  var MIN_CENTS = 1;

  /**
   * 库结构：balance 是**权威余额**（分），logs 只用于展示。
   * 为什么余额要单独存：logs 有 500 条上限，超了会丢最旧的记录，
   * 只靠 logs 累加会让「存了很多笔」的老用户余额凭空变少。
   */
  var db = { v: VERSION, balance: 0, logs: [], updatedAt: 0 };
  /** 存储不可用（隐私模式 / 配额满）时为 false —— 只读展示，写入返回 reason:'store' */
  var ready = true;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function dateKey(value) {
    var d = (value === undefined || value === null) ? new Date() : new Date(value);
    if (isNaN(d.getTime())) { d = new Date(); }
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function addDays(key, days) {
    var p = String(key).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (isNaN(d.getTime())) { return key; }
    d.setDate(d.getDate() + days);
    return dateKey(d);
  }

  /** 元 → 分（四舍五入到分）。非有限数或负数返回 null。 */
  function toCents(yuan) {
    var v = Number(yuan);
    if (!isFinite(v) || v < 0) { return null; }
    return Math.round(v * 100);
  }

  /** 分 → '¥1,234.00'（与 engine.fmtMoney 同形，模块内自带以便单测） */
  function fmtCents(cents) {
    var v = Math.round(Number(cents) || 0);
    var neg = v < 0;
    var abs = Math.abs(v);
    var s = Math.floor(abs / 100) + '.' + pad2(abs % 100);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-¥' : '¥') + parts[0] + '.' + parts[1];
  }

  function uid() {
    return 'p_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 100000).toString(36);
  }

  /* ------------------------------------------------------------------ */
  /* 持久化                                                              */
  /* ------------------------------------------------------------------ */

  function normalizeLog(r) {
    if (!r || typeof r !== 'object') { return null; }
    var cents = Math.round(Number(r.cents));
    if (!isFinite(cents) || cents <= 0) { return null; }
    var type = (r.type === 'out') ? 'out' : 'in';
    var date = (typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) ? r.date : '';
    if (!date) { return null; }
    return {
      id: (typeof r.id === 'string' && r.id) ? r.id : uid(),
      date: date,
      type: type,
      cents: Math.min(cents, MAX_CENTS),
      note: typeof r.note === 'string' ? r.note.slice(0, 40) : '',
      at: isFinite(Number(r.at)) ? Number(r.at) : Date.now()
    };
  }

  /** 逐条归一化：坏条丢弃、不牵连整库（与省钱图谱同策略） */
  function normalizeDb(obj) {
    var o = (obj && typeof obj === 'object') ? obj : {};
    var src = Array.isArray(o.logs) ? o.logs : [];
    var out = [];
    var seen = {};
    var fromLogs = 0;
    for (var i = 0; i < src.length; i++) {
      var r = normalizeLog(src[i]);
      if (!r) { continue; }
      var k = r.id;
      if (seen[k]) { continue; }
      seen[k] = 1;
      out.push(r);
      fromLogs += (r.type === 'out' ? -r.cents : r.cents);
    }
    // balance 缺失 / 非法时用流水重算（旧存档兼容）；否则以 balance 为准
    var bal = Math.round(Number(o.balance));
    if (!isFinite(bal) || bal < 0 || bal > MAX_CENTS * 10) { bal = Math.max(0, fromLogs); }
    return {
      v: VERSION,
      balance: bal,
      logs: out,
      updatedAt: isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : 0
    };
  }

  /**
   * 取存储对象。
   * 浏览器用 localStorage；Node（单测）用进程内内存库，
   * 这样 deposit / withdraw 的闭环在单测里也能真实落盘校验。
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
          setItem: function (k, v) { this._d[k] = String(v); }
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

  function load() {
    var ls = storage();
    if (!ls) { ready = false; db = { v: VERSION, balance: 0, logs: [], updatedAt: 0 }; return db; }
    var raw = null;
    try {
      raw = ls.getItem(KEY);
    } catch (e) {
      ready = false;
      db = { v: VERSION, balance: 0, logs: [], updatedAt: 0 };
      return db;
    }
    if (!raw) { db = { v: VERSION, balance: 0, logs: [], updatedAt: 0 }; return db; }
    try {
      db = normalizeDb(JSON.parse(raw));
    } catch (e2) {
      // 存档坏了：只把罐子清空，绝不动主账本
      db = { v: VERSION, balance: 0, logs: [], updatedAt: 0 };
    }
    return db;
  }

  function save() {
    var ls = storage();
    if (!ls) { ready = false; return false; }
    try {
      db.updatedAt = Date.now();
      ls.setItem(KEY, JSON.stringify(db));
      return true;
    } catch (e) {
      ready = false;
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 读写                                                                */
  /* ------------------------------------------------------------------ */

  /** 罐内余额（分）：以权威字段为准，流水只做展示 */
  function getBalanceCents() {
    return Math.round(Number(db.balance) || 0);
  }

  function getBalance() {
    return getBalanceCents() / 100;
  }

  /**
   * 存入。
   * @param {number} cents 金额（分，正整数）
   * @param {string} [note] 备注
   * @return {{ok:boolean, log:?Object, balanceCents:number, reason:?string}}
   */
  /**
   * 校验金额是不是合法的「分」。
   * 注意：不做 Math.round —— 0.5 分这种非整数输入必须判非法，
   * 否则「存 0.5 分」会被悄悄记成 1 分，账就对不上了。
   */
  function validCents(cents) {
    var c = Number(cents);
    if (!isFinite(c) || Math.floor(c) !== c || c > 9007199254740991) { return -1; }
    return c;
  }

  function deposit(cents, note) {
    var c = validCents(cents);
    if (c < MIN_CENTS) { return fail('amount'); }
    if (c > MAX_CENTS) { return fail('toolarge'); }
    var log = {
      id: uid(),
      date: dateKey(new Date()),
      type: 'in',
      cents: c,
      note: typeof note === 'string' ? note.slice(0, 40) : '',
      at: Date.now()
    };
    db.logs.push(log);
    if (db.logs.length > MAX_LOGS) { db.logs = db.logs.slice(db.logs.length - MAX_LOGS); }
    db.balance = getBalanceCents() + c;
    if (!save()) {
      // 写不进去就把这条撤回来，避免「界面显示存了、刷新后没了」
      db.logs.pop();
      db.balance = getBalanceCents() - c;
      return fail('store');
    }
    return { ok: true, log: log, balanceCents: getBalanceCents(), reason: null };
  }

  /**
   * 取出。
   * @param {number} cents 金额（分）；不传或超过余额时按「全部取出」处理
   */
  function withdraw(cents, note) {
    var bal = getBalanceCents();
    if (bal <= 0) { return fail('empty'); }
    var c = validCents(cents);
    if (c <= 0 || c > bal) { c = bal; }
    var log = {
      id: uid(),
      date: dateKey(new Date()),
      type: 'out',
      cents: c,
      note: typeof note === 'string' ? note.slice(0, 40) : '',
      at: Date.now()
    };
    db.logs.push(log);
    if (db.logs.length > MAX_LOGS) { db.logs = db.logs.slice(db.logs.length - MAX_LOGS); }
    db.balance = bal - c;
    if (!save()) {
      db.logs.pop();
      db.balance = bal;
      return fail('store');
    }
    return { ok: true, log: log, balanceCents: getBalanceCents(), reason: null };
  }

  function fail(reason) {
    return { ok: false, log: null, balanceCents: getBalanceCents(), reason: reason };
  }

  /** 最近的流水（新的在前） */
  function listLogs(limit) {
    var n = (limit === undefined || limit === null) ? db.logs.length : Math.max(0, Math.round(limit));
    var arr = db.logs.slice().sort(function (a, b) {
      return (b.at || 0) - (a.at || 0);
    });
    return n >= arr.length ? arr : arr.slice(0, n);
  }

  /**
   * 汇总统计。
   * streak = 连续存钱天数（今天还没存时从昨天往前算，不会一早就断签）
   */
  function stats() {
    var balance = getBalanceCents();
    var count = 0;
    var days = {};
    var inDays = {};
    var first = '';
    var last = '';
    var todayKey = dateKey(new Date());
    var todayCents = 0;
    var biggest = 0;
    var i;
    for (i = 0; i < db.logs.length; i++) {
      var l = db.logs[i];
      days[l.date] = 1;
      if (l.type === 'in') {
        count++;
        inDays[l.date] = 1;
        if (l.date === todayKey) { todayCents += l.cents; }
        if (l.cents > biggest) { biggest = l.cents; }
        if (!first || l.date < first) { first = l.date; }
        if (!last || l.date > last) { last = l.date; }
      }
    }
    var streak = 0;
    var cur = todayKey;
    if (!inDays[cur]) { cur = addDays(cur, -1); }
    while (inDays[cur]) {
      streak++;
      cur = addDays(cur, -1);
    }
    return {
      balanceCents: balance,
      count: count,
      depositCount: count,
      days: Object.keys(days).length,
      streak: streak,
      todayCents: todayCents,
      biggestCents: biggest,
      firstDate: first,
      lastDate: last
    };
  }

  function reset() {
    db = { v: VERSION, balance: 0, logs: [], updatedAt: 0 };
    return save();
  }

  /* ------------------------------------------------------------------ */
  /* 输入解析                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 解析用户输入的金额文本 → 分。
   * 允许：'50' / '50.5' / '50.00' / '￥50' / '50元' / '１２０'（全角数字）
   * 拒绝：空 / 非数字 / 0 / 负数 / 科学计数法 → null
   */
  function parseAmount(text) {
    if (text === null || text === undefined) { return null; }
    var s = String(text).trim();
    if (!s) { return null; }
    // 全角数字 + 全角句点转半角
    s = s.replace(/[\uFF10-\uFF19]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    }).replace(/\uFF0E/g, '.');
    // 去掉货币符与单位、千分位
    s = s.replace(/[¥￥$,\s元块]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) {
      // 允许 3 位以上小数，四舍五入到分
      if (!/^\d+(\.\d+)?$/.test(s)) { return null; }
    }
    var cents = toCents(s);
    if (cents === null || cents < MIN_CENTS) { return null; }
    return Math.min(cents, MAX_CENTS);
  }

  /* ------------------------------------------------------------------ */
  /* 鼓励话术                                                            */
  /* ------------------------------------------------------------------ */

  /** 里程碑：跨过就换一句更有分量的话 */
  var MILESTONES = [
    { cents: 10000, text: '破百了！第一个一百块最难，后面会越来越快。' },
    { cents: 50000, text: '五百块在手，已经够一台二手平板或者一次说走就走的短途。' },
    { cents: 100000, text: '一千块！这在学生阶段是一笔正经的「底气钱」了。' },
    { cents: 300000, text: '三千块，你已经攒下了一个月的容错空间。' }
  ];

  /** 按单笔金额分档的主话术 */
  function tierLines(amountCents, balanceCents) {
    var yuan = amountCents / 100;
    if (yuan < 5) {
      return [
        '几块钱也是钱，攒钱的习惯比金额更值钱。',
        '小钱不嫌少，罐子就是靠这种「顺手一存」长大的。',
        '别小看这几块，月底你会感谢现在顺手存下的自己。'
      ];
    }
    if (yuan < 20) {
      return [
        '一杯奶茶的钱换成了存款，这波很清醒。',
        '这笔存下来，等于把一次冲动消费提前拦住了。',
        '一顿饭钱进罐子，嘴上省一口，心里踏实一分。'
      ];
    }
    if (yuan < 100) {
      return [
        '这个数额刚刚好，既存下了钱，又不影响这几天吃饭。',
        '稳，这笔存得很有分寸。',
        '把钱先挪进罐子，剩下的才是真能花的额度。'
      ];
    }
    if (yuan < 500) {
      return [
        '手笔不小！这笔存下去，本月的存款曲线会很明显。',
        '这一下够实在的，月底你会看到差距。',
        '大笔先锁起来，是防止它被「不知道怎么就没了」的最好办法。'
      ];
    }
    return [
      '这一笔相当有魄力，你对自己挺狠的（褒义）。',
      '大额先入罐，这个决定比买任何东西都值。',
      '敢一次性存这么多，说明你心里有数了。'
    ];
  }

  /** 连续存钱的加成话术 */
  function streakLines(streak) {
    if (streak >= 7) { return '已经连续 ' + streak + ' 天往里存了，这个节奏别断。'; }
    if (streak >= 3) { return '连续 ' + streak + ' 天，习惯正在成型，继续保持。'; }
    if (streak >= 2) { return '这是连续第 ' + streak + ' 天，第二天是最容易断的，你顶住了。'; }
    return '';
  }

  /** 余额偏紧还坚持存的特别鼓励 */
  function tightLines(remainingCents, dailyCents) {
    if (remainingCents === null || remainingCents === undefined) { return ''; }
    if (remainingCents <= 0) { return ''; }
    if (dailyCents && remainingCents < dailyCents * 3) {
      return '现在账面不算宽裕，你还在存钱，这份克制值得记一笔。';
    }
    if (remainingCents < 10000) {
      return '余额已经不多了，记得给吃饭留够钱，存钱可以随时停。';
    }
    return '';
  }

  /**
   * 生成鼓励话术（纯函数，便于单测）。
   * @param {Object} ctx
   *   amountCents     本次存入金额（分）
   *   balanceCents    存入后罐内余额（分）
   *   countBefore     本次之前的存入笔数
   *   streak          连续存钱天数
   *   remainingCents  存入后账面可用余额（分），可省略
   *   dailyCents      日均可用（分），可省略
   * @return {{emoji:string, title:string, text:string}}
   */
  function cheer(ctx) {
    var c = ctx || {};
    var amount = Math.round(Number(c.amountCents) || 0);
    var balance = Math.round(Number(c.balanceCents) || 0);
    var countBefore = Math.round(Number(c.countBefore) || 0);
    var streak = Math.round(Number(c.streak) || 0);
    var remaining = (c.remainingCents === null || c.remainingCents === undefined)
      ? null : Math.round(Number(c.remainingCents));
    var daily = (c.dailyCents === null || c.dailyCents === undefined) ? null : Math.round(Number(c.dailyCents));

    var icon = 'target';
    var title;
    var lines;

    if (countBefore === 0) {
      icon = 'spark';
      title = '第一笔存钱，开罐大吉！';
      lines = ['你把钱放进罐子的那一刻，攒钱就算真的开始了。',
        '不着急，金额不重要，重要的是你开始「先存后花」了。'];
    } else {
      lines = tierLines(amount, balance);
      title = '又存下 ' + fmtCents(amount);
    }

    // 里程碑：本次刚跨过某条线
    var before = balance - amount;
    var milestone = '';
    for (var i = 0; i < MILESTONES.length; i++) {
      if (before < MILESTONES[i].cents && balance >= MILESTONES[i].cents) {
        milestone = MILESTONES[i].text;
        icon = 'piggy';
        break;
      }
    }

    var pick = lines[countBefore % lines.length];
    var extra = milestone || streakLines(streak) || tightLines(remaining, daily) || '';
    if (!extra) {
      // 兜底补一句进度提示，保证每次都有「下一句」而不是干巴巴一句
      extra = '罐子里现在一共 ' + fmtCents(balance) + '，离下一个整数还差 ' +
        fmtCents(nextStepCents(balance)) + '。';
    }

    return {
      emoji: icon,
      title: title,
      text: pick + (extra ? ' ' + extra : '')
    };
  }

  /** 距离下一个「整百 / 整千」还差多少分 */
  function nextStepCents(balanceCents) {
    var b = Math.max(0, Math.round(balanceCents));
    var step = b < 10000 ? 10000 : (b < 100000 ? 10000 : 100000);
    var next = Math.floor(b / step) * step + step;
    return next - b;
  }

  /* ------------------------------------------------------------------ */

  var API = {
    KEY: KEY,
    VERSION: VERSION,
    MAX_CENTS: MAX_CENTS,

    isReady: function () { return ready && !!storage(); },
    load: load,
    reset: reset,

    getBalanceCents: getBalanceCents,
    getBalance: getBalance,
    deposit: deposit,
    withdraw: withdraw,
    listLogs: listLogs,
    stats: stats,

    cheer: cheer,
    parseAmount: parseAmount,
    fmtCents: fmtCents,
    nextStepCents: nextStepCents,
    dateKey: dateKey,
    /* 仅供单测：拿到内部存储对象，用于注入坏存档验证容错（生产代码请勿调用） */
    __store: storage
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.piggy = API;
  }
})(typeof window !== 'undefined' ? window : this);
