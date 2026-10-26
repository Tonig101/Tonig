/**
 * diagnose.js — 消费诊断规则集 + 周期末预测（纯函数，零存储、零文案）
 *
 * 定位：只回答「这个周期哪里花得不对」和「照这个节奏到期末会怎样」，
 *       产出结构化的**事实**（code / level / amount / ...），句子交给 app.js
 *       用 tone.js 拼 —— 这样换语气零成本、规则可单测、不碰既有文案断言。
 *
 * 边界：不读 localStorage、不写 state、不 import 任何东西；
 *       账单数组由调用方传入，缺字段一律当 0 / 空处理，绝不抛异常。
 *
 * 对外 API（window.AJ.diagnose）：
 *   forecast(o)     周期末预测 → {projected, remainingAtEnd, overBudgetBy, level, dailyAvg}
 *   build(o)        诊断规则 → 最多 3 条 [{code, level, amount, ...}]，已按严重度排序
 *   maxSeverity(l)  列表里的最高等级 → 'high'|'mid'|'low'|''
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);

  /* 分类的「必需 / 非必需」来自 data.js（本轮只给 CATEGORIES 追加了 essential），
     这里只读不写；拿不到 data.js 时 wantRatio 规则自动沉默，绝不自造一份分类表。 */
  var DATA = null;
  if (isNode) {
    try { DATA = require('./data.js'); } catch (e) { DATA = null; }
  } else if (global.AJ && global.AJ.data) {
    DATA = global.AJ.data;
  }

  /** 单次诊断最多给几条：3 条以外用户根本不看，还会把卡片撑长 */
  var MAX_ITEMS = 3;
  /** cycleUp 的触发门槛：环比涨 30% 才算「花快了」 */
  var UP_THRESHOLD = 0.3;
  /** 环比涨 80% 升级为 high */
  var UP_HIGH = 0.8;
  /** 非必需占比触发的金额下限（元）：几十块的非必需不值得一提 */
  var WANT_MIN_AMOUNT = 100;
  /** 非必需占比默认阈值（settings.alertRatio 未配置时用） */
  var DEFAULT_ALERT_RATIO = 0.8;
  /** 小额高频：笔数下限 */
  var SMALL_MIN_COUNT = 5;
  /** 小额阈值上下限（元） */
  var SMALL_MIN_THR = 10;
  var SMALL_MAX_THR = 100;

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /** 两位小数四舍五入（与 engine.round2 同口径，模块内自带以保持零依赖） */
  function round2(n) {
    var v = num(n);
    return Math.round(v * 100) / 100;
  }

  /* ------------------------------------------------------------------ */
  /* 周期末预测                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 「照这个节奏，期末会怎样」。
   * @param {{spent:number, passedDays:number, remainingDays:number, total:number}} o
   * @return {{projected:number, remainingAtEnd:number, overBudgetBy:number,
   *           level:string, dailyAvg:number}}
   *   level: over（已确定超支） / tight（结余不到两天的日均） / safe
   */
  function forecast(o) {
    var src = o || {};
    var spent = Math.max(0, round2(src.spent));
    var total = Math.max(0, round2(src.total));
    // 周期第一天时 passedDays 可能算成 0，除法会炸，兜底为 1
    var passedDays = Math.max(1, Math.round(num(src.passedDays)));
    var remainingDays = Math.max(0, Math.round(num(src.remainingDays)));

    var dailyAvg = round2(spent / passedDays);
    var projected = round2(spent + dailyAvg * remainingDays);
    var remainingAtEnd = round2(total - projected);
    var overBudgetBy = total > 0 ? round2(Math.max(0, projected - total)) : 0;

    var level;
    if (overBudgetBy > 0) {
      level = 'over';
    } else if (remainingAtEnd < dailyAvg * 2) {
      level = 'tight';
    } else {
      level = 'safe';
    }

    return {
      projected: projected,
      remainingAtEnd: remainingAtEnd,
      overBudgetBy: overBudgetBy,
      level: level,
      dailyAvg: dailyAvg
    };
  }

  /* ------------------------------------------------------------------ */
  /* 诊断规则                                                            */
  /* ------------------------------------------------------------------ */

  /** 非必需分类集合（从 data.js 现算，避免和 CATEGORIES 两处维护） */
  function nonEssentialMap() {
    var map = {};
    var cats = (DATA && Array.isArray(DATA.CATEGORIES)) ? DATA.CATEGORIES : [];
    for (var i = 0; i < cats.length; i++) {
      if (cats[i] && cats[i].essential === false && cats[i].key) {
        map[cats[i].key] = 1;
      }
    }
    return map;
  }

  /** 统一成一条诊断事实：缺的字段补默认值，下游不用做 null 判断 */
  function entry(code, level, amount, extra) {
    var e = {
      code: code,
      level: level,
      amount: round2(amount),
      count: 0,
      ratio: 0,
      category: '',
      days: 0,
      threshold: 0
    };
    var k;
    if (extra) {
      for (k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) { e[k] = extra[k]; }
      }
    }
    return e;
  }

  /** 规则①：单日支出超上限（只统计 cycle.start..todayKey，未到日子不算） */
  function ruleDailyOver(dailyMap, start, endOfToday, cap) {
    if (!(cap > 0)) { return null; }
    var days = 0;
    var peak = 0;
    var k;
    for (k in dailyMap) {
      if (!Object.prototype.hasOwnProperty.call(dailyMap, k)) { continue; }
      if (k < start || k > endOfToday) { continue; }
      var sum = round2(dailyMap[k]);
      if (sum > cap) {
        days++;
        if (sum > peak) { peak = sum; }
      }
    }
    if (days < 1) { return null; }
    // 超了 3 天及以上说明是习惯问题，不是偶然
    return entry('dailyOver', days >= 3 ? 'high' : 'mid', peak, { days: days });
  }

  /** 规则②（原设计中的分类预算规则已随「分类预算上限」整块砍掉，不实现） */

  /** 规则③：非必需占比过高 */
  function ruleWantRatio(wantAmt, expense, alertRatio) {
    if (expense <= 0) { return null; }
    if (wantAmt <= WANT_MIN_AMOUNT) { return null; }
    var ratio = wantAmt / expense;
    if (ratio < alertRatio) { return null; }
    return entry('wantRatio', 'mid', wantAmt, { ratio: Math.round(ratio * 100) });
  }

  /** 规则④：环比上个周期涨得太快 */
  function ruleCycleUp(expense, prevExpense) {
    if (!(prevExpense > 0)) { return null; }
    var growth = (expense - prevExpense) / prevExpense;
    if (!(growth > UP_THRESHOLD)) { return null; }
    return entry('cycleUp', growth > UP_HIGH ? 'high' : 'mid', expense, {
      ratio: Math.round(growth * 100)
    });
  }

  /** 规则⑤：小额高频（奶茶 / 零食这种，单笔不起眼、加起来最贵） */
  function ruleSmallFreq(list, dailyAvg) {
    var thr = round2(Math.max(SMALL_MIN_THR, Math.min(dailyAvg * 0.5, SMALL_MAX_THR)));
    var count = 0;
    var sum = 0;
    var i;
    for (i = 0; i < list.length; i++) {
      var a = round2(list[i].amount);
      if (a <= 0 || a > thr) { continue; }
      count++;
      sum += a;
    }
    if (count < SMALL_MIN_COUNT) { return null; }
    return entry('smallFreq', 'mid', sum, { count: count, threshold: thr });
  }

  var LEVEL_WEIGHT = { high: 3, mid: 2, low: 1 };

  /**
   * 消费诊断主入口。
   * @param {{bills:Array, cycle:{start:string,end:string,passedDays:number,remainingDays:number},
   *          prevExpense:number, settings:{dailyCap:number, alertRatio:number},
   *          todayKey:string}} o
   * @return {Array<{code:string, level:string, amount:number, count:number, ratio:number,
   *                 category:string, days:number, threshold:number}>}
   */
  function build(o) {
    var src = o || {};
    var bills = Array.isArray(src.bills) ? src.bills : [];
    var cycle = src.cycle || {};
    var settings = src.settings || {};
    var start = (typeof cycle.start === 'string') ? cycle.start : '';
    var end = (typeof cycle.end === 'string') ? cycle.end : '';
    var todayKey = (typeof src.todayKey === 'string' && src.todayKey) ? src.todayKey : end;
    // 今天已超出周期末时，按周期末截断（历史周期回看时不会把未来的账算进来）
    if (end && todayKey > end) { todayKey = end; }

    var expense = 0;
    var wantAmt = 0;
    var dailyMap = {};
    var inCycle = [];
    var nonEssential = nonEssentialMap();
    var i;

    for (i = 0; i < bills.length; i++) {
      var b = bills[i];
      if (!b || typeof b !== 'object') { continue; }
      if (b.type === 'income') { continue; }
      var date = (typeof b.date === 'string') ? b.date : '';
      if (!date) { continue; }
      if (start && date < start) { continue; }
      if (end && date > end) { continue; }
      var amount = round2(b.amount);
      if (amount <= 0) { continue; }
      inCycle.push(b);
      expense = round2(expense + amount);
      dailyMap[date] = round2(num(dailyMap[date]) + amount);
      if (nonEssential[b.category]) { wantAmt = round2(wantAmt + amount); }
    }

    if (expense <= 0) { return []; }

    var passedDays = Math.max(1, Math.round(num(cycle.passedDays)));
    var dailyAvg = round2(expense / passedDays);
    var alertRatio = num(settings.alertRatio);
    if (alertRatio <= 0 || alertRatio > 1) { alertRatio = DEFAULT_ALERT_RATIO; }

    var list = [];
    var r;
    r = ruleDailyOver(dailyMap, start, todayKey, num(settings.dailyCap));
    if (r) { list.push(r); }
    r = ruleWantRatio(wantAmt, expense, alertRatio);
    if (r) { list.push(r); }
    r = ruleCycleUp(expense, num(src.prevExpense));
    if (r) { list.push(r); }
    r = ruleSmallFreq(inCycle, dailyAvg);
    if (r) { list.push(r); }

    // 严重度优先，同级按金额降序（钱多的那条更值得先看）
    list.sort(function (a, b) {
      var wa = LEVEL_WEIGHT[a.level] || 0;
      var wb = LEVEL_WEIGHT[b.level] || 0;
      if (wa !== wb) { return wb - wa; }
      return b.amount - a.amount;
    });
    return list.slice(0, MAX_ITEMS);
  }

  /**
   * 列表里的最高严重度。
   * @param {Array} list build() 的结果
   * @return {string} 'high' | 'mid' | 'low' | ''
   */
  function maxSeverity(list) {
    var arr = Array.isArray(list) ? list : [];
    var best = '';
    var bestW = 0;
    for (var i = 0; i < arr.length; i++) {
      var w = LEVEL_WEIGHT[arr[i] && arr[i].level] || 0;
      if (w > bestW) {
        bestW = w;
        best = arr[i].level;
      }
    }
    return best;
  }

  var API = {
    MAX_ITEMS: MAX_ITEMS,
    forecast: forecast,
    build: build,
    maxSeverity: maxSeverity
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.diagnose = API;
  }
})(typeof window !== 'undefined' ? window : this);
