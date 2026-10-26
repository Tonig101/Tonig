/**
 * coach.js — 理财专家模式（核心附加能力）
 *
 * 定位：除了记账与预算预警之外的「校园理财专家」。
 * 触发场景：
 *   1. 记录【娱乐 / 冲动消费 / 高溢价品牌】账单后，给出「💡 理财专家说」卡片（≤50 字）；
 *   2. 用户问「怎么省钱 / 怎么赚钱」时，输出校园场景具体建议；
 *   3. 用户表达「想买 XX」时，引导走「剁手冷静法」三步问答。
 *
 * 对外 API（window.AJ.coach）：
 *   adviceForBill(bill, alt)   -> ?string  账单触发的一条专家建议（≤50 字，不触发返回 null）
 *   saveMoneyAnswer()          -> string  「怎么省钱」结构化回答（HTML）
 *   makeMoneyAnswer()          -> string  「怎么赚钱」结构化回答（HTML）
 *   isWantBuy(text)            -> ?{item, price}  识别「想买 XX」意图
 *   COOLING_STEPS              -> 剁手冷静法三步问题定义
 *   coolingVerdict(answers)    -> {level, title, text}  三步问答后的结论
 *   ACADEMY                    -> 理财学院课程列表
 *   personalTips(state, ov)    -> [tip]  基于账本数据生成的专属建议
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);
  var DATA = isNode ? require('./data.js') : global.AJ.data;
  var ENG = isNode ? require('./engine.js') : global.AJ.engine;

  var ALTERNATIVES = DATA.ALTERNATIVES;
  var CATEGORY_BUDGET_RATIO = DATA.CATEGORY_BUDGET_RATIO;

  /** 专家建议硬性长度上限（用户规格：不超过 50 字） */
  var ADVICE_MAX_LEN = 50;

  /** 兜底裁剪：无论如何都不超过 50 字 */
  function fit50(text) {
    var s = String(text || '').trim();
    if (s.length <= ADVICE_MAX_LEN) { return s; }
    return s.slice(0, ADVICE_MAX_LEN - 1) + '…';
  }

  function fmtMoney(n) {
    return ENG.fmtMoney(n);
  }

  /** 行内小图标（与 app.js 的 ic 同义；各模块独立闭包，不能跨文件取名） */
  function ic(name, cls, label) {
    return DATA.inlineIcon('i-' + name, cls, label);
  }

  /* ================================================================== */
  /* 一、账单触发规则（记账后主动建议）                                    */
  /* ================================================================== */

  /* 冲动消费（情绪 / 想要）建议轮换，避免每次同一句 */
  var IMPULSE_ADVICE = [
    '先加购物车晾 48 小时，两天后还想买再找我记。',
    '冲动是魔鬼：把商品放进收藏夹，这周过去再看。',
    '给未来的自己发条消息：「三天后还想要吗？」'
  ];

  /* 娱乐类支出建议轮换 */
  var FUN_ADVICE = [
    '校园影院、免费展览也香，娱乐预算省着点造。',
    '快乐不靠烧钱：操场、图书馆、社团活动零成本。',
    '设个娱乐月上限，花超了就用免费项目补位。'
  ];

  var adviceCursor = { impulse: 0, fun: 0 };

  /**
   * 判断一笔支出是否触发专家建议，并返回建议文案。
   * 触发优先级：高溢价品牌（有平替） > 冲动消费 > 娱乐类。
   * @param {Object} bill 归一化后的账单
   * @param {?Object} alt ENG.getAlternative(bill) 的结果（可不传，内部自算）
   * @return {?string} ≤50 字建议；不触发返回 null
   */
  function adviceForBill(bill, alt) {
    if (!bill || bill.type !== 'expense') { return null; }
    if (alt === undefined) { alt = ENG.getAlternative(bill); }

    // 1) 高溢价品牌：有校园平替
    if (alt && alt.save > 0) {
      var line = '试试' + alt.altName + '（' + ENG.fmt1(alt.altPrice) + '元），' +
        (alt.tip || '更划算') + '更香。';
      return fit50(line);
    }

    // 2) 冲动消费：情绪消费 / 想要
    if (bill.motivation === '情绪' || bill.want === true) {
      var pool = IMPULSE_ADVICE;
      var txt = pool[adviceCursor.impulse % pool.length];
      adviceCursor.impulse++;
      return fit50(txt);
    }

    // 3) 娱乐类支出
    if (bill.category === '娱乐') {
      var fpool = FUN_ADVICE;
      var ftxt = fpool[adviceCursor.fun % fpool.length];
      adviceCursor.fun++;
      return fit50(ftxt);
    }

    return null;
  }

  /* ================================================================== */
  /* 二、怎么省钱 / 怎么赚钱（校园场景具体建议）                           */
  /* ================================================================== */

  function saveMoneyAnswer() {
    return '' +
      '<div class="coach-qa-title">' + ic('bulb', 'bico-brand', '省钱攻略') + '理财专家说 · 校园省钱攻略</div>' +
      '<ol class="coach-qa-list">' +
      '<li><b>食堂平替外卖</b>：一荤一素 10 元上下，一周少点 3 次外卖立省 50+</li>' +
      '<li><b>拿铁因子</b>：奶茶咖啡改自泡茶包 / 食堂现磨，一周省 30+</li>' +
      '<li><b>二手真香</b>：教材、电子产品去校园二手群 / 闲鱼，毕业季一折捡漏</li>' +
      '<li><b>白嫖资源</b>：图书馆数据库、MOOC、校园影院和展览，免费也快乐</li>' +
      '<li><b>每周复盘</b>：周日看一次分类占比，超支的类别下周设上限</li>' +
      '</ol>' +
      '<div class="coach-qa-foot">先挑 1 条执行，比一次全改更容易坚持。</div>';
  }

  function makeMoneyAnswer() {
    return '' +
      '<div class="coach-qa-title">' + ic('wallet', 'bico-brand', '搞钱路子') + '理财专家说 · 校园搞钱路子</div>' +
      '<ol class="coach-qa-list">' +
      '<li><b>勤工俭学</b>：图书馆助理 / 实验室值班 / 助教，时薪 15-25，稳定靠谱</li>' +
      '<li><b>技能变现</b>：PPT 代做、约拍、家教，校园群 / 闲鱼接单，一单 50-300</li>' +
      '<li><b>闲置回血</b>：教材、电子产品、用不上的会员挂闲鱼，毕业季集中清</li>' +
      '<li><b>奖学金</b>：国奖 8000、校奖 1000-3000，性价比最高的「赚钱」</li>' +
      '<li><b>竞赛奖金</b>：创新创业 / 程序设计大赛，拿钱同时给简历加分</li>' +
      '</ol>' +
      '<div class="coach-qa-foot warn">' + ic('alert', 'bico-warn', '防骗提醒') + '先交钱的兼职都是骗子，天上不会掉馅饼。</div>';
  }

  /* ================================================================== */
  /* 三、剁手冷静法（想买 XX 时引导）                                      */
  /* ================================================================== */

  /**
   * 识别「想买 XX」意图。
   * 注意：只匹配「想 / 打算 / 准备 买」这类购买意图，不匹配「买了」（已消费，应正常记账）。
   * @return {?{item:string, price:number}}
   */
  function isWantBuy(text) {
    var raw = String(text || '').trim();
    if (!raw) { return null; }
    // 负向意图（不想买了 / 别买 / 没想买）不触发
    if (/(不|别|没|甭|何必)(好想|想要|很想|想|买)/.test(raw)) { return null; }
    // 已完成的购买描述（含金额 + 买了/花了/充值等）-> 交给正常记账，不拦截
    if (/\d/.test(raw) && /(买了|花了|付了|充值|已购|剁手了|下单了|入手了)/.test(raw)) { return null; }

    // 强意图：句首的「我想买 / 好想买 / 打算买 / 准备买…」（避免把「心情不好想买的」这类
    // 已消费描述误判为购买意图）；弱意图：句中「心痒 / 长草 / 看中」。
    var strong = /^(?:我|俺|咱)?\s*(?:好想|很想要?|超想|想|想要|打算|准备|计划)\s*(?:买|购入|入手|下单)/;
    var weak = /(心痒|长草|看中了?)/;
    if (!strong.test(raw) && !weak.test(raw)) { return null; }

    // 金额：优先带货币单位 / 「左右」的数字，其次末尾裸数字
    var price = 0;
    var pm = raw.match(/(\d+(?:\.\d+)?)\s*(?:元|块|圆|rmb|¥|左右|上下|前后)/i) ||
      raw.match(/(\d+(?:\.\d+)?)\s*$/);
    if (pm) { price = Number(pm[1]) || 0; }

    // 商品名：剥离意图动词、量词、金额与口语词
    var item = raw
      .replace(/^(我|俺|咱)?\s*(好想|想要|很想|想|打算|准备|计划)/, '')
      .replace(/(看中了|心痒了?|长草了?)/, '')
      .replace(/^(看到|看见|瞧见|发现|觉得|感觉)/, '')
      .replace(/(买|购入|入手|下单)/g, ' ')
      .replace(/\d+(?:\.\d+)?\s*(?:元|块|圆|rmb|¥)/gi, ' ')
      .replace(/\d+(?:\.\d+)?\s*(左右|上下|前后)/g, ' ')
      .replace(/\s*\d+(?:\.\d+)?\s*$/, ' ')
      .replace(/(大概|大约|左右|差不多)/g, ' ')
      .replace(/^\s*(那个|这个|一个|一件|一台|一部|一双|一款|个|台|部|双|件|款)/, ' ')
      .replace(/[，。！？!?,~～、\s]+/g, ' ')
      .trim();

    if (!item) { return null; }
    if (item.length > 16) { item = item.slice(0, 16); }
    return { item: item, price: price };
  }

  /** 剁手冷静法三步问题定义 */
  var COOLING_STEPS = [
    {
      key: 'reason',
      q: '第 1 问 · 买它的核心原因是？',
      options: [
        { val: 'need', label: '真的需要' },
        { val: 'want', label: '就是想要' },
        { val: 'mood', label: '犒劳自己' },
        { val: 'follow', label: '别人有我也要' }
      ]
    },
    {
      key: 'freq',
      q: '第 2 问 · 买来后使用频率？',
      options: [
        { val: 'often', label: '每周都用' },
        { val: 'sometimes', label: '偶尔用用' },
        { val: 'dust', label: '说不定吃灰' }
      ]
    },
    {
      key: 'pressure',
      q: '第 3 问 · 这笔钱对你来说？',
      options: [
        { val: 'easy', label: '轻松拿下' },
        { val: 'think', label: '要掂量一下' },
        { val: 'hard', label: '咬牙 / 分期' }
      ]
    }
  ];

  /** 三步问答结论 */
  function coolingVerdict(answers) {
    var score = 0;
    var map = {
      need: 2, want: 1, mood: 0, follow: 0,
      often: 2, sometimes: 1, dust: 0,
      easy: 2, think: 1, hard: 0
    };
    for (var i = 0; i < answers.length; i++) {
      score += (map[answers[i]] || 0);
    }
    if (score >= 5) {
      return {
        level: 'ok',
        icon: 'check',
        title: '可以买',
        text: '刚需、高频、无压力，下单前记得比价，学生优惠 / 教育资格能用就用。'
      };
    }
    if (score >= 3) {
      return {
        level: 'warn',
        icon: 'alert',
        title: '建议晾 48 小时',
        text: '先加进购物车，两天后还想要，再来找我，我帮你记上这笔。'
      };
    }
    return {
      level: 'stop',
      icon: 'stop',
      title: '建议先不买',
      text: '多半是情绪 / 从众冲动。先去做别的事转移注意力，真需要了再说。'
    };
  }

  /* ================================================================== */
  /* 四、理财学院（静态知识卡）                                            */
  /* ================================================================== */

  var ACADEMY = [
    {
      id: 'cooldown',
      icon: 'clock',
      title: '剁手冷静法：48 小时法则',
      tag: '冲动消费',
      body: '想买的东西先加购物车，晾满 48 小时再决定。\n' +
        '· 80% 的冲动两天后自动消退；\n' +
        '· 仍想要的，写清「买它的核心原因」再下单；\n' +
        '· 单笔超过 50 元自动触发冷静期提醒。'
    },
    {
      id: 'latte',
      icon: 'cat-food',
      title: '拿铁因子：小钱也是钱',
      tag: '日常开销',
      body: '每天一杯 15 元奶茶，一年约 5475 元，够换一台平板。\n' +
        '· 改自泡茶包（2 元）或食堂现磨（6-10 元）；\n' +
        '· 不是不能喝，而是把「下意识买」变成「主动选择」。'
    },
    {
      id: 'engel',
      icon: 'split',
      title: '恩格尔系数：吃饭钱别超 60%',
      tag: '餐饮',
      body: '餐饮支出 ÷ 总支出超过 60%，说明吃占了大头。\n' +
        '· 健康线 50%-59%，超过就要警惕；\n' +
        '· 外卖 28 元 ≈ 食堂两荤一素 12 元，一周差出 48 元；\n' +
        '· 省下的不是饭钱，是资料费、考证费和旅行基金。'
    },
    {
      id: 'infodiff',
      icon: 'radar',
      title: '省钱信息差：先看别人怎么省',
      tag: '节流实操',
      body: '同一样东西有人 39 买、有人 89 买，差的往往不是钱，是信息。\n' +
        '· 下单前先搜「关键词 + 省钱 / 测评 / 平替」，看别人踩过的坑；\n' +
        '· 大促前先收藏原价，别被先涨后降的假折扣骗；\n' +
        '· 信息差是零成本的：花 5 分钟搜索，常能省下一顿饭钱。',
      resources: [{
        type: 'copy',
        label: '红米鸡（抖音省钱博主）',
        desc: '没有固定主页链接，复制博主名去抖音搜索，看她日常怎么挑便宜货。',
        copy: '红米鸡'
      }]
    },
    {
      id: 'bloggers',
      icon: 'link',
      title: '跟着博主学省钱（B 站）',
      tag: '跟人学',
      body: '省钱干货更新最快的地方在博主主页，不在文章里：\n' +
        '· 信息差是即时更新的：这个月的奶茶价、这季度的打车券，上个月的攻略早就过期；\n' +
        '· 看真实操作比看结论有用：同一件商品怎么比价、怎么凑单，跟着点一遍就会；\n' +
        '· 关注 1-2 个就够，别刷成娱乐——看它是为了省钱，不是为了多一个刷手机的理由。',
      resources: [{
        type: 'up',
        label: '天月遥',
        desc: '消费主义克星 · 极简省钱｜《生活费不够花？给学生党的 10 条省钱建议》',
        url: 'https://m.bilibili.com/space/1023335019'
      }, {
        type: 'up',
        label: '先天省钱圣体',
        desc: '19 万粉 · 极实操的薅羊毛信息差｜1.5 元喝奶茶、30 元以内半价、拼多多与打车省钱',
        url: 'https://m.bilibili.com/space/366581522'
      }],
      resNote: '主页会持续更新，建议先看播放量高的入门合集再刷日常；UP 主观点不代表本应用立场，不构成投资建议。'
    },
    {
      id: 'budget',
      icon: 'bar',
      title: '50/30/20 预算法（学生版）',
      tag: '预算',
      body: '把每月生活费切成三份：\n' +
        '· 50% 必要开销：吃饭、交通、话费、学习资料；\n' +
        '· 30% 想要开销：聚餐、娱乐、服饰，可弹性压缩；\n' +
        '· 20% 储蓄与目标：梦想基金、应急金，发钱日先转走。'
    },
    {
      id: 'invest',
      icon: 'wallet',
      title: '零花钱理财第一课',
      tag: '理财入门',
      body: '学生理财从「不亏」开始，不追高、不碰不懂的：\n' +
        '· 先攒 3 个月生活费做应急金（货币基金 / 活期）；\n' +
        '· 再用闲钱做小额定投宽基指数，练心态不看短期涨跌；\n' +
        '· 收益率再香也先问自己：能放多久、亏 20% 慌不慌。',
      resources: [{
        type: 'video',
        label: '大学生理财扫盲（不推基金）',
        desc: '给大学生做金融祛魅，不推基金不割韭菜，先建立正确的金钱观。',
        url: 'https://www.snm0516.aisee.tv/video/BV1tj6wBDEXF/'
      }, {
        type: 'video',
        label: '零基础理财入门课 · 第 1 集 + 第 5 集',
        desc: '全 20 集短课（每集 20-30 分钟），课堂时间有限，只看第 1 集打底 + 第 5 集实操。',
        url: 'https://www.snm0516.aisee.tv/video/BV1yAX5YQEAs/'
      }],
      resNote: '资源为公开 B 站视频，经镜像站转发以保证课堂网络环境可播放；镜像不可用时可在 B 站搜索同名标题。'
    },
    {
      id: 'mooc',
      icon: 'cap',
      title: '中国大学 MOOC《个人理财》',
      tag: '系统学习',
      body: '想把理财学成体系，去跟一门完整课程：\n' +
        '· 官方课程页，含「流动性管理工具——货币市场基金」「基金定投」等章节；\n' +
        '· 先看这两节，能直接对上本页的应急金与定投建议；\n' +
        '· 免费旁听即可，不必为了证书花钱。',
      resources: [{
        type: 'course',
        label: '中国大学 MOOC《个人理财》课程页',
        desc: '系统学习入口 · 含货币市场基金、基金定投等章节。',
        url: 'https://www.icourse163.org/course/detail.htm?cid=1207124806'
      }]
    },
    {
      id: 'loan',
      icon: 'alert',
      title: '警惕校园贷与超前消费',
      tag: '避坑',
      body: '凡是「零门槛、秒到账」的贷款都别碰：\n' +
        '· 真实年化往往超过 24%，违约金滚雪球；\n' +
        '· 分期买非必需品 = 给未来的自己加税；\n' +
        '· 实在紧张先找家人 / 学校勤工助学，别碰网贷。'
    },
    {
      id: 'resale',
      icon: 'swap',
      title: '闲置转让回血指南',
      tag: '搞钱',
      body: '宿舍里躺着的是钱，不是垃圾：\n' +
        '· 教材、辅导书毕业季最值钱，提前 1 个月挂闲鱼；\n' +
        '· 电子产品走平台验货，别线下先款后货；\n' +
        '· 会员时长、优惠券也能转让，积少成多。'
    },
    {
      id: 'work',
      icon: 'lock',
      title: '勤工俭学避坑指南',
      tag: '搞钱',
      body: '靠谱优先于钱多：\n' +
        '· 校内岗位（图书馆 / 实验室 / 助教）最稳，时薪 15-25；\n' +
        '· 家教、PPT 代做靠技能，接单先收定金；\n' +
        '· 刷单、跑分、出租账号 = 违法，给多少钱都不干。'
    }
  ];

  /**
   * 学习资源的类型顺序：视频 → 课程 → UP 主主页。
   * 固定顺序是为了让看板卡与聊天气泡的「首屏内容」永远是 3 条视频 / 课程，
   * 后加入的 UP 主主页排在后面，不会把原有视频挤下去。
   */
  var LEARN_TYPE_ORDER = ['video', 'course', 'up'];

  /**
   * 聚合理财学院里所有可学习资源，供看板卡与聊天卡片共用（单一数据源，
   * 不复制任何链接，ACADEMY 内容变更后两处入口自动同步）。
   *   · 只收 type 为 video / course / up 且带合法 url 的条目（copy 型没有外链，
   *     放进来会渲染成点不动的空行，故跳过）；
   *   · 返回顺序固定为 video → course → up，同类型内保持 ACADEMY 顺序；
   *   · 每次调用返回全新数组与全新对象，外部修改不会污染 ACADEMY。
   * @return {Array<Object>} 每项 {lessonId, tag, icon, type, label, desc, url, copy}
   */
  function learningResources() {
    var out = [];
    for (var t = 0; t < LEARN_TYPE_ORDER.length; t++) {
      var want = LEARN_TYPE_ORDER[t];
      for (var i = 0; i < ACADEMY.length; i++) {
        var lesson = ACADEMY[i];
        if (!lesson || !lesson.resources || !lesson.resources.length) { continue; }
        for (var j = 0; j < lesson.resources.length; j++) {
          var r = lesson.resources[j];
          if (!r || !r.label) { continue; }
          var type = typeof r.type === 'string' ? r.type : '';
          if (type !== want) { continue; }
          if (typeof r.url !== 'string' || r.url === '') { continue; }
          out.push({
            lessonId: lesson.id || '',
            tag: lesson.tag || '',
            icon: lesson.icon || '',
            type: type,
            label: r.label,
            desc: r.desc || '',
            url: r.url,
            copy: typeof r.copy === 'string' ? r.copy : ''
          });
        }
      }
    }
    return out;
  }

  /* ================================================================== */
  /* 五、专属建议（基于账本数据动态生成）                                  */
  /* ================================================================== */

  /**
   * 根据账本数据生成 3-6 条专属建议。
   * @param {Object} state 应用状态（含 bills / budget / goals）
   * @param {Object} ov getOverview() 的结果
   * @return {Array<{level:string, icon:string, title:string, text:string}>}
   */
  function personalTips(state, ov) {
    var tips = [];
    if (!state || !ov) { return tips; }

    var bills = (state.bills || []).filter(function (b) {
      return b.type === 'expense' && b.date >= ov.cycle.start && b.date <= ov.cycle.end;
    });

    /* 1) 冲动消费扫描 */
    var impulse = bills.filter(function (b) {
      return b.motivation === '情绪' || b.want === true;
    });
    var impulseTotal = 0;
    impulse.forEach(function (b) { impulseTotal += b.amount; });
    if (impulse.length >= 2) {
      tips.push({
        level: 'warn',
        icon: 'stop',
        title: '本周期冲动消费 ' + impulse.length + ' 笔 · ' + fmtMoney(impulseTotal),
        text: '超过 2 笔就该上「剁手冷静法」了：加购物车晾 48 小时，大部分冲动会自动消退。'
      });
    }

    /* 2) 高溢价消费扫描（有平替的） */
    var hits = [];
    var weeklySave = 0;
    bills.forEach(function (b) {
      var alt = ENG.getAlternative(b);
      if (alt && alt.save > 0) {
        hits.push({ bill: b, alt: alt });
        weeklySave += alt.weeklySave;
      }
    });
    if (hits.length > 0) {
      var top = hits.slice().sort(function (a, b) { return b.alt.save - a.alt.save; })[0];
      tips.push({
        level: 'info',
        icon: 'cat-food',
        title: '发现 ' + hits.length + ' 笔高溢价消费',
        text: '全部换平替一周约省 ' + fmtMoney(weeklySave) + ' 元。最大一笔是「' +
          top.bill.note + '」，换成' + top.alt.altName + '立省 ' + fmtMoney(top.alt.save) + '。'
      });
    }

    /* 3) 恩格尔系数 */
    var engel = ov.engel || {};
    if (engel.ratio != null && engel.ratio > 0.6) {
      tips.push({
        level: 'warn',
        icon: 'pie',
        title: '恩格尔系数 ' + Math.round(engel.ratio * 100) + '% · 吃饭钱偏高',
        text: '外卖是主因：食堂两荤一素约 12 元，一周少点 3 次外卖，餐饮立省 50+。'
      });
    }

    /* 4) 储蓄率（getIncomeStats 返回百分数，如 25 表示 25%） */
    var rate = ov.incomeStats ? ov.incomeStats.savingsRate : null;
    if (rate != null && rate < 30) {
      tips.push({
        level: 'warn',
        icon: 'bar',
        title: '本周期储蓄率 ' + Math.round(rate) + '%',
        text: '健康线 30%。发钱日先转 10% 进梦想基金，剩下的再花，无痛攒钱。'
      });
    }

    /* 5) 应急金 */
    var balance = ov.incomeStats ? ov.incomeStats.balance : 0;
    if (balance < 500) {
      tips.push({
        level: 'info',
        icon: 'piggy',
        title: '先攒 500 元应急金',
        text: '手机碎屏、临时考证报名都靠它。每月存 100，5 个月就有了，再谈理财。'
      });
    }

    /* 6) 花钱速度 */
    var bs = ov.budgetState;
    var daysTotal = ov.cycle.totalDays || 30;
    var elapsed = ov.cycle.passedDays || Math.max(1, daysTotal - (ov.cycle.remainingDays || 0));
    var expected = state.budget.total * (elapsed / daysTotal);
    var spent = ov.cycleAgg ? ov.cycleAgg.expense : 0;
    if (spent > expected * 1.2 && spent > 0) {
      tips.push({
        level: 'warn',
        icon: 'clock',
        title: '花钱速度超前 ' + Math.round((spent / expected - 1) * 100) + '%',
        text: '按这个节奏月末要超支。接下来 ' + (ov.cycle.remainingDays || 0) + ' 天日均只花 ' +
          fmtMoney(bs.dailyAllowance) + '，先把外卖换成食堂。'
      });
    }

    /* 兜底：一切健康时也给一条正向建议 */
    if (tips.length === 0) {
      tips.push({
        level: 'ok',
        icon: 'alert',
        title: '本周期节奏健康',
        text: '支出、储蓄、冲动控制都在线。保持每周复盘，月底来查收成就。'
      });
    }

    return tips.slice(0, 6);
  }

  /**
   * 业务规则 5：每次记账回复都必须带一条「理财专家一句话建议」。
   * 地域绑定（业务规则 4）：优先使用《南海北区专属省钱平替库》里的点位与价格。
   * 即使这条账单没有命中平替，也必须给出兜底建议，保证「每次都有」。
   * @param {Object} bill
   * @param {?Object} ov  getOverview() 结果（用于给余额相关的兜底建议）
   * @return {string} ≤50 字
   */
  var CATEGORY_FALLBACK = {
    '餐饮': ['下一顿试试南海北区食堂一荤一素，11 元搞定。', '少点一顿外卖，一周能省 50+。'],
    '社交': ['AA 聚餐改之选 affordable：食堂二楼拼桌，人均 20 以内。', '份子钱先记下来，月底单独看这一项。'],
    '购物': ['日用品可以先去润泰超市（正门斜对面 150 米）比个价。', '不急的东西等拼多多百亿补贴，别在校内便利店买。'],
    '学习': ['打印去 17A / E2 / E3 的宿舍打印店，0.1 元/面。', '教材先看图书馆再看闲鱼，原价买最亏。'],
    '交通': ['短途共享单车月卡 10 元/月，比单次扫码省。', '去市区坐公交 K5，1.5 小时只花几块钱。'],
    '娱乐': ['娱乐-非刚需要单独看：操场夜跑和社团活动都免费。', '这周娱乐预算还稳吗？月底复盘最容易超的就是它。'],
    '居住': ['空调开 26 度，出门前检查有没有关。', '月底电费分摊时别因小钱闹矛盾。'],
    '医疗': ['校医院能开的不必校外买药，记得走医保。', '备药一次买齐，别临时在校内便利店买贵的。'],
    '其他': ['每一笔都单独看一眼，超预算的类别下周设上限。', '周日花三分钟复盘一次比什么都管用。']
  };

  var fallbackCursor = 0;

  function cooldownAdvice() {
    return '这笔属于冲动消费冷静期对象，建议先晾 24 小时。';
  }

  function oneLineAdvice(bill, ov) {
    if (!bill || bill.type !== 'expense') {
      return '收入已入账，别急着花：先把它划到这个周期的预算里。';
    }
    // 1) 有平替 -> 用平替
    var alt = ENG.getAlternative(bill);
    if (alt && alt.save > 0) {
      return '试试' + alt.altName + '（' + ENG.fmt1(alt.altPrice) + '元），' +
        (alt.tip || '更划算') + '更香。';
    }
    // 2) 非刚需 -> 冷静期提示
    if (bill.motivation === '情绪' || bill.want === true || ENG.hitsCooldownKeyword(bill)) {
      return cooldownAdvice();
    }
    // 3) 按分类给校园版兜底建议
    var pool = CATEGORY_FALLBACK[bill.category] || CATEGORY_FALLBACK['其他'];
    fallbackCursor++;
    var base = pool[fallbackCursor % pool.length];
    // 4) 余额紧张时优先说预算
    if (ov && ov.budgetState && (ov.budgetState.status === 'danger' || ov.budgetState.status === 'tight')) {
      return fit50('预算只剩 ' + fmtMoney(ov.budgetState.remaining) + '，' + base);
    }
    return fit50(base);
  }

  var API = {
    ADVICE_MAX_LEN: ADVICE_MAX_LEN,
    adviceForBill: adviceForBill,
    oneLineAdvice: oneLineAdvice,
    saveMoneyAnswer: saveMoneyAnswer,
    makeMoneyAnswer: makeMoneyAnswer,
    isWantBuy: isWantBuy,
    COOLING_STEPS: COOLING_STEPS,
    coolingVerdict: coolingVerdict,
    ACADEMY: ACADEMY,
    learningResources: learningResources,
    personalTips: personalTips
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.coach = API;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
