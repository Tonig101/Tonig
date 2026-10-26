/**
 * engine.js — 预算引擎 / 平替建议 / 冷静期 / 目标测算（纯函数，可 Node 直接测试）
 *
 * 对外主要 API：
 *   getCycle(today, payday, cycleLen)
 *   getBudgetState({total, spent, remainingDays, todaySpent})
 *   simulatePurchase({amount, state, remainingDays})
 *   getAlternative(item)
 *   getGoalProjection(goal, monthlySurplus, today)
 *   aggregate(bills, startDate, endDate)
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);
  var DATA;
  if (isNode) {
    DATA = require('./data.js');
  } else {
    global.AJ = global.AJ || {};
    DATA = global.AJ.data;
  }

  var ALTERNATIVES = DATA.ALTERNATIVES;
  var CATEGORY_KEYS = DATA.CATEGORY_KEYS;
  var CATEGORY_KEYWORDS = DATA.CATEGORY_KEYWORDS;
  var ALL_MERCHANTS = DATA.MERCHANTS;
  var COOLDOWN_KEYWORDS = DATA.COOLDOWN_KEYWORDS;

  /** 业务规则：餐饮支出占比超过 60% 触发恩格尔预警 */
  var ENGEL_ALERT_RATIO = 0.6;

  var MS_PER_DAY = 24 * 60 * 60 * 1000;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /** 任意值转 Date（支持 'YYYY-MM-DD' / Date / 时间戳） */
  function toDate(value) {
    if (value instanceof Date) {
      return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      var p = value.split('-');
      return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    }
    var d = new Date(value === undefined || value === null ? Date.now() : value);
    if (isNaN(d.getTime())) { return new Date(); }
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /** Date -> 'YYYY-MM-DD' */
  function formatDate(value) {
    var d = toDate(value);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 日期加天数 */
  function addDays(value, days) {
    var d = toDate(value);
    d.setDate(d.getDate() + Math.round(days));
    return d;
  }

  /** b - a 的天数差 */
  function diffDays(a, b) {
    var da = toDate(a);
    var db = toDate(b);
    return Math.round((db.getTime() - da.getTime()) / MS_PER_DAY);
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function round2(n) {
    var v = Number(n);
    if (!isFinite(v)) { return 0; }
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  /** 一位小数金额，用于文案 */
  function fmt1(n) {
    var v = round2(n);
    return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1);
  }

  /** 两位小数金额，带千分位 */
  function fmtMoney(n) {
    var v = round2(n);
    var neg = v < 0;
    var abs = Math.abs(v);
    var s = abs.toFixed(2);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-¥' : '¥') + parts[0] + '.' + parts[1];
  }

  function clampInt(v, min, max, fallback) {
    var n = Math.round(num(v));
    if (!isFinite(n) || n < min || n > max) { return fallback; }
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* 周期                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 按"发生活费日"计算当前预算周期。
   * 发钱日 15 号则周期为 15 号到次月 14 号。
   *
   * 第 3 参同时兼容三种写法（保持 v1 调用方零改动）：
   *   getCycle(today, payday)                       // v1 行为
   *   getCycle(today, payday, 30)                   // 固定周期长度（v1 已支持）
   *   getCycle(today, payday, null, '2025-10-23')    // 自定义起点
   *   getCycle(today, payday, '2025-10-23')         // 自定义起点（便捷写法）
   *
   * @param {Date|string} today 今天
   * @param {number} payday 发钱日（1-28）
   * @param {number|string} [cycleLenOrStart] 周期长度（天）或自定义起点 'YYYY-MM-DD'
   * @param {string} [overrideStart] 自定义起点 'YYYY-MM-DD'
   * @return {{start:string,end:string,totalDays:number,passedDays:number,remainingDays:number,isCustom:boolean}}
   */
  function getCycle(today, payday, cycleLenOrStart, overrideStart) {
    var now = toDate(today);
    var pd = clampInt(payday, 1, 28, 1);
    var cycleLen = 0;
    var customStart = null;
    var arg3 = cycleLenOrStart;

    if (typeof arg3 === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(arg3)) {
      customStart = arg3;
    } else if (typeof arg3 === 'number' && arg3 >= 1) {
      cycleLen = Math.round(arg3);
    } else if (arg3 && typeof arg3 === 'object') {
      if (typeof arg3.cycleLen === 'number' && arg3.cycleLen >= 1) {
        cycleLen = Math.round(arg3.cycleLen);
      }
      if (typeof arg3.overrideStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(arg3.overrideStart)) {
        customStart = arg3.overrideStart;
      }
    }
    if (typeof overrideStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(overrideStart)) {
      customStart = overrideStart;
    }

    /* ---- 分支 A：自定义起点（必须 <= 今天才生效，否则回退发钱日） ---- */
    var start;
    var end;
    var isCustom = false;

    if (customStart) {
      var cs = toDate(customStart);
      if (cs.getTime() <= now.getTime()) {
        start = cs;
        // 该起点之后（严格晚于起点）的第一个发钱日，再减 1 天
        var nextPayday = new Date(cs.getFullYear(), cs.getMonth(), pd);
        if (nextPayday.getTime() <= cs.getTime()) {
          nextPayday = new Date(cs.getFullYear(), cs.getMonth() + 1, pd);
        }
        end = addDays(nextPayday, -1);
        isCustom = true;
      }
    }

    /* ---- 分支 B：v1 行为（发钱日推算 / 固定长度） ---- */
    if (!isCustom) {
      var y = now.getFullYear();
      var m = now.getMonth();
      var d = now.getDate();
      start = (d >= pd) ? new Date(y, m, pd) : new Date(y, m - 1, pd);
      if (cycleLen > 0) {
        end = addDays(start, cycleLen - 1);
      } else {
        end = addDays(new Date(start.getFullYear(), start.getMonth() + 1, pd), -1);
      }
    }

    var totalDays = diffDays(start, end) + 1;
    if (totalDays < 1) { totalDays = 1; }
    var passedDays = diffDays(start, now) + 1;
    if (passedDays < 1) { passedDays = 1; }
    if (passedDays > totalDays) { passedDays = totalDays; }
    var remainingDays = totalDays - passedDays + 1;
    if (remainingDays < 1) { remainingDays = 1; }

    return {
      start: formatDate(start),
      end: formatDate(end),
      totalDays: totalDays,
      passedDays: passedDays,
      remainingDays: remainingDays,
      isCustom: isCustom
    };
  }

  /* ------------------------------------------------------------------ */
  /* 预算状态                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 计算预算状态。
   * @param {{total:number, spent:number, remainingDays:number, todaySpent?:number}} opts
   * @return {{remaining:number, dailyAllowance:number, isOver:boolean, overBy:number,
   *           todayRemain:number, status:string, spendPercent:number}}
   */
  function getBudgetState(opts) {
    var o = opts || {};
    var total = num(o.total);
    var spent = num(o.spent);
    var remainingDays = Math.max(1, Math.round(num(o.remainingDays) || 1));
    var todaySpent = num(o.todaySpent);

    var remaining = round2(total - spent);
    var dailyAllowance = round2(remaining / remainingDays);
    var isOver = remaining < 0;
    var overBy = isOver ? round2(-remaining) : 0;
    var todayRemain = round2(Math.max(0, dailyAllowance - todaySpent));
    var spendPercent = total > 0 ? round2(Math.min(999, spent / total * 100)) : 0;

    var status;
    if (remaining <= 0) {
      status = 'danger';
    } else if (dailyAllowance < 20) {
      status = 'danger';
    } else if (dailyAllowance < 40) {
      status = 'tight';
    } else {
      status = 'safe';
    }

    return {
      remaining: remaining,
      dailyAllowance: dailyAllowance,
      isOver: isOver,
      overBy: overBy,
      todaySpent: round2(todaySpent),
      todayRemain: todayRemain,
      status: status,
      spendPercent: spendPercent
    };
  }

  /* ------------------------------------------------------------------ */
  /* 购买模拟                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 模拟一笔消费对日均可用额度的影响。
   * @param {{amount:number, state:Object, remainingDays:number}} opts
   * @return {{verdict:string,newDaily:number,afterBalance:number,noodleDays:number,message:string}}
   */
  function simulatePurchase(opts) {
    var o = opts || {};
    var amount = num(o.amount);
    var state = o.state || {};
    var remainingDays = Math.max(1, Math.round(num(o.remainingDays) || num(state.remainingDays) || 1));
    var remaining = num(state.remaining);

    var afterBalance = round2(remaining - amount);
    var newDaily = round2(afterBalance / remainingDays);
    var verdict = 'ok';
    var noodleDays = 0;
    var message;

    if (afterBalance < 0) {
      verdict = 'danger';
      noodleDays = remainingDays;
      message = '买完这笔，本周期生活费直接超支 ¥' + fmt1(-afterBalance) +
        '，接下来 ' + remainingDays + ' 天只能靠 ' + noodleDays + ' 天泡面配食堂免费汤。';
      return {
        verdict: verdict,
        newDaily: newDaily,
        afterBalance: afterBalance,
        noodleDays: noodleDays,
        message: message
      };
    }

    if (newDaily < 15) {
      verdict = 'danger';
      noodleDays = Math.max(1, Math.ceil((15 - newDaily) / 15 * remainingDays));
      message = '买完这笔，接下来 ' + remainingDays + ' 天日均只剩 ¥' + fmt1(newDaily) +
        '。真买的话大概要 ' + noodleDays + ' 天泡面配食堂免费汤。';
    } else if (newDaily < 30) {
      verdict = 'tight';
      message = '买完这笔，接下来 ' + remainingDays + ' 天日均只剩 ¥' + fmt1(newDaily) +
        '，只够吃食堂，别的花销先停一停吧。';
    } else {
      verdict = 'ok';
      message = '买完这笔，接下来 ' + remainingDays + ' 天日均还有 ¥' + fmt1(newDaily) +
        '，问题不大，放心买。';
    }

    return {
      verdict: verdict,
      newDaily: newDaily,
      afterBalance: afterBalance,
      noodleDays: noodleDays,
      message: message
    };
  }

  /* ------------------------------------------------------------------ */
  /* 平替推荐                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 查找校园平替方案。
   * @param {string|{note?:string,category?:string,amount?:number}} item
   * @return {?{id:string,brand:string,altName:string,altPrice:number,paid:number,
   *            save:number,weeklySave:number,times:number,unit:string,tip:string}}
   */
  function getAlternative(item) {
    var text = '';
    var paidAmount = 0;
    if (typeof item === 'string') {
      text = item;
    } else if (item && typeof item === 'object') {
      text = (item.note || '') + ' ' + (item.category || '');
      paidAmount = num(item.amount);
    }
    if (!text.trim()) { return null; }

    var best = null;
    var bestLen = 0;
    var i;
    var j;
    for (i = 0; i < ALTERNATIVES.length; i++) {
      var alt = ALTERNATIVES[i];
      for (j = 0; j < alt.keywords.length; j++) {
        var kw = alt.keywords[j];
        if (text.indexOf(kw) !== -1 && kw.length > bestLen) {
          best = alt;
          bestLen = kw.length;
        }
      }
    }
    if (!best) { return null; }

    // 取"品牌单价"与"实付金额"中较小的一个：
    // ① 批量消费（一次打印 36 元）不会算出几十元的荒谬省钱数；
    // ② 用券后实付很低时，省钱额也随之收敛，不会出现"省的钱比花的多"。
    var effectivePaid = best.brandPrice;
    if (paidAmount > 0 && paidAmount < effectivePaid) {
      effectivePaid = paidAmount;
    }
    // 实付都不够买平替（用券场景），推荐没有意义，直接不返回
    if (effectivePaid <= best.altPrice) { return null; }

    var save = round2(effectivePaid - best.altPrice);
    var times = (typeof best.times === 'number' && best.times > 0) ? best.times : 1;
    return {
      id: best.id,
      brand: best.brand,
      altName: best.altName,
      altPrice: round2(best.altPrice),
      paid: round2(effectivePaid),
      save: save,
      times: times,
      weeklySave: round2(save * times),
      unit: best.unit,
      tip: best.tip || best.timesText
    };
  }

  /* ------------------------------------------------------------------ */
  /* 汇总                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 汇总指定日期区间内的账单。
   * @param {Array} bills
   * @param {string} [startDate] 'YYYY-MM-DD'，含
   * @param {string} [endDate] 'YYYY-MM-DD'，含
   * @return {{expense:number,income:number,count:number,byCategory:Object,dailyMap:Object}}
   */
  function aggregate(bills, startDate, endDate) {
    /* 容错：调用方若传 Date，内部比较（b.date 是 YYYY-MM-DD 字符串）会静默失效、
       退化成统计全量账单。这里统一归一到日期串，避免周期/环比口径算错。 */
    if (startDate instanceof Date) { startDate = formatDate(startDate); }
    if (endDate instanceof Date) { endDate = formatDate(endDate); }
    var result = {
      expense: 0,
      income: 0,
      count: 0,
      byCategory: {},
      dailyMap: {}
    };
    var i;
    for (i = 0; i < CATEGORY_KEYS.length; i++) {
      result.byCategory[CATEGORY_KEYS[i]] = 0;
    }
    var list = Array.isArray(bills) ? bills : [];
    for (i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || !b.date) { continue; }
      if (startDate && b.date < startDate) { continue; }
      if (endDate && b.date > endDate) { continue; }
      var amount = num(b.amount);
      if (b.type === 'income') {
        result.income = round2(result.income + amount);
        continue;
      }
      result.count++;
      result.expense = round2(result.expense + amount);
      if (!Object.prototype.hasOwnProperty.call(result.byCategory, b.category)) {
        result.byCategory[b.category] = 0;
      }
      result.byCategory[b.category] = round2(result.byCategory[b.category] + amount);
      result.dailyMap[b.date] = round2((result.dailyMap[b.date] || 0) + amount);
    }
    return result;
  }

  /**
   * 恩格尔系数（餐饮支出 / 总支出）。
   * @param {Object} byCategory aggregate().byCategory
   * @return {{ratio:number, percent:number, alert:boolean}}
   */
  function getEngel(byCategory, totalExpense) {
    var food = num(byCategory && byCategory['餐饮']);
    var total = num(totalExpense);
    var ratio = total > 0 ? food / total : 0;
    var percent = round2(ratio * 100);
    return { ratio: ratio, percent: percent, alert: percent > 60 };
  }

  /**
   * 业务规则 1：从记账语句里提取「商家」（南海北区商家词典，最长词优先）。
   * @param {string} text 原始语句 / 备注
   * @return {string} 商家名，未命中返回 ''
   */
  function extractMerchant(text) {
    var s = String(text || '');
    if (!s) { return ''; }
    var best = '';
    var bestLen = 0;
    for (var i = 0; i < ALL_MERCHANTS.length; i++) {
      var m = ALL_MERCHANTS[i];
      for (var j = 0; j < m.words.length; j++) {
        var w = m.words[j];
        if (s.indexOf(w) !== -1 && w.length > bestLen) {
          best = m.key;
          bestLen = w.length;
        }
      }
    }
    return best;
  }

  /**
   * 业务规则：单笔非刚需支出（游戏充值、盲盒、潮玩、超出日常预算的聚会）命中关键词。
   * @param {Object|string} billOrText
   * @return {boolean}
   */
  function hitsCooldownKeyword(billOrText) {
    var text = '';
    if (typeof billOrText === 'string') {
      text = billOrText;
    } else if (billOrText) {
      text = (billOrText.note || '') + ' ' + (billOrText.category || '');
    }
    if (!text) { return false; }
    for (var i = 0; i < COOLDOWN_KEYWORDS.length; i++) {
      if (text.indexOf(COOLDOWN_KEYWORDS[i]) !== -1) { return true; }
    }
    return false;
  }

  /**
   * 周期收支概览（看板「收支概览」卡数据源）。
   * 储蓄率 = (收入 - 支出) / 收入 * 100；收入为 0 时返回 null，避免 NaN / Infinity。
   * @param {Array} bills 账单
   * @param {{start:string,end:string}} cycle 周期（getCycle 返回值）
   * @return {{income:number,expense:number,balance:number,savingsRate:?number,
   *           incomeCount:number,expenseCount:number,hasIncome:boolean}}
   */
  function getIncomeStats(bills, cycle) {
    var c = cycle || {};
    var agg = aggregate(bills, c.start, c.end);
    var income = round2(agg.income);
    var expense = round2(agg.expense);
    var balance = round2(income - expense);
    var savingsRate = income > 0 ? round2(balance / income * 100) : null;
    var incomeCount = 0;
    var list = Array.isArray(bills) ? bills : [];
    var i;
    for (i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || !b.date || b.type !== 'income') { continue; }
      if (c.start && b.date < c.start) { continue; }
      if (c.end && b.date > c.end) { continue; }
      incomeCount++;
    }
    return {
      income: income,
      expense: expense,
      balance: balance,
      savingsRate: savingsRate,
      incomeCount: incomeCount,
      expenseCount: agg.count,
      hasIncome: income > 0
    };
  }

  /* ------------------------------------------------------------------ */
  /* 目标测算                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 计算目标进度与"还需几个月"。
   * @param {{name:string,target:number,saved:number,deadline:string}} goal
   * @param {number} monthlySurplus 每月可结余金额
   * @param {Date|string} today
   * @return {{need:number,percent:number,monthsLeft:?number,monthsToDeadline:?number,
   *           lateMonths:?number,extraPerMonth:number}}
   */
  function getGoalProjection(goal, monthlySurplus, today) {
    var g = goal || {};
    var target = num(g.target);
    var saved = num(g.saved);
    var surplus = Math.max(0, num(monthlySurplus));
    var need = round2(Math.max(0, target - saved));
    var percent = target > 0 ? round2(Math.min(100, saved / target * 100)) : 0;

    var monthsLeft = null;
    if (need <= 0) {
      monthsLeft = 0;
    } else if (surplus > 0) {
      monthsLeft = Math.ceil(need / surplus);
    }

    var monthsToDeadline = null;
    if (g.deadline && /^\d{4}-\d{2}-\d{2}$/.test(g.deadline)) {
      var days = diffDays(toDate(today), toDate(g.deadline));
      monthsToDeadline = days <= 0 ? 0 : Math.ceil(days / 30.44);
    }

    var lateMonths = null;
    var extraPerMonth = 0;
    if (monthsToDeadline !== null) {
      if (monthsLeft !== null) {
        lateMonths = Math.max(0, monthsLeft - monthsToDeadline);
      }
      if (need > 0 && monthsToDeadline > 0) {
        var needPerMonth = need / monthsToDeadline;
        extraPerMonth = Math.max(0, Math.ceil(round2(needPerMonth - surplus)));
      }
    }

    return {
      need: need,
      percent: percent,
      monthsLeft: monthsLeft,
      monthsToDeadline: monthsToDeadline,
      lateMonths: lateMonths,
      extraPerMonth: extraPerMonth
    };
  }

  var API = {
    toDate: toDate,
    formatDate: formatDate,
    addDays: addDays,
    diffDays: diffDays,
    round2: round2,
    fmt1: fmt1,
    fmtMoney: fmtMoney,
    getCycle: getCycle,
    getBudgetState: getBudgetState,
    simulatePurchase: simulatePurchase,
    getAlternative: getAlternative,
    aggregate: aggregate,
    getEngel: getEngel,
    extractMerchant: extractMerchant,
    hitsCooldownKeyword: hitsCooldownKeyword,
    getIncomeStats: getIncomeStats,
    getGoalProjection: getGoalProjection
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.engine = API;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
