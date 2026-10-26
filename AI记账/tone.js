/**
 * tone.js — 说话风格表（温柔学姐 / 铁面教练 / 理性分析官）+ 占位替换，UMD
 *
 * 定位：只放「一句话 + 占位符」的文案表，**不含任何成品逻辑、不碰存储**。
 *   ① 本轮新增功能（心愿单 / 诊断卡 / 期末预测）的句子全部从这里出，
 *      业务模块只产事实（金额、天数、占比），换语气零成本；
 *   ② 既有文案（coach.js、欢迎语、账单分析报告）一个字都不进来，
 *      避免动到老功能的断言；
 *   ③ 未知 key 一律回落温柔学姐，再回落空串 —— 调用方拿到空串就当「这句不显示」，
 *      不会因为少一条文案把整张卡片弄坏。
 *
 * 对外 API（window.AJ.tone）：
 *   TONES         [{key,name,desc}] 三种语气（顺序即设置页展示顺序）
 *   DEFAULT_TONE  'gentle'
 *   normalize(k)  未知值回落 'gentle'
 *   set(k)        切换当前语气（越界自动回落）
 *   get()         当前语气 key
 *   t(key, vars)  取文案并替换 {占位符}；查不到返回 ''
 *   has(key)      是否存在该 key（任意语气命中即 true）
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);

  var DEFAULT_TONE = 'gentle';

  /** 三种语气的元信息：设置页三张卡片直接用它渲染，不另写一份 */
  var TONES = [
    { key: 'gentle', name: '温柔学姐', desc: '先接住情绪，再给建议' },
    { key: 'strict', name: '铁面教练', desc: '不哄你，只说问题' },
    { key: 'rational', name: '理性分析官', desc: '只讲数据和结论' }
  ];

  /**
   * 文案表：TABLE[语气][key] = '带 {占位符} 的一句话'。
   * key 只有本轮新增功能在用；写死的 17 条与设计文档 §3.1 一一对应。
   */
  var TABLE = {
    gentle: {
      'cool.added': '好，{title} 先放进心愿单，48 小时后我们再聊。',
      'cool.due': '{title} 的冷静期到了，还想买吗？',
      'cool.bought': '想清楚就好，{amount} 已记上啦。',
      'cool.dropped': '真棒！放下的 {amount} 会留在你兜里。',
      'cool.extend': '再给自己 {days} 天，想清楚更划算。',
      'cool.saved': '因为冷静期，你已经省下 {amount} 了。',
      'diag.dailyOver': '有 {days} 天单日花超了，最多的一天 {amount}。',
      'diag.catBudget': '{cat} 这个分类有点超了，已经 {amount}。',
      'diag.wantRatio': '非必需消费占了 {ratio}，一共 {amount}。',
      'diag.cycleUp': '比上个周期多花了 {growth}，这周期 {amount}。',
      'diag.smallFreq': '{count} 笔小额加起来 {amount}，其实是它最贵。',
      'diag.empty': '这周期没什么明显问题，保持就好。',
      'forecast.over': '照这个节奏，期末会超 {amount}，缓一缓。',
      'forecast.safe': '照现在这样，期末还能剩 {amount}。',
      'worth.recap': '这笔「{title}」还值吗？',
      'worth.thanks': '记下了，你对钱越来越有感觉了。',
      'hint.proactive': '我看了下这个周期的账，有 {n} 个地方想跟你聊聊。'
    },
    strict: {
      'cool.added': '{title} 已入清单，48 小时内不许下单。',
      'cool.due': '{title} 冷静期结束，给个结论。',
      'cool.bought': '行，买了就买了，{amount} 已入账。',
      'cool.dropped': '顶住了，{amount} 保住了。',
      'cool.extend': '只准再延一次，{days} 天后必须决定。',
      'cool.saved': '冷静期替你拦下 {amount}，继续。',
      'diag.dailyOver': '{days} 天超标，手太松了。',
      'diag.catBudget': '{cat} 又超了，{amount}，先停一停。',
      'diag.wantRatio': '{ratio} 花在「想要」上，收一收。',
      'diag.cycleUp': '涨了 {growth}，钱花快了。',
      'diag.smallFreq': '{count} 笔小钱，{amount}，全是漏。',
      'diag.empty': '没毛病，继续盯住。',
      'forecast.over': '会超 {amount}，现在不改就来不及。',
      'forecast.safe': '还剩 {amount}，别乱花。',
      'worth.recap': '「{title}」到底值不值，给个说法。',
      'worth.thanks': '行，评价收到。',
      'hint.proactive': '别装看不见，{n} 个问题。'
    },
    rational: {
      'cool.added': '已为「{title}」设置 48 小时冷静观察期。',
      'cool.due': '「{title}」观察期已结束，请做决策。',
      'cool.bought': '已按决策记账：{title}，金额 {amount}。',
      'cool.dropped': '「{title}」判定为放弃，节省 {amount}。',
      'cool.extend': '观察期延长 {days} 天，累计延长次数已记录。',
      'cool.saved': '冷静期累计节省金额：{amount}。',
      'diag.dailyOver': '单日超阈值天数 {days}，峰值 {amount}。',
      'diag.catBudget': '{cat} 分类支出 {amount}，已越预算上限。',
      'diag.wantRatio': '非必需分类占比 {ratio}，金额 {amount}。',
      'diag.cycleUp': '环比上一周期上升 {growth}，当前 {amount}。',
      'diag.smallFreq': '小额高频 {count} 笔，合计 {amount}。',
      'diag.empty': '本周期未触发任何诊断规则。',
      'forecast.over': '期末预测超支 {amount}。',
      'forecast.safe': '期末预测结余 {amount}。',
      'worth.recap': '请评估「{title}」的价值。',
      'worth.thanks': '评价已保存。',
      'hint.proactive': '本周期检测到 {n} 条消费异常，是否查看？'
    }
  };

  /** 当前语气（仅内存；权威值在 state.settings.tone，由 app.js 每次渲染前 set） */
  var current = DEFAULT_TONE;

  /** 语气校验：只认三种，其余一律回落默认 */
  function normalize(key) {
    if (key === 'strict' || key === 'rational' || key === 'gentle') { return key; }
    return DEFAULT_TONE;
  }

  function set(key) {
    current = normalize(key);
    return current;
  }

  function get() { return current; }

  function has(key) {
    if (typeof key !== 'string' || !key) { return false; }
    return Object.prototype.hasOwnProperty.call(TABLE[current], key) ||
      Object.prototype.hasOwnProperty.call(TABLE[DEFAULT_TONE], key);
  }

  /**
   * 取文案并替换占位符。
   * @param {string} key 文案 key（如 'cool.added'）
   * @param {Object} [vars] 占位符表，如 {title:'降噪耳机'}
   * @return {string} 命中的句子；当前语气缺这条时回落温柔学姐；都没有返回 ''
   */
  function t(key, vars) {
    if (typeof key !== 'string' || !key) { return ''; }
    var text = '';
    if (Object.prototype.hasOwnProperty.call(TABLE[current], key)) {
      text = TABLE[current][key];
    } else if (Object.prototype.hasOwnProperty.call(TABLE[DEFAULT_TONE], key)) {
      text = TABLE[DEFAULT_TONE][key];
    }
    if (!text) { return ''; }
    var v = vars || {};
    // 纯字符串替换，不用 eval / new Function：文案表是静态的，占位符只会是简单词
    return text.replace(/\{(\w+)\}/g, function (m, name) {
      if (v[name] === null || v[name] === undefined) { return ''; }
      return String(v[name]);
    });
  }

  var API = {
    TONES: TONES,
    DEFAULT_TONE: DEFAULT_TONE,
    normalize: normalize,
    set: set,
    get: get,
    t: t,
    has: has
  };

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.tone = API;
  }
})(typeof window !== 'undefined' ? window : this);
