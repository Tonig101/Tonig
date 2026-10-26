/**
 * deals.js — 省钱雷达（商家活动日历 + 比价口径引擎 + 品类价格带）
 *
 * 定位：把「今天有什么优惠」「哪天是会员日」「三家谁便宜」做成可计算、可复现的本地能力。
 *
 * 三条数据来源，严格分开标注，绝不混着说：
 *   ① 规律型活动（肯德基疯狂星期四 = 每周四、京东 PLUS 会员日 = 每月 8 号）
 *      —— 由 date.weekday 直接算真实日期，不联网，不会过期；
 *   ② 大促节点（双 11 / 618 / 38 节…）
 *      —— 固定月日 + 预热天数，按年滚动算下一次是哪天；
 *   ③ 商品实时价
 *      —— 本模块**不编造**。只用「用户抄来的价 / 传进来的报价」做口径换算，
 *         没有报价就返回价格带参考 + 明确告诉用户还差什么。
 *
 * 对外 API（window.AJ.deals）：
 *   MERCHANTS / PROMOS                  商家与打促基础数据
 *   dealsOn(date)                       当天所有活动（限时 + 常驻 + 大促预热）
 *   upcoming(days, from)                未来 N 天逐日活动
 *   nextOf(merchantId, from)            某个活动的下一次日期
 *   nextPromo(from)                     最近一场大促 + 倒计时
 *   todayCardHtml(date) / kfcCardHtml() 聊天卡片 HTML
 *   compareOffers(offers, opts)         比价：到手价 / 单价折算 / 可比性判定 / 排名
 *   findBand(item) / judgePrice()       品类价格带 + 这个价属于哪一档
 *   timingAdvice(price, date)           现在买还是等大促
 *   calendarCsv(from, days)             真实商家日历 CSV（日期由代码算出）
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);

  /* ================================================================== */
  /* 一、商家活动：规律型（按周 / 按月），日期由代码算，永不过期            */
  /* ================================================================== */

  /**
   * rule.type
   *   weekly  : weekday 1=周一 … 7=周日
   *   monthly : day 1-28（避开月末缺日）
   *   always  : 常驻活动，每天有效
   * certainty
   *   'stable' 规律稳定（周几固定）
   *   'varies' 档期/力度常调，只能说"哪天有"，具体单品与价格以官方为准
   */
  var MERCHANTS = [
    {
      id: 'kfc', name: '肯德基', emoji: '🍗', cat: '快餐',
      place: '校门口商业街',
      title: '疯狂星期四',
      rule: { type: 'weekly', weekday: 4 },
      what: '每周四的限定特价套餐日',
      how: '校门口商业街店，走过去就行；App 里先领券再下单',
      tip: '比点外卖便宜至少 15 元（省了配送费），建议步行前往；热门单品中午就卖完了',
      coach: '疯狂星期四确实比外卖便宜 15 元以上，但每月控制在 1-2 次，别每周都去。',
      certainty: 'stable',
      source: '肯德基 App / 门店活动'
    },
    {
      id: 'mcd', name: '麦当劳', emoji: '🍟', cat: '快餐',
      place: '阳光广场',
      title: '13.9 元随心配（周一）',
      rule: { type: 'weekly', weekday: 1 },
      what: '每周一的 13.9 元套餐组合',
      how: '阳光广场店，周一点「1+1 随心配 / 13.9 元专区」，比单点省 10 元左右',
      tip: '适合月初手头紧的时候去吃；先看组合内容，别为了凑套餐加购不需要的东西',
      coach: '月初预算紧张时的兜底方案；比单点省 10 元左右，但注意充餐里有没有本来不打算买的东西。',
      certainty: 'varies',
      source: '麦当劳 App / 阳光广场门店'
    },
    {
      id: 'luckin', name: '瑞幸 / 库迪', emoji: '☕', cat: '饮品',
      place: '阳光广场',
      title: '9.9 元两杯 / 8.8 元券（周二）',
      rule: { type: 'weekly', weekday: 2 },
      what: '周二 9.9 元两杯活动，另有不定期 8.8 元券',
      how: '和舍友拼单，人均不到 5 元；走过去也就几分钟',
      tip: '每周最多 2 杯；用瑞幸 / 库迪代替喜茶、奈雪，单杯省 15-20 元',
      coach: '和舍友拼单，人均不到 5 元，是奶茶的最优解；但每周控制在 2 杯以内。',
      certainty: 'varies',
      source: '瑞幸 / 库迪 App 活动页'
    },
    /* —— 以下为「省钱图谱」同步过来的品牌固定活动，统一进雷达日历（每周几 / 每月几号） —— */
    {
      id: 'mcd-member', name: '麦当劳会员日', emoji: '🍔', cat: '快餐',
      place: '门店 / 外卖 App',
      title: '会员日领券（周一）',
      rule: { type: 'weekly', weekday: 1 },
      what: '每周一麦当劳会员日，App 领券后部分单品更便宜',
      how: '周一打开麦当劳 App 先领「会员日券」，再点单；和 13.9 随心配专区可叠加看哪个更划算',
      tip: '券的面额每周会变，先比再买；别为了用券多买不需要的东西',
      coach: '会员日券通常比平时便宜几元，周一吃麦当劳前先领券，但别为凑券加购。',
      certainty: 'varies',
      source: '麦当劳 App 会员日'
    },
    {
      id: 'dominos-mon', name: '达美乐', emoji: '🍕', cat: '快餐',
      place: '外卖 App',
      title: '外卖 8 折（周一）',
      rule: { type: 'weekly', weekday: 1 },
      what: '每周一达美乐外卖 8 折',
      how: '周一在达美乐小程序 / App 点外卖，结算自动 8 折；比平时下单省约 20%',
      tip: '仅外卖、自取不一定参与；满减与折扣不同享时选更省的',
      coach: '周一想吃披萨就等这天，8 折比平时省一笔；别每周都点。',
      certainty: 'stable',
      source: '达美乐官方活动'
    },
    {
      id: 'tastien', name: '塔斯汀', emoji: '🍔', cat: '快餐',
      place: '门店 / 外卖 App',
      title: '会员日（周二）',
      rule: { type: 'weekly', weekday: 2 },
      what: '每周二塔斯汀会员日，部分单品会员价',
      how: '周二在塔斯汀小程序领会员券，买汉堡 / 披萨更便宜',
      tip: '会员日力度每周略有不同，先看好再凑单',
      coach: '周二想吃塔斯汀就这天去，但控制在 1 次。',
      certainty: 'varies',
      source: '塔斯汀会员日'
    },
    {
      id: 'heytea-topping', name: '喜茶 / CoCo', emoji: '🧋', cat: '饮品',
      place: '门店 / 外卖 App',
      title: '免费加小料（周二）',
      rule: { type: 'weekly', weekday: 2 },
      what: '每周二喜茶 / CoCo 免费加小料（珍珠、椰果等）',
      how: '周二点单时勾选「免费加料」，奶茶口感升级不加价',
      tip: '只免基础小料，别顺手加收费配料；想省钱就用它替代周三的付费升杯',
      coach: '周二想喝奶茶就靠免费加料白嫖，比平时省 3-5 元。',
      certainty: 'varies',
      source: '喜茶 / CoCo 会员活动'
    },
    {
      id: 'dominos-wed', name: '达美乐', emoji: '🍕', cat: '快餐',
      place: '外卖 App',
      title: '外卖 7 折（周三）',
      rule: { type: 'weekly', weekday: 3 },
      what: '每周三达美乐外卖 7 折（比周一 8 折更狠）',
      how: '周三下单自动 7 折，大单更划算；和周一 8 折择低选一天',
      tip: '力度常变，以结算页为准；自取可能不参与',
      coach: '周三披萨更便宜，但每周最多 1 次，别因为打折就多吃。',
      certainty: 'stable',
      source: '达美乐官方活动'
    },
    {
      id: 'pizza', name: '必胜客', emoji: '🍕', cat: '快餐',
      place: '门店 / 外卖 App',
      title: '尖叫星期三（周三）',
      rule: { type: 'weekly', weekday: 3 },
      what: '每周三必胜客「尖叫星期三」特价',
      how: '周三在必胜客 App 看本周尖叫单品，部分半价或买一送一',
      tip: '指定单品才参与，先确认再点；别为了特价硬凑人数',
      coach: '周三想吃必胜客就等尖叫日，但每月 1-2 次足够。',
      certainty: 'varies',
      source: '必胜客官方活动'
    },
    {
      id: 'mixue', name: '蜜雪冰城', emoji: '🍦', cat: '饮品',
      place: '门店',
      title: '满 12 减 2（周三）',
      rule: { type: 'weekly', weekday: 3 },
      what: '每周三蜜雪冰城满 12 减 2',
      how: '周三凑满 12 元自动减 2，和同学拼单很容易达标',
      tip: '本就便宜，满减是锦上添花；别为凑单多喝',
      coach: '周三想喝蜜雪就凑满减，省 2 元也是省。',
      certainty: 'stable',
      source: '蜜雪冰城门店活动'
    },
    {
      id: 'chabaidao-up', name: '茶百道', emoji: '🧋', cat: '饮品',
      place: '门店 / 外卖 App',
      title: '会员升杯（周三）',
      rule: { type: 'weekly', weekday: 3 },
      what: '每周三茶百道会员升杯（中杯升大杯等）',
      how: '周三会员点单勾选升杯，免费大一号；比平时更值',
      tip: '仅会员、指定饮品；想喝就这天，但别天天喝',
      coach: '周三茶百道升杯白赚，替代平时的付费大杯。',
      certainty: 'varies',
      source: '茶百道会员活动'
    },
    {
      id: 'chabaidao-88', name: '茶百道', emoji: '🧋', cat: '饮品',
      place: '门店 / 外卖 App',
      title: '88 折（周四）',
      rule: { type: 'weekly', weekday: 4 },
      what: '每周四茶百道 88 折',
      how: '周四在茶百道点单自动 88 折，比平时省约 12%',
      tip: '和周三升杯择一即可，别两天都喝；力度以结算页为准',
      coach: '周四茶百道 88 折，但奶茶一周控制在 2 杯内。',
      certainty: 'stable',
      source: '茶百道会员活动'
    },
    {
      id: 'wallace', name: '华莱士', emoji: '🐔', cat: '快餐',
      place: '门店 / 外卖 App',
      title: '会员日买一送一（周五）',
      rule: { type: 'weekly', weekday: 5 },
      what: '每周五华莱士会员日，指定单品买一送一',
      how: '周五华莱士会员点单，汉堡 / 鸡块常买一送一，和同学拼最划算',
      tip: '指定单品参与，先确认品类；别为凑买一送一硬吃两份',
      coach: '周五华莱士买一送一适合拼单，但别每周都冲。',
      certainty: 'varies',
      source: '华莱士会员日'
    },
    {
      id: 'guming', name: '古茗', emoji: '🍵', cat: '饮品',
      place: '门店 / 外卖 App',
      title: '会员日（每月 20 号）',
      rule: { type: 'monthly', day: 20 },
      what: '每月 20 号古茗会员日，领券 / 折扣',
      how: '每月 20 号打开古茗小程序领会员券，部分饮品更便宜',
      tip: '券额每月不同，先比再买；别囤券',
      coach: '想喝古茗就等 20 号会员日，省几元。',
      certainty: 'varies',
      source: '古茗会员日'
    },
    {
      id: 'yihetang', name: '益禾堂', emoji: '🥤', cat: '饮品',
      place: '门店 / 外卖 App',
      title: '半价 / 买一送一（每月 18 号）',
      rule: { type: 'monthly', day: 18 },
      what: '每月 18 号益禾堂半价或买一送一',
      how: '每月 18 号益禾堂会员活动，指定饮品半价 / 买一送一',
      tip: '指定单品参与，拼单更值；别为凑单多喝',
      coach: '益禾堂 18 号活动力度大，但每月 1 次足够。',
      certainty: 'varies',
      source: '益禾堂会员日'
    },
    {
      id: 'haoxianglai', name: '好想来', emoji: '🛒', cat: '零食',
      place: '门店',
      title: '88 折（每月 8 号）',
      rule: { type: 'monthly', day: 8 },
      what: '每月 8 号好想来全场 88 折',
      how: '每月 8 号去好想来囤零食，结算 88 折；比平时省 12%',
      tip: '零食是隐形支出，只在清单内的东西上享受折扣，别顺手多拿',
      coach: '好想来 8 号 88 折适合囤清单零食，但别逛着逛着拿一堆。',
      certainty: 'stable',
      source: '好想来会员日'
    },
    {
      id: 'dicos', name: '德克士', emoji: '🍗', cat: '快餐',
      place: '门店 / 外卖 App',
      title: '买一送一（每月 18 号）',
      rule: { type: 'monthly', day: 18 },
      what: '每月 18 号德克士指定单品买一送一',
      how: '每月 18 号德克士会员活动，鸡块 / 汉堡常买一送一',
      tip: '指定单品参与，拼单更值；和益禾堂 18 号错峰安排',
      coach: '德克士 18 号买一送一适合拼单，但别每月都冲。',
      certainty: 'varies',
      source: '德克士会员日'
    },
    {
      id: 'haidilao', name: '海底捞', emoji: '🍲', cat: '聚餐',
      place: '门店（需学生认证）',
      title: '大学生 69 折（工作日 14-17 & 22 后）',
      rule: { type: 'weekly', weekday: [1, 2, 3, 4, 5] },
      what: '工作日 14:00-17:00 及 22:00 后，大学生认证 69 折',
      how: '用学生证 / 学信网认证后，工作日下午茶段或夜宵段去海底捞打 69 折',
      tip: '仅工作日、且限指定时段；周末和饭点不打折。先确认门店参与再约人',
      coach: '海底捞大学生 69 折很香，但只在工作日非饭点，约人前先算好时段。',
      certainty: 'stable',
      source: '海底捞大学生优惠'
    },
    {
      id: 'zym', name: '赵一鸣零食', emoji: '🍬', cat: '零食',
      place: '阳光广场',
      title: '会员日折扣 / 满减',
      rule: { type: 'always' },
      what: '不定期会员日折扣与满减',
      how: '囤零食去赵一鸣比校内便利店便宜；只买清单上的东西',
      tip: '别囤太多——零食是隐形支出，逛着逛着拿一堆最容易超支',
      coach: '比校内便利店便宜，但零食是隐形支出：只买清单上的，别逛着逛着拿一堆。',
      certainty: 'varies',
      source: '赵一鸣门店会员日公告'
    },
    {
      id: 'zunte', name: '尊特优选', emoji: '🏬', cat: '超市',
      place: '第二饭堂三楼',
      title: '校内最大超市',
      rule: { type: 'always' },
      what: '校内最大的超市，东西最全',
      how: '急用才去，不急的等网购（拼多多百亿补贴）',
      tip: '价格不一定最优，图的是方便；同样的东西润泰超市通常更便宜',
      coach: '着急用才去，价格不一定最优；不急的下单网购，价格通常更便宜。',
      certainty: 'stable',
      source: '校内实地'
    },
    {
      id: 'convenience', name: '校内便利店', emoji: '🏪', cat: '超市',
      place: '各饭堂旁（一饭三、一饭四最方便）',
      title: '应急零食 / 水 / 纸巾',
      rule: { type: 'always' },
      what: '饭堂旁的校内便利店',
      how: '买水、买纸巾可以；别在这买整箱饮料',
      tip: '溢价明显，比润泰超市贵；整箱饮料拼多多送到菜鸟驿站更便宜',
      coach: '溢价最明显的点位，只适合应急；整箱饮料走网购，均价能省一半。',
      certainty: 'stable',
      source: '校内实地'
    },
    {
      id: 'runtop', name: '润泰超市', emoji: '🛒', cat: '超市',
      place: '正门斜对面 150 米',
      title: '日常生活用品',
      rule: { type: 'always' },
      what: '校外超市，日用品价格比校内便宜',
      how: '买洗发水、纸巾这类日用品可以走到校门对面去买',
      tip: '比校内尊特优选便宜；走过去也就几分钟，顺路蹲的话不亏',
      coach: '买日用品可以走过去，比校内超市便宜；周末顺便去买，一趟搞定一个月用量。',
      certainty: 'stable',
      source: '校内实地'
    },
    {
      id: 'dormstore', name: '宿舍楼下小卖部', emoji: '🏠', cat: '超市',
      place: '宿舍楼下',
      title: '应急泡面 / 水',
      rule: { type: 'always' },
      what: '深夜应急的泡面和水',
      how: '深夜饿了应急可以买一次',
      tip: '长期在这买零食会悄悄掏空钱包，记账时往往连笔记都懒得记',
      coach: '深夜应急可以，但长期在这买零食会悄悄掏空钱包——记得单独记一笔，月底复盘会吓你一跳。',
      certainty: 'stable',
      source: '校内实地'
    }
  ];

  /* ================================================================== */
  /* 二、大促节点：固定月日，按年滚动算下一次                            */
  /* ================================================================== */

  var PROMOS = [
    { id: 'double11', name: '双11', month: 11, day: 11, warmup: 12,
      depth: '全品类，全年深度最大', bestFor: '大件、囤货、服饰' },
    { id: 'double12', name: '双12', month: 12, day: 12, warmup: 5,
      depth: '约 5%-15%，力度弱于双11', bestFor: '补漏、小件' },
    { id: 'newyear', name: '年货节', month: 1, day: 10, warmup: 10,
      depth: '食品 / 礼盒约 10%-25%', bestFor: '食品、年礼' },
    { id: 'w38', name: '38节', month: 3, day: 8, warmup: 7,
      depth: '美妆个护约 15%-30%', bestFor: '美妆、个护' },
    { id: 'p618', name: '618', month: 6, day: 18, warmup: 20,
      depth: '数码家电约 15%-30%', bestFor: '数码、家电、大件' },
    { id: 'school', name: '开学季', month: 8, day: 25, warmup: 10,
      depth: '文具 / 数码约 10%-20%', bestFor: '学生用品、笔记本' }
  ];

  /* ================================================================== */
  /* 三、日期工具（全部本地时区，避免 UTC 偏移把"今天"算错一天）           */
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

  function addDays(d, n) {
    var x = toDate(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function daysBetween(a, b) {
    var ms = toDate(b).getTime() - toDate(a).getTime();
    return Math.round(ms / 86400000);
  }

  /** JS 的 getDay(): 0=周日 … 6=周六；本模块统一用 1=周一 … 7=周日 */
  function isoWeekday(d) {
    var w = toDate(d).getDay();
    return w === 0 ? 7 : w;
  }

  /** 行内小图标（与 app.js 的 ic 同义；模块独立闭包不能跨文件取名） */
  function dlIcon(name, cls, label) {
    var D = (typeof module !== 'undefined' && module.exports) ? require('./data.js') : global.AJ.data;
    return D.inlineIcon('i-' + name, cls, label);
  }

  /** 条目小图标：优先线性 svg（it.icon），没有才用 emoji（商户插画，如 🍗 肯德基） */
  function itemIcon(it, cls) {
    return it && it.icon ? dlIcon(it.icon, cls, null) : esc(it && it.emoji ? it.emoji : '');
  }

  function weekdayCn(d) { return WEEK_CN[toDate(d).getDay()]; }

  /* ================================================================== */
  /* 四、活动计算                                                        */
  /* ================================================================== */

  function merchantById(id) {
    for (var i = 0; i < MERCHANTS.length; i++) {
      if (MERCHANTS[i].id === id) { return MERCHANTS[i]; }
    }
    return null;
  }

  /** 某个商家活动是否落在这一天 */
  function matchRule(m, d) {
    var r = m.rule || {};
    if (r.type === 'always') { return true; }
    if (r.type === 'weekly') {
      if (Array.isArray(r.weekday)) { return r.weekday.indexOf(isoWeekday(d)) !== -1; }
      return isoWeekday(d) === r.weekday;
    }
    if (r.type === 'monthly') { return toDate(d).getDate() === r.day; }
    return false;
  }

  /** 下一次（含今天）命中该活动的日期 */
  function nextOf(merchantId, from) {
    var m = merchantById(merchantId);
    if (!m) { return null; }
    var start = toDate(from || new Date());
    if (m.rule.type === 'always') { return start; }
    for (var i = 0; i < 400; i++) {
      var d = addDays(start, i);
      if (matchRule(m, d)) { return d; }
    }
    return null;
  }

  /** 最近一场大促：{promo, date, days, warming} */
  function nextPromo(from) {
    var start = toDate(from || new Date());
    var best = null;
    for (var y = start.getFullYear(); y <= start.getFullYear() + 1; y++) {
      for (var i = 0; i < PROMOS.length; i++) {
        var p = PROMOS[i];
        var dt = new Date(y, p.month - 1, p.day);
        var d = daysBetween(start, dt);
        if (d < 0) { continue; }
        if (!best || d < best.days) {
          best = { promo: p, date: dt, days: d, warming: d <= p.warmup };
        }
      }
    }
    return best;
  }

  /** 当天活动列表：[{type:'weekly'|'monthly'|'always'|'promo', merchant?, promo?, title, ...}] */
  function dealsOn(date) {
    var d = toDate(date);
    var out = [];
    var i;
    for (i = 0; i < MERCHANTS.length; i++) {
      var m = MERCHANTS[i];
      if (!matchRule(m, d)) { continue; }
      var isAlways = m.rule.type === 'always';
      out.push({
        type: isAlways ? 'always' : (m.rule.type === 'weekly' ? 'weekly' : 'monthly'),
        id: m.id, name: m.name, emoji: m.emoji, cat: m.cat,
        place: m.place || '', coach: m.coach || '',
        title: m.title, what: m.what, how: m.how, tip: m.tip,
        certainty: m.certainty, source: m.source,
        tag: isAlways ? '常驻' : (m.rule.type === 'weekly' ? (Array.isArray(m.rule.weekday) ? '工作日' : '每周' + WEEK_CN[m.rule.weekday % 7]) : '每月 ' + m.rule.day + ' 号')
      });
    }
    var np = nextPromo(d);
    if (np && np.days === 0) {
      out.push({ type: 'promo', id: np.promo.id, name: '电商大促', icon: 'spark', cat: '电商',
        title: np.promo.name + ' 当天', what: np.promo.depth, how: '当天为正式活动日，注意尾款与满减门槛',
        tip: '大促当天不是所有品类都最便宜，先看历史价再下单', certainty: 'stable',
        source: '平台官方活动页', tag: '今天' });
    } else if (np && np.days === np.promo.warmup) {
      out.push({ type: 'promo', id: np.promo.id, name: '电商大促', icon: 'clock', cat: '电商',
        title: np.promo.name + ' 预热开始（还有 ' + np.days + ' 天）', what: np.promo.depth,
        how: '先加购物车、领券，正式开卖再付；注意预售价与定金规则',
        tip: '预热期的"预售价"未必最低，别被倒计时催着下单', certainty: 'stable',
        source: '平台官方活动页', tag: '预热' });
    }
    return out;
  }

  /** 未来 N 天逐日：只有限时活动才进日历，常驻活动单独列一次，避免日历全是噪音 */
  function upcoming(days, from) {
    var start = toDate(from || new Date());
    var list = [];
    for (var i = 0; i < (days || 14); i++) {
      var d = addDays(start, i);
      var all = dealsOn(d).filter(function (x) { return x.type !== 'always'; });
      list.push({ date: dateKey(d), weekday: weekdayCn(d), offset: i, items: all });
    }
    return list;
  }

  /** 常驻活动（不进逐日日历，单独展示） */
  function alwaysDeals() {
    return dealsOn(new Date()).filter(function (x) { return x.type === 'always'; });
  }

  /* ================================================================== */
  /* 五、品类价格带（素人模式第一句回答用；不是报价）                      */
  /* ================================================================== */

  /**
   * 口径：为日常主流价位经验区间，只用于"这个价大概在什么档"，
   * 精确比价必须用真实报价（compareOffers）。充电宝一行按 10000mAh 主流容量估。
   */
  var BANDS = [
    { keys: ['充电宝', '移动电源', '充电电池'], name: '充电宝（10000mAh）', low: [40, 80], mid: [80, 150], high: [150, 300], channel: '拼多多百亿补贴 / 京东大促' },
    { keys: ['蓝牙耳机', '无线耳机', '耳机', 'airpods'], name: '蓝牙耳机', low: [50, 150], mid: [150, 500], high: [500, 1500], channel: '拼多多百亿补贴（标品）' },
    { keys: ['保温杯', '水杯', '杯子'], name: '保温杯（500ml）', low: [30, 60], mid: [60, 150], high: [150, 400], channel: '拼多多百亿补贴 / 淘宝第三方' },
    { keys: ['洗衣液'], name: '洗衣液（3L 装）', low: [15, 25], mid: [25, 45], high: [45, 80], channel: '拼多多 / 抖音直播间' },
    { keys: ['洗发水', '洗发露'], name: '洗发水（500ml）', low: [20, 40], mid: [40, 80], high: [80, 200], channel: '拼多多百亿补贴' },
    { keys: ['电动牙刷'], name: '电动牙刷', low: [80, 150], mid: [150, 350], high: [350, 800], channel: '拼多多百亿补贴' },
    { keys: ['空气炸锅'], name: '空气炸锅', low: [150, 300], mid: [300, 600], high: [600, 1200], channel: '拼多多 / 京东大促' },
    { keys: ['电饭煲', '电饭锅'], name: '电饭煲', low: [100, 250], mid: [250, 600], high: [600, 1500], channel: '京东自营大促 / 拼多多' },
    { keys: ['运动鞋', '跑鞋', '球鞋'], name: '运动鞋', low: [100, 250], mid: [250, 600], high: [600, 1500], channel: '唯品会 / 淘宝第三方' },
    { keys: ['笔记本', '电脑', '平板'], name: '笔记本（学生本）', low: [2500, 3500], mid: [3500, 5500], high: [5500, 9000], channel: '京东教育优惠 / 618' },
    { keys: ['显示器'], name: '显示器（27 寸）', low: [500, 800], mid: [800, 1500], high: [1500, 3000], channel: '京东自营 / 618' },
    { keys: ['扫地机器人', '扫地机'], name: '扫地机器人', low: [800, 1500], mid: [1500, 3000], high: [3000, 6000], channel: '京东自营大促' }
  ];

  function findBand(item) {
    var s = String(item || '').toLowerCase();
    if (!s) { return null; }
    for (var i = 0; i < BANDS.length; i++) {
      var b = BANDS[i];
      for (var j = 0; j < b.keys.length; j++) {
        if (s.indexOf(b.keys[j].toLowerCase()) !== -1) { return b; }
      }
    }
    return null;
  }

  /** 把一个价按价格带分档：入门 / 中档 / 高档 / 偏贵 */
  function judgePrice(item, price) {
    var b = findBand(item);
    var p = Number(price);
    if (!b || !isFinite(p) || p <= 0) { return null; }
    var level, label, note;
    if (p <= b.low[1]) {
      level = 'entry'; label = '入门档';
      note = '属于「' + b.name + '」的入门价位，' + b.low[0] + '-' + b.low[1] + ' 元区间内';
    } else if (p <= b.mid[1]) {
      level = 'mid'; label = '中档';
      note = '落在中档价位（' + b.mid[0] + '-' + b.mid[1] + ' 元），通常是主力款';
    } else if (p <= b.high[1]) {
      level = 'high'; label = '高档';
      note = '已到高档价位（' + b.high[0] + '-' + b.high[1] + ' 元），为品牌/功能溢价买单';
    } else {
      level = 'over'; label = '偏贵';
      note = '高于「' + b.name + '」的主流高档上限（' + b.high[1] + ' 元），先确认是不是新款/大容量版本';
    }
    return { band: b.name, bandObj: b, level: level, label: label, text: note, channel: b.channel };
  }

  /** 现在买还是等大促（口径：不承诺大促一定更便宜） */
  function timingAdvice(price, from) {
    var np = nextPromo(from);
    var p = Number(price) || 0;
    var advice;
    if (!np) {
      return { text: '按需买就行，暂时算不出最近的大促节点。', promo: null, days: null };
    }
    var days = np.days;
    var name = np.promo.name;
    if (p >= 500) {
      if (days <= 30) { advice = '单价 ' + p + ' 元属大件，距 ' + name + ' 只剩 ' + days + ' 天——不急就等，大促通常有直降或满减。'; }
      else { advice = '单价 ' + p + ' 元属大件，但距 ' + name + ' 还有 ' + days + ' 天，等下去时间成本过高——现在买，记得看有没有价保。'; }
    } else if (p > 0 && p < 100) {
      advice = '单价 ' + p + ' 元属小件，跨平台价差通常只有几块——不用为省这点钱等 ' + days + ' 天，现在比完价就买。';
    } else if (days <= 20) {
      advice = '距 ' + name + ' 还有 ' + days + ' 天——不急着用可以等；急用现在买。';
    } else {
      advice = '距最近的 ' + name + ' 还有 ' + days + ' 天，比较远——按需买就行。';
    }
    return {
      text: advice,
      promo: np.promo.name,
      days: days,
      date: dateKey(np.date),
      warming: np.warming,
      depth: np.promo.depth
    };
  }

  /* ================================================================== */
  /* 六、比价口径引擎                                                     */
  /* ================================================================== */

  var RE_MULTI = /(\d+)\s*[包瓶罐盒装袋提]?\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*(ml|毫升|l|升|g|克|kg|千克|公斤)/;
  var RE_MULTI_REV = /(\d+(?:\.\d+)?)\s*(ml|毫升|l|升|g|克|kg|千克|公斤)\s*[xX×*]\s*(\d+)\s*[包瓶罐盒装袋]?/;
  var RE_PREFIX = /(\d+(?:\.\d+)?)\s*[包瓶罐盒袋箱筒听提条支]\s*装\s*(\d+(?:\.\d+)?)\s*(ml|毫升|l|升|g|克|kg|千克|公斤)/;
  var RE_COUNT_MULTI = /(\d+(?:\.\d+)?)\s*(抽|张|片|卷|包|袋|盒|瓶|罐|听|筒|条|个|只|支|枚|件)\s*[xX×*]?\s*(\d+(?:\.\d+)?)\s*(提|箱|组|套|袋|包|盒|件)/;
  var RE_JIN_MULTI = /(\d+(?:\.\d+)?)\s*斤\s*[xX×*]\s*(\d+)/;
  var RE_JIN = /(\d+(?:\.\d+)?)\s*斤/;
  /* 充电宝/电池容量：10000mAh —— 单列一类，按元/1000mAh 折算才直观 */
  var RE_MAH = /(\d+(?:\.\d+)?)\s*(mah|毫安时|毫安)/i;
  var RE_VOL = /(\d+(?:\.\d+)?)\s*(ml|毫升|l|L|升|g|克|kg|千克|公斤)/;
  var RE_COUNT = /(\d+(?:\.\d+)?)\s*(包|抽|张|提|片|枚|卷|条|双|只|个|支|盒|袋|瓶|罐|听|筒|箱|组|套|件)/;
  var RE_NEED1 = /(?:需买|需购买|需要买|必须买|至少买|最少买|买够|买满|满|囤)\s*(\d+)\s*(?:件|个|盒|包|提|瓶|罐|袋|组|箱|套)/;
  var RE_NEED2 = /(\d+)\s*(?:件|个|盒|包|提|瓶|罐|袋|组|箱|套)\s*(?:起|以上|起售|起购)/;

  var CN_DIGIT = { '零': '0', '一': '1', '二': '2', '两': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' };

  /** 价格清洗：'¥39.9' / '39.9元' / '1,299.00' / 全角 都能读 */
  function toNum(v, dft) {
    if (v === null || v === undefined || v === '') { return dft === undefined ? null : dft; }
    if (typeof v === 'number') { return isFinite(v) ? v : (dft === undefined ? null : dft); }
    var s = String(v)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[．]/g, '.').replace(/,/g, '');
    var m = s.match(/-?\d+(?:\.\d+)?/);
    if (!m) { return dft === undefined ? null : dft; }
    var n = parseFloat(m[0]);
    return isFinite(n) ? n : (dft === undefined ? null : dft);
  }

  function normSpecText(spec) {
    var s = String(spec || '').replace(/\s+/g, '');
    s = s.replace(/包邮|包运费|免邮|包退|包换|包安装|包配送/g, '');
    s = s.replace(/[零一二两三四五六七八九十](?=[包瓶罐盒袋箱筒听提条支个只张片抽卷])/g, function (ch) {
      return CN_DIGIT[ch] || ch;
    });
    return s;
  }

  /** 规格 -> {qty, unit}；unit 为 ml / g / 计数单位，可直接横向比单价 */
  function parseSpec(spec) {
    var s = normSpecText(spec);
    if (!s) { return { qty: null, unit: null }; }
    var m, cnt, val, u;
    m = s.match(RE_MULTI);
    if (m) {
      cnt = parseFloat(m[1]); val = parseFloat(m[2]); u = m[3].toLowerCase();
      if (u === 'l' || u === '升') { return { qty: cnt * val * 1000, unit: 'ml' }; }
      if (u === 'kg' || u === '千克' || u === '公斤') { return { qty: cnt * val * 1000, unit: 'g' }; }
      return { qty: cnt * val, unit: (u === 'ml' || u === '毫升') ? 'ml' : 'g' };
    }
    m = s.match(RE_MULTI_REV);
    if (m) {
      val = parseFloat(m[1]); u = m[2].toLowerCase(); cnt = parseFloat(m[3]);
      if (u === 'l' || u === '升') { return { qty: cnt * val * 1000, unit: 'ml' }; }
      if (u === 'kg' || u === '千克' || u === '公斤') { return { qty: cnt * val * 1000, unit: 'g' }; }
      return { qty: cnt * val, unit: (u === 'ml' || u === '毫升') ? 'ml' : 'g' };
    }
    m = s.match(RE_PREFIX);
    if (m) {
      cnt = parseFloat(m[1]); val = parseFloat(m[2]); u = m[3].toLowerCase();
      if (u === 'l' || u === '升') { return { qty: cnt * val * 1000, unit: 'ml' }; }
      if (u === 'kg' || u === '千克' || u === '公斤') { return { qty: cnt * val * 1000, unit: 'g' }; }
      return { qty: cnt * val, unit: (u === 'ml' || u === '毫升') ? 'ml' : 'g' };
    }
    m = s.match(RE_COUNT_MULTI);
    if (m) { return { qty: parseFloat(m[3]), unit: m[4] }; }
    m = s.match(RE_JIN_MULTI);
    if (m) { return { qty: parseFloat(m[1]) * 500 * parseFloat(m[2]), unit: 'g' }; }
    m = s.match(RE_JIN);
    if (m) { return { qty: parseFloat(m[1]) * 500, unit: 'g' }; }
    m = s.match(RE_MAH);
    if (m) { return { qty: parseFloat(m[1]), unit: 'mAh' }; }
    m = s.match(RE_VOL);
    if (m) {
      val = parseFloat(m[1]); u = m[2].toLowerCase();
      if (u === 'l' || u === '升') { return { qty: val * 1000, unit: 'ml' }; }
      if (u === 'kg' || u === '千克' || u === '公斤') { return { qty: val * 1000, unit: 'g' }; }
      return { qty: val, unit: (u === 'ml' || u === '毫升') ? 'ml' : 'g' };
    }
    m = s.match(RE_COUNT);
    if (m) { return { qty: parseFloat(m[1]), unit: m[2] }; }
    return { qty: null, unit: null };
  }

  /** 购买门槛：「需买 4 件」「4 件起」-> 4；没写 -> 1 */
  function parseNeed(text) {
    var s = String(text || '');
    var m = s.match(RE_NEED1) || s.match(RE_NEED2);
    if (!m) { return 1; }
    var n = parseInt(m[1], 10);
    return (isFinite(n) && n >= 1) ? n : 1;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function fmt(n) {
    if (n === null || n === undefined || !isFinite(n)) { return '—'; }
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  function fmt3(n) {
    if (n === null || n === undefined || !isFinite(n)) { return '—'; }
    return (Math.round(n * 1000) / 1000).toFixed(3);
  }

  /** 折合单价的展示文案：ml/g 给每 100 单位，mAh 给每 1000mAh，其余给每个计数单位 */
  function perLabel(r) {
    if (!r || r.per === null || r.per === undefined || !isFinite(r.per)) { return '—'; }
    if (r.unit === 'ml' || r.unit === 'g') { return fmt(r.per * 100) + ' 元/100' + r.unit; }
    if (r.unit === 'mAh') { return fmt(r.per * 1000) + ' 元/1000mAh'; }
    return fmt3(r.per) + ' 元/' + r.unit;
  }

  /**
   * 比价主函数
   * @param {Array} offers [{platform,title,price,ship,coupon,spec,needQty}]
   * @param {Object} opts   {item, budget, today}
   * @return {Object} 结果（含 headline / rows / warnings / timing / budget）
   */
  function compareOffers(offers, opts) {
    opts = opts || {};
    var item = opts.item || '未命名商品';
    var today = opts.today ? toDate(opts.today) : new Date();
    var rows = [], skipped = [], i;

    offers = Array.isArray(offers) ? offers.slice(0, 20) : [];
    for (i = 0; i < offers.length; i++) {
      var o = offers[i] || {};
      var price = toNum(o.price);
      if (price === null || price <= 0 || !isFinite(price)) {
        skipped.push('第 ' + (i + 1) + ' 条：没读到有效价格，已跳过');
        continue;
      }
      var ship = toNum(o.ship, 0) || 0;
      var coupon = toNum(o.coupon, 0) || 0;
      var need = toNum(o.needQty, null);
      if (!need) { need = parseNeed((o.title || '') + ' ' + (o.spec || '')); }
      need = Math.max(1, Math.round(need || 1));
      var sp = parseSpec(o.spec);
      if (need === 1) {
        var need2 = parseNeed(String(o.spec || ''));
        if (need2 > 1) { need = need2; }
      }
      var eff = Math.max(0, price * need + ship - coupon);
      rows.push({
        platform: String(o.platform || '未知平台'),
        title: String(o.title || '').trim(),
        price: price, ship: ship, coupon: coupon, needQty: need,
        spec: String(o.spec || ''),
        eff: eff, qty: sp.qty, unit: sp.unit,
        per: (sp.qty && sp.qty > 0) ? eff / (sp.qty * need) : null
      });
    }

    if (!rows.length) {
      return {
        ok: false, item: item, rows: [], mode: 'empty', comparable: false,
        headline: '这几条里没读到有效价格——按「平台 + 价格 + 规格」给我，例如：淘宝 89 包邮 10000mAh。',
        sublines: [], warnings: skipped, skipped: skipped, timing: null, budget: null
      };
    }

    /* ---- 可比性判定：先找最大可比子集（单位相同的条目才能放一起比） ---- */
    var groups = {}, j;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.qty && r.unit) {
        if (!groups[r.unit]) { groups[r.unit] = []; }
        groups[r.unit].push(r);
      }
    }
    var mainGroup = [], mainUnit = null;
    for (var u in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, u)) { continue; }
      if (groups[u].length > mainGroup.length) { mainGroup = groups[u]; mainUnit = u; }
    }
    var covered = (mainGroup.length === rows.length && mainGroup.length > 0);
    var qtyKeys = {};
    for (j = 0; j < mainGroup.length; j++) { qtyKeys[Math.round(mainGroup[j].qty * 100)] = true; }
    var sameQty = covered && Object.keys(qtyKeys).length === 1;
    // 「需买N件」不一致时不能比整单总价：京东 99 元需买 2 件，整单 198 元，
    // 直接跟单件 89 元比会得出"贵 109 元"的假结论 —— 必须切到单价口径。
    var needKeys = {};
    for (j = 0; j < mainGroup.length; j++) { needKeys[mainGroup[j].needQty] = true; }
    var sameNeed = covered && Object.keys(needKeys).length === 1;

    var mode;
    if (rows.length === 1) { mode = 'single'; }
    else if (mainGroup.length >= 2 && covered && sameQty && sameNeed) { mode = 'total'; }
    else if (mainGroup.length >= 2 && covered) { mode = 'unit'; }
    else if (mainGroup.length >= 2) { mode = 'partial'; }
    else if (mainGroup.length === 0) { mode = 'total_nospec'; }
    else { mode = 'mixed'; }

    rows.sort(function (a, b) {
      if (mode === 'unit' || mode === 'partial') {
        var pa = a.per === null ? Infinity : a.per;
        var pb = b.per === null ? Infinity : b.per;
        if (pa !== pb) { return pa - pb; }
      }
      return a.eff - b.eff;
    });

    var best = rows[0], worst = rows[rows.length - 1];
    var save = worst.eff - best.eff;
    var multi = rows.length >= 2 && save > 0.005;

    function tag(r) {
      return '[' + r.platform + ']' + (r.title ? ' ' + r.title : '');
    }
    function perUnit(r) { return perLabel(r); }

    var headline = '', sublines = [], warnings = [];
    if (mode === 'unit') {
      var cands = mainGroup.slice().sort(function (a, b) { return a.per - b.per; });
      headline = '按折合单价，' + tag(cands[0]) + ' 最划算：' + perUnit(cands[0]) +
        '；最贵的是 [' + cands[cands.length - 1].platform + '] ' + perUnit(cands[cands.length - 1]) + '。';
      sublines.push('各家规格数量不一样，只比总价会看错——总价最低的那家单价未必最低。');
      best = cands[0];
    } else if (mode === 'partial') {
      var mainCands = mainGroup.slice().sort(function (a, b) { return a.per - b.per; });
      headline = '能对上的 ' + mainGroup.length + ' 条（都是「' + mainUnit + '」）里，' +
        tag(mainCands[0]) + ' 最划算：' + perUnit(mainCands[0]) + '。';
      var others = rows.filter(function (r) { return mainGroup.indexOf(r) === -1; });
      sublines.push('另有 ' + others.length + ' 条规格不同或没写（' +
        others.map(function (r) { return '[' + r.platform + ']'; }).join('、') +
        '），没法放进来一起比——补上规格我再算。');
      best = mainCands[0];
    } else if (mode === 'mixed') {
      headline = '这几条规格口径对不上（有的是「包」、有的是「提/瓶/克」，或者根本没写规格），没法直接说谁更便宜。';
      sublines.push('把规格对齐再看：要么都比「每包多少钱」，要么都按同一件数比总价。');
    } else if (mode === 'total_nospec') {
      headline = tag(best) + ' 到手价最低 ' + fmt(best.eff) + ' 元' +
        (multi ? '，比最贵的 [' + worst.platform + '] 省 ' + fmt(save) + ' 元' : '') + '。';
      sublines.push('你没给规格（多少包 / 多少 ml），如果各家规格不一样，这个总价差没意义——补上规格我按单价重算。');
    } else if (multi) {
      headline = tag(best) + ' 到手价最低 ' + fmt(best.eff) + ' 元，比最贵的 [' + worst.platform + '] 省 ' + fmt(save) + ' 元。';
    } else if (rows.length >= 2) {
      headline = '各家到手价基本持平（差不到 5 分钱），按运费、售后、发货地选即可。';
    } else {
      headline = '只收到 1 条报价（' + tag(best) + ' 到手 ' + fmt(best.eff) + ' 元），暂时没法比出贵不贵——再给我一个平台的价格就能比。';
    }

    /* ---- 隐性成本 ---- */
    var hasShip = rows.some(function (r) { return r.ship > 0; });
    var hasFree = rows.some(function (r) { return r.ship === 0; });
    if (hasShip && hasFree) { sublines.push('有的包邮有的要运费——运费算进来才是到手价（上面已算）。'); }
    if (rows.length >= 2 && save <= 3) { sublines.push('价差不到 3 块，这种情况优先选运费险 / 七天无理由 / 旗舰店，退货成本比差价重要。'); }
    if (rows.some(function (r) { return r.coupon > 0; })) { sublines.push('券有门槛和有效期；跨店满减要凑单的话，别为了凑单买用不上的东西。'); }
    if (rows.some(function (r) { return r.needQty > 1; })) { sublines.push('有的平台要一次买够 N 件才给这个价（明细里标了「需买N件」）——囤不了那么多，它的单价可能不如看着便宜。'); }

    /* ---- 预警：按"当前口径"的中位数找异常，避免拿 12 包的价格去比 24 包的中位价 ---- */
    var usePer = (mode === 'unit' || mode === 'partial');
    var pool = [];
    (usePer ? mainGroup : rows).forEach(function (r) {
      var v = usePer ? r.per : r.eff;
      if (v !== null && v !== undefined && isFinite(v) && v > 0) { pool.push(v); }
    });
    pool.sort(function (a, b) { return a - b; });
    var med = 0;
    if (pool.length >= 3) {
      med = pool.length % 2 ? pool[(pool.length - 1) / 2] : (pool[pool.length / 2 - 1] + pool[pool.length / 2]) / 2;
    }
    rows.forEach(function (r) {
      var v = usePer ? r.per : r.eff;
      var shown = usePer ? perLabel(r) : fmt(r.eff) + ' 元';
      if (med > 0 && v !== null && v < 0.5 * med) {
        warnings.push('[' + r.platform + '] ' + shown + ' 明显低于同口径中位价——可能规格不同 / 临期 / 二手 / 仿品，下单前核对店铺资质与规格。');
      } else if (med > 0 && v !== null && v > 1.6 * med) {
        warnings.push('[' + r.platform + '] ' + shown + ' 明显高于同口径中位价，没有品牌 / 售后优势可以放弃。');
      }
      if (r.coupon > 0 && r.coupon >= r.price * r.needQty + r.ship) {
        warnings.push('[' + r.platform + '] 券额 ≥ 应付款，数据异常，请核对活动真实性。');
      }
    });
    if (mode === 'mixed') { warnings.push('本次规格口径不一致，上面的排序只能参考，不能当作「谁更便宜」的依据。'); }

    /* ---- 预算判断 ---- */
    var budget = toNum(opts.budget, null);
    var budgetInfo = null;
    if (budget && budget > 0) {
      var cost = (mode === 'unit' || mode === 'partial') ? best.eff : best.eff;
      if (cost <= budget) {
        budgetInfo = { budget: budget, diff: round2(budget - cost), ok: true,
          text: '最低到手 ' + fmt(cost) + ' 元，比你的预算 ' + fmt(budget) + ' 元还低 ' + fmt(budget - cost) + ' 元——预算内。' };
      } else {
        budgetInfo = { budget: budget, diff: round2(cost - budget), ok: false,
          text: '最低到手 ' + fmt(cost) + ' 元，超预算 ' + fmt(cost - budget) + ' 元——要么降规格，要么等大促。' };
      }
    }

    /* ---- 时机 ---- */
    var timing = timingAdvice(best.eff, today);

    /* ---- 价格带参考 ---- */
    var bandInfo = judgePrice(item, best.eff);

    return {
      ok: true,
      item: item,
      rows: rows,
      mode: mode,
      comparable: mode !== 'mixed',
      best: best,
      worst: worst,
      save: round2(save),
      headline: headline,
      sublines: sublines,
      warnings: warnings,
      skipped: skipped,
      budget: budgetInfo,
      timing: timing,
      band: bandInfo
    };
  }

  /* ================================================================== */
  /* 七、真实商家日历 CSV（日期由代码算，不是手写）                        */
  /* ================================================================== */

  function csvCell(v) {
    var s = String(v === undefined || v === null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** 生成未来 days 天的商家日历 CSV 文本（带 BOM，Excel 打开不乱码） */
  function calendarCsv(from, days) {
    var start = toDate(from || new Date());
    var total = days || 56;
    var rows = [['日期', '星期', '活动类型', '商家/平台', '地点', '活动名称', '怎么用', '教练建议', '核实渠道']];
    rows.push(['（生成时间）', dateKey(start), '代码计算', '—', '—', '未来 ' + total + ' 天', '常驻活动只在首日列一次', '—', '本地日历算法']);

    var alwaysList = alwaysDeals();
    var first = true;
    for (var i = 0; i < total; i++) {
      var d = addDays(start, i);
      var list = dealsOn(d).filter(function (x) { return x.type !== 'always'; });
      var k;
      for (k = 0; k < list.length; k++) {
        var it = list[k];
        rows.push([
          dateKey(d), weekdayCn(d),
          it.type === 'promo' ? '大促' : (it.type === 'monthly' ? '每月固定' : '每周固定'),
          it.name, it.place || '—', it.title, it.how, it.coach || '—', it.source
        ]);
      }
      if (first) {
        for (k = 0; k < alwaysList.length; k++) {
          var a = alwaysList[k];
          rows.push([dateKey(d), weekdayCn(d), '常驻（每日）', a.name, a.place || '—', a.title, a.how, a.coach || '—', a.source]);
        }
      }
      first = false;
    }
    var lines = [];
    for (var r = 0; r < rows.length; r++) {
      lines.push(rows[r].map(csvCell).join(','));
    }
    return '\ufeff' + lines.join('\r\n');
  }

  /* ================================================================== */
  /* 八、聊天卡片 HTML                                                    */
  /* ================================================================== */

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 今天有什么优惠：限时活动 + 最近三场 + 大促倒计时 */
  function todayCardHtml(date) {
    var d = toDate(date || new Date());
    var list = dealsOn(d);
    var limited = list.filter(function (x) { return x.type !== 'always'; });
    var always = list.filter(function (x) { return x.type === 'always'; });
    var np = nextPromo(d);

    var html = '<div class="deals-card">';
    html += '<div class="deals-card-head"><b>' + dlIcon('radar') + '省钱雷达</b><span>' + dateKey(d) + ' ' + weekdayCn(d) + '</span></div>';

    if (np) {
      html += '<div class="deals-promo">' +
        '<span>' + esc(np.promo.name) + (np.days === 0 ? ' 就是今天' : ' 还有 ' + np.days + ' 天') + '</span>' +
        '<small>' + esc(np.promo.depth) + ' · 适合：' + esc(np.promo.bestFor) + '</small>' +
        '</div>';
    }

    if (limited.length) {
      html += '<div class="deals-sec">今天的限时活动</div>';
      limited.forEach(function (it) {
        html += '<div class="deals-item">' +
          '<div class="di-top"><span class="di-emoji">' + itemIcon(it) + '</span>' +
          '<b>' + esc(it.name) + ' · ' + esc(it.title) + '</b>' +
          '<span class="di-tag">' + esc(it.tag) + '</span></div>' +
          '<p>' + esc(it.what) + '</p>' +
          '<p class="di-how">👉 ' + esc(it.how) + '</p>' +
          '<p class="di-tip">⚠ ' + esc(it.tip) + '</p>' +
          '</div>';
      });
    } else {
      html += '<div class="deals-empty">今天没有固定的限时活动（肯德基疯狂星期四在周四、必胜客在周三）。要去的话，我帮你查下一次是哪天。</div>';
    }

    if (always.length) {
      html += '<div class="deals-sec">常驻优惠（不用等）</div><div class="deals-always">';
      always.slice(0, 5).forEach(function (it) {
        html += '<span class="deals-pill">' + itemIcon(it) + ' ' + esc(it.name) + '·' + esc(it.title) + '</span>';
      });
      html += '</div>';
    }

    html += '<div class="deals-actions">' +
      '<button type="button" class="btn-mini primary" data-deal-act="open-today">看 14 天日历</button>' +
      '<button type="button" class="btn-mini" data-deal-act="open-compare">比一比价格</button>' +
      '</div>';
    html += '<p class="deals-note">活动日期由本地日历按周/按月算出，真实有效；具体单品、价格与参与门店以官方页面为准，我不编价格。</p>';
    html += '</div>';
    return html;
  }

  /** 疯狂星期四专项卡片 */
  function kfcCardHtml(date) {
    var d = toDate(date || new Date());
    var next = nextOf('kfc', d);
    var isToday = isoWeekday(d) === 4;
    var delta = daysBetween(d, next);
    var html = '<div class="deals-card">';
    html += '<div class="deals-card-head"><b>' + dlIcon('cat-food') + '疯狂星期四</b><span>' + dateKey(d) + ' ' + weekdayCn(d) + '</span></div>';
    if (isToday) {
      html += '<p class="deals-hl">今天就是周四——想吃就今天去，别拖到明天。</p>';
    } else {
      html += '<p class="deals-hl">今天是' + weekdayCn(d) + '，最近一次是 <b>' + dateKey(next) + '（' + weekdayCn(next) +
        '）</b>，还有 ' + delta + ' 天。</p>';
    }
    html += '<p>规律很硬：<b>每周四</b>，不需要联网也不会记错日期。但要吃对，注意三件事：</p>' +
      '<ul class="deals-ul">' +
      '<li>当天在 App / 小程序「疯狂星期四」专区看<b>当日单品</b>，每周不一样；</li>' +
      '<li>热门单品中午就卖完，晚上去经常只剩冷门款；</li>' +
      '<li>先领券再下单，外卖价和堂食价不同，别拿外卖价当堂食价。</li>' +
      '</ul>' +
      '<p class="deals-note">具体单品与价格以肯德基官方页面为准；本卡片只负责把日子算准，不编价格。</p>' +
      '<div class="deals-actions">' +
      '<button type="button" class="btn-mini primary" data-deal-act="open-calendar">看未来 14 天</button>' +
      '</div></div>';
    return html;
  }

  /** 比价引导卡：只给价格带 + 明确还差什么，不编价格 */
  function compareIntroHtml(item, budget, date) {
    var band = findBand(item);
    var t = timingAdvice(budget || 0, date);
    var html = '<div class="deals-card">';
    html += '<div class="deals-card-head"><b>' + dlIcon('scale') + '比价 · ' + esc(item || '这个商品') + '</b><span>' + dateKey(date || new Date()) + '</span></div>';
    if (band) {
      html += '<p class="deals-hl">「' + esc(band.name) + '」主流价格带：入门 ' + band.low[0] + '-' + band.low[1] +
        ' 元 / 中档 ' + band.mid[0] + '-' + band.mid[1] + ' 元 / 高档 ' + band.high[0] + '-' + band.high[1] + ' 元。</p>';
      html += '<p>这类东西通常 <b>' + esc(band.channel) + '</b> 更便宜，同款跨平台能差 20%-40%。</p>';
    } else {
      html += '<p class="deals-hl">这个品类我没有价格带参考，但不影响比价——只要你把三家的价给我，我照样能算到手价和单价。</p>';
    }
    if (budget) {
      var j = judgePrice(item, budget);
      html += '<p>你的预算 <b>' + fmt(budget) + ' 元</b>' + (j ? '落在「' + j.label + '」档：' + esc(j.text) : '') + '。</p>';
    }
    html += '<p class="deals-note">我这边不抓电商实时价（会过期、也不合规），所以下一步要你帮一把：把看到的价按「平台 + 价格 + 规格」发我，' +
      '例如「淘宝 89 包邮 10000mAh / 拼多多 79 / 京东 99 需买 2 件」，我立刻算到手价、折单价、排最便宜的。</p>';
    html += '<div class="deals-actions">' +
      '<button type="button" class="btn-mini primary" data-deal-act="open-compare">打开比价计算器</button>' +
      '<button type="button" class="btn-mini" data-deal-act="open-today">今天有什么优惠</button>' +
      '</div>';
    if (t && t.days !== null) {
      html += '<p class="deals-timing">⏰ ' + esc(t.text) + '</p>';
    }
    html += '</div>';
    return html;
  }

  /* ================================================================== */
  /* 导出                                                                */
  /* ================================================================== */

  var API = {
    VERSION: '1.0.0',
    MERCHANTS: MERCHANTS,
    PROMOS: PROMOS,
    BANDS: BANDS,
    /* 日期 */
    toDate: toDate, dateKey: dateKey, addDays: addDays, daysBetween: daysBetween,
    isoWeekday: isoWeekday, weekdayCn: weekdayCn,
    /* 活动 */
    dealsOn: dealsOn, upcoming: upcoming, alwaysDeals: alwaysDeals,
    nextOf: nextOf, nextPromo: nextPromo, merchantById: merchantById,
    /* 价格 */
    findBand: findBand, judgePrice: judgePrice, timingAdvice: timingAdvice,
    compareOffers: compareOffers, parseSpec: parseSpec, parseNeed: parseNeed,
    toNum: toNum, fmt: fmt, perLabel: perLabel,
    /* 导出与卡片 */
    calendarCsv: calendarCsv,
    todayCardHtml: todayCardHtml, kfcCardHtml: kfcCardHtml, compareIntroHtml: compareIntroHtml
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.deals = API;
  }
})(typeof window !== 'undefined' ? window : this);
