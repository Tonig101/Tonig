/**
 * nlp.js — 自然语言账单解析器（纯函数，可 Node 直接测试）
 *
 * 对外主函数：parseBill(text, options) -> { items: BillDraft[], unparsed: string[] }
 *
 * BillDraft = {
 *   date: 'YYYY-MM-DD', amount: Number, category: String, note: String,
 *   motivation: '刚需'|'情绪', want: Boolean, type: 'expense'|'income',
 *   meal: String, raw: String
 * }
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

  var CATEGORIES = DATA.CATEGORIES;
  var CATEGORY_KEYWORDS = DATA.CATEGORY_KEYWORDS;
  var EMOTION_KEYWORDS = DATA.EMOTION_KEYWORDS;
  var WANT_KEYWORDS = DATA.WANT_KEYWORDS;
  var INCOME_KEYWORDS = DATA.INCOME_KEYWORDS;
  var DATE_WORDS = DATA.DATE_WORDS;
  var MEAL_WORDS = DATA.MEAL_WORDS;
  var STOP_WORDS = DATA.STOP_WORDS;
  var LEADING_CONNECTORS = DATA.LEADING_CONNECTORS;

  /** 连接词：出现即视为分句边界 */
  var CONNECTORS = ['还有', '然后', '另外', '加上', '以及', '顺便'];

  /** 停用词按长度倒序，保证 "买了" 先于 "买" 被剔除 */
  var STOP_SORTED = STOP_WORDS.slice().sort(function (a, b) {
    return b.length - a.length;
  });

  /* ------------------------------------------------------------------ */
  /* 通用工具                                                            */
  /* ------------------------------------------------------------------ */

  /** 补零到两位 */
  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /** Date -> 'YYYY-MM-DD' */
  function toDateStr(date) {
    var d = (date instanceof Date) ? date : new Date(date);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 四舍五入保留两位小数 */
  function round2(n) {
    var v = Number(n);
    if (!isFinite(v)) { return 0; }
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  /**
   * 全角字符归一化：０-９ → 0-9，． → . ，；：！？ → 半角。
   * 归一化是 1:1 字符替换，不改变字符串长度，因此索引仍然有效。
   * @param {string} text
   * @return {string}
   */
  function normalizeWidth(text) {
    return String(text)
      .replace(/[\uFF10-\uFF19]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      })
      .replace(/\uFF0E/g, '.')
      .replace(/\uFF0C/g, ',')
      .replace(/\uFF1B/g, ';')
      .replace(/\uFF1A/g, ':')
      .replace(/\uFF01/g, '!')
      .replace(/\uFF1F/g, '?');
  }

  /* ------------------------------------------------------------------ */
  /* 中文数字                                                            */
  /* ------------------------------------------------------------------ */

  var CN_DIGITS = {
    '零': 0, '〇': 0, '一': 1, '壹': 1, '二': 2, '两': 2, '贰': 2,
    '三': 3, '叁': 3, '四': 4, '肆': 4, '五': 5, '伍': 5,
    '六': 6, '陆': 6, '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9
  };

  var CN_UNITS = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 };

  /**
   * 中文数字转阿拉伯数字。
   * 支持：十八 / 五十 / 两百 / 一百二（120）/ 一百零二（102）/ 一千二（1200）
   * @param {string} cn 中文数字串
   * @return {number}
   */
  function chineseToNumber(cn) {
    if (!cn) { return 0; }
    var section = 0;
    var num = 0;
    var lastUnit = 0;
    var hasLing = false;
    var i;
    var c;
    for (i = 0; i < cn.length; i++) {
      c = cn.charAt(i);
      if (Object.prototype.hasOwnProperty.call(CN_DIGITS, c)) {
        num = CN_DIGITS[c];
        if (c === '零' || c === '〇') { hasLing = true; }
      } else if (Object.prototype.hasOwnProperty.call(CN_UNITS, c)) {
        var u = CN_UNITS[c];
        if (num === 0) { num = 1; }
        section += num * u;
        num = 0;
        lastUnit = u;
      }
    }
    var total = section + num;
    if (!hasLing && num > 0 && num < 10 && lastUnit >= 100) {
      total = section + num * (lastUnit / 10);
    }
    return total;
  }

  /* ------------------------------------------------------------------ */
  /* 金额识别                                                            */
  /* ------------------------------------------------------------------ */

  /** 判断区间是否与已识别金额重叠 */
  function overlaps(list, start, end) {
    var i;
    for (i = 0; i < list.length; i++) {
      if (start < list[i].end && end > list[i].start) { return true; }
    }
    return false;
  }

  var RE_ARABIC = /\d+(?:\.\d{1,2})?/g;
  var RE_CHINESE = /[零〇一二两三四五六七八九十百千]+/g;
  var RE_CN_UNIT_AFTER = /^(元|块钱|块|毛|角)/;
  var RE_CN_TRIGGER_BEFORE = /(花了|花费|付了|付款|支付|用了|一共|总共|合计|消费|充值|充了|买了|买|才|就|价格|价)$/;

  /**
   * 【统一排除表】数字后面紧跟这些字时，它表示"数量"或"时间"，不是钱。
   * 例：9点 / 3号线 / 30分钟 / 两包 / 三折 / 12岁
   * 注意：绝对不要把 元/块/毛/角/钱 放进来，否则所有金额都会被误杀。
   */
  var RE_NON_MONEY_SUFFIX = /^(点|号|线|楼|层|岁|折|个|只|张|份|杯|瓶|件|斤|袋|盒|碗|串|根|支|把|套|位|人|家|门|台|本|条|顿|箱|包|桶|罐|卷|片|颗|粒|双|次|天|年|月|日|时|分|秒|%|％)/;

  /**
   * 数量词子集：只用于"口语小数合成"场景。
   * 「十块三个包子」里的 "3" 是数量，不能和前面的 "十块" 合成 10.3。
   * 刻意不含 毛/角 —— 「399块9毛」仍然要合成 399.9。
   */
  var RE_QUANTITY_SUFFIX = /^(个|只|张|份|杯|瓶|件|斤|袋|盒|碗|串|根|支|把|套|位|人|条|顿|箱|包|桶|罐|卷|片|颗|粒|双)/;

  /** 口语法小数：9块9 / 19块9 / 3块5 -> 9.9 / 19.9 / 3.5 */
  var RE_ARABIC_DECIMAL = /(\d+)\s*(?:块|元)\s*([1-9])(?![\d.])/g;
  /** 口语法小数（中文数字）：五块五 / 两块五 -> 5.5 / 2.5 */
  var RE_CHINESE_DECIMAL = /([零〇一二两三四五六七八九十百千]+)\s*(?:块|元)\s*([一二三四五六七八九])(?![\d.一二三四五六七八九十百千])/g;

  /**
   * 取 idx 处的后置字符片段（允许跳过最多 1 个空格，兼容 "9 点"）。
   * @param {string} text
   * @param {number} idx
   * @return {string} 最多两个字符
   */
  function suffixAt(text, idx) {
    var i = idx;
    if (i < text.length && text.charAt(i) === ' ') { i++; }
    return text.slice(i, i + 2);
  }

  /**
   * 统一判定：idx 处是否紧跟"非金额单位"（数量词 / 时间词）。
   * 三处扫描（阿拉伯数字、小数预扫描、中文数字）复用此函数，逻辑只有一份。
   * @param {string} text
   * @param {number} idx 数字结束位置
   * @return {boolean}
   */
  function isNonMoneySuffix(text, idx) {
    return RE_NON_MONEY_SUFFIX.test(suffixAt(text, idx));
  }

  /**
   * 统一判定：idx 处是否是"数量词"（用于小数合成场景）。
   * @param {string} text
   * @param {number} idx
   * @return {boolean}
   */
  function isQuantitySuffix(text, idx) {
    return RE_QUANTITY_SUFFIX.test(suffixAt(text, idx));
  }

  /**
   * 从文本中按出现顺序抽取所有金额。
   * 阿拉伯数字直接采信；中文数字必须带单位或带触发动词，避免 "三食堂" 被误判。
   * "9块9" 这类口语小数先合成一笔，避免被拆成 9 和 9 两笔。
   * @param {string} text
   * @return {Array<{value:number,start:number,end:number,raw:string}>}
   */
  function findAmounts(text) {
    var out = [];
    var m;
    var v;

    /* ① 预扫描：口语小数（数字 + 块/元 + 个位数字） */
    RE_ARABIC_DECIMAL.lastIndex = 0;
    while ((m = RE_ARABIC_DECIMAL.exec(text)) !== null) {
      var whole = Number(m[1]);
      var dec = Number(m[2]);
      if (!isFinite(whole) || !isFinite(dec)) { continue; }
      // 尾部数字后面若是"数量词"，说明它是数量不是角分（十块三个包子 -> 10，不是 10.3）；
      // 若是 毛/角 则照常合成小数（399块9毛 -> 399.9）
      var decEnd = m.index + m[0].length;
      if (isQuantitySuffix(text, decEnd)) { continue; }
      out.push({
        value: round2(whole + dec / 10),
        start: m.index,
        end: decEnd,
        raw: m[0]
      });
    }

    /* ①b 预扫描：中文数字口语小数（五块五） */
    RE_CHINESE_DECIMAL.lastIndex = 0;
    while ((m = RE_CHINESE_DECIMAL.exec(text)) !== null) {
      var cs = m.index;
      var ce = m.index + m[0].length;
      if (overlaps(out, cs, ce)) { continue; }
      if (isQuantitySuffix(text, ce)) { continue; }
      var wholeCn = chineseToNumber(m[1]);
      var decCn = chineseToNumber(m[2]);
      if (wholeCn > 0 && decCn > 0) {
        out.push({
          value: round2(wholeCn + decCn / 10),
          start: cs,
          end: ce,
          raw: m[0]
        });
      }
    }

    /* ② 阿拉伯数字（跳过已被预扫描消费的区间 / 后跟非金额单位） */
    RE_ARABIC.lastIndex = 0;
    while ((m = RE_ARABIC.exec(text)) !== null) {
      var aStart = m.index;
      var aEnd = m.index + m[0].length;
      if (overlaps(out, aStart, aEnd)) { continue; }
      // 9点 / 3号线 / 30分钟 / 两包 都不是钱
      if (isNonMoneySuffix(text, aEnd)) { continue; }
      v = parseFloat(m[0]);
      if (!isNaN(v) && v > 0) {
        out.push({ value: v, start: aStart, end: aEnd, raw: m[0] });
      }
    }

    RE_CHINESE.lastIndex = 0;
    while ((m = RE_CHINESE.exec(text)) !== null) {
      var s = m.index;
      var e = m.index + m[0].length;
      if (overlaps(out, s, e)) { continue; }
      var after = text.slice(e, e + 3);
      var before = text.slice(Math.max(0, s - 6), s);
      var hasUnit = RE_CN_UNIT_AFTER.test(after);
      if (hasUnit) {
        // 五块 / 二十元：直接采信
      } else if (isNonMoneySuffix(text, e)) {
        // 一双鞋 / 三百米 / 十点 / 三折：数字后跟非金额单位，视为非金额
        continue;
      } else {
        var atEnd = (e >= text.length) || /^[，。；、,!！?？~～\s]/.test(after);
        var hasTrigger = RE_CN_TRIGGER_BEFORE.test(before);
        // 句末的两位以上中文数字（"打车二十"）也视为金额
        var isTrailingAmount = atEnd && m[0].length >= 2;
        if (!hasTrigger && !isTrailingAmount) { continue; }
      }
      var cnVal = chineseToNumber(m[0]);
      if (cnVal > 0 && cnVal < 1000000) {
        out.push({ value: cnVal, start: s, end: e, raw: m[0] });
      }
    }

    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 分句                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 按标点与连接词切分句子。
   * @param {string} text
   * @return {string[]}
   */
  function splitSentences(text) {
    var t = String(text);
    var i;
    for (i = 0; i < CONNECTORS.length; i++) {
      t = t.split(CONNECTORS[i]).join('|');
    }
    var raw = t.split(/[，。；、,;!！?？~～\n\r|]+/);
    var out = [];
    for (i = 0; i < raw.length; i++) {
      var s = raw[i].trim();
      if (s) { out.push(s); }
    }
    return out;
  }

  /**
   * 把无金额的分句合并到相邻分句，返回"必定含金额"的语义组。
   * @param {string} text
   * @return {string[]}
   */
  function buildGroups(text) {
    var sentences = splitSentences(text);
    var groups = [];
    var pending = '';
    var i;
    for (i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      if (findAmounts(s).length > 0) {
        groups.push(pending + s);
        pending = '';
      } else {
        pending += s;
      }
    }
    if (pending) {
      if (groups.length > 0) {
        groups[groups.length - 1] += pending;
      } else {
        groups.push(pending);
      }
    }
    return groups;
  }

  /**
   * 组内按金额数量切段：一句话多笔时按顺序配对。
   * 例："打车 15 和奶茶 12" -> ["打车 15", "和奶茶 12"]
   * @param {string} groupText
   * @return {Array<{text:string, amount:number}>}
   */
  function splitByAmounts(groupText) {
    var amts = findAmounts(groupText);
    if (amts.length === 0) { return []; }
    var parts = [];
    var cursor = 0;
    var i;
    for (i = 0; i < amts.length; i++) {
      parts.push({ text: groupText.slice(cursor, amts[i].end), amount: amts[i].value, raw: amts[i].raw });
      cursor = amts[i].end;
    }
    if (cursor < groupText.length) {
      parts[parts.length - 1].text += groupText.slice(cursor);
    }
    return parts;
  }

  /* ------------------------------------------------------------------ */
  /* 时间 / 餐段                                                         */
  /* ------------------------------------------------------------------ */

  /** 按当前钟点推断餐段 */
  function inferMealByHour(hour) {
    if (hour < 10) { return '早餐'; }
    if (hour >= 11 && hour <= 14) { return '午餐'; }
    if (hour >= 17 && hour <= 21) { return '晚餐'; }
    return '';
  }

  /**
   * 解析时间词与餐段词。
   * @param {string} text
   * @param {Date} now 基准时间
   * @return {{date:string, meal:string, hasDate:boolean}}
   */
  function parseTime(text, now) {
    var offset = null;
    var meal = '';
    var hasDate = false;
    var i;
    for (i = 0; i < DATE_WORDS.length; i++) {
      if (text.indexOf(DATE_WORDS[i].word) !== -1) {
        offset = DATE_WORDS[i].offset;
        hasDate = true;
        break;
      }
    }
    for (i = 0; i < MEAL_WORDS.length; i++) {
      if (text.indexOf(MEAL_WORDS[i].word) !== -1) {
        meal = MEAL_WORDS[i].meal;
        break;
      }
    }
    var d = new Date(now.getTime());
    d.setDate(d.getDate() + (offset === null ? 0 : offset));
    return { date: toDateStr(d), meal: meal, hasDate: hasDate };
  }

  /* ------------------------------------------------------------------ */
  /* 收入 / 分类 / 动机                                                  */
  /* ------------------------------------------------------------------ */

  var RE_EXPENSE_VERB = /(花了|付了|买了|支付|消费|充了|充值|交了)/;
  var RE_REDPACKET_IN = /(收到|收了|领到|领了|抢到|抢了|来了|给我发|退回)/;

  /**
   * 判断该句是否为收入。
   * @param {string} text
   * @return {boolean}
   */
  function detectIncome(text) {
    if (RE_EXPENSE_VERB.test(text)) { return false; }
    if (text.indexOf('红包') !== -1) {
      return RE_REDPACKET_IN.test(text);
    }
    var i;
    for (i = 0; i < INCOME_KEYWORDS.length; i++) {
      if (text.indexOf(INCOME_KEYWORDS[i]) !== -1) { return true; }
    }
    return false;
  }

  /**
   * 推断收入来源（生活费 / 兼职 / 奖学金 / 助学金 / 红包 / 退款 / 其他）。
   * @param {string} text
   * @return {string}
   */
  function detectIncomeSource(text) {
    var groups = DATA.INCOME_SOURCE_KEYWORDS || [];
    var i;
    var j;
    var t = String(text || '');
    for (i = 0; i < groups.length; i++) {
      for (j = 0; j < groups[i].keywords.length; j++) {
        if (t.indexOf(groups[i].keywords[j]) !== -1) {
          return groups[i].source;
        }
      }
    }
    return '其他';
  }

  /** 强社交信号：命中即显著抬高"社交"分类得分（"火锅AA"/"和舍友吃饭" 应判社交而非餐饮） */
  var SOCIAL_BOOST_WORDS = ['AA', '聚餐', '请客', '请吃', '舍友', '室友', '同学', '朋友'];

  /**
   * 分类打分：最长命中词长度 * 10 + 命中词个数，平手按 CATEGORIES 顺序取先者。
   * @param {string} text
   * @return {string} 分类 key
   */
  function classify(text) {
    var bestKey = '其他';
    var bestScore = 0;
    var i;
    var j;
    var socialBoost = 0;
    for (i = 0; i < SOCIAL_BOOST_WORDS.length; i++) {
      if (text.indexOf(SOCIAL_BOOST_WORDS[i]) !== -1) { socialBoost += 8; }
    }
    for (i = 0; i < CATEGORIES.length; i++) {
      var key = CATEGORIES[i].key;
      var kws = CATEGORY_KEYWORDS[key];
      if (!kws) { continue; }
      var maxLen = 0;
      var hits = 0;
      for (j = 0; j < kws.length; j++) {
        if (text.indexOf(kws[j]) !== -1) {
          hits++;
          if (kws[j].length > maxLen) { maxLen = kws[j].length; }
        }
      }
      if (hits === 0) { continue; }
      var score = maxLen * 10 + hits;
      if (key === '社交') { score += socialBoost; }
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    return bestKey;
  }

  /**
   * 消费动机判定。
   * @param {string} text
   * @return {{motivation:string, want:boolean}}
   */
  function detectMotivation(text) {
    var isEmotion = false;
    var want = false;
    var i;
    for (i = 0; i < EMOTION_KEYWORDS.length; i++) {
      if (text.indexOf(EMOTION_KEYWORDS[i]) !== -1) {
        isEmotion = true;
        break;
      }
    }
    for (i = 0; i < WANT_KEYWORDS.length; i++) {
      if (text.indexOf(WANT_KEYWORDS[i]) !== -1) {
        want = true;
        break;
      }
    }
    return { motivation: isEmotion ? '情绪' : '刚需', want: want };
  }

  /* ------------------------------------------------------------------ */
  /* 备注                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 生成备注：剔除金额、时间词、动词量词后剩余文本；为空用分类名 / 餐段兜底。
   * @param {string} segText 单笔对应的原始片段
   * @param {string} category 分类
   * @param {string} meal 餐段
   * @return {string}
   */
  function buildNote(segText, category, meal) {
    var t = String(segText);
    // 先整体抹掉"数字 + 非金额单位"的时间/数量表达（12点 / 3号线 / 30分钟 / 20岁），
    // 避免备注里残留孤零零的"点""号线"
    t = t.replace(/\d+(?:\.\d{1,2})?\s*(?:点钟|点|号线|号|分钟|小时|个月|岁|折|楼|层)/g, ' ');
    t = t.replace(/\d+(?:\.\d{1,2})?/g, ' ');
    t = t.replace(/[零〇一二两三四五六七八九十百千]+(?:元|块钱|块|毛|角)/g, ' ');
    t = t.replace(/[，。；、,!！?？~～|]+/g, ' ');
    var i;
    for (i = 0; i < LEADING_CONNECTORS.length; i++) {
      if (t.replace(/^\s+/, '').indexOf(LEADING_CONNECTORS[i]) === 0) {
        t = t.replace(/^\s+/, '').slice(LEADING_CONNECTORS[i].length);
        break;
      }
    }
    for (i = 0; i < STOP_SORTED.length; i++) {
      t = t.split(STOP_SORTED[i]).join(' ');
    }
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(/^[的与及]+/, '').trim();
    // 清掉残留的孤立中文数字（如 "一 鞋" -> "鞋"）
    t = t.replace(/(^|\s)[零〇一二两三四五六七八九十百千]+(?=\s|$)/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    if (!t) { t = meal || category; }
    return t;
  }

  /* ------------------------------------------------------------------ */
  /* 主函数                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 解析一句自然语言，得到若干笔账单草稿。
   * @param {string} text 用户输入
   * @param {{now?:Date}} [options] 基准时间（便于测试）
   * @return {{items:Array, unparsed:string[]}}
   */
  function parseBill(text, options) {
    var opts = options || {};
    var now = opts.now ? new Date(opts.now) : new Date();
    var result = { items: [], unparsed: [] };
    if (typeof text !== 'string' || !text.trim()) { return result; }
    text = normalizeWidth(text);

    var groups = buildGroups(text);
    var lastDate = null;
    var i;
    var j;

    for (i = 0; i < groups.length; i++) {
      var parts = splitByAmounts(groups[i]);
      for (j = 0; j < parts.length; j++) {
        var part = parts[j];
        var noteSource = part.text;
        // 先把已识别的金额原文从备注里剔除（中文数字金额没有单位时尤其需要）
        if (part.raw) {
          var pos = noteSource.lastIndexOf(part.raw);
          if (pos >= 0) {
            noteSource = noteSource.slice(0, pos) + ' ' + noteSource.slice(pos + part.raw.length);
          }
        }
        // 一句多笔时，"和/跟/与" 属于连接词，不属于备注内容
        if (parts.length > 1 && j > 0) {
          noteSource = noteSource.replace(/^\s*(和|跟|与|还有|然后|另外|加上|以及|顺便|再)\s*/, '');
        }
        var time = parseTime(part.text, now);
        if (time.hasDate) { lastDate = time.date; }
        var date = lastDate || toDateStr(now);
        var meal = time.meal || inferMealByHour(now.getHours());
        var income = detectIncome(part.text);
        var category = income ? (DATA.INCOME_CATEGORY || '收入') : classify(part.text);
        // 分段后上下文可能丢失（"9块9的奶茶和18块的黄焖鸡" 的 "奶茶" 被切到下一段），
        // 单段打不出分类时回退到整句再打一次分，仍无命中才归"其他"。
        if (!income && category === '其他') {
          var ctxCategory = classify(text);
          if (ctxCategory !== '其他') { category = ctxCategory; }
        }
        var motive = detectMotivation(part.text);
        var note = buildNote(noteSource, category, meal);

        result.items.push({
          date: date,
          amount: round2(part.amount),
          category: category,
          source: income ? detectIncomeSource(part.text) : '',
          note: note,
          motivation: income ? '刚需' : motive.motivation,
          want: income ? false : motive.want,
          type: income ? 'income' : 'expense',
          meal: meal,
          raw: part.text.trim()
        });
      }
    }

    if (result.items.length === 0) {
      result.unparsed.push(String(text).trim());
    }
    return result;
  }

  var API = {
    parseBill: parseBill,
    findAmounts: findAmounts,
    splitSentences: splitSentences,
    buildGroups: buildGroups,
    splitByAmounts: splitByAmounts,
    parseTime: parseTime,
    classify: classify,
    detectIncome: detectIncome,
    detectIncomeSource: detectIncomeSource,
    detectMotivation: detectMotivation,
    buildNote: buildNote,
    chineseToNumber: chineseToNumber,
    normalizeWidth: normalizeWidth,
    inferMealByHour: inferMealByHour,
    toDateStr: toDateStr,
    round2: round2
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.nlp = API;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
