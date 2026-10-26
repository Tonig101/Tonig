/**
 * intent.js — 会话意图分类层 + 模糊兜底文案引擎（纯函数，可 Node 直接测试）
 *
 * 设计依据：「意图路由与模糊兜底设计方案.md」
 *   §2.1 意图枚举 / §2.2 18 个信号判据 / §2.3 权重矩阵 / §2.4 仲裁规则（V1-V4 + R1/R3a/R3b）
 *   §2.5 classifyIntent 伪代码 / §3.2 L0-L5 阶梯文案 / §3.3 pending 状态机 / §3.4 反死循环硬规则
 *
 * 对外主函数：
 *   classifyIntent(text, ctx)        -> Result
 *   detectSignals(text, ctx)         -> {SIG_XXX:boolean}
 *   extractSlots(text, signals, ctx) -> Slots
 *   scoreIntents(signals)            -> {record, query, howto, advice, dataop, chitchat}
 *   applyVeto(scores, signals)       -> scores（V1-V4 之后）
 *   arbitrate(scores, signals, slots)-> {intent, score, second, confidence, margin, tier}
 *   rankIntents(scores)              -> [{intent, score}] 降序
 *   resolveQueryKind(signals, slots) -> 'balance'|'pie'|'category'|'detail'|null
 *   missingSlots(intent, slots)      -> string[]
 *   resolveLevel(pending, intent, missing) -> {level, formType, promptKey, allowed}
 *   mustEscalate(promptKey, recentKeys)    -> boolean（同 isAntiLoopViolation）
 *   buildPrompt(state, viewCtx)      -> {html, promptKey, formType, level}（只产出 HTML 片段，不碰 DOM）
 *   amountHints(slots, viewCtx)      -> [{label, value, source}]
 *   mergeVerdict(local, verdict)     -> Result（云端只在本地 top2 内改判）
 *
 * 约束（硬性）：
 *   1) 只用 ES5 语法（var / function / 字符串拼接）；禁止 ES6 声明关键字、箭头函数、
 *      模板字符串、class、解构，以及 includes / padStart 这类新方法；
 *   2) 零第三方依赖，只 require('./data.js') 与 require('./nlp.js')；
 *   3) 双导出：Node 用 module.exports，浏览器挂到 global.AJ.intent（写法照抄 nlp.js）。
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);
  var DATA, NLP;
  if (isNode) {
    DATA = require('./data.js');
    NLP = require('./nlp.js');
  } else {
    global.AJ = global.AJ || {};
    DATA = global.AJ.data;
    NLP = global.AJ.nlp;
  }

  /* ================================================================== */
  /* 一、常量（全部导出，便于单测逐格断言）                              */
  /* ================================================================== */

  /** 7 个顶层意图（command 由 app.js 的 commandMatch 在分类之前短路，不在此枚举内） */
  var INTENTS = ['record', 'query', 'howto', 'advice', 'dataop', 'chitchat', 'unknown'];

  /** 平手时的稳定排序依据（record 优先，保证「什么都不像」时偏向记账缺槽位） */
  var INTENT_ORDER = INTENTS;

  /** 每个意图的必需槽位（缺则走 L2 / L3 澄清） */
  var REQUIRED_SLOTS = {
    record: ['amount'],
    query: ['queryKind'],
    dataop: ['target'],
    howto: [],
    advice: [],
    chitchat: [],
    unknown: []
  };

  /* ---- 仲裁阈值（§2.4 常量，照抄，不做二次拍脑袋） ---- */
  var SCORE_LOW = 30;             // 低于此分且无兜底证据 -> unknown
  var SCORE_HIGH = 55;            // 高置信线（保留常量，供调参）
  var MARGIN_MIN = 15;            // 冠军与亚军的最小分差
  var CONF_HIGH = 0.75;
  var CONF_LOW = 0.45;
  var RECORD_DOMINANCE = 0.70;    // record 单极豁免
  var FORCE_RECORD_MIN = 70;      // 「带金额 + 无疑问」强制 record 的下限

  /** pending 单轮待补全上下文的存活时间（毫秒）：刷新即清空，刻意不写 localStorage */
  var PENDING_TTL_MS = 120000;
  var MAX_TRIES = 3;
  var LEVELS = [0, 1, 2, 3, 4, 5];

  /** 阶梯层 -> 交互形式 */
  var FORM_OF_LEVEL = {
    0: 'confirm', 1: 'infer', 2: 'chip_group', 3: 'form', 4: 'choice', 5: 'giveup'
  };

  /** 反死循环硬规则（§3.4） */
  var ANTI_LOOP = {
    SAME_PROMPT_FORBIDDEN: true,   // 同一 promptKey 不得连续出现两次
    MAX_TRIES: 3,                  // tries>=3 禁止再追问
    FORCE_FORM_CHANGE_AT: 2        // tries>=2 必须换 formType（按钮 -> 表单/选择）
  };

  /**
   * 权重矩阵：信号 × 意图（正整数加分 / 负整数扣分）。
   * §2.3 数字逐个照抄，可被单测逐格断言；只允许调参，不允许改结构。
   */
  var WEIGHTS = {
    SIG_AMOUNT:       { record: 62, query: 0, howto: 0, advice: 6, dataop: -10, chitchat: -15 },
    SIG_AMOUNT_FUZZY: { record: 26, query: 4, howto: 2, advice: 4, dataop: -8, chitchat: 0 },
    SIG_SPEND_VERB:   { record: 30, query: 0, howto: 0, advice: 0, dataop: 6, chitchat: -6 },
    SIG_PLAN_VERB:    { record: 16, query: 2, howto: 2, advice: 12, dataop: 0, chitchat: 4 },
    SIG_TIME_PAST:    { record: 10, query: 8, howto: 6, advice: 0, dataop: 6, chitchat: 0 },
    SIG_CATEGORY:     { record: 18, query: 10, howto: 0, advice: 2, dataop: 0, chitchat: 0 },
    SIG_HOWTO:        { record: -55, query: 10, howto: 58, advice: 8, dataop: 6, chitchat: 0 },
    SIG_YESNO:        { record: -28, query: 12, howto: 20, advice: 6, dataop: 0, chitchat: 0 },
    SIG_WH:           { record: -22, query: 26, howto: 16, advice: 6, dataop: 0, chitchat: 0 },
    SIG_QMARK:        { record: -12, query: 8, howto: 10, advice: 4, dataop: 0, chitchat: 0 },
    SIG_Q_BALANCE:    { record: -25, query: 64, howto: 0, advice: 0, dataop: 0, chitchat: 0 },
    SIG_Q_PIE:        { record: -25, query: 60, howto: 0, advice: 0, dataop: 0, chitchat: 0 },
    SIG_Q_STAT:       { record: -18, query: 44, howto: 0, advice: 0, dataop: 0, chitchat: 0 },
    SIG_ANAPHORA:     { record: -10, query: 14, howto: 4, advice: 0, dataop: 12, chitchat: 0 },
    SIG_DATAOP:       { record: -34, query: 6, howto: 8, advice: 0, dataop: 60, chitchat: 0 },
    SIG_EMOTION:      { record: -12, query: 0, howto: 0, advice: 4, dataop: 0, chitchat: 42 },
    SIG_ADVICE:       { record: -12, query: 0, howto: 4, advice: 46, dataop: 0, chitchat: 4 },
    SIG_EMPTY:        { record: -60, query: -60, howto: -60, advice: -60, dataop: -60, chitchat: 50 }
  };

  /* ================================================================== */
  /* 二、词表（内聚在本模块，不污染 data.js，保证可独立单测）            */
  /* ================================================================== */

  var LEX = {
    /** 怎么办式求助 */
    HOW_TO: ['怎么办', '咋办', '怎么弄', '怎么搞', '如何', '怎么补', '怎么改', '怎么删',
      '教我', '能不能补', '忘记记', '漏记'],
    /** 求助的具体话题（补记 / 改 / 删 / 找不到入口） */
    HOWTO_TOPIC: [
      { topic: 'backfill', words: ['补', '忘记', '漏', '补记'] },
      { topic: 'edit', words: ['改', '修改'] },
      { topic: 'delete', words: ['删', '撤销', '撤回'] },
      { topic: 'where', words: ['在哪', '哪里', '怎么打开'] }
    ],
    /** 是否式疑问 */
    YES_NO: ['吗', '能不能', '可不可以', '是不是', '行不行', '有没有', '贵吗', '划算吗'],
    /** 疑问词（刻意不含「怎么」，归 HOW_TO，避免双重计数） */
    WH_WORDS: ['多少', '几', '哪', '啥', '什么', '为什么', '咋'],
    /** 余额查询 */
    Q_BALANCE: ['余额', '还剩', '还能花', '剩多少', '够花'],
    /** 结构查询 */
    Q_PIE: ['饼图', '占比', '结构', '大头', '花在哪些', '分布'],
    /** 统计查询（强证据） */
    Q_STAT: ['花了多少', '一共花', '总共花', '这周花', '本月花', '上个月花'],
    /** 统计查询（弱证据：必须配合查询对象才成立，「帮我看看」不能算查询） */
    Q_STAT_WEAK: ['统计', '汇总', '查一下', '看看'],
    /** 明细查询 */
    QUERY_DETAIL: ['那笔', '这笔', '哪笔', '明细', '记录', '刚才那笔'],
    /** 改 / 删 / 撤 */
    DATA_OP: ['改一下', '修改', '改掉', '改成', '改为', '删掉', '删除', '删了', '撤销', '撤回', '取消', '记错', '应该是', '输错', '录错', '写错', '打错', '不是这个', '不对'],
    /** 纠错（改金额）：刻意不含「不对」「不是」，避免与「对不对/是不是」疑问相撞 */
    CORRECTION: ['记错', '改成', '应该是', '写错', '输错', '录错', '打错', '改一下', '修改'],
    /** 指代（刻意不含「这个」：会与「这个月」撞车，误判成指代） */
    ANAPHORA: ['那笔', '这笔', '那个', '它', '刚才那', '上一条', '上一笔'],
    /** 情绪词（补集：DATA.EMOTION_KEYWORDS 是「情绪型消费」，这里是「人本身的心情」） */
    MOOD: ['累', '烦', 'emo', '难受', '难过', '焦虑', '穷', '吃土', '压力', '崩溃', '无语',
      '开心', '爽', '烦死', '心累', '烦躁'],
    /** 求建议 */
    ADVICE: ['想买', '该不该', '值不值', '要不要', '值得吗', '怎么省', '省钱', '剁手', '忍不住', '冲动'],
    /** 求建议：省钱向 */
    ADVICE_SAVE: ['怎么省', '省钱', '少花', '节流', '省点'],
    /** 求建议：赚钱向 */
    ADVICE_EARN: ['赚钱', '搞钱', '兼职', '攒钱', '开源'],
    /** 已发生消费动词（刻意不含裸「吃/喝/买」，否则与计划语气冲突） */
    SPEND_VERB: ['买了', '花了', '付了', '充了', '交了', '吃了', '喝了', '下单了', '打车', '转账', '请客'],
    /** 计划语气 */
    PLAN_VERB: ['想买', '要买', '要去', '打算', '准备', '计划', '约', '明天', '后天', '下周',
      '周末', '一会', '待会'],
    /** 模糊金额（区间词优先，修饰词次之） */
    FUZZY_AMOUNT: ['十几', '几十', '百来', '小一百', '差不多', '大概', '大约', '左右', '不到',
      '半百', '一杯', '一顿'],
    /** 时间范围（用于查询聚合口径） */
    PERIOD: [
      { period: 'today', words: ['今天', '今日', '今天花'] },
      { period: 'week', words: ['这周', '本周', '一周', '这星期'] },
      { period: 'week', words: ['上周', '上星期'] },
      { period: 'month', words: ['这个月', '本月', '这月'] },
      { period: 'lastMonth', words: ['上个月', '上月'] },
      { period: 'all', words: ['一共', '总共', '累计'] }
    ],
    /** 问候短路（同时是 R3b 的守卫：防止把「你好」问成「你好多少钱」） */
    GREETING: ['你好', '您好', '嗨', 'hi', 'hello', '在吗', '在不在', '在么', '谢谢', '谢啦',
      '好的', '好嘞', '收到', '晚安', '早上好', '早', '哈喽', '嘿嘿', '嗯嗯']
  };

  /** 模糊金额区间表（可解释来源：文本里的模糊量词） */
  var FUZZY_RANGES = [
    { label: '十几', min: 10, max: 19, guess: 15 },
    { label: '几十', min: 20, max: 99, guess: 40 },
    { label: '小一百', min: 80, max: 100, guess: 99 },
    { label: '百来', min: 80, max: 120, guess: 100 },
    { label: '半百', min: 40, max: 60, guess: 50 }
  ];

  /** 模糊金额修饰词（无区间，仅表示不精确） */
  var FUZZY_MODIFIERS = ['差不多', '大概', '大约', '左右', '不到', '一杯', '一顿'];

  /** 饮品词：用于金额建议的「同品类参考价」 */
  var DRINK_WORDS = ['奶茶', '咖啡', '饮料', '果茶', '豆浆', '柠檬水', '可乐', '雪糕', '冰淇淋'];

  /** 冷启动金额建议（无历史数据时的可解释参考价；有历史时优先用近 30 天均值） */
  var DEFAULT_HINTS = {
    '餐饮': [10, 15, 20],
    '社交': [60, 80, 120],
    '购物': [30, 60, 100],
    '学习': [10, 20, 50],
    '交通': [3, 10, 20],
    '娱乐': [20, 50, 100],
    '居住': [50, 100, 200],
    '医疗': [10, 30, 80],
    '其他': [6, 10, 15]
  };

  /** 餐段参考价（比品类更精确时优先） */
  var MEAL_HINTS = {
    '早餐': [4, 6, 10],
    '午餐': [10, 15, 20],
    '晚餐': [12, 18, 25],
    '夜宵': [10, 20, 30]
  };

  /** 饮品参考价（doc §3.5 的「奶茶」示例：8 / 12 / 18） */
  var DRINK_HINTS = [8, 12, 18];

  /* ================================================================== */
  /* 三、文本预处理                                                      */
  /* ================================================================== */

  var RE_EMOJI = /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u27BF\u2B00-\u2BFF\u3000-\u303F\uFE00-\uFE0F\uFE30-\uFE4F\uFF00-\uFFEF\uD800-\uDBFF\uDC00-\uDFFF]/g;
  var RE_PUNCT = /[\s，。；、,;:!?？!！~～…—\-_+*\/\\|@#$%^&()（）\[\]{}<>《》「」『』"'"'·、]/g;

  /**
   * 全角归一化 + 去首尾空白（1:1 字符替换，不改变语义）。
   * @param {*} text
   * @return {string}
   */
  function normalize(text) {
    var t = (typeof text === 'string') ? text : String(text === undefined || text === null ? '' : text);
    return NLP.normalizeWidth(t).trim();
  }

  /**
   * 去掉 emoji / 标点 / 空白，只留「有信息量」的字符。
   * @param {string} text
   * @return {string}
   */
  function stripNoise(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(RE_EMOJI, '')
      .replace(RE_PUNCT, '')
      .replace(/\s+/g, '');
  }

  /**
   * 是否「纯标点 / 纯表情 / 只有空白」。
   * @param {string} text
   * @return {boolean}
   */
  function isPurePunct(text) {
    var s = String(text === undefined || text === null ? '' : text);
    var visible = s.replace(/\s+/g, '');
    return visible.length > 0 && stripNoise(s).length === 0;
  }

  /** HTML 转义（intent.js 不依赖 app.js 的 esc） */
  function escHtml(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 词表命中判定（子串包含）。
   * @param {string} text
   * @param {Array<string>} words
   * @return {boolean}
   */
  function anyHit(text, words) {
    var i;
    for (i = 0; i < words.length; i++) {
      if (text.indexOf(words[i]) !== -1) { return true; }
    }
    return false;
  }

  /**
   * 取第一个命中的词（用于 slots.topic / adviceKind 这类单值槽位）。
   * @param {string} text
   * @param {Array<string>} words
   * @return {?string}
   */
  function firstHit(text, words) {
    var i;
    for (i = 0; i < words.length; i++) {
      if (text.indexOf(words[i]) !== -1) { return words[i]; }
    }
    return null;
  }

  /**
   * 问候短路。只认「整句就是一个问候」或「问候 + 1 个字」，
   * 避免「谢谢，午饭15」这类正常记账句被误判为闲聊。
   * @param {string} text
   * @return {boolean}
   */
  function isGreeting(text) {
    var s = stripNoise(text);
    if (!s) { return false; }
    if (s.length > 6) { return false; }
    var i;
    for (i = 0; i < LEX.GREETING.length; i++) {
      var g = LEX.GREETING[i];
      if (s === g) { return true; }
      if (s.indexOf(g) === 0 && (s.length - g.length) <= 1) { return true; }
    }
    return false;
  }

  /**
   * 规范类目名（去掉「其他」）。
   *
   * 背景：NLP.classify 只认「奶茶 / 打车 / 黄焖鸡」这类**口语词**
   * （data.js 的 CATEGORY_KEYWORDS），不认 data.js 里的**规范类目名本身**，
   * 于是「上个月餐饮花了多少」里的「餐饮」被判成「其他」，
   * SIG_CATEGORY 检测不到，queryKind 落到 detail —— 用户问「餐饮花了多少」
   * 拿到的是上月全部账单。这里补一条规范名通道，不动 nlp.js。
   */
  var CANON_KEYS = (function () {
    var src = (DATA && DATA.CATEGORY_KEYS) ? DATA.CATEGORY_KEYS : [];
    var out = [];
    var i;
    for (i = 0; i < src.length; i++) {
      if (src[i] && src[i] !== '其他') { out.push(src[i]); }
    }
    return out;
  })();

  /* ================================================================== */
  /* 四、信号检测（18 个 bool，§2.2）                                    */
  /* ================================================================== */

  /** 统计查询的强正则（「这个月…多少」这类带范围的问法） */
  var RE_Q_STAT_STRONG = /(这个月|这周|本周|上周|上个月|本月).{0,8}(多少|几|花|支出|消费)/;
  /**
   * 模糊量词（含「几」的那些）必须在判疑问词之前剔掉。
   * 否则「十几块的奶茶」里的「几」会被 SIG_WH 当成疑问词，把要记的账抢成查询（P0 丢单）。
   */
  var RE_FUZZY_QTY = /(十几|几十|几百|几千|几万|好几十|好几|[十百千万]\s*几|几\s*[十百千万]|几块|几块钱|几元|第几|几乎|几岁)/g;
  /** 纯时间指代词表（昨天/今天/上周…）。整句剥掉这些词后若什么都不剩，说明只说了一个时间点。 */
  var PURE_TIME_WORDS = ['大前天','大后天','前天','后天','昨天','今天','今日','明天','上星期','上周','下星期','下周','这星期','这周','本周','上个月','上月','下个月','下月','本月','这个月','这月','去年','今年','前年','后年','周末','周','星期','早上','上午','中午','下午','傍晚','晚上','夜里','凌晨','半夜','刚才','刚刚','最近','前一阵','这会儿','那时候','当天'];
  function isPureTimeReference(text) {
    var s = stripNoise(text);
    if (!s || s.length > 12) { return false; }
    var i;
    for (i = 0; i < PURE_TIME_WORDS.length; i++) { s = s.split(PURE_TIME_WORDS[i]).join(''); }
    s = s.replace(/[早中晚上下大个号日月年那会儿刚才最近当天]/g, '');
    return stripNoise(s).length === 0;
  }
  /** 是否式问句的句尾「么」 */
  var RE_YESNO_TAIL = /么$/;
  /** 问号 */
  var RE_QMARK = /[?？]/;

  /**
   * 检测 18 个意图信号。
   * @param {string} text 用户原句
   * @param {Object} [ctx] {now, lastBill, pending}
   * @return {Object<string, boolean>}
   */
  function detectSignals(text, ctx) {
    var t = normalize(text);
    var amounts = NLP.findAmounts(t);
    var hasAmount = amounts.length > 0;
    var category = NLP.classify(t);
    var time = NLP.parseTime(t, (ctx && ctx.now) ? new Date(ctx.now) : new Date());
    var hasMeal = !!time.meal;
    var hasCanon = !!firstHit(t, CANON_KEYS);
    var hasCategory = (category && category !== '其他') || hasMeal || hasCanon;
    var moodHit = anyHit(t, LEX.MOOD);

    var sig = {};
    /* R0：空 / 纯表情（长度 <= 1 或去掉噪声后为空） */
    sig.SIG_EMPTY = (t.length <= 1) || (t.length > 0 && stripNoise(t).length === 0);
    /* 精确金额：不做第二套实现，直接用 NLP.findAmounts */
    sig.SIG_AMOUNT = hasAmount;
    /* 模糊金额：无精确金额 + 区间词/修饰词 */
    sig.SIG_AMOUNT_FUZZY = !hasAmount && hasFuzzyWord(t);
    sig.SIG_SPEND_VERB = anyHit(t, LEX.SPEND_VERB);
    sig.SIG_PLAN_VERB = anyHit(t, LEX.PLAN_VERB);
    sig.SIG_TIME_PAST = time.hasDate;
    sig.SIG_CATEGORY = hasCategory;
    sig.SIG_HOWTO = anyHit(t, LEX.HOW_TO);
    sig.SIG_YESNO = anyHit(t, LEX.YES_NO) || RE_YESNO_TAIL.test(t);
    sig.SIG_WH = anyHit(t.replace(RE_FUZZY_QTY, ''), LEX.WH_WORDS);
    sig.SIG_QMARK = RE_QMARK.test(t);
    sig.SIG_Q_BALANCE = anyHit(t, LEX.Q_BALANCE);
    sig.SIG_Q_PIE = anyHit(t, LEX.Q_PIE);
    sig.SIG_Q_STAT = anyHit(t, LEX.Q_STAT) || anyHit(t, LEX.Q_STAT_WEAK) || RE_Q_STAT_STRONG.test(t);
    sig.SIG_ANAPHORA = anyHit(t, LEX.ANAPHORA);
    sig.SIG_DATAOP = anyHit(t, LEX.DATA_OP);
    sig.SIG_CORRECTION = anyHit(t, LEX.CORRECTION);
    /* 情绪：MOOD 直接成立；DATA.EMOTION_KEYWORDS 是「情绪型消费词」（奶茶/皮肤…），
       只在本句没有任何品类证据时才当作情绪信号，否则「奶茶」会被压成闲聊。
       这是对 §2.2 的一处必要收紧，见回传的「偏离说明」。 */
    sig.SIG_EMOTION = moodHit || (!hasCategory && anyHit(t, DATA.EMOTION_KEYWORDS || []));
    sig.SIG_ADVICE = anyHit(t, LEX.ADVICE);

    /* ---- 以下几个是内部辅助位（不在 18 个里，无权重，不参与打分） ---- */
    sig.SIG_GREET = isGreeting(t);
    sig.SIG_Q_STAT_STRONG = anyHit(t, LEX.Q_STAT) || RE_Q_STAT_STRONG.test(t);
    sig.SIG_MOOD = moodHit;
    return sig;
  }

  /**
   * 是否含模糊金额表达（区间词 / 修饰词）。
   * @param {string} text
   * @return {boolean}
   */
  function hasFuzzyWord(text) {
    var i;
    for (i = 0; i < FUZZY_RANGES.length; i++) {
      if (text.indexOf(FUZZY_RANGES[i].label) !== -1) { return true; }
    }
    for (i = 0; i < FUZZY_MODIFIERS.length; i++) {
      if (text.indexOf(FUZZY_MODIFIERS[i]) !== -1) { return true; }
    }
    return false;
  }

  /**
   * 解析模糊金额，得到可解释的区间与猜测值。
   * @param {string} text
   * @return {?{label:string, min:?number, max:?number, guess:?number}}
   */
  function fuzzyAmountOf(text) {
    var i;
    for (i = 0; i < FUZZY_RANGES.length; i++) {
      if (text.indexOf(FUZZY_RANGES[i].label) !== -1) {
        return {
          label: FUZZY_RANGES[i].label,
          min: FUZZY_RANGES[i].min,
          max: FUZZY_RANGES[i].max,
          guess: FUZZY_RANGES[i].guess
        };
      }
    }
    var mod = firstHit(text, FUZZY_MODIFIERS);
    if (mod) { return { label: mod, min: null, max: null, guess: null }; }
    return null;
  }

  /* ================================================================== */
  /* 五、槽位抽取                                                        */
  /* ================================================================== */

  /**
   * 抽取槽位（先抽全，再按意图求差）。
   * @param {string} text
   * @param {Object} signals detectSignals 的结果
   * @param {Object} [ctx]
   * @return {Object} {amount, amountFuzzy, date, category, meal, plan, target, mood, topic, period, adviceKind, drink, detailHint}
   */
  function extractSlots(text, signals, ctx) {
    var t = normalize(text);
    var sig = signals || detectSignals(t, ctx);
    var now = (ctx && ctx.now) ? new Date(ctx.now) : new Date();
    var slots = {};
    var amounts = NLP.findAmounts(t);
    var time = NLP.parseTime(t, now);
    var category = NLP.classify(t);
    var i;

    if (amounts.length === 0) {
      slots.amount = null;
    } else {
      /* 缺省取第一个金额 */
      slots.amount = NLP.round2(amounts[0].value);
      /* 纠错句（金额>1 个）分辨「被否定的旧值」与「要改成的新值」：
         含「不是」-> 取第一个（「是18不是15」->18）；否则含「应该是/改成/改到」-> 取最后一个（「奶茶18…应该是15」->15） */
      var corr = sig.SIG_CORRECTION === true;
      if (corr && amounts.length > 1) {
        var hasNeg = /不是|而不是/.test(t);
        var hasMark = /应该是|改成|改到/.test(t);
        if (hasNeg) {
          slots.amount = NLP.round2(amounts[0].value);
        } else if (hasMark) {
          slots.amount = NLP.round2(amounts[amounts.length - 1].value);
        }
      }
    }
    slots.amountFuzzy = sig.SIG_AMOUNT_FUZZY ? fuzzyAmountOf(t) : null;
    slots.date = time.hasDate ? time.date : null;
    slots.meal = time.meal || null;
    /* 规范类目名（餐饮/交通/购物…）优先，其次退回 NLP.classify 的口语词判定。
       顺序不能反：「这个月餐饮花了多少」里 classify 返回「其他」，
       只有规范名通道能给出 slots.category，answerCategoryQuery 才不会答非所问。 */
    var canonKey = firstHit(t, CANON_KEYS);
    if (canonKey) {
      slots.category = canonKey;
    } else {
      slots.category = (category && category !== '其他') ? category : null;
    }
    slots.plan = sig.SIG_PLAN_VERB === true;
    slots.target = sig.SIG_ANAPHORA ? 'last' : null;
    /* 纠错（改上一笔金额）：带预算/收入字样不算纠错，避免误改账 */
    slots.correction = sig.SIG_CORRECTION === true && !/预算|收入|工资|生活费/.test(t);
    if (slots.correction) { slots.target = 'last'; }

    /* 情绪 */
    if (sig.SIG_EMPTY) {
      slots.mood = 'empty';
    } else if (sig.SIG_GREET) {
      slots.mood = 'greeting';
    } else {
      slots.mood = firstHit(t, LEX.MOOD);
    }

    /* 求助话题 */
    if (sig.SIG_HOWTO) {
      slots.topic = null;
      for (i = 0; i < LEX.HOWTO_TOPIC.length; i++) {
        if (anyHit(t, LEX.HOWTO_TOPIC[i].words)) {
          slots.topic = LEX.HOWTO_TOPIC[i].topic;
          break;
        }
      }
      if (!slots.topic) { slots.topic = 'where'; }
    } else {
      slots.topic = null;
    }

    /* 查询范围 */
    slots.period = null;
    for (i = 0; i < LEX.PERIOD.length; i++) {
      if (anyHit(t, LEX.PERIOD[i].words)) {
        slots.period = LEX.PERIOD[i].period;
        break;
      }
    }

    /* 建议倾向 */
    slots.adviceKind = null;
    if (sig.SIG_ADVICE) {
      if (anyHit(t, LEX.ADVICE_EARN)) { slots.adviceKind = 'earn'; }
      else if (anyHit(t, LEX.ADVICE_SAVE)) { slots.adviceKind = 'save'; }
      else { slots.adviceKind = 'wantbuy'; }
    }

    slots.drink = anyHit(t, DRINK_WORDS);
    slots.detailHint = anyHit(t, LEX.QUERY_DETAIL);
    slots.queryKind = null;   // 由 resolveQueryKind 统一算
    return slots;
  }

  /* ================================================================== */
  /* 六、打分 / 否决 / 仲裁                                              */
  /* ================================================================== */

  /**
   * 按权重矩阵累加 6 个意图分。
   * @param {Object} signals
   * @return {Object} scores
   */
  function scoreIntents(signals) {
    var scores = { record: 0, query: 0, howto: 0, advice: 0, dataop: 0, chitchat: 0 };
    var sig = signals || {};
    var k, it, row;
    for (k in sig) {
      if (!Object.prototype.hasOwnProperty.call(sig, k)) { continue; }
      if (sig[k] !== true) { continue; }
      row = WEIGHTS[k];
      if (!row) { continue; }          // SIG_GREET 等内部辅助信号无权重
      for (it in row) {
        if (!Object.prototype.hasOwnProperty.call(row, it)) { continue; }
        scores[it] += row[it];
      }
    }
    return scores;
  }

  /**
   * 4 条否决规则（V1-V4），先于 argmax 生效。
   * V1 疑问式求助 / V2 查询词 / V3 改删撤 -> record 压到 ≤ -1
   * V4 带金额且无疑问结构 -> record 抬到 ≥ 70（保留现有「带金额一律记账」规则，禁止改动）
   * @param {Object} scores
   * @param {Object} signals
   * @return {Object} 新 scores
   */
  function applyVeto(scores, signals) {
    var s = {};
    var k;
    for (k in scores) {
      if (Object.prototype.hasOwnProperty.call(scores, k)) { s[k] = scores[k]; }
    }
    var sig = signals || {};
    var hasAmount = sig.SIG_AMOUNT === true;
    /* V1：疑问式求助永远不当成记账 */
    if (sig.SIG_HOWTO && !hasAmount) { s.record = Math.min(s.record, -1); }
    /* V2：查询句不当记账 */
    if ((sig.SIG_Q_BALANCE || sig.SIG_Q_PIE || sig.SIG_Q_STAT) && !hasAmount) {
      s.record = Math.min(s.record, -1);
    }
    /* V3：改删撤不当记账 */
    if (sig.SIG_DATAOP && !hasAmount && !sig.SIG_HOWTO) { s.record = Math.min(s.record, -1); }
    /* V4：带金额 + 无疑问结构 -> 强制记账（唯一一条抬分规则，为不破坏现有业务而存在） */
    if (isForceRecord(sig)) { s.record = Math.max(s.record, FORCE_RECORD_MIN); }
    /* V5：纠错句永不记账（改金额由 dataop 通道处理；isForceRecord 已排除 SIG_CORRECTION，V4 不会抬起） */
    if (sig.SIG_CORRECTION) { s.record = Math.min(s.record, -1); }
    return s;
  }

  /**
   * V4 规则的唯一实现判据：句子里有精确金额，且没有疑问结构。
   * 「肯德基疯狂星期四 25」「我想买个耳机 500」都必须记账。
   * @param {Object} signals
   * @return {boolean}
   */
  function isForceRecord(signals) {
    var sig = signals || {};
    if (sig.SIG_CORRECTION) { return false; }
    if (sig.SIG_AMOUNT !== true) { return false; }
    return !(sig.SIG_HOWTO || sig.SIG_YESNO || sig.SIG_WH || sig.SIG_QMARK || sig.SIG_Q_BALANCE);
  }

  /**
   * 排序：按分数降序，平手按 INTENT_ORDER 稳定排序。
   * @param {Object} scores
   * @return {Array<{intent:string, score:number}>}
   */
  function rankIntents(scores) {
    var arr = [];
    var i;
    for (i = 0; i < INTENT_ORDER.length; i++) {
      var k = INTENT_ORDER[i];
      if (k === 'unknown') { continue; }
      arr.push({
        intent: k,
        score: (scores && typeof scores[k] === 'number') ? scores[k] : 0
      });
    }
    arr.sort(function (a, b) {
      if (b.score !== a.score) { return b.score - a.score; }
      return INTENT_ORDER.indexOf(a.intent) - INTENT_ORDER.indexOf(b.intent);
    });
    return arr;
  }

  /**
   * confidence 归一化（分差 + 40 基线，可解释、无魔法）。
   * @param {number} top
   * @param {number} second
   * @return {number} 0 ~ 0.99
   */
  function toConfidence(top, second) {
    var v = ((top - Math.max(0, second)) + 40) / 100;
    return Math.max(0, Math.min(0.99, v));
  }

  /**
   * argmax + confidence/margin/tier 判定 + R1（record 单极豁免）。
   * @param {Object} scores 已过 V1-V4
   * @param {Object} signals
   * @param {Object} slots
   * @return {{intent:string, score:number, second:Object, confidence:number, margin:number, tier:string, rank:Array}}
   */
  function arbitrate(scores, signals, slots) {
    var rank = rankIntents(scores);
    var top = rank[0];
    var second = rank[1] || { intent: 'unknown', score: 0 };
    var conf = toConfidence(top.score, second.score);
    var margin = top.score - second.score;
    var tier;
    if (conf >= CONF_HIGH && margin >= MARGIN_MIN) { tier = 'high'; }
    else if (top.score >= SCORE_LOW || conf >= CONF_LOW) { tier = 'low'; }
    else { tier = 'verylow'; }

    /* R1：record 单极豁免——不必等云端 3 秒，本地立刻按「缺金额」承接 */
    if (top.intent === 'record' && second.score < top.score * RECORD_DOMINANCE) { tier = 'high'; }

    /* R1b：chitchat 单极豁免（同 R1 理由）。情绪承接必须秒回，不能为了 0.01 的
       confidence 差去等云端 3 秒裁决。只对 chitchat 生效，不影响 query 的「低置信」
       （「昨天那笔是什么」仍需保持 low，见 §4.5 第 14 行）。 */
    if (top.intent === 'chitchat' && second.score < top.score * RECORD_DOMINANCE) { tier = 'high'; }

    return {
      intent: top.intent,
      score: top.score,
      second: second,
      confidence: conf,
      margin: margin,
      tier: tier,
      rank: rank
    };
  }

  /**
   * 解析 query 的子槽位 queryKind。
   * @param {Object} signals
   * @param {Object} slots
   * @return {?string} 'balance'|'pie'|'category'|'detail'|null
   */
  function resolveQueryKind(signals, slots) {
    var sig = signals || {};
    var s = slots || {};
    if (sig.SIG_Q_BALANCE) { return 'balance'; }
    if (sig.SIG_Q_PIE) { return 'pie'; }
    if (sig.SIG_Q_STAT) {
      /* 有品类词就按品类统计（「这个月奶茶花了多少」）；
         只有指代 / 明细词时才退化成明细列表（「昨天那个」）。 */
      if (sig.SIG_CATEGORY) { return 'category'; }
      if (sig.SIG_ANAPHORA || s.detailHint || s.period) { return 'detail'; }
      return 'detail';
    }
    if (sig.SIG_ANAPHORA || s.detailHint) { return 'detail'; }
    if (sig.SIG_WH && sig.SIG_CATEGORY) { return 'category'; }
    if (sig.SIG_WH && s.period) { return 'category'; }
    return null;
  }

  /**
   * 必需槽位求差。
   * @param {string} intent
   * @param {Object} slots
   * @return {string[]}
   */
  function missingSlots(intent, slots) {
    var req = REQUIRED_SLOTS[intent] || [];
    var s = slots || {};
    var out = [];
    var i;
    for (i = 0; i < req.length; i++) {
      var v = s[req[i]];
      if (v === undefined || v === null || v === '') { out.push(req[i]); }
    }
    return out;
  }

  /**
   * 弱查询证据判定：只有一个空泛的「看看 / 查一下」，没有任何查询对象。
   * @param {Object} signals
   * @param {Object} slots
   * @return {boolean}
   */
  function isWeakQueryOnly(signals, slots) {
    var sig = signals || {};
    var s = slots || {};
    if (!sig.SIG_Q_STAT) { return false; }
    if (sig.SIG_Q_STAT_STRONG) { return false; }
    if (sig.SIG_Q_BALANCE || sig.SIG_Q_PIE || sig.SIG_CATEGORY || sig.SIG_WH ||
      sig.SIG_ANAPHORA || sig.SIG_AMOUNT) { return false; }
    if (s.period || s.detailHint) { return false; }
    return true;
  }

  /* ================================================================== */
  /* 七、反死循环：阶梯解析                                              */
  /* ================================================================== */

  /**
   * 计算本次该用哪一层，并给出 promptKey（同一 promptKey 绝不连续出现）。
   * @param {?Object} pending {tries, level, formType, promptKey}
   * @param {string} intent
   * @param {string[]} missing
   * @return {{level:number, formType:string, promptKey:string, allowed:boolean}}
   */
  function resolveLevel(pending, intent, missing) {
    var p = pending || { tries: 0, level: 2, promptKey: null, formType: null };
    var miss = (missing && missing.length) ? missing.slice().sort().join(',') : '';
    var tries = Number(p.tries) || 0;
    var level;

    if (tries >= ANTI_LOOP.MAX_TRIES) { level = 5; }          // 硬规则：tries>=3 -> L5
    else if (tries >= 2) { level = 4; }                        // 硬规则：tries>=2 -> L4
    else if (tries >= 1) { level = 3; }                        // 硬规则：tries>=1 -> L3
    else { level = 2; if (missing && missing.length >= 2) { level = 3; } }  // 缺 >=2 槽位直接 L3

    var formType = FORM_OF_LEVEL[level];
    var promptKey = keyOf(intent, miss, level, tries);

    /* 硬规则：同一 promptKey 不得连续出现 -> 逐级上抬直到不同或到 5 */
    var guard = 0;
    while (ANTI_LOOP.SAME_PROMPT_FORBIDDEN && promptKey === p.promptKey && level < 5 && guard < 4) {
      level++;
      formType = FORM_OF_LEVEL[level];
      promptKey = keyOf(intent, miss, level, tries);
      guard++;
    }
    /* 硬规则：tries>=2 时 formType 必须与上次不同（按钮 -> 表单/选择） */
    if (tries >= ANTI_LOOP.FORCE_FORM_CHANGE_AT && formType === p.formType) {
      level = Math.min(5, level + 1);
      formType = FORM_OF_LEVEL[level];
      promptKey = keyOf(intent, miss, level, tries);
    }
    /* L5 是终点：文案固定，但 promptKey 追加尝试序号，
       保证「连续 5 次无法解析」产生的 key 两两不等（§3.4 验收断言）。 */
    return { level: level, formType: formType, promptKey: promptKey, allowed: true };
  }

  /**
   * 生成 promptKey。L5 追加尝试序号，避免「永远同一个放弃卡」被当成重复。
   * @param {string} intent
   * @param {string} miss 已排序逗号串
   * @param {number} level
   * @param {number} tries
   * @return {string}
   */
  function keyOf(intent, miss, level, tries) {
    var key = intent + '|' + miss + '|' + level;
    if (level >= 5) { key += '#' + Math.min(tries, 9); }
    return key;
  }

  /**
   * 发送前最后一道闸：最近已发 promptKey 命中即视为重复，需升级。
   * @param {string} promptKey
   * @param {string[]} recentKeys
   * @return {boolean}
   */
  function mustEscalate(promptKey, recentKeys) {
    var list = recentKeys || [];
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i] === promptKey) { return true; }
    }
    return false;
  }

  /* ================================================================== */
  /* 八、金额建议（L2 的按钮值必须来自可解释来源，不允许编造）            */
  /* ================================================================== */

  /**
   * 分位数（线性插值），用于把「该品类近 30 天金额」变成 P25/P50/P75 三个按钮值。
   * @param {Array<number>} sorted 升序数组
   * @param {number} p 0~1
   * @return {number}
   */
  function pctValue(sorted, p) {
    var n = sorted.length;
    if (n === 0) { return 0; }
    if (n === 1) { return Number(sorted[0]); }
    var idx = (n - 1) * p;
    var lo = Math.floor(idx);
    var hi = Math.ceil(idx);
    if (lo === hi) { return Number(sorted[lo]); }
    return Number(sorted[lo]) + (Number(sorted[hi]) - Number(sorted[lo])) * (idx - lo);
  }

  /**
   * 生成 3 个金额候选。
   * 来源优先级（全部可解释，不编造）：
   *   ① 文本模糊量词区间 ② 饮品参考价带 ③ 该品类近 30 天 P25/P50/P75
   *   ④ 该餐段历史均值 ⑤ 冷启动参考价
   * @param {Object} slots
   * @param {Object} [viewCtx] {categoryAvg, categoryCount, categoryAmounts, mealAvg, mealCount, mealAmounts}
   * @return {Array<{label:string, value:number, source:string}>}
   */
  function amountHints(slots, viewCtx) {
    var s = slots || {};
    var ctx = viewCtx || {};
    var out = [];
    var i;

    function push(value, source) {
      var v = Math.round(Number(value));
      if (!isFinite(v) || v <= 0) { return; }
      for (var j = 0; j < out.length; j++) {
        if (out[j].value === v) { return; }
      }
      if (out.length >= 3) { return; }
      out.push({ label: String(v), value: v, source: source });
    }

    /* ① 模糊量词：十几 -> 15 / 12 / 18 */
    if (s.amountFuzzy && isFinite(s.amountFuzzy.guess) && s.amountFuzzy.guess > 0) {
      var g = s.amountFuzzy.guess;
      push(g, 'fuzzy');
      push(g * 0.8, 'fuzzy');
      push(g * 1.2, 'fuzzy');
    } else if (s.drink) {
      /* ② 饮品价带：奶茶 / 咖啡的合理区间和大类均值差一个量级，
         用大类均值会给出「奶茶 72 元」这种荒谬按钮，因此饮品优先取价带。 */
      for (i = 0; i < DRINK_HINTS.length; i++) { push(DRINK_HINTS[i], 'drink-band'); }
    } else if (ctx.categoryAmounts && ctx.categoryAmounts.length >= 3) {
      /* ③ 该品类近 30 天的 P25 / P50 / P75 */
      var cs = ctx.categoryAmounts.slice().sort(function (a, b) { return a - b; });
      push(pctValue(cs, 0.25), 'category-30d');
      push(pctValue(cs, 0.5), 'category-30d');
      push(pctValue(cs, 0.75), 'category-30d');
    } else if (Number(ctx.categoryAvg) > 0 && Number(ctx.categoryCount) >= 3) {
      push(Number(ctx.categoryAvg), 'category-avg');
      push(Number(ctx.categoryAvg) * 0.8, 'category-avg');
      push(Number(ctx.categoryAvg) * 1.2, 'category-avg');
    } else if (Number(ctx.mealAvg) > 0 && Number(ctx.mealCount) >= 3) {
      /* ④ 该餐段历史均值 */
      push(Number(ctx.mealAvg), 'meal-avg');
      push(Number(ctx.mealAvg) * 0.8, 'meal-avg');
      push(Number(ctx.mealAvg) * 1.2, 'meal-avg');
    }

    if (out.length < 3) {
      /* ⑤ 冷启动参考价：餐段只在「餐饮 / 无分类」时更精确（社交聚餐用饭堂价会离谱）；
         其余按品类参考价，最后兜底「其他」。 */
      var base = null;
      if (s.meal && MEAL_HINTS[s.meal] && (!s.category || s.category === '餐饮')) {
        base = MEAL_HINTS[s.meal];
      } else {
        base = DEFAULT_HINTS[s.category || '其他'] || DEFAULT_HINTS['其他'];
      }
      for (i = 0; i < base.length && out.length < 3; i++) { push(base[i], 'default'); }
    }
    /* 保底：任何异常都给 3 个正数，避免出现空按钮组 */
    var fallback = DEFAULT_HINTS['其他'];
    for (i = 0; i < fallback.length && out.length < 3; i++) { push(fallback[i], 'default'); }
    return out;
  }

  /* ================================================================== */
  /* 九、文案引擎（只产出 HTML 片段，不碰 DOM）                          */
  /* ================================================================== */

  /**
   * 单个「待补全」按钮。
   * @param {string} pendId pendingCtx.id（防串味）
   * @param {string} val 值
   * @param {string} label 文案
   * @param {boolean} primary 是否主按钮
   * @return {string}
   */
  function pendBtn(pendId, val, label, primary) {
    return '<button type="button" class="btn-mini' + (primary ? ' primary' : '') +
      '" data-act="pend" data-pend="' + escHtml(pendId) + '" data-val="' + escHtml(val) + '">' +
      escHtml(label) + '</button>';
  }

  /** 通用快捷出口按钮（走既有 data-cmd -> handleSend） */
  function cmdBtn(cmd, label, primary) {
    return '<button type="button" class="btn-mini' + (primary ? ' primary' : '') +
      '" data-cmd="' + escHtml(cmd) + '">' + escHtml(label) + '</button>';
  }

  function actionsHtml(inner) {
    return '<div class="msg-actions">' + inner + '</div>';
  }

  /** L2：单槽位澄清（缺 amount 的默认层） */
  function level2Html(state, hints, pendId) {
    var slots = state.slots || {};
    var last = String(state.lastText || '').trim();
    var cat = slots.category || '';
    var head;
    var i;
    var btns = '';

    if (slots.plan) {
      head = '还没发生吧？先记个预计也行，等真花了再改。<br>大概准备花多少？';
    } else if (slots.amountFuzzy) {
      var g = hints.length ? hints[0].value : '';
      head = '「' + escHtml(slots.amountFuzzy.label || '差不多') + '」我猜你花了 <b>' +
        escHtml(g) + '</b> 左右，点一下我就记上（记错能撤回）。';
    } else if (last && cat && cat !== '其他' && last.length <= 6) {
      head = escHtml(last) + '多少钱？点一下就行：';
    } else if (last && cat && cat !== '其他') {
      head = '多少<b>' + escHtml(cat) + '</b>钱？点一下就行：';
    } else if (last) {
      head = '「' + escHtml(last) + '」多少钱？我按<b>' + escHtml(cat || '其他') + '</b>给你记。';
    } else {
      head = '记多少？点一下就行：';
    }

    for (i = 0; i < hints.length; i++) {
      btns += pendBtn(pendId, String(hints[i].value), String(hints[i].value), false);
    }
    btns += pendBtn(pendId, 'form', '自己填', false);
    if (slots.plan) { btns += pendBtn(pendId, 'skip', '等吃完再记', false); }

    return '<div class="bubble ai">' + head + '</div>' + actionsHtml(btns);
  }

  /** L3：换交互形式（表单 / 意图二选一） */
  function level3Html(state, pendId) {
    if (state.formType === 'choice' || state.intent === 'unknown') {
      return '<div class="bubble ai">这句话我拿不准是<b>记账</b>还是<b>问事</b>，你要哪个？</div>' +
        actionsHtml(pendBtn(pendId, 'form', '我要记一笔', true) +
          pendBtn(pendId, 'ask', '我在问事', false));
    }
    return '<div class="bubble ai">不猜了，直接把表单给你，填个金额就完事。</div>' +
      actionsHtml(pendBtn(pendId, 'form', '帮我填', true));
  }

  /** 行内小图标（与 app.js 的 ic 同义；各模块独立闭包不能跨文件取名） */
  function itIcon(name, cls, label) {
    return DATA.inlineIcon('i-' + name, cls, label);
  }

  /** L4：降级换通道（示例引导，不再问同一件事） */
  function level4Html() {
    return '<div class="bubble ai">' + itIcon('chat', 'bico-brand', '提示') + '换个说法我就能听懂，比如这几句：</div>' +
      actionsHtml(cmdBtn('午饭食堂 15', '午饭食堂 15', false) +
        cmdBtn('昨天打车 15', '昨天打车 15', false) +
        cmdBtn('这个月奶茶花了多少', '这个月奶茶花了多少', false));
  }

  /**
   * unknown 的第一层承接（§3.5 第 11 行）：把三个最常用的入口直接给出去，
   * 而不是一上来就「没辙了」。L5 只留给连续第 4 次仍判不出的情况。
   */
  function unknownClarifyHtml() {
    return '<div class="bubble ai">' + itIcon('bulb', 'bico-brand', '提示') + '想看啥？我给你三个最常用的：</div>' +
      actionsHtml(cmdBtn('查余额', '查余额', false) +
        cmdBtn('本月花销饼图', '本月饼图', false) +
        cmdBtn('这个月奶茶花了多少', '这个月奶茶花了多少', false));
  }

  /** L5：彻底放弃 + 3 个明确出口（禁止再追问，不含问号） */
  function giveUpHtml() {
    return '<div class="bubble ai">这句我是真没辙了（不再猜，免得给你记错）。你直接选：</div>' +
      actionsHtml('<button type="button" class="btn-mini primary" data-act="quick-add">手动记一笔</button>' +
        cmdBtn('查余额', '查余额', false) +
        cmdBtn('记一笔', '怎么记账', false));
  }

  /**
   * 按「意图 + 缺槽位 + 阶梯层」产出提示语 HTML。
   * @param {Object} state {intent, slots, missing, level, formType, lastText, hints, pendId, promptKey}
   * @param {Object} [viewCtx]
   * @return {{html:string, promptKey:string, formType:string, level:number}}
   */
  function buildPrompt(state, viewCtx) {
    var s = state || {};
    var intent = s.intent || 'record';
    var missing = s.missing || ['amount'];
    var level = typeof s.level === 'number' ? s.level : 2;
    var formType = s.formType || FORM_OF_LEVEL[level] || 'chip_group';
    var pendId = s.pendId || s.id || '';
    var hints = s.hints || amountHints(s.slots || {}, viewCtx || {});
    var miss = missing.slice().sort().join(',');
    var promptKey = s.promptKey || (intent + '|' + miss + '|' + level);
    var html;

    if (level >= 5) {
      html = giveUpHtml();
      formType = 'giveup';
    } else if (level === 4) {
      /* unknown 的第四层不是「举例引导」，而是「把三个最常用入口给出去」 */
      html = (intent === 'unknown') ? unknownClarifyHtml() : level4Html();
      formType = 'choice';
    } else if (level === 3) {
      html = level3Html(s, pendId);
      formType = (s.formType === 'choice') ? 'choice' : 'form';
    } else {
      html = level2Html(s, hints, pendId);
      formType = 'chip_group';
    }
    return { html: html, promptKey: promptKey, formType: formType, level: level };
  }

  /* ================================================================== */
  /* 十、主入口：classifyIntent（§2.5 伪代码落地）                       */
  /* ================================================================== */

  /**
   * 组装返回结果（统一收口，保证字段齐全）。
   * @return {Object}
   */
  function packFinal(intent, confidence, tier, scores, signals, slots, missing, queryKind, plan, reason) {
    var miss = missing || [];
    /* 槽位齐 = L0（直接执行），只有「还缺东西」才谈阶梯层 */
    var lv = (miss.length === 0)
      ? { level: 0, formType: FORM_OF_LEVEL[0], promptKey: intent + '||0', allowed: true }
      : resolveLevel(null, intent, miss);
    return {
      intent: intent,
      confidence: Math.round(Number(confidence) * 100) / 100,
      tier: tier,
      scores: scores || {},
      signals: signals || {},
      slots: slots || {},
      missing: miss,
      queryKind: queryKind || null,
      plan: plan === true,
      reason: reason || '',
      level: lv.level,
      formType: lv.formType,
      promptKey: lv.promptKey
    };
  }

  /**
   * 意图分类主入口（纯函数，无 DOM 依赖，< 1ms）。
   * @param {string} text 用户原句
   * @param {{now?:Date, lastBill?:Object, pending?:Object}} [ctx]
   * @return {{intent:string, confidence:number, tier:string, scores:Object, signals:Object,
   *   slots:Object, missing:string[], queryKind:?string, plan:boolean, reason:string,
   *   level:number, formType:string, promptKey:string}}
   */
  function classifyIntent(text, ctx) {
    var t = normalize(text);
    var opt = ctx || {};

    /* ---- step 0：空输入 / 纯表情 ---- */
    if (!t || stripNoise(t).length === 0 || isPurePunct(t)) {
      return packFinal('chitchat', 0.90, 'high', {}, {},
        { mood: 'empty' }, [], null, false, 'R0 空输入');
    }
    /* ---- step 0.5：问候短路（R3b 的守卫） ---- */
    if (isGreeting(t)) {
      return packFinal('chitchat', 0.92, 'high', {}, { SIG_GREET: true },
        { mood: 'greeting' }, [], null, false, 'R0.5 问候');
    }

    /* ---- step 1：18 个信号 ---- */
    var sig = detectSignals(t, opt);
    /* ---- step 2：槽位 ---- */
    var slots = extractSlots(t, sig, opt);
    /* ---- step 3：打分 ---- */
    var scores = scoreIntents(sig);
    /* ---- step 4：否决 V1-V4 ---- */
    scores = applyVeto(scores, sig);
    /* ---- step 5/6：argmax + tier + R1 ---- */
    var arb = arbitrate(scores, sig, slots);

    var intent = arb.intent;
    var conf = arb.confidence;
    var tier = arb.tier;
    var topScore = arb.score;
    var reason = 'argmax';

    /* ---- step 6.5：V4 是硬规则，自带高置信（同 R2 的理由） ----
       命中 V4 说明「句子带金额 + 无疑问结构」，业务规则已直接判定为记账，
       这不是分数竞争，因此不需要云端二次裁决。 */
    if (isForceRecord(sig) && intent === 'record') { tier = 'high'; }

    /* ---- step 7：R2 疑问覆盖改删（「记错了怎么删掉」是在问方法） ---- */
    if (sig.SIG_HOWTO && sig.SIG_DATAOP) {
      intent = 'howto';
      topScore = scores.howto;
      conf = Math.max(conf, 0.80);
      tier = 'high';
      reason = 'R2 疑问覆盖改删';
    }

    /* ---- step 7.5：弱查询证据降级（「帮我看看」没有任何查询对象） ---- */
    if (intent === 'query' && isWeakQueryOnly(sig, slots)) {
      intent = 'unknown';
      topScore = 0;
      conf = Math.min(conf, 0.40);
      tier = 'verylow';
      reason = '弱查询证据';
    }

    /* ---- step 7.8：R4 指代兜底 ----
       「昨天那个」「那笔」这类只给了指代、没给金额也没给改删动词的句子，
       应该按「明细查询」处理并让用户点选，而不是反问「昨天那个多少钱」。
       （P1 修复：此前 NLP.classify('那笔') 会命中「笔」-> 学习，R3a 把它错判成记账） */
    if (topScore < SCORE_LOW && sig.SIG_ANAPHORA && !sig.SIG_AMOUNT &&
      !sig.SIG_DATAOP && !sig.SIG_HOWTO && !sig.SIG_Q_BALANCE && !sig.SIG_Q_PIE) {
      slots.queryKind = 'detail';
      return packFinal('query', Math.max(conf, 0.45), 'low', scores, sig, slots,
        [], 'detail', false, 'R4 指代兜底');
    }

    /* step 7.95：纯时间指代（昨天/今天/上周…）不能当成消费项目。整句剥掉时间词后若什么都不剩，说明用户只说了一个时间点，按查询该时段处理（无损，不编造账单）。 */
    if (isPureTimeReference(t) && !sig.SIG_AMOUNT && !sig.SIG_SPEND_VERB) {
      slots.queryKind = 'detail';
      return packFinal('query', Math.max(conf, 0.55), 'low', scores, sig, slots, [], 'detail', false, '纯时间指代到查询');
    }

    /* ---- step 8：R3 兜底（R3a 品类 / R3b 短名词） ---- */
    if (topScore < SCORE_LOW) {
      /* 指代也算「有明确语义线索」：不许再被 R3a 拽回记账 */
      var noVeto = !(sig.SIG_HOWTO || sig.SIG_YESNO || sig.SIG_WH || sig.SIG_QMARK ||
        sig.SIG_Q_BALANCE || sig.SIG_Q_PIE || sig.SIG_Q_STAT || sig.SIG_ANAPHORA ||
        sig.SIG_EMOTION || sig.SIG_ADVICE || sig.SIG_DATAOP);
      if (noVeto && (sig.SIG_CATEGORY || sig.SIG_SPEND_VERB)) {
        /* R3a：品类词 / 消费动词，但分数不够 -> 记账缺金额 */
        return packFinal('record', 0.40, 'low', scores, sig, slots,
          ['amount'], null, slots.plan === true, 'R3a 品类兜底');
      }
      var bare = String(t).replace(/\s+/g, '');
      var looksLikeNoun = noVeto && !/\d/.test(bare) && bare.length >= 2 && bare.length <= 8;
      if (looksLikeNoun) {
        /* R3b：「红糖糍粑」这类连 classify 都打不出分类的短名词 -> 仍问金额 */
        if (!slots.category) { slots.category = '其他'; }
        return packFinal('record', 0.30, 'verylow', scores, sig, slots,
          ['amount'], null, false, 'R3b 短名词兜底');
      }
      return packFinal('unknown', conf, 'verylow', scores, sig, slots,
        ['intent'], null, false, reason === 'argmax' ? '无证据' : reason);
    }

    /* ---- step 9：必需槽位求差 ---- */
    slots.queryKind = resolveQueryKind(sig, slots);
    var missing = missingSlots(intent, slots);
    return packFinal(intent, conf, tier, scores, sig, slots, missing,
      slots.queryKind, slots.plan === true, reason);
  }

  /* ================================================================== */
  /* 十一、端云协同：云端裁决的合流（只允许在本地 top2 内改判）           */
  /* ================================================================== */

  /**
   * 合并云端裁决结果。
   * 保护逻辑：① 越界改判拒收；② 本地 record + 有金额时拒收（V4 保护）；
   *          ③ 云端 confidence < 0.6 不采信；④ 合并后 tier 记 low（本地已确认的部分保留）。
   * @param {Object} local classifyIntent 的结果
   * @param {Object} verdict {intent, confidence, missing, queryKind}
   * @return {Object} 合并后的结果（结构同 classifyIntent）
   */
  function mergeVerdict(local, verdict) {
    if (!local) { return local; }
    if (!verdict || !verdict.intent) { return local; }
    var ranked = rankIntents(local.scores || {});
    var top2 = [];
    if (ranked[0]) { top2.push(ranked[0].intent); }
    if (ranked[1]) { top2.push(ranked[1].intent); }
    /* ① 只允许在本地 top2 内改判 */
    if (top2.indexOf(verdict.intent) === -1) { return local; }
    /* ② V4 保护：本地已判定 record 且句子里有金额 -> 不接受任何改判 */
    if (local.signals && local.signals.SIG_AMOUNT && local.intent === 'record') { return local; }
    /* ③ 云端低置信不采信 */
    var cf = Number(verdict.confidence);
    if (isFinite(cf) && cf < 0.6) { return local; }

    var slots = local.slots || {};
    var missing = verdict.missing || missingSlots(verdict.intent, slots);
    var lv = resolveLevel(null, verdict.intent, missing);
    return {
      intent: verdict.intent,
      confidence: Math.round(Math.max(Number(local.confidence) || 0, 0.6) * 100) / 100,
      tier: 'low',
      scores: local.scores || {},
      signals: local.signals || {},
      slots: slots,
      missing: missing,
      queryKind: verdict.queryKind || local.queryKind || null,
      plan: local.plan === true,
      reason: 'cloud-verdict',
      level: lv.level,
      formType: lv.formType,
      promptKey: lv.promptKey
    };
  }

  /* ================================================================== */
  /* 十二、导出                                                          */
  /* ================================================================== */

  var API = {
    classifyIntent: classifyIntent,
    detectSignals: detectSignals,
    extractSlots: extractSlots,
    scoreIntents: scoreIntents,
    applyVeto: applyVeto,
    arbitrate: arbitrate,
    rankIntents: rankIntents,
    resolveQueryKind: resolveQueryKind,
    missingSlots: missingSlots,
    resolveLevel: resolveLevel,
    mustEscalate: mustEscalate,
    isAntiLoopViolation: mustEscalate,
    buildPrompt: buildPrompt,
    amountHints: amountHints,
    fuzzyAmountOf: fuzzyAmountOf,
    isGreeting: isGreeting,
    mergeVerdict: mergeVerdict,
    normalize: normalize,
    CONST: {
      INTENTS: INTENTS,
      INTENT_ORDER: INTENT_ORDER,
      REQUIRED_SLOTS: REQUIRED_SLOTS,
      WEIGHTS: WEIGHTS,
      LEX: LEX,
      SCORE_LOW: SCORE_LOW,
      SCORE_HIGH: SCORE_HIGH,
      MARGIN_MIN: MARGIN_MIN,
      CONF_HIGH: CONF_HIGH,
      CONF_LOW: CONF_LOW,
      RECORD_DOMINANCE: RECORD_DOMINANCE,
      FORCE_RECORD_MIN: FORCE_RECORD_MIN,
      PENDING_TTL_MS: PENDING_TTL_MS,
      MAX_TRIES: MAX_TRIES,
      LEVELS: LEVELS,
      FORM_OF_LEVEL: FORM_OF_LEVEL,
      ANTI_LOOP: ANTI_LOOP
    }
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.intent = API;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
