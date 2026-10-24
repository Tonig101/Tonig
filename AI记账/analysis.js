/**
 * analysis.js — 账单导入分析（支付宝 / 微信 / 银行 CSV）
 *
 * 全局命名空间：window.AJ.analysis
 * Node 单测：require('./analysis.js')
 *
 * 纯函数，无 DOM / 无网络依赖。负责：
 *   ① 字节解码（UTF-8 严格 → GBK 兜底）
 *   ② CSV 状态机解析（正确处理引号内逗号与转义双引号）
 *   ③ 表头模糊定位（跳过导出文件顶部的多行说明）
 *   ④ 列映射、金额清洗、收支方向判定、分类映射、去重
 *   ⑤ 9 节报告 report(rows, opts) / 建议 insights(report, budgetState) / Markdown 导出
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);
  var DATA;
  var NLP;
  var ENG;

  if (isNode) {
    DATA = require('./data.js');
    NLP = require('./nlp.js');
    ENG = require('./engine.js');
  } else {
    global.AJ = global.AJ || {};
    DATA = global.AJ.data;
    NLP = global.AJ.nlp;
    ENG = global.AJ.engine;
  }

  var MS_PER_DAY = 24 * 60 * 60 * 1000;
  var INCOME_CATEGORY = DATA.INCOME_CATEGORY || '收入';

  /* ================================================================== */
  /* 基础工具                                                            */
  /* ================================================================== */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function round2(n) {
    var v = Number(n);
    if (!isFinite(v)) { return 0; }
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  /** 统一金额展示：¥1,234.50 */
  function money(n) {
    var v = round2(n);
    var neg = v < 0;
    var s = Math.abs(v).toFixed(2).split('.');
    s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-¥' : '¥') + s[0] + '.' + s[1];
  }

  /** 百分比展示：43.2% */
  function percent(n, digits) {
    var v = Number(n);
    if (!isFinite(v)) { return '—'; }
    return v.toFixed(typeof digits === 'number' ? digits : 1) + '%';
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function sum(arr, pick) {
    var total = 0;
    var i;
    for (i = 0; i < arr.length; i++) {
      total += num(pick ? pick(arr[i]) : arr[i]);
    }
    return round2(total);
  }

  function toDate(value) {
    if (value instanceof Date) {
      return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      var p = value.slice(0, 10).split('-');
      return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    }
    return new Date(value === undefined || value === null ? Date.now() : value);
  }

  function formatDate(date) {
    var d = toDate(date);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function currentMonth() {
    return formatDate(new Date()).slice(0, 7);
  }

  function monthKeyOf(dateStr) {
    return String(dateStr || '').slice(0, 7);
  }

  /** month 'YYYY-MM' 平移 delta 个月 */
  function shiftMonth(month, delta) {
    var p = String(month || currentMonth()).split('-');
    var y = Number(p[0]);
    var m = Number(p[1]) - 1;
    var d = new Date(y, m + (delta || 0), 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  /** 该月天数 */
  function daysInMonth(month) {
    var p = String(month || currentMonth()).split('-');
    return new Date(Number(p[0]), Number(p[1]), 0).getDate();
  }

  /** 0=周日 … 6=周六 */
  function weekdayOf(dateStr) {
    return toDate(dateStr).getDay();
  }

  function isWeekend(dateStr) {
    var w = weekdayOf(dateStr);
    return w === 0 || w === 6;
  }

  /* ================================================================== */
  /* ① 解码                                                              */
  /* ================================================================== */

  function toBytes(input) {
    if (!input) { return null; }
    if (typeof input === 'string') { return null; }
    if (typeof Uint8Array !== 'undefined' && input instanceof Uint8Array) { return input; }
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    if (input && input.buffer && typeof input.byteLength === 'number') {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    return null;
  }

  var GARBLED_REASON = '无法识别文件编码';

  /**
   * 判断解码结果是否「全是乱码」。
   * TextDecoder('gbk') 对任意字节都不会抛错，因此必须用替换字符与不可见控制字符
   * 的占比来判断：超过 30% 视为不是文本文件（PDF / xlsx / 二进制）。
   * @param {string} text
   * @return {boolean}
   */
  function isGarbled(text) {
    var s = String(text === undefined || text === null ? '' : text);
    var len = s.length;
    if (len === 0) { return false; }
    var bad = 0;
    var i;
    for (i = 0; i < len; i++) {
      var code = s.charCodeAt(i);
      if (code === 0xFFFD) { bad++; continue; }
      if (code === 0x09 || code === 0x0A || code === 0x0D) { continue; }
      if (code < 0x20) { bad++; continue; }
      if (code >= 0x7F && code <= 0xA0) { bad++; }
    }
    return (bad / len) > 0.3;
  }

  /** 取文本前 n 个非空行（用于解析失败时的诊断预览） */
  function firstLines(text, n) {
    var arr = String(text === undefined || text === null ? '' : text)
      .split('\n')
      .map(function (l) { return String(l || '').replace(/\r$/, ''); })
      .filter(function (l) { return l.trim().length > 0; });
    return arr.slice(0, n || 4).join('\n');
  }

  /** 粗略判断一段字节是否像是 PDF / Excel 等二进制（不是文本 CSV） */
  function looksBinary(bytes) {
    if (!bytes) { return false; }
    var b = toBytes(bytes);
    if (!b) { return false; }
    var len = Math.min(b.length, 512);
    var i;
    // PDF 以 %PDF 开头
    if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
      return true;
    }
    // 大量 NUL 字节（xlsx/zip 等）视为二进制
    var nul = 0;
    for (i = 0; i < len; i++) { if (b[i] === 0x00) { nul += 1; } }
    return len > 0 && (nul / len) > 0.05;
  }

  /**
   * 字节 → 文本。先按 UTF-8 严格解码（fatal），失败再用 GBK/GB18030 兜底。
   * 每次解码后都做乱码校验，避免把二进制文件当 GBK 硬解成一大段乱码。
   * @param {ArrayBuffer|Uint8Array} input
   * @return {{ok:boolean, text:string, encoding:string, reason:string}}
   */
  function decodeBytes(input) {
    var bytes = toBytes(input);
    if (!bytes) {
      return { ok: false, text: '', encoding: '', reason: GARBLED_REASON };
    }
    var hasTextDecoder = (typeof TextDecoder !== 'undefined');
    if (!hasTextDecoder) {
      return { ok: false, text: '', encoding: '', reason: '当前浏览器不支持 TextDecoder，无法解析文件' };
    }

    var text = null;
    var encoding = '';
    try {
      var utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!isGarbled(utf8)) {
        text = utf8;
        encoding = 'utf-8';
      }
    } catch (e1) {
      text = null;
    }
    if (text === null) {
      var charsets = ['gbk', 'gb18030', 'big5'];
      var i;
      for (i = 0; i < charsets.length; i++) {
        var candidate = null;
        try {
          // gbk 解码不会抛错，只要浏览器实现支持该编码即可
          candidate = new TextDecoder(charsets[i]).decode(bytes);
        } catch (e2) {
          candidate = null;
        }
        if (candidate === null || isGarbled(candidate)) { continue; }
        text = candidate;
        encoding = charsets[i];
        break;
      }
    }
    if (text === null || typeof text !== 'string') {
      return { ok: false, text: '', encoding: '', reason: GARBLED_REASON };
    }
    if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); }
    // 某些 GBK 实现会把不认识的字节解成 U+FFFD，这里顺手规整一下换行
    return { ok: true, text: text.replace(/\r\n?/g, '\n'), encoding: encoding, reason: '' };
  }

  /* ================================================================== */
  /* ② CSV 解析（逐字符状态机）                                          */
  /* ================================================================== */

  /**
   * 检测分隔符：前 30 行里逗号 / 制表符 / 分号谁多就用谁。
   * @param {string} text
   * @return {string}
   */
  function detectDelimiter(text) {
    var lines = String(text || '').split('\n').slice(0, 30);
    var counts = { ',': 0, '\t': 0, ';': 0 };
    var i;
    var j;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      var inQuotes = false;
      for (j = 0; j < line.length; j++) {
        var ch = line.charAt(j);
        if (ch === '"') { inQuotes = !inQuotes; continue; }
        if (inQuotes) { continue; }
        if (Object.prototype.hasOwnProperty.call(counts, ch)) { counts[ch]++; }
      }
    }
    var best = ',';
    var bestCount = counts[','];
    if (counts['\t'] > bestCount) { best = '\t'; bestCount = counts['\t']; }
    if (counts[';'] > bestCount) { best = ';'; }
    return best;
  }

  /**
   * CSV / TSV 解析（支持双引号包裹、字段内逗号、"" 转义）。
   * @param {string} text
   * @param {string} [delimiter] 默认自动检测
   * @return {string[][]}
   */
  function parseDelimited(text, delimiter) {
    var src = String(text === undefined || text === null ? '' : text);
    if (src.charCodeAt(0) === 0xFEFF) { src = src.slice(1); }
    var delim = delimiter || detectDelimiter(src);
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;

    while (i < src.length) {
      var ch = src.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (src.charAt(i + 1) === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === delim) {
        row.push(field);
        field = '';
        i += 1;
        continue;
      }
      if (ch === '\r') {
        i += 1;
        continue;
      }
      if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    }
    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /** 兼容旧调用名 */
  function parseCsv(text, delimiter) {
    return parseDelimited(text, delimiter);
  }

  /* ================================================================== */
  /* ③ 表头识别                                                          */
  /* ================================================================== */

  /** 全半角归一 + 去空格 + 去括号 + 小写 */
  function normHeader(value) {
    var s = String(value === undefined || value === null ? '' : value);
    s = s.replace(/[\uFF01-\uFF5E]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    s = s.replace(/[\s\u3000]/g, '');
    s = s.replace(/[()\[\]{}（）【】「」<>《》]/g, '');
    return s.toLowerCase();
  }

  /**
   * 列名字典。weight 越大越优先（同一列可能有多个别名命中，例如「金额(元)」同时命中「金额」）。
   * 顺序：时间 / 金额 / 收支 / 对方 / 说明 / 分类。
   */
  var FIELD_ALIASES = [
    { field: 'time', alias: '交易时间', weight: 100 },
    { field: 'time', alias: '交易创建时间', weight: 100 },
    { field: 'time', alias: '交易发生时间', weight: 100 },
    { field: 'time', alias: '记账日期', weight: 100 },
    { field: 'time', alias: '交易日期', weight: 100 },
    { field: 'time', alias: '付款时间', weight: 96 },
    { field: 'time', alias: '时间', weight: 70 },
    { field: 'time', alias: '日期', weight: 60 },

    { field: 'amount', alias: '交易金额', weight: 100 },
    { field: 'amount', alias: '金额元', weight: 98 },
    { field: 'amount', alias: '本次金额', weight: 94 },
    { field: 'amount', alias: '订单金额', weight: 88 },
    { field: 'amount', alias: '发生额', weight: 80 },
    { field: 'amount', alias: '金额', weight: 70 },

    /* 银行 / 部分支付宝导出会把收与支拆成两列：借方=支出，贷方=收入 */
    { field: 'amountDebit', alias: '借方发生额', weight: 100 },
    { field: 'amountDebit', alias: '支出金额', weight: 96 },
    { field: 'amountDebit', alias: '借方金额', weight: 96 },
    { field: 'amountCredit', alias: '贷方发生额', weight: 100 },
    { field: 'amountCredit', alias: '收入金额', weight: 96 },
    { field: 'amountCredit', alias: '贷方金额', weight: 96 },

    { field: 'direction', alias: '收/支', weight: 100 },
    { field: 'direction', alias: '收支', weight: 100 },
    { field: 'direction', alias: '借贷标志', weight: 92 },
    { field: 'direction', alias: '资金方向', weight: 90 },
    { field: 'direction', alias: '方向', weight: 80 },
    { field: 'direction', alias: '交易类型', weight: 30 },

    { field: 'counterparty', alias: '交易对方', weight: 100 },
    { field: 'counterparty', alias: '对方户名', weight: 100 },
    { field: 'counterparty', alias: '商户名称', weight: 96 },
    { field: 'counterparty', alias: '收款方', weight: 92 },
    { field: 'counterparty', alias: '付款方', weight: 86 },
    { field: 'counterparty', alias: '交易对象', weight: 84 },
    { field: 'counterparty', alias: '对方', weight: 70 },
    { field: 'counterparty', alias: '商户', weight: 60 },

    /* 说明列：微信导出的「商品」几乎总有值，而「备注」普遍为空，
       所以「商品 / 摘要」系列权重必须高于「备注」，同时保留「备注」做兜底。 */
    { field: 'desc', alias: '商品说明', weight: 100 },
    { field: 'desc', alias: '商品名称', weight: 98 },
    { field: 'desc', alias: '交易说明', weight: 96 },
    { field: 'desc', alias: '商品', weight: 96 },
    { field: 'desc', alias: '摘要', weight: 96 },
    { field: 'desc', alias: '交易摘要', weight: 94 },
    { field: 'desc', alias: '备注', weight: 80 },
    { field: 'desc', alias: '用途', weight: 70 },

    { field: 'category', alias: '交易分类', weight: 100 },
    { field: 'category', alias: '账单分类', weight: 96 },
    { field: 'category', alias: '分类', weight: 70 }
  ];

  /**
   * 给一列表头单元格（已 split）做列映射。
   * 收支列可能有多列命中（如同时有「交易类型」与「收/支」），全部保留并按权重排序；
   * 说明列同理保留成 descList —— 真实微信账单里「备注」常整列为空，
   * 需要按分数依次回退到「商品」，否则会丢掉「转账给李四」这类关键文字。
   * @param {string[]} cells
   * @return {{time:?Object, amount:?Object, amountDebit:?Object, amountCredit:?Object,
   *           direction:Object[], descList:Object[], counterparty:?Object,
   *           desc:?Object, category:?Object}}
   */
  function mapColumns(cells) {
    var cols = {
      time: null,
      amount: null,
      amountDebit: null,
      amountCredit: null,
      direction: [],
      descList: [],
      counterparty: null,
      desc: null,
      category: null
    };
    var i;
    var j;
    var list = Array.isArray(cells) ? cells : [];
    for (i = 0; i < list.length; i++) {
      var header = String(list[i] === undefined || list[i] === null ? '' : list[i]);
      var norm = normHeader(header);
      if (!norm) { continue; }
      for (j = 0; j < FIELD_ALIASES.length; j++) {
        var def = FIELD_ALIASES[j];
        if (norm.indexOf(normHeader(def.alias)) === -1) { continue; }
        var cand = {
          index: i,
          score: def.weight * 1000 + def.alias.length,
          alias: def.alias,
          header: header.trim()
        };
        if (def.field === 'direction') {
          cols.direction.push(cand);
        } else if (def.field === 'desc') {
          var dup = false;
          var di;
          for (di = 0; di < cols.descList.length; di++) {
            if (cols.descList[di].index === i) {
              dup = true;
              if (cand.score > cols.descList[di].score) { cols.descList[di] = cand; }
              break;
            }
          }
          if (!dup) { cols.descList.push(cand); }
          if (!cols.desc || cand.score > cols.desc.score) { cols.desc = cand; }
        } else if (!cols[def.field] || cand.score > cols[def.field].score) {
          cols[def.field] = cand;
        }
      }
    }
    cols.direction.sort(function (a, b) { return b.score - a.score; });
    cols.descList.sort(function (a, b) { return b.score - a.score; });
    return cols;
  }

  /**
   * 是否识别到可用的金额列（单列 或 借方/贷方双列之一）。
   * @param {Object} cols mapColumns() 结果
   * @return {boolean}
   */
  function hasAmountColumn(cols) {
    if (!cols) { return false; }
    return !!(cols.amount || cols.amountDebit || cols.amountCredit);
  }

  /**
   * 扫描前 30 行，找同时含「时间列」与「金额列」的那一行作为表头。
   * @param {string[][]} rows
   * @return {?{index:number, columns:Object, score:number}}
   */
  function detectHeader(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var limit = Math.min(list.length, 30);
    var best = null;
    var i;
    for (i = 0; i < limit; i++) {
      var cols = mapColumns(list[i]);
      if (!cols.time || !hasAmountColumn(cols)) { continue; }
      var score = 0;
      if (cols.time) { score += cols.time.score; }
      if (cols.amount) { score += cols.amount.score; }
      if (cols.amountDebit) { score += cols.amountDebit.score; }
      if (cols.amountCredit) { score += cols.amountCredit.score; }
      if (cols.direction.length > 0) { score += 50; }
      if (cols.counterparty) { score += 40; }
      if (cols.desc) { score += 30; }
      if (cols.category) { score += 20; }
      if (!best || score > best.score) {
        best = { index: i, columns: cols, score: score };
      }
    }
    return best;
  }

  /* ================================================================== */
  /* ④ 记录解析                                                          */
  /* ================================================================== */

  /**
   * 日期时间解析，兼容：
   *   2025-10-21 12:30:05 / 2025/10/21 / 2025年10月21日 / 10-21 12:30 / 20251021
   * @param {string} raw
   * @param {Date} [now] 补年份用
   * @return {?{date:string, time:string, month:string}}
   */
  function parseDateTime(raw, now) {
    var s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!s) { return null; }
    var base = now ? toDate(now) : new Date();
    var year = 0;
    var month = 0;
    var day = 0;

    var m = s.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
    if (m) {
      year = Number(m[1]);
      month = Number(m[2]);
      day = Number(m[3]);
    } else {
      var compact = s.match(/(\d{4})(\d{2})(\d{2})/);
      if (compact) {
        year = Number(compact[1]);
        month = Number(compact[2]);
        day = Number(compact[3]);
      } else {
        var short = s.match(/(\d{1,2})\s*[-/月]\s*(\d{1,2})/);
        if (short) {
          year = base.getFullYear();
          month = Number(short[1]);
          day = Number(short[2]);
        }
      }
    }
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) { return null; }

    var time = '';
    var tm = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (tm) {
      time = pad2(Number(tm[1])) + ':' + tm[2];
    }
    var date = year + '-' + pad2(month) + '-' + pad2(day);
    return { date: date, time: time, month: date.slice(0, 7) };
  }

  /**
   * 金额清洗：去掉 ¥ ￥ , " 空格；处理 -12.00 / (12.00) 负数写法。
   * @param {string} raw
   * @return {?{value:number, negative:boolean}}
   */
  function cleanAmount(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!s) { return null; }
    s = s.replace(/[¥￥$,\s"]/g, '');
    if (!s) { return null; }
    var negative = false;
    if (/^\(.*\)$/.test(s)) {
      negative = true;
      s = s.slice(1, -1);
    }
    if (s.charAt(0) === '-') {
      negative = true;
      s = s.slice(1);
    } else if (s.charAt(0) === '+') {
      s = s.slice(1);
    }
    // 去掉「元」等尾巴
    s = s.replace(/元$/, '');
    if (!/^\d+(\.\d+)?$/.test(s)) { return null; }
    var value = Number(s);
    if (!isFinite(value) || value <= 0) { return null; }
    return { value: round2(value), negative: negative };
  }

  /**
   * 收支方向文本归一。
   * 「不计收支 / 不计入收支」是微信转账行的标准写法，必须单独识别为 excluded，
   * 否则会落到兜底的 expense，把转账算成消费。
   * @param {string} raw
   * @return {string} 'income' | 'expense' | 'excluded' | ''
   */
  function normalizeDirection(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw).replace(/\s/g, '');
    if (!s) { return ''; }
    if (s === '/' || s === '-' || s === '—' || s === '--') { return ''; }
    if (/^(不计收支|不计入收支|不计入|不计)/.test(s)) { return 'excluded'; }
    if (/^(收入|收|贷|入账|存入|转入|退款|收款)/.test(s)) { return 'income'; }
    if (/^(支出|支|借|出账|转出|付款|消费)/.test(s)) { return 'expense'; }
    return '';
  }

  /**
   * 「提现 / 还款 / 借贷」类：无论收支方向，永远不计入收支统计。
   * 这里**只认完整词**，刻意不走 BILL_EXCLUDED_CATEGORIES（那份列表含「转账」，
   * 会让「交易类型=转账 + 收/支=收入」的生活费被误排掉），也不用裸「借」「贷」
   * 二字，避免把「借贷宝超市」这类商户名误杀。
   * @param {string} text
   * @return {boolean}
   */
  function isWithdrawOrRepay(text) {
    var s = String(text === undefined || text === null ? '' : text);
    if (!s) { return false; }
    if (/提现/.test(s)) { return true; }
    if (/还款|信用卡还|还花呗/.test(s)) { return true; }
    if (/投资理财|理财赎回/.test(s)) { return true; }
    if (/借贷/.test(s)) { return true; }
    return false;
  }

  /**
   * 「转账 / 汇款」类文字。用于两处：支出方向 → 不计入消费；收入方向 → 记为转账型收入。
   * @param {string} text
   * @return {boolean}
   */
  function isTransferText(text) {
    var s = String(text === undefined || text === null ? '' : text);
    if (!s) { return false; }
    return /转账|转入|转出|汇款/.test(s);
  }

  /**
   * @deprecated 保留给旧调用；新代码请用 isWithdrawOrRepay / isTransferText
   * @param {string} text
   * @return {boolean}
   */
  function looksExcluded(text) {
    return isWithdrawOrRepay(text) || isTransferText(text);
  }

  /** 分类映射：14 → 应用内 9 类；未命中回退 nlp.classify() */
  function resolveCategory(rawCategory, text, type) {
    var map = DATA.BILL_CATEGORY_MAP || {};
    var excludedList = DATA.BILL_EXCLUDED_CATEGORIES || [];
    var raw = String(rawCategory === undefined || rawCategory === null ? '' : rawCategory).replace(/\s/g, '');
    var keys = Object.keys(map).sort(function (a, b) { return b.length - a.length; });
    var hit = '';
    var i;

    for (i = 0; i < keys.length; i++) {
      if (raw && raw.indexOf(keys[i]) !== -1) {
        hit = keys[i];
        break;
      }
    }

    /* 先判「转账 / 还款」——即使是收入方向，也不能算进收支统计 */
    var excluded = false;
    if (hit && excludedList.indexOf(hit) !== -1) { excluded = true; }
    if (raw && excludedList.indexOf(raw) !== -1) { excluded = true; }
    if (!excluded && /转账|还款|信用还款|提现/.test(raw)) { excluded = true; }
    if (!excluded && /转账给|给.{0,6}转账|还花呗|还款/.test(text)) { excluded = true; }
    if (excluded) {
      return { category: '其他', excluded: true };
    }

    if (type === 'income') {
      return { category: INCOME_CATEGORY, excluded: false };
    }

    var category = hit ? map[hit] : '';
    if (!category || category === INCOME_CATEGORY) { category = ''; }
    if (!category) {
      var guessed = (NLP && typeof NLP.classify === 'function') ? NLP.classify(text) : '其他';
      category = DATA.CATEGORY_KEYS.indexOf(guessed) !== -1 ? guessed : '其他';
    }
    return { category: category, excluded: false };
  }

  /**
   * 解析单个文件。
   * @param {{name:string, text?:string, bytes?:ArrayBuffer|Uint8Array, encoding?:string}} file
   * @param {{now?:Date}} [opts]
   * @return {Object} 文件解析结果（含 records / headerRow / skipped / columns）
   */
  function parseFile(file, opts) {
    var o = opts || {};
    var name = (file && file.name) ? String(file.name) : '未命名.csv';
    var result = {
      name: name,
      ok: false,
      reason: '',
      encoding: '',
      headerRow: 0,
      totalRows: 0,
      records: [],
      skipped: 0,
      skippedBefore: 0,
      transferIncomeCount: 0,
      columns: {},
      columnNames: {},
      delimiter: ','
    };

    var text = '';
    if (file && typeof file.text === 'string') {
      text = file.text;
      result.encoding = file.encoding || 'text';
    } else if (file && file.bytes) {
      if (looksBinary(file.bytes)) {
        result.reason = '这看起来是 PDF / Excel 等二进制文件，不是 CSV 文本。请在微信/支付宝里重新导出：选「CSV（用做个人对账）」格式，再导入。';
        return result;
      }
      var dec = decodeBytes(file.bytes);
      if (!dec.ok) {
        result.reason = dec.reason || '无法识别文件编码';
        return result;
      }
      text = dec.text;
      result.encoding = dec.encoding;
    } else {
      result.reason = '文件内容为空';
      return result;
    }

    if (!text.trim()) {
      result.reason = '文件内容为空';
      return result;
    }

    result.preview = firstLines(text, 4);

    var rows = parseDelimited(text);
    result.delimiter = detectDelimiter(text);
    result.totalRows = rows.length;

    var header = detectHeader(rows);
    if (!header) {
      result.reason = '没有找到表头：需要同时包含「时间」类列与「金额」类列';
      return result;
    }
    var cols = header.columns;
    var dualAmount = !!(cols.amountDebit || cols.amountCredit);
    result.headerRow = header.index + 1;

    var amountHeaderText = '';
    if (dualAmount) {
      /* amount 保留「主金额列」的表头文本（借方优先），双列信息另有独立字段 */
      amountHeaderText = (cols.amountDebit ? cols.amountDebit.header : '') ||
        (cols.amountCredit ? cols.amountCredit.header : '');
    } else if (cols.amount) {
      amountHeaderText = cols.amount.header;
    }
    result.columns = {
      time: cols.time ? cols.time.header : '',
      amount: amountHeaderText,
      amountDebit: cols.amountDebit ? cols.amountDebit.header : '',
      amountCredit: cols.amountCredit ? cols.amountCredit.header : '',
      direction: cols.direction.length ? cols.direction[0].header : '',
      counterparty: cols.counterparty ? cols.counterparty.header : '',
      desc: cols.desc ? cols.desc.header : '',
      category: cols.category ? cols.category.header : ''
    };

    /* 单金额列的「借 / 贷」语义要基于真实命中的表头文本判断，
       不能拿常量别名去 indexOf，否则「贷方发生额」这类列永远判不出来。 */
    var amountKind = '';
    if (!dualAmount && cols.amount) {
      var amtNorm = normHeader(cols.amount.header);
      if (amtNorm.indexOf('借方') !== -1 || amtNorm.indexOf('支出') !== -1 ||
          amtNorm.indexOf('付款') !== -1 || amtNorm.indexOf('转出') !== -1) {
        amountKind = 'debit';
      } else if (amtNorm.indexOf('贷方') !== -1 || amtNorm.indexOf('收入') !== -1 ||
          amtNorm.indexOf('存入') !== -1 || amtNorm.indexOf('转入') !== -1) {
        amountKind = 'credit';
      }
    }

    var i;
    var skipped = 0;
    var transferIncomeCount = 0;
    var timeIndex = cols.time.index;
    var amountIndex = cols.amount ? cols.amount.index : -1;
    var debitIndex = cols.amountDebit ? cols.amountDebit.index : -1;
    var creditIndex = cols.amountCredit ? cols.amountCredit.index : -1;

    for (i = header.index + 1; i < rows.length; i++) {
      var cells = rows[i];
      if (!cells || cells.length === 0) { skipped++; continue; }
      var joined = cells.join('').replace(/\s/g, '');
      if (!joined) { skipped++; continue; }

      var dt = parseDateTime(cells[timeIndex], o.now);
      if (!dt) { skipped++; continue; }

      /* ---- 金额：借方 / 贷方双列优先，单列兜底 ---- */
      var amt = null;
      var dualType = '';
      var amountConflict = false;
      if (debitIndex >= 0 || creditIndex >= 0) {
        var debitAmt = debitIndex >= 0 ? cleanAmount(cells[debitIndex]) : null;
        var creditAmt = creditIndex >= 0 ? cleanAmount(cells[creditIndex]) : null;
        if (debitAmt && creditAmt) {
          // 两列同时有值：取绝对值较大者，并打上冲突标记供 UI 提示
          amountConflict = true;
          if (debitAmt.value >= creditAmt.value) {
            amt = debitAmt;
            dualType = 'expense';
          } else {
            amt = creditAmt;
            dualType = 'income';
          }
        } else if (debitAmt) {
          amt = debitAmt;
          dualType = 'expense';
        } else if (creditAmt) {
          amt = creditAmt;
          dualType = 'income';
        }
      }
      if (!amt && amountIndex >= 0) { amt = cleanAmount(cells[amountIndex]); }
      if (!amt) { skipped++; continue; }

      /* ---- 收支方向：取第一个能识别的方向列，同时把其余列文本留作排除判断 ---- */
      var direction = '';
      var typeColText = '';
      var d;
      for (d = 0; d < cols.direction.length; d++) {
        var dRaw = cells[cols.direction[d].index];
        var dText = String(dRaw === undefined || dRaw === null ? '' : dRaw).trim();
        if (!dText) { continue; }
        typeColText += ' ' + dText;
        var dir = normalizeDirection(dText);
        if (dir && !direction) { direction = dir; }
      }

      var type;
      if (direction === 'excluded') {
        // 「不计收支」的转账行：金额仍在，但不能进任何合计
        type = 'expense';
      } else if (direction) {
        type = direction;
      } else if (dualType) {
        type = dualType;
      } else if (amt.negative) {
        type = 'expense';
      } else if (amountKind === 'debit') {
        type = 'expense';
      } else if (amountKind === 'credit') {
        type = 'income';
      } else {
        // 既没有收支列、金额也是正数：优先按支出理解（消费分析为主，避免虚增收入）
        type = 'expense';
      }

      var counterparty = cols.counterparty
        ? String(cells[cols.counterparty.index] || '').trim() : '';

      /* 说明列按分数依次回退：备注为空时自动落到「商品」，两列都有值时优先高分列 */
      var desc = '';
      var dl;
      for (dl = 0; dl < cols.descList.length; dl++) {
        var dCell = cells[cols.descList[dl].index];
        var dVal = String(dCell === undefined || dCell === null ? '' : dCell).trim();
        if (dVal) { desc = dVal; break; }
      }

      var rawCategory = cols.category
        ? String(cells[cols.category.index] || '').trim() : '';

      var mapText = (counterparty + ' ' + desc + ' ' + rawCategory + ' ' + typeColText).trim();
      var resolved = resolveCategory(rawCategory, mapText, type);

      /* ---- 是否计入收支 ----
         优先级（顺序不能换）：
           ① 「不计收支」显式排除 → 永远 excluded
           ② 提现 / 还款 / 借贷 → 永远 excluded（收入方向也不算收入）
           ③ 收入方向 → 计入收入；即使「交易类型=转账」也照收（生活费常由转账进来），
              只打 transferIncome 标记，方便用户自查并手动排除本人账户互转
           ④ 支出方向且文字含转账 / 汇款 → excluded（给室友转账不是消费）
         提现/还款只匹配「分类 + 交易类型」这类标签列，不匹配对方名 / 商品名，
         否则「借贷宝超市」会被当成借贷记录误杀。 */
      var labelText = (rawCategory + ' ' + typeColText).trim();
      var withdrawRepay = isWithdrawOrRepay(labelText);
      var transferText = isTransferText(rawCategory + ' ' + typeColText + ' ' + desc) || resolved.excluded;

      var isExcluded = false;
      var transferIncome = false;
      if (direction === 'excluded') {
        isExcluded = true;
      } else if (withdrawRepay) {
        isExcluded = true;
      } else if (type === 'income') {
        isExcluded = false;
        transferIncome = transferText;
      } else if (transferText) {
        isExcluded = true;
      }

      var finalCategory = isExcluded
        ? '其他'
        : (type === 'income' ? INCOME_CATEGORY : resolved.category);

      if (transferIncome) { transferIncomeCount += 1; }

      var motive = (NLP && typeof NLP.detectMotivation === 'function')
        ? NLP.detectMotivation(counterparty + ' ' + desc + ' ' + rawCategory)
        : { motivation: '刚需', want: false };

      result.records.push({
        file: name,
        row: i + 1,
        date: dt.date,
        time: dt.time,
        month: dt.month,
        amount: amt.value,
        type: type,
        rawCategory: rawCategory,
        category: finalCategory,
        excluded: isExcluded,
        transferIncome: transferIncome,
        amountConflict: amountConflict,
        counterparty: counterparty,
        desc: desc,
        note: (counterparty ? counterparty + ' ' : '') + desc,
        motivation: type === 'income' ? '刚需' : motive.motivation,
        want: type === 'income' ? false : !!motive.want,
        excludedReason: isExcluded
          ? (direction === 'excluded' ? '「不计收支」的转账 / 还款记录，不计入统计' : '转账 / 还款不计入消费统计')
          : ''
      });
    }

    result.skipped = skipped;
    result.transferIncomeCount = transferIncomeCount;
    /* 表头之前的说明行（导出文件顶部的账号、时间范围等）单独计数，
       不能和表头之后的坏行混成一个「跳过 N 行」。 */
    result.skippedBefore = header.index;
    result.ok = result.records.length > 0;
    if (!result.ok && !result.reason) {
      result.reason = '表头识别成功，但没有解析出有效记录（请检查日期与金额列）';
    }
    return result;
  }

  /* ================================================================== */
  /* ⑤ 去重                                                              */
  /* ================================================================== */

  /**
   * 同「日期 + 金额 + 对方」判为疑似重复（跨文件与文件内都判）。
   * 只标记不删除：dupIndex === 0 的保留，其余 isDuplicate = true。
   * @param {Array} rows
   * @return {Array<{key:string,date:string,amount:number,counterparty:string,items:Array}>}
   */
  function markDuplicates(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var map = {};
    var order = [];
    var i;
    for (i = 0; i < list.length; i++) {
      var row = list[i];
      if (!row || !row.date || !row.amount) { continue; }
      var cp = String(row.counterparty || '').replace(/\s/g, '');
      var key = row.date + '|' + round2(row.amount).toFixed(2) + '|' + cp;
      row.dupKey = key;
      if (!Object.prototype.hasOwnProperty.call(map, key)) {
        map[key] = [];
        order.push(key);
      }
      map[key].push(row);
    }

    var groups = [];
    var g;
    for (g = 0; g < order.length; g++) {
      var key2 = order[g];
      var items = map[key2];
      if (items.length < 2) {
        var only = items[0];
        if (only) {
          only.dupIndex = 0;
          only.isDuplicate = false;
          only.duplicateOf = '';
        }
        continue;
      }
      var group = {
        key: key2,
        date: items[0].date,
        amount: round2(items[0].amount),
        counterparty: items[0].counterparty,
        items: items
      };
      var j;
      for (j = 0; j < items.length; j++) {
        items[j].dupIndex = j;
        items[j].isDuplicate = j > 0;
        items[j].duplicateOf = j === 0 ? '' : String(items[0].file) + '#' + items[0].row;
      }
      groups.push(group);
    }
    return groups;
  }

  /**
   * 多文件汇总。rows 已经打完去重标记。
   * @param {Array} files parseFile 结果数组
   * @param {{now?:Date}} [opts]
   * @return {{rows:Array, files:Array, duplicates:Array}}
   */
  function buildRows(files, opts) {
    var list = Array.isArray(files) ? files : [];
    var rows = [];
    var metas = [];
    var i;
    var j;
    for (i = 0; i < list.length; i++) {
      var meta = list[i];
      metas.push({
        name: meta.name,
        ok: !!meta.ok,
        reason: meta.reason || '',
        preview: meta.preview || '',
        encoding: meta.encoding || '',
        headerRow: meta.headerRow || 0,
        totalRows: meta.totalRows || 0,
        skipped: meta.skipped || 0,
        skippedBefore: meta.skippedBefore || 0,
        transferIncomeCount: meta.transferIncomeCount || 0,
        columns: meta.columns || {},
        records: (meta.records || []).length,
        delimiter: meta.delimiter || ','
      });
      for (j = 0; j < (meta.records || []).length; j++) {
        rows.push(meta.records[j]);
      }
    }
    var duplicates = markDuplicates(rows);
    return { rows: rows, files: metas, duplicates: duplicates };
  }

  /* ================================================================== */
  /* ⑥ 报告                                                              */
  /* ================================================================== */

  function inferMonth(rows) {
    var best = '';
    var i;
    for (i = 0; i < rows.length; i++) {
      var m = rows[i] && rows[i].month ? rows[i].month : monthKeyOf(rows[i] && rows[i].date);
      if (m && m > best) { best = m; }
    }
    return best || currentMonth();
  }

  function collectDuplicateGroups(rows) {
    var map = {};
    var order = [];
    var i;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row.date || !row.amount) { continue; }
      var cp = String(row.counterparty || '').replace(/\s/g, '');
      var key = row.date + '|' + round2(row.amount).toFixed(2) + '|' + cp;
      if (!Object.prototype.hasOwnProperty.call(map, key)) {
        map[key] = [];
        order.push(key);
      }
      map[key].push(row);
    }
    var out = [];
    var k;
    for (k = 0; k < order.length; k++) {
      var items = map[order[k]];
      if (items.length < 2) { continue; }
      out.push({
        key: order[k],
        date: items[0].date,
        amount: round2(items[0].amount),
        counterparty: items[0].counterparty || items[0].note || '',
        items: items.map(function (r) {
          return { file: r.file, row: r.row, desc: r.desc, category: r.category };
        })
      });
    }
    return out;
  }

  /** 分组求和工具 */
  function groupSum(rows, keyFn) {
    var map = {};
    var i;
    for (i = 0; i < rows.length; i++) {
      var k = keyFn(rows[i]);
      if (k === undefined || k === null || k === '') { continue; }
      if (!Object.prototype.hasOwnProperty.call(map, k)) {
        map[k] = { key: k, amount: 0, count: 0, rows: [] };
      }
      map[k].amount = round2(map[k].amount + num(rows[i].amount));
      map[k].count += 1;
      map[k].rows.push(rows[i]);
    }
    return map;
  }

  /**
   * 生成 9 节报告。
   * @param {Array} rows 记录（可含 excluded / isDuplicate 标记）
   * @param {{month?:string, excludeDuplicates?:boolean, files?:Array}} [opts]
   * @return {Object}
   */
  function report(rows, opts) {
    var o = opts || {};
    var all = Array.isArray(rows) ? rows : [];
    var excludeDuplicates = !!o.excludeDuplicates;
    var month = o.month || inferMonth(all);
    var prevMonth = shiftMonth(month, -1);
    var i;

    /* ---- 有效行（排除 转账/还款；可选排除重复项） ---- */
    var valid = [];
    for (i = 0; i < all.length; i++) {
      var r = all[i];
      if (!r || !r.date || !r.amount) { continue; }
      if (r.excluded) { continue; }
      if (excludeDuplicates && r.isDuplicate) { continue; }
      valid.push(r);
    }

    var monthRows = [];
    var prevRows = [];
    for (i = 0; i < valid.length; i++) {
      var m = valid[i].month || monthKeyOf(valid[i].date);
      if (m === month) { monthRows.push(valid[i]); }
      else if (m === prevMonth) { prevRows.push(valid[i]); }
    }

    var expenseRows = [];
    var incomeRows = [];
    for (i = 0; i < monthRows.length; i++) {
      if (monthRows[i].type === 'income') { incomeRows.push(monthRows[i]); }
      else { expenseRows.push(monthRows[i]); }
    }
    var prevExpenseRows = [];
    var prevIncomeRows = [];
    for (i = 0; i < prevRows.length; i++) {
      if (prevRows[i].type === 'income') { prevIncomeRows.push(prevRows[i]); }
      else { prevExpenseRows.push(prevRows[i]); }
    }

    var totalExpense = sum(expenseRows, function (x) { return x.amount; });
    var totalIncome = sum(incomeRows, function (x) { return x.amount; });
    var balance = round2(totalIncome - totalExpense);

    /* ---- 1. 总览 ---- */
    var activeDays = {};
    for (i = 0; i < expenseRows.length; i++) { activeDays[expenseRows[i].date] = true; }
    var activeDayCount = Object.keys(activeDays).length;

    var prevExpense = sum(prevExpenseRows, function (x) { return x.amount; });
    var prevIncome = sum(prevIncomeRows, function (x) { return x.amount; });
    var hasPrev = prevRows.length > 0;

    var overview = {
      month: month,
      prevMonth: prevMonth,
      expense: totalExpense,
      income: totalIncome,
      balance: balance,
      count: expenseRows.length,
      expenseCount: expenseRows.length,
      incomeCount: incomeRows.length,
      avgPerTx: expenseRows.length > 0 ? round2(totalExpense / expenseRows.length) : 0,
      activeDays: activeDayCount,
      daysInMonth: daysInMonth(month),
      avgPerDay: activeDayCount > 0 ? round2(totalExpense / activeDayCount) : 0,
      prevExpense: hasPrev ? prevExpense : null,
      prevIncome: hasPrev ? prevIncome : null,
      expenseDelta: hasPrev ? round2(totalExpense - prevExpense) : null,
      expenseDeltaPercent: (hasPrev && prevExpense > 0)
        ? round2((totalExpense - prevExpense) / prevExpense * 100) : null,
      savingsRate: totalIncome > 0 ? round2(balance / totalIncome * 100) : null,
      hasPrev: hasPrev
    };

    /* ---- 2. 分类占比与环比 ---- */
    var catNow = groupSum(expenseRows, function (x) { return x.category; });
    var catPrev = groupSum(prevExpenseRows, function (x) { return x.category; });
    var categories = [];
    var keys = DATA.CATEGORY_KEYS.slice();
    var keySet = {};
    for (i = 0; i < keys.length; i++) { keySet[keys[i]] = true; }
    var extraKeys = Object.keys(catNow);
    for (i = 0; i < extraKeys.length; i++) {
      if (!keySet[extraKeys[i]]) { keys.push(extraKeys[i]); keySet[extraKeys[i]] = true; }
    }
    var k;
    for (k = 0; k < keys.length; k++) {
      var cat = keys[k];
      var now = catNow[cat] || { amount: 0, count: 0 };
      var prev = catPrev[cat] || { amount: 0, count: 0 };
      if (now.amount <= 0 && prev.amount <= 0) { continue; }
      categories.push({
        category: cat,
        amount: round2(now.amount),
        count: now.count,
        avg: now.count > 0 ? round2(now.amount / now.count) : 0,
        percent: totalExpense > 0 ? round2(now.amount / totalExpense * 100) : 0,
        prevAmount: round2(prev.amount),
        delta: round2(now.amount - prev.amount),
        deltaPercent: prev.amount > 0 ? round2((now.amount - prev.amount) / prev.amount * 100) : null
      });
    }
    categories.sort(function (a, b) { return b.amount - a.amount; });

    /* ---- 3. Top 10 单笔大额 ---- */
    var sortedByAmount = expenseRows.slice().sort(function (a, b) {
      if (b.amount !== a.amount) { return b.amount - a.amount; }
      return a.date < b.date ? -1 : 1;
    });
    var topExpenses = sortedByAmount.slice(0, 10).map(function (x) {
      return {
        date: x.date,
        time: x.time || '',
        counterparty: x.counterparty || '',
        desc: x.desc || '',
        category: x.category,
        amount: round2(x.amount)
      };
    });

    /* ---- 4. Top 10 高频商户 ---- */
    var merchantMap = groupSum(expenseRows, function (x) {
      return String(x.counterparty || '').trim();
    });
    var topMerchants = Object.keys(merchantMap).map(function (name) {
      var g = merchantMap[name];
      return {
        name: name,
        count: g.count,
        amount: round2(g.amount),
        avg: round2(g.amount / g.count)
      };
    }).sort(function (a, b) {
      if (b.count !== a.count) { return b.count - a.count; }
      return b.amount - a.amount;
    }).slice(0, 10);

    /* ---- 5. 周末 vs 工作日（用日均比，不用总额比） ---- */
    var buckets = {
      weekend: { count: 0, amount: 0, days: {} },
      weekday: { count: 0, amount: 0, days: {} }
    };
    for (i = 0; i < expenseRows.length; i++) {
      var e = expenseRows[i];
      var bucket = isWeekend(e.date) ? buckets.weekend : buckets.weekday;
      bucket.count += 1;
      bucket.amount = round2(bucket.amount + num(e.amount));
      bucket.days[e.date] = true;
    }
    var weekendDays = Object.keys(buckets.weekend.days).length;
    var weekdayDays = Object.keys(buckets.weekday.days).length;
    var weekendAvg = weekendDays > 0 ? round2(buckets.weekend.amount / weekendDays) : 0;
    var weekdayAvg = weekdayDays > 0 ? round2(buckets.weekday.amount / weekdayDays) : 0;
    var weekendVsWeekday = {
      weekend: {
        count: buckets.weekend.count,
        amount: round2(buckets.weekend.amount),
        days: weekendDays,
        avg: weekendAvg
      },
      weekday: {
        count: buckets.weekday.count,
        amount: round2(buckets.weekday.amount),
        days: weekdayDays,
        avg: weekdayAvg
      },
      ratio: weekdayAvg > 0 ? round2(weekendAvg / weekdayAvg) : null
    };

    /* ---- 6. 订阅型支出（连续 ≥3 个月 同对方 + 同金额） ---- */
    var allExpense = [];
    for (i = 0; i < valid.length; i++) {
      if (valid[i].type !== 'income') { allExpense.push(valid[i]); }
    }
    var subMap = {};
    var subOrder = [];
    for (i = 0; i < allExpense.length; i++) {
      var row2 = allExpense[i];
      var name = String(row2.counterparty || '').trim();
      if (!name) { continue; }
      var subKey = name + '|' + round2(row2.amount).toFixed(2);
      if (!Object.prototype.hasOwnProperty.call(subMap, subKey)) {
        subMap[subKey] = { name: name, amount: round2(row2.amount), months: {}, count: 0 };
        subOrder.push(subKey);
      }
      subMap[subKey].months[row2.month || monthKeyOf(row2.date)] = true;
      subMap[subKey].count += 1;
    }
    var subscriptions = [];
    var s;
    for (s = 0; s < subOrder.length; s++) {
      var sub = subMap[subOrder[s]];
      var months = Object.keys(sub.months).sort();
      if (months.length < 3) { continue; }
      // 找最长连续月份段
      var bestRun = [];
      var run = [months[0]];
      var mi;
      for (mi = 1; mi < months.length; mi++) {
        if (months[mi] === shiftMonth(months[mi - 1], 1)) {
          run.push(months[mi]);
        } else {
          if (run.length > bestRun.length) { bestRun = run.slice(); }
          run = [months[mi]];
        }
      }
      if (run.length > bestRun.length) { bestRun = run.slice(); }
      if (bestRun.length < 3) { continue; }
      subscriptions.push({
        name: sub.name,
        amount: sub.amount,
        months: bestRun.length,
        monthList: bestRun,
        activeThisMonth: bestRun.indexOf(month) !== -1,
        annual: round2(sub.amount * 12),
        lastMonth: bestRun[bestRun.length - 1]
      });
    }
    subscriptions.sort(function (a, b) { return b.annual - a.annual; });

    /* ---- 7. 异常大额（该分类其余各笔笔均 ×3） ---- */
    var anomalies = [];
    var catRows = groupSum(expenseRows, function (x) { return x.category; });
    var catKeys = Object.keys(catRows);
    var c;
    for (c = 0; c < catKeys.length; c++) {
      var group = catRows[catKeys[c]];
      if (group.rows.length < 3) { continue; }
      var totalCat = group.amount;
      var n = group.rows.length;
      var ri;
      for (ri = 0; ri < group.rows.length; ri++) {
        var rr = group.rows[ri];
        var othersAvg = (totalCat - rr.amount) / (n - 1);
        if (othersAvg > 0 && rr.amount > othersAvg * 3) {
          anomalies.push({
            date: rr.date,
            counterparty: rr.counterparty || '',
            desc: rr.desc || '',
            category: rr.category,
            amount: round2(rr.amount),
            othersAvg: round2(othersAvg),
            times: round2(rr.amount / othersAvg)
          });
        }
      }
    }
    anomalies.sort(function (a, b) { return b.amount - a.amount; });

    /* ---- 8. 疑似重复 ---- */
    var duplicates = collectDuplicateGroups(all).map(function (g) {
      return {
        date: g.date,
        amount: g.amount,
        counterparty: g.counterparty,
        items: g.items
      };
    });

    /* ---- 9. 解析情况 ---- */
    var fileMetas = Array.isArray(o.files) ? o.files : [];
    var excludedTransfer = 0;
    var excludedDuplicate = 0;
    var transferIncomeCount = 0;
    var qi;
    for (qi = 0; qi < all.length; qi++) {
      if (!all[qi]) { continue; }
      if (all[qi].excluded) { excludedTransfer += 1; }
      if (all[qi].isDuplicate) { excludedDuplicate += 1; }
      if (all[qi].transferIncome) { transferIncomeCount += 1; }
    }
    var parseInfo = {
      files: fileMetas.map(function (f) {
        return {
          name: f.name,
          ok: !!f.ok,
          reason: f.reason || '',
          encoding: f.encoding || '',
          headerRow: f.headerRow || 0,
          records: typeof f.records === 'number' ? f.records : 0,
          skipped: f.skipped || 0,
          skippedBefore: f.skippedBefore || 0,
          transferIncomeCount: f.transferIncomeCount || 0,
          totalRows: f.totalRows || 0,
          columns: f.columns || {}
        };
      }),
      totalRecords: all.length,
      totalSkipped: fileMetas.reduce(function (acc, f) { return acc + (f.skipped || 0); }, 0),
      totalSkippedBefore: fileMetas.reduce(function (acc, f) { return acc + (f.skippedBefore || 0); }, 0),
      /* 「转账/还款」与「疑似重复」是两种完全不同的排除原因，必须分开计数 */
      excludedTransfer: excludedTransfer,
      excludedDuplicate: excludedDuplicate,
      /* 以「交易类型=转账」进来的收入：已计入收入，单独计数供 UI 提示 */
      transferIncomeCount: transferIncomeCount,
      excludedRecords: excludedTransfer
    };

    /* ---- 建议输入派生指标 ---- */
    var food = catNow['餐饮'] || { amount: 0, count: 0 };
    var emotional = expenseRows.filter(function (x) { return x.motivation === '情绪'; });
    var emotionAmount = sum(emotional, function (x) { return x.amount; });
    var nightFood = expenseRows.filter(function (x) {
      if (x.category !== '餐饮' && x.category !== '社交') { return false; }
      var h = Number(String(x.time || '').slice(0, 2));
      if (!isFinite(h) || !x.time) { return false; }
      return h >= 21 || h < 2;
    });
    var nightAmount = sum(nightFood, function (x) { return x.amount; });
    var small = expenseRows.filter(function (x) { return x.amount < 20; });
    var maxGrowth = null;
    for (i = 0; i < categories.length; i++) {
      var cg = categories[i];
      if (cg.deltaPercent === null || cg.deltaPercent < 0) { continue; }
      if (!maxGrowth || cg.deltaPercent > maxGrowth.deltaPercent) { maxGrowth = cg; }
    }

    var extras = {
      engelPercent: totalExpense > 0 ? round2(food.amount / totalExpense * 100) : 0,
      foodAmount: round2(food.amount),
      foodCount: food.count,
      emotion: {
        count: emotional.length,
        amount: emotionAmount,
        ratioAmount: totalExpense > 0 ? round2(emotionAmount / totalExpense * 100) : 0,
        ratioCount: expenseRows.length > 0 ? round2(emotional.length / expenseRows.length * 100) : 0
      },
      nightFood: {
        count: nightFood.length,
        amount: nightAmount,
        ratioOfFood: food.amount > 0 ? round2(nightAmount / food.amount * 100) : 0
      },
      small: {
        count: small.length,
        amount: sum(small, function (x) { return x.amount; }),
        ratioCount: expenseRows.length > 0 ? round2(small.length / expenseRows.length * 100) : 0
      },
      maxGrowth: maxGrowth
    };

    return {
      overview: overview,
      categories: categories,
      topExpenses: topExpenses,
      topMerchants: topMerchants,
      weekendVsWeekday: weekendVsWeekday,
      subscriptions: subscriptions,
      anomalies: anomalies,
      duplicates: duplicates,
      parseInfo: parseInfo,
      extras: extras,
      meta: {
        month: month,
        prevMonth: prevMonth,
        excludeDuplicates: excludeDuplicates,
        rowCount: all.length,
        validCount: valid.length,
        generatedAt: new Date().toISOString()
      }
    };
  }

  /* ================================================================== */
  /* ⑦ 消费建议                                                          */
  /* ================================================================== */

  /**
   * 基于报告生成 3~5 条带数字证据的建议。
   * 语气克制、不下价值判断、不推荐任何具体产品 / 平台 / 理财。
   * @param {Object} rep report() 结果
   * @param {Object} [budgetState] getBudgetState() 结果（可选）
   * @return {Array<{level:string,title:string,evidence:string,action:string}>}
   */
  function insights(rep, budgetState) {
    var r = rep || {};
    var ov = r.overview || {};
    var ex = r.extras || {};
    var out = [];

    if (ov.expense > 0) {
      /* 1. 恩格尔系数 */
      if (ex.engelPercent > 50) {
        out.push({
          level: 'warn',
          title: '餐饮占掉了过半支出',
          evidence: '本月餐饮 ' + money(ex.foodAmount) + '，占总支出 ' +
            percent(ex.engelPercent) + '（' + (ov.count || 0) + ' 笔中有 ' + (ex.foodCount || 0) + ' 笔是餐饮）。',
          action: '把外卖和奶茶各压两成，按当前餐饮金额能省回约 ' + money(ex.foodAmount * 0.2) + '。'
        });
      }

      /* 2. 情绪型消费占比 */
      if (ex.emotion && ex.emotion.ratioAmount > 15) {
        out.push({
          level: 'warn',
          title: '情绪型消费占比偏高',
          evidence: '情绪型消费 ' + ex.emotion.count + ' 笔、合计 ' + money(ex.emotion.amount) +
            '，占本月支出 ' + percent(ex.emotion.ratioAmount) + '。',
          action: '下次这类消费先放进购物车放 24 小时，回来再决定买不买。'
        });
      }

      /* 3. 夜间餐饮 */
      if (ex.nightFood && ex.nightFood.count >= 2 && ex.nightFood.ratioOfFood >= 25) {
        out.push({
          level: 'tip',
          title: '夜里的外卖和餐饮有点集中',
          evidence: '21:00 之后的餐饮 ' + ex.nightFood.count + ' 笔 ' + money(ex.nightFood.amount) +
            '，占餐饮支出 ' + percent(ex.nightFood.ratioOfFood) + '。',
          action: '这 ' + money(ex.nightFood.amount) + ' 可以先试着挪到白天：定一条「22 点后不下单」，坚持一周看效果。'
        });
      }

      /* 4. 小额高频 */
      if (ex.small && ex.small.ratioCount > 30 && ex.small.count >= 5) {
        out.push({
          level: 'tip',
          title: '小额支出笔数多',
          evidence: '单笔 20 元以下的支出 ' + ex.small.count + ' 笔、合计 ' + money(ex.small.amount) +
            '，占本月支出笔数的 ' + percent(ex.small.ratioCount) + '。',
          action: '把这 ' + ex.small.count + ' 笔、合计 ' + money(ex.small.amount) +
            ' 的零碎花费合成一个「日限额」，超了就停。'
        });
      }

      /* 5. 订阅型支出 */
      if (r.subscriptions && r.subscriptions.length >= 3) {
        var annualTotal = 0;
        var i;
        for (i = 0; i < r.subscriptions.length; i++) {
          annualTotal += r.subscriptions[i].annual;
        }
        out.push({
          level: 'tip',
          title: '有 ' + r.subscriptions.length + ' 笔固定订阅在扣',
          evidence: '「' + r.subscriptions[0].name + '」等 ' + r.subscriptions.length + ' 笔每月固定 ' +
            money(sum(r.subscriptions, function (x) { return x.amount; })) + '，一年要花 ' +
            money(annualTotal) + '。',
          action: '看看哪几个最近没怎么用，先停一个，一年就是 ' + money(r.subscriptions[0].annual) + '。'
        });
      }

      /* 6. 周末日均 */
      var wv = r.weekendVsWeekday || {};
      if (wv.ratio && wv.ratio > 2) {
        out.push({
          level: 'tip',
          title: '周末花得比平时快',
          evidence: '周末日均 ' + money(wv.weekend.avg) + '，工作日日均 ' + money(wv.weekday.avg) +
            '，相差 ' + wv.ratio.toFixed(1) + ' 倍（周末 ' + wv.weekend.count + ' 笔 / 工作日 ' + wv.weekday.count + ' 笔）。',
          action: '周末出门前先定一个当天上限，比如 ' + money(wv.weekend.avg * 0.7) + '。'
        });
      }

      /* 7. 分类环比 */
      if (ex.maxGrowth && ex.maxGrowth.deltaPercent > 30 && ex.maxGrowth.delta > 50) {
        out.push({
          level: 'tip',
          title: ex.maxGrowth.category + '比上月涨了 ' + Math.round(ex.maxGrowth.deltaPercent) + '%',
          evidence: '本月 ' + ex.maxGrowth.category + ' ' + money(ex.maxGrowth.amount) +
            '，上月 ' + money(ex.maxGrowth.prevAmount) + '，多了 ' + money(ex.maxGrowth.delta) + '。',
          action: '本月多了 ' + money(ex.maxGrowth.delta) + '，先翻这 ' + money(ex.maxGrowth.amount) +
            ' 的明细，看看哪几笔是可省的。'
        });
      }
    }

    /* 8. 储蓄率 */
    if (ov.savingsRate !== null && ov.savingsRate < 10) {
      out.push({
        level: 'warn',
        title: '这个月几乎没存下钱',
        evidence: '本月收入 ' + money(ov.income) + '、支出 ' + money(ov.expense) +
          '，结余 ' + money(ov.balance) + '，储蓄率 ' + percent(ov.savingsRate) + '。',
        action: '先把目标定成每月存 ' + money(Math.max(50, ov.expense * 0.1)) + '，发钱当天就先转出去。'
      });
    }

    /* ---- 兜底：保证至少 3 条，且每条都带数字 ---- */
    if (out.length < 3 && ov.expense > 0) {
      var top = (r.categories && r.categories.length > 0) ? r.categories[0] : null;
      if (top) {
        out.push({
          level: 'tip',
          title: '本月最大的一类是' + top.category,
          evidence: top.category + ' ' + money(top.amount) + '，占支出 ' + percent(top.percent) +
            '，共 ' + top.count + ' 笔，笔均 ' + money(top.avg) + '。',
          action: '先从笔均 ' + money(top.avg) + ' 的那几笔看起，通常最容易省。'
        });
      }
      out.push({
        level: 'tip',
        title: '本月支出概况',
        evidence: '共 ' + ov.count + ' 笔、合计 ' + money(ov.expense) + '，笔均 ' + money(ov.avgPerTx) +
          '，有记录的 ' + ov.activeDays + ' 天里日均 ' + money(ov.avgPerDay) + '。',
        action: '按 ' + ov.daysInMonth + ' 天摊，每天约 ' + money(ov.expense / ov.daysInMonth) +
          '，可以拿它当每日限额的参考。'
      });
    }
    /* 这一支只在「有收入」且前面凑不满 3 条时执行。此时结余一定是正的：
       ① expense === 0 → balance === income > 0；
       ② expense > 0 且 balance < 0 → 储蓄率必为负数 → 上面「储蓄率 < 10%」那条必然命中，
          再由 `out.length < 3 && ov.expense > 0` 补足到 3 条，走不到这里。
       所以不需要再判负结余。
       金额用比例（50% / 50%）而不是 money(balance * 0.5)：后者在 report 里反查不到，
       会违反「建议里引用的每个 ¥ 金额都能回到报告」这条约束。 */
    if (out.length < 3 && ov.income > 0) {
      out.push({
        level: 'tip',
        title: '本月收支结构',
        evidence: '收入 ' + money(ov.income) + '、支出 ' + money(ov.expense) + '，结余 ' + money(ov.balance) +
          '，储蓄率 ' + (ov.savingsRate === null ? '—' : percent(ov.savingsRate)) + '。',
        action: '把结余 ' + money(ov.balance) + ' 按 50% / 50% 拆开：一半先转进目标池，一半再当零花。'
      });
    }

    return out.slice(0, 5);
  }

  /* ================================================================== */
  /* ⑧ Markdown 导出                                                     */
  /* ================================================================== */

  /**
   * 第 9 节「列映射」展示串。借贷双列时两个金额列都要展示，
   * 否则用户看到「记账日期 / 借方发生额 / 对方户名」会以为收入列没被识别。
   * @param {Object} cols parseFile().columns
   * @param {boolean} [full] true 时附带「说明 / 分类」（看板用）
   * @return {string}
   */
  function columnMapText(cols, full) {
    var c = cols || {};
    var amountText;
    if (c.amountDebit && c.amountCredit) {
      amountText = c.amountDebit + ' / ' + c.amountCredit;
    } else {
      amountText = c.amountDebit || c.amountCredit || c.amount || '';
    }
    var parts = [c.time, amountText, c.direction, c.counterparty];
    if (full) { parts.push(c.desc, c.category); }
    return parts.filter(Boolean).join(' / ') || '—';
  }

  function mdTable(headers, rows) {
    var out = [];
    out.push('| ' + headers.join(' | ') + ' |');
    out.push('| ' + headers.map(function () { return '---'; }).join(' | ') + ' |');
    var i;
    for (i = 0; i < rows.length; i++) {
      out.push('| ' + rows[i].join(' | ') + ' |');
    }
    return out.join('\n');
  }

  /**
   * 报告 → Markdown 文本（9 节）。
   * @param {Object} rep
   * @return {string}
   */
  function toMarkdown(rep) {
    var r = rep || {};
    var ov = r.overview || {};
    var lines = [];
    lines.push('# 账单分析报告（' + (ov.month || '—') + '）');
    lines.push('');
    lines.push('> 生成时间：' + new Date().toLocaleString('zh-CN') + '　|　共 ' + ((r.meta && r.meta.validCount) || 0) + ' 条有效记录');
    lines.push('');

    lines.push('## 1. 总览');
    lines.push('');
    var prevText = ov.hasPrev
      ? (ov.expenseDeltaPercent === null ? '—' : (ov.expenseDeltaPercent >= 0 ? '+' : '') + ov.expenseDeltaPercent.toFixed(1) + '%')
      : '—';
    lines.push(mdTable(['指标', '数值'], [
      ['总支出', money(ov.expense)],
      ['总收入', money(ov.income)],
      ['结余', money(ov.balance)],
      ['支出笔数', String(ov.count)],
      ['笔均', money(ov.avgPerTx)],
      ['日均（按有记录的天数）', money(ov.avgPerDay) + '（' + ov.activeDays + ' 天）'],
      ['与上月支出对比', prevText],
      ['储蓄率', ov.savingsRate === null ? '—' : percent(ov.savingsRate)]
    ]));
    lines.push('');

    lines.push('## 2. 分类占比与环比');
    lines.push('');
    lines.push(mdTable(['分类', '金额', '占比', '笔数', '笔均', '环比'], (r.categories || []).map(function (c) {
      return [
        c.category,
        money(c.amount),
        percent(c.percent),
        String(c.count),
        money(c.avg),
        c.deltaPercent === null ? '—' : (c.deltaPercent >= 0 ? '+' : '') + c.deltaPercent.toFixed(1) + '%'
      ];
    })));
    lines.push('');

    lines.push('## 3. Top 10 单笔大额');
    lines.push('');
    lines.push(mdTable(['日期', '对方', '说明', '分类', '金额'], (r.topExpenses || []).map(function (x) {
      return [x.date, x.counterparty || '—', x.desc || '—', x.category, money(x.amount)];
    })));
    lines.push('');

    lines.push('## 4. Top 10 高频商户');
    lines.push('');
    lines.push(mdTable(['商户', '笔数', '金额', '笔均'], (r.topMerchants || []).map(function (x) {
      return [x.name, String(x.count), money(x.amount), money(x.avg)];
    })));
    lines.push('');

    lines.push('## 5. 周末 vs 工作日');
    lines.push('');
    var wv = r.weekendVsWeekday || { weekend: {}, weekday: {} };
    lines.push(mdTable(['口径', '笔数', '合计', '天数', '日均'], [
      ['周末', String(wv.weekend.count || 0), money(wv.weekend.amount || 0), String(wv.weekend.days || 0), money(wv.weekend.avg || 0)],
      ['工作日', String(wv.weekday.count || 0), money(wv.weekday.amount || 0), String(wv.weekday.days || 0), money(wv.weekday.avg || 0)]
    ]));
    lines.push('');
    lines.push('周末日均 / 工作日日均 = ' + (wv.ratio === null || wv.ratio === undefined ? '—' : wv.ratio.toFixed(2) + ' 倍'));
    lines.push('');

    lines.push('## 6. 订阅型支出');
    lines.push('');
    if ((r.subscriptions || []).length === 0) {
      lines.push('未发现连续 3 个月「同商户 + 同金额」的固定扣款。');
    } else {
      lines.push(mdTable(['商户', '月扣', '连续月数', '本月仍在扣', '折合一年'], r.subscriptions.map(function (s) {
        return [s.name, money(s.amount), String(s.months), s.activeThisMonth ? '是' : '否', money(s.annual)];
      })));
    }
    lines.push('');

    lines.push('## 7. 异常大额');
    lines.push('');
    if ((r.anomalies || []).length === 0) {
      lines.push('没有单笔超过该分类笔均 3 倍的支出。');
    } else {
      lines.push(mdTable(['日期', '对方', '说明', '分类', '金额', '该分类其余笔均', '倍数'], r.anomalies.map(function (a) {
        return [a.date, a.counterparty || '—', a.desc || '—', a.category, money(a.amount), money(a.othersAvg), a.times.toFixed(1) + '×'];
      })));
    }
    lines.push('');

    lines.push('## 8. 疑似重复');
    lines.push('');
    if ((r.duplicates || []).length === 0) {
      lines.push('未发现同日期 + 同金额 + 同对方的重复记录。');
    } else {
      (r.duplicates || []).forEach(function (g, idx) {
        lines.push((idx + 1) + '. ' + g.date + '　' + money(g.amount) + '　' + (g.counterparty || '—'));
        g.items.forEach(function (it) {
          lines.push('   - ' + it.file + ' 第 ' + it.row + ' 行：' + (it.desc || '—'));
        });
      });
    }
    lines.push('');

    lines.push('## 9. 解析情况');
    lines.push('');
    lines.push(mdTable(['文件', '编码', '表头行', '有效记录', '前置说明行', '无效数据行', '列映射'], (r.parseInfo && r.parseInfo.files || []).map(function (f) {
      return [
        f.name,
        f.encoding || '—',
        f.headerRow ? String(f.headerRow) : '—',
        String(f.records),
        String(f.skippedBefore || 0),
        String(f.skipped || 0),
        columnMapText(f.columns)
      ];
    })));
    lines.push('');

    return lines.join('\n');
  }

  /* ================================================================== */
  /* ⑨ 导入账本                                                          */
  /* ================================================================== */

  /**
   * 推断导入收入的来源（生活费 / 兼职 / 奖学金 …），推断不出才留「其他」。
   * @param {Object} row 记录
   * @return {string}
   */
  function guessIncomeSource(row) {
    var r = row || {};
    var text = [(r.desc || ''), (r.counterparty || ''), (r.note || ''), (r.rawCategory || '')]
      .join(' ').trim();
    var guessed = '';
    if (NLP && typeof NLP.detectIncomeSource === 'function') {
      guessed = NLP.detectIncomeSource(text);
    }
    var sources = DATA.INCOME_SOURCES || [];
    if (guessed && (sources.length === 0 || sources.indexOf(guessed) !== -1)) { return guessed; }
    return '其他';
  }

  /**
   * 把导入记录转成账单草稿（供 app.js commitBill 使用）。
   * @param {Array} rows
   * @param {{month?:string, excludeDuplicates?:boolean}} [opts]
   * @return {Array}
   */
  function rowsToBills(rows, opts) {
    var o = opts || {};
    var list = Array.isArray(rows) ? rows : [];
    var out = [];
    var i;
    for (i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || !r.date || !r.amount) { continue; }
      if (r.excluded) { continue; }
      if (o.excludeDuplicates && r.isDuplicate) { continue; }
      if (o.month && (r.month || monthKeyOf(r.date)) !== o.month) { continue; }
      out.push({
        date: r.date,
        amount: round2(r.amount),
        category: r.type === 'income' ? INCOME_CATEGORY : r.category,
        source: r.type === 'income' ? guessIncomeSource(r) : '',
        note: r.note || r.desc || r.counterparty || r.category,
        motivation: r.type === 'income' ? '刚需' : (r.motivation || '刚需'),
        want: r.type === 'income' ? false : !!r.want,
        type: r.type === 'income' ? 'income' : 'expense',
        imported: true
      });
    }
    return out;
  }

  var API = {
    decodeBytes: decodeBytes,
    isGarbled: isGarbled,
    detectDelimiter: detectDelimiter,
    parseDelimited: parseDelimited,
    parseCsv: parseCsv,
    normHeader: normHeader,
    mapColumns: mapColumns,
    hasAmountColumn: hasAmountColumn,
    detectHeader: detectHeader,
    parseDateTime: parseDateTime,
    cleanAmount: cleanAmount,
    normalizeDirection: normalizeDirection,
    looksExcluded: looksExcluded,
    isWithdrawOrRepay: isWithdrawOrRepay,
    isTransferText: isTransferText,
    resolveCategory: resolveCategory,
    parseFile: parseFile,
    markDuplicates: markDuplicates,
    buildRows: buildRows,
    report: report,
    insights: insights,
    toMarkdown: toMarkdown,
    rowsToBills: rowsToBills,
    guessIncomeSource: guessIncomeSource,
    columnMapText: columnMapText,
    money: money,
    percent: percent,
    shiftMonth: shiftMonth,
    monthKeyOf: monthKeyOf
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.analysis = API;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
