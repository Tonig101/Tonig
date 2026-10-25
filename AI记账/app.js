/**
 * app.js — UI 状态、渲染、事件、持久化、CSV 导出
 *
 * 依赖（按 index.html 中的加载顺序）：
 *   data.js  -> window.AJ.data
 *   nlp.js   -> window.AJ.nlp
 *   engine.js-> window.AJ.engine
 *   coach.js -> window.AJ.coach（理财专家模式）
 */
(function (global) {
  'use strict';

  var DOC = global.document;
  var DATA = global.AJ.data;
  var NLP = global.AJ.nlp;
  var ENG = global.AJ.engine;
  var ANA = global.AJ.analysis;
  var OCR = global.AJ.ocr;
  var COACH = global.AJ.coach;
  var DEALS = global.AJ.deals;
  var SAV = global.AJ.savings;

  /* 让 ocr.js 的云端识别走 WorkBuddy 云服务（视觉大模型），而非本地 detectCloud（浏览器直连腾讯云）。
     由 server.py 托管页面时 AJ_BACKEND_OCR 为真，ocr.js 的 detectBackend 会改调云服务。 */
  global.AJ_BACKEND_OCR = true;

  /* 「理财课」聊天卡片最多直接列几条资源：2 个视频 + 1 门课程，正好 3 条，
     再多会把聊天气泡撑得过长，其余统一引导到理财学院看。
     learningResources() 已固定 video → course → up 排序，所以这 3 条永远是
     视频 / 课程，UP 主主页只出现在理财学院与看板卡里。 */
  var LEARN_INLINE_MAX = 3;

  /* WorkBuddy 云服务客户端与能力（由 initCloud() 异步填充）。免密钥，无需任何外部 Key。 */
  var cloudClient = null;        // WorkBuddyCloud 客户端实例
  var cloudModels = [];          // 模型列表
  var cloudChatModel = null;     // 对话用模型
  var cloudVisionModel = null;   // 截图识别（视觉）用模型
  var cloudReady = false;        // SDK 已初始化且已取到模型
  var visionAvailable = false;   // 是否存在标记支持图片输入的模型

  /* 截图识别是否可尝试：云端已连上即可尝试（模型不支持看图时调用会优雅失败并提示手动录入） */
  function cloudOcrAvailable() { return cloudReady; }

  /* 本应用的线上版本地址（云服务认可的来源，AI 功能必须用它打开）。来源 publicConfig.endpoint。 */
  var CLOUD_APP_URL = 'https://ai-expense-tracker-91800.app.workbuddy.host/?sharecode=YKQPM3GMYK';

  /** 把模型可能带回的 ```json 围栏 / 前后缀剥掉，尽量解析成对象；失败返回 null */
  function parseCloudJson(s) {
    if (!s) { return null; }
    var t = String(s).trim();
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) { t = fence[1].trim(); }
    var a = t.indexOf('{'); var b = t.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) { t = t.slice(a, b + 1); }
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  /**
   * 调用 WorkBuddy 云服务对话模型：把用户消息 + 精简上下文发给大模型，
   * 以流式方式收集返回的 JSON（{reply, actions}），解析后回传。
   * 任何失败都返回 {fallback:true}，上层据此回退到本地 routeCommand。
   * @param {string} messageText
   * @param {Object|null} context
   * @return {Promise<{reply:?string, actions:Array, fallback:boolean, reason:string}>}
   */
  function cloudAsk(messageText, context) {
    return new Promise(function (resolve) {
      if (!cloudReady || !cloudChatModel || !cloudClient) {
        resolve({ reply: null, actions: [], fallback: true, reason: '云服务未就绪' });
        return;
      }
      var system = '你是"账小助"，一个面向大学生的校园记账 AI 助手。帮用户一句话记账、查余额、' +
        '看消费分析、定攒钱目标。用简洁、口语化、带一点鼓励的中文回复。' +
        '若用户给了消费信息，在 actions 里返回 add_bill；若用户想看余额/饼图/记收入/截屏记账/' +
        '账单分析/攒钱目标/设置预算，在 actions 里返回对应 command。' +
        '只返回一个 JSON 对象、不要其它文字：' +
        '{"reply":"<中文回复>","actions":[' +
        '{"type":"add_bill","amount":<number>,"category":<"餐饮"|"交通"|"购物"|"娱乐"|"学习"|"居住"|"医疗"|"社交"|"其他">,"note":<string>,"date":<"YYYY-MM-DD"|null>,"motivation":<"刚需"|"情绪">,"want":<bool>},' +
        '{"type":"command","name":<"balance"|"pie"|"income"|"ocr"|"analysis"|"goals"|"settings">}]}';
      var userContent = String(messageText || '');
      if (context && typeof context === 'object') {
        userContent = '【用户当前情况】\n' + JSON.stringify(context) + '\n\n【用户消息】\n' + userContent;
      }
      var messages = [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ];
      var full = '';
      var done = false;
      var timeoutTimer = setTimeout(function () {
        if (done) { return; }
        done = true;
        resolve({ reply: null, actions: [], fallback: true, reason: '云服务响应超时' });
      }, 10000);
      function finish() {
        if (done) { return; }
        done = true;
        clearTimeout(timeoutTimer);
        var parsed = parseCloudJson(full);
        if (!parsed) {
          resolve({ reply: full || null, actions: [], fallback: false, reason: '' });
          return;
        }
        resolve({
          reply: parsed.reply || null,
          actions: Array.isArray(parsed.actions) ? parsed.actions : [],
          fallback: false,
          reason: ''
        });
      }
      try {
        var stream = cloudClient.llm.chat.completions.create({
          model: cloudChatModel.id,
          messages: messages,
          stream: true,
          response_format: { type: 'json_object' }
        });
        (async function () {
          try {
            for await (var chunk of stream) {
              var c = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
              if (c) { full += c; }
            }
            finish();
          } catch (e) {
            resolve({ reply: null, actions: [], fallback: true, reason: '云服务返回异常：' + (e && e.message ? e.message : e) });
          }
        })();
      } catch (e) {
        resolve({ reply: null, actions: [], fallback: true, reason: '云服务调用失败：' + (e && e.message ? e.message : e) });
      }
    });
  }

  /**
   * 调用 WorkBuddy 云服务视觉模型，把截图原样转录成文字。
   * 返回与 ocr.js detectBackend 一致的结构 {ok, source, text, reason}。
   * @param {string} dataUrl 'data:image/png;base64,...'
   * @return {Promise<{ok:boolean, source:string, text:string, reason:string}>}
   */
  function cloudVisionOcr(dataUrl) {
    return new Promise(function (resolve) {
      if (!cloudReady || !cloudClient) {
        resolve({ ok: false, source: 'cloud', text: '', reason: 'WorkBuddy 云服务未连接（请用线上版本打开本应用：' + CLOUD_APP_URL + '）' });
        return;
      }
      var model = cloudVisionModel || cloudChatModel;
      if (!model) {
        resolve({ ok: false, source: 'cloud', text: '', reason: '没有可用的视觉模型' });
        return;
      }
      var system = '你是一个票据/截图文字识别助手。只把图片里的文字原样转录出来，' +
        '按阅读顺序逐行输出，不要解释、不要翻译、不要编造。如果图片里没有任何文字，就只回复"无文字"。';
      var messages = [
        { role: 'system', content: system },
        { role: 'user', content: [
          { type: 'text', text: '请识别这张截图里的全部文字：' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ] }
      ];
      var full = '';
      var done = false;
      function finish() {
        if (done) { return; }
        done = true;
        var text = full.trim();
        if (!text || text === '无文字') {
          resolve({ ok: false, source: 'cloud', text: '', reason: '云端没有识别到文字' });
          return;
        }
        resolve({ ok: true, source: 'cloud', text: text, reason: '' });
      }
      try {
        var stream = cloudClient.llm.chat.completions.create({
          model: model.id,
          messages: messages,
          stream: true
        });
        (async function () {
          try {
            for await (var chunk of stream) {
              var c = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
              if (c) { full += c; }
            }
            finish();
          } catch (e) {
            resolve({ ok: false, source: 'cloud', text: '', reason: '云端识别失败：' + (e && e.message ? e.message : e) });
          }
        })();
      } catch (e) {
        resolve({ ok: false, source: 'cloud', text: '', reason: '云端识别调用失败：' + (e && e.message ? e.message : e) });
      }
    });
  }

  /** 初始化 WorkBuddy 云服务客户端并拉取模型列表，确定对话/视觉模型。 */
  function initCloud() {
    if (typeof window.WorkBuddyCloud === 'undefined' || !window.AJ_CLOUD_CONFIG) {
      cloudReady = false;
      return;
    }
    try {
      cloudClient = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: window.AJ_CLOUD_CONFIG.endpoint,
        oauthRelayBaseUrl: window.AJ_CLOUD_CONFIG.oauthRelayBaseUrl,
        publishableKey: window.AJ_CLOUD_CONFIG.publishableKey
      });
    } catch (e) {
      cloudClient = null;
      cloudReady = false;
      return;
    }
    /* 把接口挂到全局，供 ocr.js 的 detectBackend 调用 */
    if (global.AJ && typeof global.AJ === 'object') {
      global.AJ.ask = cloudAsk;
      global.AJ.visionOcr = cloudVisionOcr;
    }
    loadCloudModels();
  }

  /** 拉取模型列表：选第一个启用模型做对话，选第一个支持图片的模型做截图识别。 */
  function loadCloudModels() {
    if (!cloudClient) { return; }
    cloudClient.llm.models.list().then(function (list) {
      cloudModels = Array.isArray(list) ? list : [];
      var enabled = cloudModels.filter(function (m) { return m.disabled !== true; });
      cloudChatModel = enabled[0] || null;
      cloudVisionModel = enabled.filter(function (m) { return m.supportsImages === true; })[0] || null;
      cloudReady = !!cloudChatModel;
      visionAvailable = !!cloudVisionModel;
      if ($('ocrMask') && !$('ocrMask').hidden) {
        $('ocrStatus').className = ocrCapabilityClass();
        $('ocrStatus').textContent = ocrCapabilityText();
      }
    }).catch(function () {
      cloudReady = false;
      visionAvailable = false;
    });
  }

  var STORAGE_KEY = DATA.STORAGE_KEY;
  var RING_R = 58;
  var RING_C = 2 * Math.PI * RING_R;

  var storageOK = true;
  var state = null;
  var highlightCategory = null;
  var flow = { queue: [], committed: [] };
  var pendingBill = null;
  /** 撤回栈：按记账顺序记录每笔账单 id（仅内存，不持久化）。供「撤回上一步」使用 */
  var undoStack = [];
  /** 轻量视图历史：记录进入子视图（专家/目标/看板）前的视图（仅内存，不持久化）。供「返回」按钮使用 */
  var viewHistory = [];
  /** 双 UI 视图集：完整版四视图 / 简洁版八屏（含 AI 对话记账屏 sai、省钱屏 ssave） */
  var FULL_VIEWS = { chat: 1, dash: 1, goals: 1, coach: 1 };
  var SIMPLE_VIEWS = { shome: 1, slist: 1, sbudget: 1, sprofile: 1, sai: 1, scoach: 1, sgoals: 1, ssave: 1 };

  /** 账单分析：最近一次导入的原始结果（默认不写入账本） */
  var analysisData = null;
  /** 分析模式：'current' 直接分析当前账本；'imported' 分析导入的 CSV */
  var analysisMode = 'current';

  /** 截屏记账：当前图片 dataURL / 当前待确认结果 */
  var ocrImageDataUrl = '';
  var ocrDraft = null;

  /* ================================================================== */
  /* 通用工具                                                            */
  /* ================================================================== */

  function $(id) {
    return DOC.getElementById(id);
  }

  function esc(text) {
    return String(text === undefined || text === null ? '' : text).replace(/[&<>"']/g, function (c) {
      if (c === '&') { return '&amp;'; }
      if (c === '<') { return '&lt;'; }
      if (c === '>') { return '&gt;'; }
      if (c === '"') { return '&quot;'; }
      return '&#39;';
    });
  }

  function money(n) {
    return ENG.fmtMoney(n);
  }

  function nowHM() {
    var d = new Date();
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
  }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 100000).toString(36);
  }

  function clampNumber(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) { return fallback; }
    if (n < min) { return min; }
    if (n > max) { return max; }
    return n;
  }

  function categoryColor(key) {
    return DATA.getCategoryColor(key);
  }

  /* ================================================================== */
  /* 持久化                                                              */
  /* ================================================================== */

  function normalizeBill(b) {
    if (!b || typeof b !== 'object') { return null; }
    var amount = Number(b.amount);
    if (!isFinite(amount) || amount <= 0) { return null; }
    var isIncome = b.type === 'income';
    var category;
    if (isIncome) {
      category = DATA.INCOME_CATEGORY;
    } else {
      category = (b.category && DATA.CATEGORY_KEYS.indexOf(b.category) !== -1) ? b.category : '其他';
    }
    var date = (typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) ? b.date : ENG.formatDate(new Date());
    return {
      id: b.id ? String(b.id) : uid('b'),
      date: date,
      amount: ENG.round2(amount),
      category: category,
      note: b.note ? String(b.note) : category,
      motivation: b.motivation === '情绪' ? '情绪' : '刚需',
      want: !!b.want,
      type: isIncome ? 'income' : 'expense',
      source: isIncome ? String(b.source || '') : '',
      askedCycle: !!b.askedCycle,
      imported: !!b.imported,
      worth: (b.worth === 'worth' || b.worth === 'mid' || b.worth === 'waste') ? b.worth : '',
      createdAt: isFinite(Number(b.createdAt)) ? Number(b.createdAt) : Date.now()
    };
  }

  function normalizeGoal(g) {
    if (!g || typeof g !== 'object') { return null; }
    var target = Number(g.target);
    if (!isFinite(target) || target <= 0) { return null; }
    var saved = Number(g.saved);
    return {
      id: g.id ? String(g.id) : uid('goal'),
      name: g.name ? String(g.name) : '未命名目标',
      target: ENG.round2(target),
      saved: isFinite(saved) && saved >= 0 ? ENG.round2(saved) : 0,
      deadline: (typeof g.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(g.deadline)) ? g.deadline : ''
    };
  }

  /**
   * 设置项归一化：任何一项缺失或非法都回退到默认值，
   * 保证旧版本存档（没有 settings 字段）读进来也能正常用。
   * @param {Object} raw 存档里的 settings 字段
   * @return {Object} 归一化后的设置对象
   */
  function normalizeSettings(raw) {
    var s = (raw && typeof raw === 'object') ? raw : {};
    var profile = (s.profile && typeof s.profile === 'object') ? s.profile : {};
    var notify = (s.notify && typeof s.notify === 'object') ? s.notify : {};
    var privacy = (s.privacy && typeof s.privacy === 'object') ? s.privacy : {};
    return {
      profile: {
        nickname: (typeof profile.nickname === 'string' && profile.nickname.trim())
          ? profile.nickname.trim().slice(0, 12) : '同学',
        avatar: (typeof profile.avatar === 'string' && profile.avatar.trim())
          ? profile.avatar.trim().slice(0, 4) : '🙂'
      },
      notify: {
        push: notify.push !== false,
        remind: notify.remind !== false,
        overspend: notify.overspend !== false
      },
      theme: (s.theme === 'light' || s.theme === 'dark') ? s.theme : 'system',
      fontScale: (s.fontScale === 'sm' || s.fontScale === 'lg' || s.fontScale === 'xl') ? s.fontScale : 'md',
      lang: s.lang === 'en' ? 'en' : 'zh',
      privacy: {
        album: privacy.album !== false,
        clipboard: privacy.clipboard !== false
      }
    };
  }

  function normalizeState(obj) {
    var s = obj || {};
    var budget = (s.budget && typeof s.budget === 'object') ? s.budget : {};
    var bills = [];
    var goals = [];
    var i;
    if (Array.isArray(s.bills)) {
      for (i = 0; i < s.bills.length; i++) {
        var nb = normalizeBill(s.bills[i]);
        if (nb) { bills.push(nb); }
      }
    }
    if (Array.isArray(s.goals)) {
      for (i = 0; i < s.goals.length; i++) {
        var ng = normalizeGoal(s.goals[i]);
        if (ng) { goals.push(ng); }
      }
    }
    return {
      bills: bills,
      budget: {
        total: clampNumber(budget.total, 0, 9999999, DATA.DEFAULT_BUDGET.total),
        payday: Math.round(clampNumber(budget.payday, 1, 28, DATA.DEFAULT_BUDGET.payday)),
        cooldownThreshold: clampNumber(budget.cooldownThreshold, 0, 9999999, DATA.DEFAULT_BUDGET.cooldownThreshold),
        cycleStart: (typeof budget.cycleStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(budget.cycleStart))
          ? budget.cycleStart : ''
      },
      goals: goals,
      savedMoney: clampNumber(s.savedMoney, 0, 99999999, 0),
      blockedCount: Math.round(clampNumber(s.blockedCount, 0, 999999, 0)),
      uiMode: (s.uiMode === 'simple') ? 'simple' : 'full',
      settings: normalizeSettings(s.settings)
    };
  }

  function seedState() {
    var today = new Date();
    var budget = {
      total: DATA.DEFAULT_BUDGET.total,
      payday: DATA.DEFAULT_BUDGET.payday,
      cooldownThreshold: DATA.DEFAULT_BUDGET.cooldownThreshold,
      cycleStart: ''
    };
    var cycle = ENG.getCycle(today, budget.payday);
    var bills = [];
    var i;

    for (i = 0; i < DATA.SEED_BILLS.length; i++) {
      var seed = DATA.SEED_BILLS[i];
      var d = new Date(today.getTime());
      d.setDate(d.getDate() - seed.offset);
      var ds = ENG.formatDate(d);
      if (ds < cycle.start) { ds = cycle.start; }
      bills.push({
        id: 'seed_b' + i,
        date: ds,
        amount: ENG.round2(seed.amount),
        category: seed.category,
        note: seed.note,
        motivation: seed.motivation,
        want: !!seed.want,
        type: 'expense',
        createdAt: d.getTime() + i * 1000
      });
    }

    var inc = DATA.SEED_INCOME;
    var di = new Date(today.getTime());
    di.setDate(di.getDate() - inc.offset);
    var dis = ENG.formatDate(di);
    if (dis < cycle.start) { dis = cycle.start; }
    bills.push({
      id: 'seed_income',
      date: dis,
      amount: ENG.round2(inc.amount),
      category: DATA.INCOME_CATEGORY,
      note: inc.note,
      motivation: inc.motivation,
      want: false,
      type: 'income',
      source: inc.source || '生活费',
      askedCycle: true,
      imported: false,
      createdAt: di.getTime() + 900000
    });

    var goals = [];
    for (i = 0; i < DATA.DEFAULT_GOALS.length; i++) {
      goals.push({
        id: DATA.DEFAULT_GOALS[i].id,
        name: DATA.DEFAULT_GOALS[i].name,
        target: DATA.DEFAULT_GOALS[i].target,
        saved: DATA.DEFAULT_GOALS[i].saved,
        deadline: DATA.DEFAULT_GOALS[i].deadline
      });
    }

    return {
      bills: bills,
      budget: budget,
      goals: goals,
      savedMoney: 0,
      blockedCount: 0,
      uiMode: 'full',
      settings: normalizeSettings(null)
    };
  }

  function loadState() {
    var raw = null;
    try {
      raw = global.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageOK = false;
      raw = null;
    }
    if (!raw) {
      state = seedState();
      saveState();
      return;
    }
    try {
      state = normalizeState(JSON.parse(raw));
    } catch (e2) {
      state = seedState();
    }
  }

  function saveState() {
    if (!storageOK) { return; }
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      storageOK = false;
      showStorageTip();
    }
  }

  function showStorageTip() {
    var tip = $('storageTip');
    if (tip) { tip.hidden = false; }
  }

  /* ------------------------------------------------------------------ */
  /* 省钱图谱的打卡记录：独立存储键，绝不混进主账本                         */
  /* ------------------------------------------------------------------ */

  /**
   * 为什么要单独一个键（而不是塞进 state）：
   *   ① state 一动 normalizeState() 就要重跑全套账本回归，风险大；
   *   ② 省钱记录损坏时只应重置自己，不能让用户丢掉真实账单；
   *   ③ 省钱账是「动作打卡」，与「账单流水」语义不同，合并会让「买对省 X」
   *      和冷静期「拦下 Y」混为一谈（两个数必须分开显示）。
   */
  var SAVINGS_KEY = 'ai_jizhang_savings_v1';
  var SAVINGS_LOG_MAX = 2000;
  /** 当前打卡库：{ v, logs:[{id,date,saved,manual,at}], updatedAt } */
  var savingsDb = { v: 1, logs: [], updatedAt: 0 };
  var savingsStorageOK = true;
  /** 存档解析失败时置真，首次打开面板提示一次（只重置自己） */
  var savingsRecovered = false;

  /**
   * 打卡记录归一化：任何一条不合法就丢弃那一条，而不是整个库作废。
   * 规则：id 必须是非空字符串；date 必须是 YYYY-MM-DD；同一 (id,date) 只保留一条；
   *      saved 非法按 0 处理（`none` 型条目本来就不计金额）。
   */
  function normalizeSavingsDb(obj) {
    var o = (obj && typeof obj === 'object') ? obj : {};
    var src = Array.isArray(o.logs) ? o.logs : [];
    var out = [], seen = {}, i;
    for (i = 0; i < src.length; i++) {
      var r = src[i];
      if (!r || typeof r !== 'object') { continue; }
      var id = (typeof r.id === 'string') ? r.id : '';
      if (!id) { continue; }
      var date = (typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) ? r.date : '';
      if (!date) { continue; }
      var key = id + '@' + date;
      if (seen[key]) { continue; }
      seen[key] = 1;
      var saved = Number(r.saved);
      if (!isFinite(saved) || saved < 0) { saved = 0; }
      out.push({
        id: id,
        date: date,
        saved: ENG.round2(saved),
        manual: !!r.manual,
        at: isFinite(Number(r.at)) ? Number(r.at) : 0
      });
    }
    if (out.length > SAVINGS_LOG_MAX) { out = out.slice(out.length - SAVINGS_LOG_MAX); }
    return {
      v: isFinite(Number(o.v)) ? Number(o.v) : 0,
      logs: out,
      updatedAt: isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : 0
    };
  }

  function loadSavingsDb() {
    var raw = null;
    try {
      raw = global.localStorage.getItem(SAVINGS_KEY);
    } catch (e) {
      savingsStorageOK = false;
      raw = null;
    }
    if (!raw) { savingsDb = { v: 1, logs: [], updatedAt: 0 }; return; }

    try {
      savingsDb = normalizeSavingsDb(JSON.parse(raw));
    } catch (e2) {
      savingsDb = { v: 1, logs: [], updatedAt: 0 };
      savingsRecovered = true;
      return;
    }
    /* 数据版本变了（条目 id 可能重排）：只保留仍存在的 id，不做整库清空 */
    var ver = (SAV && SAV.DATA && SAV.DATA.DATA_VERSION) || 1;
    if (savingsDb.v !== ver) {
      savingsDb.logs = savingsDb.logs.filter(function (r) { return !!(SAV && SAV.byId && SAV.byId(r.id)); });
      savingsDb.v = ver;
      saveSavingsDb();
    }
  }

  function saveSavingsDb() {
    savingsDb.updatedAt = Date.now();
    if (!savingsStorageOK) { return false; }
    try {
      global.localStorage.setItem(SAVINGS_KEY, JSON.stringify(savingsDb));
      return true;
    } catch (e) {
      savingsStorageOK = false;
      showStorageTip();
      return false;
    }
  }

  /* ================================================================== */
  /* 聊天渲染                                                            */
  /* ================================================================== */

  function chatListEl() {
    return $('chatList');
  }

  function scrollChat() {
    var list = chatListEl();
    if (list) { list.scrollTop = list.scrollHeight; }
  }

  function timeHtml() {
    return '<div class="msg-time">' + nowHM() + '</div>';
  }

  function appendRow(role, innerHtml) {
    var list = chatListEl();
    var row = DOC.createElement('div');
    row.className = 'msg-row' + (role === 'me' ? ' me' : '');
    var av = DOC.createElement('div');
    av.className = 'avatar ' + (role === 'me' ? 'me' : 'ai');
    av.textContent = role === 'me' ? '我' : '账';
    var body = DOC.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = innerHtml;
    row.appendChild(av);
    row.appendChild(body);
    list.appendChild(row);
    scrollChat();
    return body;
  }

  function addAIMessage(innerHtml) {
    return appendRow('ai', innerHtml + timeHtml());
  }

  function addUserMessage(text) {
    var body = appendRow('me', timeHtml());
    var bubble = DOC.createElement('div');
    bubble.className = 'bubble me';
    bubble.textContent = text;
    body.insertBefore(bubble, body.firstChild);
  }

  function aiBubble(text) {
    return '<div class="bubble ai">' + text + '</div>';
  }

  function tagHtml(text, cls) {
    return '<span class="tag' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>';
  }

  /**
   * 「💡 理财专家说」卡片（理财专家模式 · 核心格式）。
   * 记账结果之后触发：娱乐 / 冲动消费 / 高溢价品牌，一条 ≤50 字的建议。
   */
  function coachSayHtml(text) {
    return '<div class="coach-say">' +
      '<div class="coach-say-head">💡 <b>理财专家说</b></div>' +
      '<div class="coach-say-body">' + esc(text) + '</div>' +
      '</div>';
  }

  /** 单笔账单卡片 HTML（success=true 时按业务规则 5 显示「【记账成功】」） */
  function billCardHtml(bill, success) {
    var isIncome = bill.type === 'income';
    var sign = isIncome ? '+' : '-';
    var cls = isIncome ? 'income' : 'expense';
    var tags = '';
    tags += tagHtml(bill.category, isIncome ? 'green' : '');
    if (isIncome) {
      tags += tagHtml('收入', 'green');
    } else {
      tags += tagHtml(bill.motivation, bill.motivation === '情绪' ? 'orange' : '');
      tags += tagHtml(bill.want ? '想要' : '需要', bill.want ? 'orange' : '');
    }
    // 业务规则 1：账单卡片上必须能看到提取出来的「商家」
    if (bill.merchant) { tags += tagHtml(bill.merchant, 'gray'); }
    tags += '<span class="tag">' + esc(bill.date) + '</span>';

    return '' +
      '<div class="bill-card" data-bill="' + esc(bill.id) + '">' +
      '  <div class="bill-card-head"><span>' + (isIncome ? '收入入账' : '【记账成功】支出记账') + '</span>' +
      '<span>' + esc(bill.date) + '</span></div>' +
      '  <div class="bill-card-main">' +
      '    <span class="bill-card-note">' + esc(bill.note) + '</span>' +
      '    <span class="bill-card-amount ' + cls + '">' + sign + money(bill.amount) + '</span>' +
      '  </div>' +
      '  <div class="bill-card-tags">' + tags + '</div>' +
      '  <div class="bill-card-actions">' +
      (isIncome ? '' : '<span class="worth-q">值不值？</span>' + worthBtns(bill)) +
      '    <button type="button" class="undo-btn" data-act="undo" data-bill="' + esc(bill.id) + '">撤回</button>' +
      '  </div>' +
      '</div>';
  }

  /* ================================================================== */
  /* 业务动作                                                            */
  /* ================================================================== */

  function isImpulse(draft) {
    if (!draft || draft.type !== 'expense') { return false; }
    // 业务规则：单笔非刚需支出（游戏充值 / 盲盒 / 潮玩 / 超出日常预算的聚会）
    if (ENG.hitsCooldownKeyword(draft)) { return true; }
    return draft.motivation === '情绪' || draft.want === true;
  }

  function needsCooldown(draft) {
    if (!isImpulse(draft)) { return false; }
    var threshold = Number(state.budget.cooldownThreshold);
    if (!isFinite(threshold) || threshold <= 0) { return false; }
    return Number(draft.amount) >= threshold;
  }

  function commitBill(draft, skipUndo) {
    var isIncome = draft.type === 'income';
    var bill = {
      id: uid('b'),
      date: draft.date || ENG.formatDate(new Date()),
      amount: ENG.round2(draft.amount),
      category: isIncome ? DATA.INCOME_CATEGORY
        : (DATA.CATEGORY_KEYS.indexOf(draft.category) !== -1 ? draft.category : '其他'),
      note: draft.note || draft.category || '未命名',
      motivation: draft.motivation === '情绪' ? '情绪' : '刚需',
      want: !!draft.want,
      // 业务规则 1：必须从用户话语中提取「商家」
      merchant: draft.merchant || ENG.extractMerchant((draft.note || '') + ' ' + (draft.raw || '')),
      type: isIncome ? 'income' : 'expense',
      source: isIncome ? String(draft.source || '') : '',
      askedCycle: !!draft.askedCycle,
      imported: !!draft.imported,
      createdAt: Date.now()
    };
    state.bills.push(bill);
    // 批量导入的账单不进单步撤回栈（撤回只针对手动记错的那一笔），避免一次导入污染撤回
    if (!skipUndo) { undoStack.push(bill.id); }
    saveState();
    return bill;
  }

  /** 按 id 查找账单 */
  function findBill(id) {
    if (!id) { return null; }
    for (var i = 0; i < state.bills.length; i++) {
      if (state.bills[i].id === id) { return state.bills[i]; }
    }
    return null;
  }

  /** 撤回（删除）某笔账单，并刷新看板 */
  function deleteBill(id) {
    var b = findBill(id);
    if (!b) { return; }
    state.bills = state.bills.filter(function (x) { return x.id !== id; });
    // 同步从撤回栈移除，避免「撤回上一步」误删已删记录
    undoStack = undoStack.filter(function (x) { return x !== id; });
    saveState();
    // 从聊天流里移除这张账单卡片所在的整条消息
    var chatCards = DOC.querySelectorAll('#chatList .bill-card[data-bill="' + id + '"]');
    for (var ci = 0; ci < chatCards.length; ci++) {
      var row = chatCards[ci].closest ? chatCards[ci].closest('.msg-row') : null;
      if (row && row.parentNode) { row.parentNode.removeChild(row); }
    }
    renderAll();
    addAIMessage(aiBubble('↩️ 已撤回「' + esc(b.note) + '」' +
      (b.type === 'income' ? '（收入 ' : '（支出 ') + money(b.amount) + '），已恢复。'));
  }

  /** 给某笔支出打「值不值」标签（再次点击同一项可取消） */
  function setBillWorth(id, val) {
    var b = findBill(id);
    if (!b || b.type === 'income') { return; }
    b.worth = (b.worth === val) ? '' : val;
    saveState();
    // 只刷新这张卡片，避免整段聊天被重绘
    var cards = DOC.querySelectorAll('.bill-card');
    for (var k = 0; k < cards.length; k++) {
      if (cards[k].getAttribute('data-bill') === id) {
        var tmp = DOC.createElement('div');
        tmp.innerHTML = billCardHtml(b);
        var fresh = tmp.firstChild;
        if (fresh && fresh.nodeType === 1 && cards[k].parentNode) {
          cards[k].parentNode.replaceChild(fresh, cards[k]);
        }
        break;
      }
    }
  }

  /** 撤回上一步：删除最近一次记入的账单 */
  function undoLast() {
    if (!state.bills.length) {
      addAIMessage(aiBubble('现在没有可撤回的记录啦～'));
      return;
    }
    if (!undoStack.length) {
      addAIMessage(aiBubble('这一步没法自动撤回（比如是导入 / 重置产生的）。你可以直接点账单卡片上的「撤回」按钮删掉它。'));
      return;
    }
    var id = undoStack.pop();
    deleteBill(id);
  }

  /** 值不值 三选一按钮 */
  function worthBtns(bill) {
    var opts = [['worth', '值'], ['mid', '一般'], ['waste', '不值']];
    var html = '';
    for (var i = 0; i < opts.length; i++) {
      var v = opts[i];
      var active = bill.worth === v[0] ? ' active' : '';
      html += '<button type="button" class="worth-btn' + active + '" data-act="worth" data-bill="' +
        esc(bill.id) + '" data-val="' + v[0] + '">' + v[1] + '</button>';
    }
    return html;
  }

  /** 开始处理一批解析结果 */
  function startFlow(drafts) {
    flow.queue = drafts.slice();
    flow.committed = [];
    stepFlow();
  }

  /** 逐笔入账，遇到需要冷静期的就暂停 */
  function stepFlow() {
    while (flow.queue.length > 0) {
      var draft = flow.queue.shift();
      if (needsCooldown(draft)) {
        pendingBill = draft;
        showCooldownCard(draft);
        renderAll();
        return;
      }
      flow.committed.push(commitBill(draft));
    }
    finishFlow();
  }

  function finishFlow() {
    var list = flow.committed;
    flow.committed = [];
    pendingBill = null;
    renderAll();
    if (list.length === 0) { return; }
    reportCommitted(list);
  }

  /** 汇报本次记账结果 */
  function reportCommitted(list) {
    var i;
    var totalExpense = 0;
    for (i = 0; i < list.length; i++) {
      if (list[i].type === 'expense') { totalExpense += list[i].amount; }
    }

    var overview = getOverview();
    // 业务规则 5：每笔都要给到【记账成功】卡片 + 【余额概览】+【理财专家一句话建议】
    for (i = 0; i < list.length; i++) {
      var bill = list[i];
      var head;
      if (bill.type === 'income') {
        head = aiBubble('💰 <b>【记账成功】</b>这是一笔收入（' + esc(bill.source || '其他') + '），已经加进本周期，不计入支出统计。');
      } else {
        head = aiBubble('<b>【记账成功】</b>记好啦～归类为 <span class="hl">' + esc(bill.category) + '</span>' +
          (bill.merchant ? '，商家 <span class="hl">' + esc(bill.merchant) + '</span>' : '') +
          (bill.motivation === '情绪' ? '（情绪消费，我盯着你呢）' : '') + '。');
      }
      var html = head + billCardHtml(bill, true);
      html += balanceOverviewHtml(overview);
      html += coachSayHtml(COACH.oneLineAdvice(bill, overview));
      addAIMessage(html);
      if (bill.type === 'income') {
        maybeAskCycleReset(bill);
      }
    }
  }

  /** 【余额概览】卡片：本周期收入 / 支出 / 余额 + 日月馒头额度 */
  function balanceOverviewHtml(overview) {
    var st = overview.cycleAgg;
    var bs = overview.budgetState;
    var sentence = overview.sentence || '';
    return '' +
      '<div class="balance-card">' +
      '  <div class="bc-title">📊 【余额概览】</div>' +
      '  <div class="bc-grid">' +
      '    <div><b>' + money(st.income) + '</b><small>本周期收入</small></div>' +
      '    <div><b>' + money(st.expense) + '</b><small>本周期支出</small></div>' +
      '    <div><b class="' + (bs.remaining < 0 ? 'expense' : 'income') + '">' + money(bs.remaining) + '</b><small>剩余额度</small></div>' +
      '    <div><b>' + money(Math.max(0, bs.dailyAllowance)) + '</b><small>剩余每天可花</small></div>' +
      '  </div>' +
      '  <div class="bc-sentence">' + esc(sentence) + '</div>' +
      '</div>';
  }

  /** 冷静期决策卡（设计稿 P4：聚焦 + 单一主决策 + 校园平替） */
  function showCooldownCard(draft) {
    var overview = getOverview();
    var sim = ENG.simulatePurchase({
      amount: draft.amount,
      state: overview.budgetState,
      remainingDays: overview.cycle.remainingDays
    });
    var alt = ENG.getAlternative({ note: draft.note, category: draft.category, amount: draft.amount });

    // 业务规则：冷静期提醒必须说清「占生活费的比例」+「24 小时」+「对食堂伙食预算的影响」
    var ratioText = '';
    var totalBudget = Number(state.budget.total) || 0;
    if (totalBudget > 0) {
      ratioText = '这笔占你南海北区生活费的 ' + Math.round(draft.amount / totalBudget * 1000) / 10 + '%。';
    }
    var cooldownNotice = ratioText +
      '这笔消费占你南海北区生活费的比例偏高。建议加入购物车冷静 24 小时。如果买了它，接下来几天的食堂伙食预算会受影响。';

    var rows = '' +
      dcRow('商品', esc(draft.note || draft.category || '未命名')) +
      dcRow('金额', '<b class="mono">' + money(draft.amount) + '</b>') +
      dcRow('分类', esc(draft.category) + ' · 非必需');

    var html = '' +
      '<div class="decision-card">' +
      '  <div class="dc-icon">!</div>' +
      '  <div class="dc-title">冷静期提醒</div>' +
      '  <div class="dc-sub">检测到一笔 ' + money(draft.amount) + ' 的冲动消费</div>' +
      '  <div class="dc-detail">' + rows + '</div>' +
      '  <div class="dc-alert"><span class="dc-dot"></span><span>' + esc(cooldownNotice) + ' ' + esc(sim.message) + '</span></div>' +
      (alt
        ? '  <div class="dc-suggest"><span class="dc-dot"></span><span>校园平替：' + esc(alt.altName) +
          ' 约 ' + money(alt.altPrice) + '，可省 ' + money(alt.save) + '</span></div>'
        : '') +
      '  <div class="dc-actions">' +
      '    <button type="button" class="dc-primary" data-act="cooldown-skip">先不买，省下 ' + money(draft.amount) + '</button>' +
      '    <button type="button" class="dc-secondary" data-act="cooldown-buy">仍然记下这笔</button>' +
      '  </div>' +
      '</div>';
    addAIMessage(html);
  }

  function dcRow(label, valueHtml) {
    return '<div class="dc-row"><span>' + label + '</span><span>' + valueHtml + '</span></div>';
  }

  var PUSH_BACK_LINES = [
    '好的，那这笔就记上了～下不为例哦。',
    '行吧，快乐也是刚需，但我先记在小本本上了。',
    '记好了。下次看到「限时」两个字，先深呼吸三次。'
  ];

  function resolveCooldown(keep) {
    var draft = pendingBill;
    if (!draft) { return; }
    pendingBill = null;

    if (keep) {
      var bill = commitBill(draft);
      flow.committed.push(bill);
      var line = PUSH_BACK_LINES[Math.floor(Math.random() * PUSH_BACK_LINES.length)];
      addAIMessage(aiBubble(esc(line) + '<br>这笔 ' + money(bill.amount) + ' 已标记为「情绪消费」。'));
      showToast('已记下这笔，并标记为冲动消费', 'warn');
    } else {
      state.savedMoney = ENG.round2(state.savedMoney + draft.amount);
      state.blockedCount = ENG.round2(state.blockedCount + 1);
      saveState();
      addAIMessage(aiBubble('这波省下 ' + money(draft.amount) + '，已记进你的「省下的钱」成就（累计 ' +
        money(state.savedMoney) + '）。👏'));
      showToast('已为你省下 ' + money(draft.amount), 'ok');
      renderAll();
    }
    stepFlow();
  }

  /* ================================================================== */
  /* 理财专家 · 剁手冷静法                                                */
  /* ================================================================== */

  /** 剁手冷静法会话状态：{item, price, step, answers}；step 为 0 基索引 */
  var cooling = null;

  /** 启动剁手冷静法（用户表达「想买 XX」时由 sendToAssistant 调用） */
  function startCoolingFlow(item, price) {
    cooling = { item: String(item || '想买的东西'), price: Number(price) || 0, step: 0, answers: [] };
    renderCoolingIntro();
  }

  function renderCoolingIntro() {
    var html =
      '<div class="decision-card cool-card">' +
      '  <div class="dc-icon cool"><svg viewBox="0 0 24 24"><use href="#i-stop"/></svg></div>' +
      '  <div class="dc-title">剁手冷静法</div>' +
      '  <div class="dc-sub">想买：' + esc(cooling.item) + '</div>' +
      '  <div class="dc-detail">' + dcRow('方法', '回答 3 个问题，30 秒看清该不该买') + '</div>' +
      '  <div class="dc-actions">' +
      '    <button type="button" class="dc-primary" data-act="cool-next">开始冷静问答</button>' +
      '  </div>' +
      '</div>';
    addAIMessage(html);
  }

  function renderCoolingQuestion() {
    var stepDef = COACH.COOLING_STEPS[cooling.step];
    if (!stepDef) { renderCoolingVerdict(); return; }
    var opts = '';
    for (var i = 0; i < stepDef.options.length; i++) {
      opts += '<button type="button" class="cool-opt" data-act="cool-answer" data-val="' +
        esc(stepDef.options[i].val) + '">' + esc(stepDef.options[i].label) + '</button>';
    }
    var html =
      '<div class="decision-card cool-card">' +
      '  <div class="dc-icon cool"><svg viewBox="0 0 24 24"><use href="#i-think"/></svg></div>' +
      '  <div class="dc-title">' + esc(stepDef.q) + '</div>' +
      '  <div class="dc-sub">想买：' + esc(cooling.item) + ' · 第 ' + (cooling.step + 1) + ' / 3 问</div>' +
      '  <div class="cool-opts">' + opts + '</div>' +
      '</div>';
    addAIMessage(html);
  }

  function renderCoolingVerdict() {
    var v = COACH.coolingVerdict(cooling.answers);
    var actions = '';
    if (cooling.price > 0) {
      actions += '<button type="button" class="dc-primary" data-act="cool-record">还是要买，帮我记下 ' +
        money(cooling.price) + '</button>';
      actions += '<button type="button" class="dc-secondary" data-act="cool-skip">先不买了，省下 ' +
        money(cooling.price) + '</button>';
    } else {
      actions += '<div class="cool-note">告诉我它的价格，我帮你记上这笔。</div>';
      actions += '<button type="button" class="dc-secondary" data-act="cool-skip">先不买了</button>';
    }
    var html =
      '<div class="decision-card cool-card verdict-' + v.level + '">' +
      '  <div class="dc-icon cool">' + v.icon + '</div>' +
      '  <div class="dc-title">' + esc(v.title) + '</div>' +
      '  <div class="dc-sub">想买：' + esc(cooling.item) + '</div>' +
      '  <div class="dc-detail">' + dcRow('专家判断', esc(v.text)) + '</div>' +
      '  <div class="dc-actions">' + actions + '</div>' +
      '</div>';
    addAIMessage(html);
  }

  /** 三步问答中的一步作答（btnEl 用于把问题卡标记为已作答，防重复点击） */
  function coolingAnswer(val, btnEl) {
    if (!cooling) { return; }
    var card = btnEl && btnEl.closest ? btnEl.closest('.cool-card') : null;
    if (card) {
      if (card.getAttribute('data-done') === '1') { return; }
      card.setAttribute('data-done', '1');
      var stepDef = COACH.COOLING_STEPS[cooling.step];
      var label = val;
      if (stepDef) {
        for (var i = 0; i < stepDef.options.length; i++) {
          if (stepDef.options[i].val === val) { label = stepDef.options[i].label; }
        }
      }
      var optsBox = card.querySelector('.cool-opts');
      if (optsBox) { optsBox.innerHTML = '<span class="tag green">已选：' + esc(label) + '</span>'; }
    }
    cooling.answers.push(val);
    cooling.step++;
    if (cooling.step >= COACH.COOLING_STEPS.length) {
      renderCoolingVerdict();
    } else {
      renderCoolingQuestion();
    }
  }

  /** 结论后选择「仍然购买」：直接入账（已走完冷静流程，不再二次弹冷静期） */
  function coolingRecord() {
    if (!cooling) { return; }
    var draft = {
      amount: cooling.price,
      category: '购物',
      note: cooling.item,
      date: ENG.formatDate(new Date()),
      motivation: '情绪',
      want: true,
      type: 'expense'
    };
    var bill = commitBill(draft);
    cooling = null;
    renderAll();
    reportCommitted([bill]);
  }

  /** 结论后选择「先不买」：金额计入「省下的钱」成就 */
  function coolingSkip() {
    if (!cooling) { return; }
    var amount = cooling.price;
    if (amount > 0) {
      state.savedMoney = ENG.round2(state.savedMoney + amount);
      state.blockedCount = ENG.round2(state.blockedCount + 1);
      saveState();
      addAIMessage(aiBubble('漂亮！这波省下 ' + money(amount) +
        '，已记进「省下的钱」（累计 ' + money(state.savedMoney) + '）。👏'));
      showToast('已为你省下 ' + money(amount), 'ok');
      renderAll();
    } else {
      addAIMessage(aiBubble('好，那先不买。把它加进购物车晾 48 小时，还想要再来找我。'));
    }
    cooling = null;
  }

  /* ================================================================== */
  /* 概览计算                                                            */
  /* ================================================================== */

  function getOverview() {
    var today = new Date();
    var todayStr = ENG.formatDate(today);
    var cycle = ENG.getCycle(today, state.budget.payday, null, state.budget.cycleStart);
    var cycleAgg = ENG.aggregate(state.bills, cycle.start, cycle.end);
    var allAgg = ENG.aggregate(state.bills, null, null);
    var todaySpent = ENG.round2(cycleAgg.dailyMap[todayStr] || 0);
    var budgetState = ENG.getBudgetState({
      total: state.budget.total,
      spent: cycleAgg.expense,
      remainingDays: cycle.remainingDays,
      todaySpent: todaySpent
    });
    var engel = ENG.getEngel(cycleAgg.byCategory, cycleAgg.expense);
    var incomeStats = ENG.getIncomeStats(state.bills, cycle);
    var monthlySurplus = cycle.remainingDays > 0
      ? Math.max(0, ENG.round2(budgetState.remaining / cycle.remainingDays * 30))
      : 0;
    var sentence;
    if (budgetState.isOver) {
      sentence = '📉 本周期已经超支 ' + money(budgetState.overBy) + '，接下来 ' +
        cycle.remainingDays + ' 天建议只吃食堂，先把窟窿补上。';
    } else if (budgetState.status === 'danger') {
      sentence = '📉 本周期还剩 ' + money(budgetState.remaining) + '，日均可用只有 ' +
        money(budgetState.dailyAllowance) + '，进入吃土预警状态。';
    } else if (budgetState.status === 'tight') {
      sentence = '📊 本周期还剩 ' + money(budgetState.remaining) + '，日均可用 ' +
        money(budgetState.dailyAllowance) + '，稍微收着点花。';
    } else {
      sentence = '📊 本周期还剩 ' + money(budgetState.remaining) + '，日均可用 ' +
        money(budgetState.dailyAllowance) + '，节奏还不错，继续保持。';
    }
    return {
      today: today,
      todayStr: todayStr,
      cycle: cycle,
      cycleAgg: cycleAgg,
      allAgg: allAgg,
      budgetState: budgetState,
      engel: engel,
      incomeStats: incomeStats,
      monthlySurplus: monthlySurplus,
      sentence: sentence
    };
  }

  /* ================================================================== */
  /* 看板渲染                                                            */
  /* ================================================================== */

  function renderAll() {
    renderDashboard();
    renderGoals();
    renderCoachPanel();
    renderSimple();
  }

  /* ================================================================== */
  /* 理财专家面板渲染                                                     */
  /* ================================================================== */

  /** 渲染「理财专家」Tab：专属建议 + 理财学院 */
  function renderCoachPanel() {
    renderCoachTips();
    renderCoachAcademy();
  }

  /** 专属建议：基于本周期账单数据动态生成（COACH.personalTips） */
  function renderCoachTips() {
    var box = $('coachTips');
    if (!box) { return; }
    var ov = getOverview();
    var tips = COACH.personalTips(state, ov);
    var html = '';
    for (var i = 0; i < tips.length; i++) {
      var t = tips[i];
      html += '<div class="coach-tip level-' + esc(t.level) + '">' +
        '<div class="coach-tip-head"><span class="coach-tip-ico">' + esc(t.icon) + '</span>' +
        '<b>' + esc(t.title) + '</b></div>' +
        '<div class="coach-tip-text">' + esc(t.text) + '</div>' +
        '</div>';
    }
    box.innerHTML = html;
  }

  /**
   * 校验外链协议：只放行 http / https。
   * 用于知识卡资源区，避免 javascript: / data: 之类可执行协议进入 href。
   * @param {string} url 待校验地址
   * @return {string} 合法时返回原地址，否则返回空串
   */
  function safeHttpUrl(url) {
    if (typeof url !== 'string') { return ''; }
    var v = url.replace(/^\s+|\s+$/g, '');
    return /^https?:\/\//i.test(v) ? v : '';
  }

  /**
   * 渲染单张知识卡的学习资源区（可选字段 resources）。
   * 无 resources 或全部条目非法时返回空串，保证未挂资源的卡不报错。
   * @param {Object} lesson 知识卡数据
   * @return {string} 资源区 HTML 片段
   */
  function coachResHtml(lesson) {
    if (!lesson || !lesson.resources || !lesson.resources.length) { return ''; }
    var rows = '';
    for (var i = 0; i < lesson.resources.length; i++) {
      var r = lesson.resources[i];
      if (!r || !r.label) { continue; }
      var label = esc(r.label);
      var desc = r.desc ? esc(r.desc) : '';
      if (r.type === 'copy') {
        var copyText = typeof r.copy === 'string' ? r.copy : '';
        if (copyText === '') { continue; }
        rows += '<div class="coach-res-item">' +
          '<span class="coach-res-main">' +
          '<span class="coach-res-label">' + label + '</span>' +
          (desc ? '<span class="coach-res-desc">' + desc + '</span>' : '') +
          '</span>' +
          '<button type="button" class="coach-res-copy" data-copy="' + esc(copyText) + '">复制</button>' +
          '</div>';
        continue;
      }
      var href = safeHttpUrl(r.url);
      if (href === '') { continue; }
      rows += '<a class="coach-res-item" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="coach-res-main">' +
        '<span class="coach-res-label">' + label + '</span>' +
        (desc ? '<span class="coach-res-desc">' + desc + '</span>' : '') +
        '</span>' +
        '<span class="coach-res-go" aria-hidden="true">↗</span>' +
        '</a>';
    }
    var note = lesson.resNote ? esc(lesson.resNote) : '';
    if (rows === '' && note === '') { return ''; }
    return '<div class="coach-res">' +
      (rows !== '' ? '<div class="coach-res-title">学习资源</div>' + rows : '') +
      (note !== '' ? '<div class="coach-res-note">' + note + '</div>' : '') +
      '</div>';
  }

  /** 理财学院：可折叠知识卡（COACH.ACADEMY） */
  function renderCoachAcademy() {
    var box = $('coachAcademy');
    if (!box) { return; }
    var html = '';
    for (var i = 0; i < COACH.ACADEMY.length; i++) {
      var l = COACH.ACADEMY[i];
      html += '<div class="coach-lesson" data-lesson="' + esc(l.id) + '">' +
        '<button type="button" class="coach-lesson-head">' +
        '<span class="coach-lesson-ico">' + esc(l.icon) + '</span>' +
        '<span class="coach-lesson-title">' + esc(l.title) + '</span>' +
        '<span class="coach-lesson-tag">' + esc(l.tag) + '</span>' +
        '<span class="coach-lesson-arrow">›</span>' +
        '</button>' +
        '<div class="coach-lesson-body">' +
        l.body.split('\n').map(esc).join('<br>') +
        coachResHtml(l) +
        '</div>' +
        '</div>';
    }
    box.innerHTML = html;
  }

  /**
   * 降级复制：临时 textarea + document.execCommand('copy')。
   * 用于非 https 环境或浏览器不支持 Clipboard API 的情况。
   * @param {string} text 要复制的文本
   * @return {boolean} 是否复制成功
   */
  function coachLegacyCopy(text) {
    if (!DOC || !DOC.body || typeof DOC.execCommand !== 'function') { return false; }
    var ta = DOC.createElement('textarea');
    var ok = false;
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    DOC.body.appendChild(ta);
    try {
      ta.focus();
      ta.select();
      if (typeof ta.setSelectionRange === 'function') { ta.setSelectionRange(0, text.length); }
      ok = DOC.execCommand('copy') === true;
    } catch (err) {
      ok = false;
    }
    if (ta.parentNode) { ta.parentNode.removeChild(ta); }
    return ok;
  }

  /**
   * 复制文本：优先 Clipboard API，失败或不可用时降级。
   * @param {string} text 要复制的文本
   * @param {Function} done 回调，参数为是否成功（boolean）
   */
  function coachClipboardWrite(text, done) {
    var nav = global.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      try {
        var p = nav.clipboard.writeText(text);
        if (p && typeof p.then === 'function') {
          p.then(function () { done(true); }, function () { done(coachLegacyCopy(text)); });
          return;
        }
        done(true);
        return;
      } catch (err) {
        /* 少数浏览器会同步抛错（非安全上下文），继续走降级 */
      }
    }
    done(coachLegacyCopy(text));
  }

  /**
   * 知识卡资源区「复制」按钮：复制 data-copy 文本并给出反馈。
   * 成功后按钮文案短暂变为「已复制」，1.5s 后恢复；重复点击重新计时。
   * @param {Element} btn 触发复制的按钮
   */
  function coachCopyResource(btn) {
    var text = btn && btn.getAttribute ? (btn.getAttribute('data-copy') || '') : '';
    if (text === '') { return; }
    coachClipboardWrite(text, function (ok) {
      if (!ok) {
        showToast('复制失败，请手动记下「' + text + '」再去抖音搜索', 'warn');
        return;
      }
      if (btn.__copyTimer) { clearTimeout(btn.__copyTimer); }
      btn.textContent = '已复制';
      btn.classList.add('is-done');
      showToast('已复制「' + text + '」，打开抖音搜索即可', 'ok');
      btn.__copyTimer = setTimeout(function () {
        btn.textContent = '复制';
        btn.classList.remove('is-done');
        btn.__copyTimer = null;
      }, 1500);
    });
  }

  /** 专家问答入口：「怎么省钱」 */
  function showSaveMoneyGuide() {
    addAIMessage('<div class="bubble ai coach-bubble">' + COACH.saveMoneyAnswer() + '</div>');
  }

  /** 专家问答入口：「怎么赚钱」 */
  function showMakeMoneyGuide() {
    addAIMessage('<div class="bubble ai coach-bubble">' + COACH.makeMoneyAnswer() + '</div>');
  }

  /** 专家问答入口：「剁手冷静法」——方法说明 + 立即测试 */
  function showCoolingGuide() {
    var lesson = null;
    for (var i = 0; i < COACH.ACADEMY.length; i++) {
      if (COACH.ACADEMY[i].id === 'cooldown') { lesson = COACH.ACADEMY[i]; break; }
    }
    var html = '<div class="coach-qa-title"><svg class="cq-ico" viewBox="0 0 24 24"><use href="#i-stop"/></svg>剁手冷静法 · 48 小时法则</div>';
    if (lesson) {
      html += '<div class="coach-qa-body">' + lesson.body.split('\n').map(esc).join('<br>') + '</div>';
    }
    html += '<div class="coach-qa-actions">' +
      '<button type="button" class="btn-mini primary" data-act="cool-start">测一测：我现在想买…</button>' +
      '</div>';
    addAIMessage('<div class="bubble ai coach-bubble">' + html + '</div>');
  }

  /**
   * 把「理财学院」区块滚到专家面板可视区顶部。
   * 优先滚动专家面板自己的滚动容器（.coach-scroll），避免整页跳动；
   * 找不到容器时降级为 scrollIntoView({block:'start'})，再降级到 scrollIntoView(true)。
   */
  function scrollAcademyIntoView() {
    var box = $('coachAcademy');
    if (!box) { return; }
    var scroller = box.parentNode;
    while (scroller && scroller !== DOC.body &&
      !(scroller.classList && scroller.classList.contains('coach-scroll'))) {
      scroller = scroller.parentNode;
    }
    var hasScroller = !!(scroller && scroller.classList &&
      scroller.classList.contains('coach-scroll'));
    if (hasScroller && typeof box.getBoundingClientRect === 'function' &&
      typeof scroller.getBoundingClientRect === 'function') {
      var delta = box.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      var top = scroller.scrollTop + delta - 8;
      scroller.scrollTop = top > 0 ? top : 0;
      return;
    }
    if (typeof box.scrollIntoView === 'function') {
      try {
        box.scrollIntoView({ block: 'start' });
      } catch (err) {
        box.scrollIntoView(true);
      }
    }
  }

  /**
   * 进入理财学院并定位到学院区。
   * 视图映射交给 switchView（简洁版自动映射到 scoach），此处不硬编码视图名。
   */
  function openAcademy() {
    switchView('coach');
    scrollAcademyIntoView();
  }

  /**
   * 聊天入口：「理财课」——直接列 3 条视频 / 课程资源 + 一键跳理财学院。
   * 学习资源里排在后面的 UP 主主页不进气泡（LEARN_INLINE_MAX 上限不变），
   * 只在底部小字里提示「另有 2 位省钱博主」，避免气泡被撑长。
   * 不切视图，避免打断正在看聊天记录的用户；链接统一过 safeHttpUrl。
   */
  function showLearnGuide() {
    var list = (COACH && typeof COACH.learningResources === 'function')
      ? COACH.learningResources()
      : [];
    var rows = '';
    var shown = 0;
    for (var i = 0; i < list.length && shown < LEARN_INLINE_MAX; i++) {
      var href = safeHttpUrl(list[i].url);
      if (href === '') { continue; }
      rows += '<a class="coach-res-item" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="coach-res-main">' +
        '<span class="coach-res-label">' + esc(list[i].label) + '</span>' +
        (list[i].desc ? '<span class="coach-res-desc">' + esc(list[i].desc) + '</span>' : '') +
        '</span>' +
        '<span class="coach-res-go" aria-hidden="true">↗</span>' +
        '</a>';
      shown++;
    }

    var html = '<div class="coach-qa-title">' +
      '<svg class="cq-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-cap"/></svg>' +
      '理财课 · 视频学习</div>';
    if (rows === '') {
      html += '<div class="coach-qa-body">学习资源暂时没加载出来，刷新页面再试，' +
        '或者去「理财学院」翻知识卡。</div>';
    } else {
      html += '<div class="coach-qa-body"><div class="coach-res">' + rows + '</div></div>';
    }
    html += '<div class="coach-qa-foot">' +
      '视频源为公开 B 站内容、经镜像站转发（打不开就去 B 站搜同名标题）；课程为中国大学 MOOC 官方页面。' +
      '另有 2 位 B 站省钱博主主页，在理财学院查看。</div>';
    html += '<div class="coach-qa-actions">' +
      '<button type="button" class="btn-mini primary" data-act="learn-all">去理财学院看全部（含 2 位省钱博主）›</button>' +
      '</div>';
    addAIMessage('<div class="bubble ai coach-bubble">' + html + '</div>');
  }

  /** 专家面板「问专家」按钮：切回聊天，给出专家能回答的问题入口 */
  function showAskCoachIntro() {
    switchView('chat');
    addAIMessage(
      '<div class="bubble ai coach-bubble">' +
      '<div class="coach-qa-title"><svg class="cq-ico" viewBox="0 0 24 24"><use href="#i-cap"/></svg>理财专家 · 可以这样问我</div>' +
      '<div class="coach-qa-chips">' +
      '<button type="button" class="chip" data-cmd="怎么省钱">怎么省钱</button>' +
      '<button type="button" class="chip" data-cmd="怎么赚钱">怎么赚钱</button>' +
      '<button type="button" class="chip" data-cmd="剁手冷静法">剁手冷静法</button>' +
      '</div>' +
      '<div class="coach-qa-foot">或者直接说「我想买个 XX」，我陪你走冷静法。</div>' +
      '</div>'
    );
  }

  /**
   * 看板「收支概览」卡：本周期 收入 / 支出 / 结余 / 储蓄率。
   * 收入为 0 时储蓄率显示「—」，避免 NaN / Infinity。
   * @param {Object} ov getOverview() 结果
   */
  function renderIncomeCard(ov) {
    var stats = ov.incomeStats || { income: 0, expense: 0, balance: 0, savingsRate: null };
    var incomeEl = $('incIncome');
    var expenseEl = $('incExpense');
    var balanceEl = $('incBalance');
    var rateEl = $('incRate');
    if (!incomeEl || !expenseEl || !balanceEl || !rateEl) { return; }

    incomeEl.textContent = money(stats.income);
    expenseEl.textContent = money(stats.expense);
    balanceEl.textContent = money(stats.balance);
    balanceEl.className = stats.balance < 0 ? 'neg' : '';
    rateEl.textContent = stats.savingsRate === null ? '—' : stats.savingsRate.toFixed(1) + '%';
    rateEl.className = (stats.savingsRate !== null && stats.savingsRate < 0) ? 'neg' : '';

    var hint = $('incomeHint');
    if (hint) {
      hint.textContent = stats.hasIncome
        ? '收入 ' + stats.incomeCount + ' 笔'
        : '还没记收入';
    }
  }

  /**
   * 看板「理财课 · 视频与博主」卡：把理财学院里的视频 / 课程 / B 站 UP 主主页
   * 直接摊在看板上（不再截断，当前 3 条视频课程 + 2 位博主共 5 条）。
   * 数据来自 COACH.learningResources()（单一数据源，不复制链接）；
   * 一旦所有地址都不合法（safeHttpUrl 返回空串）就整卡隐藏，不留空壳。
   */
  function renderLearnCard() {
    var card = $('learnCard');
    var box = $('learnMini');
    if (!card || !box) { return; }
    var list = (COACH && typeof COACH.learningResources === 'function')
      ? COACH.learningResources()
      : [];
    var rows = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var href = safeHttpUrl(r.url);
      if (href === '') { continue; }
      rows += '<a class="learn-item" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="learn-main">' +
        '<span class="learn-label">' + esc(r.label) + '</span>' +
        (r.desc ? '<span class="learn-desc">' + esc(r.desc) + '</span>' : '') +
        '</span>' +
        (r.type === 'up' ? '<span class="learn-badge">主页</span>' : '') +
        '<span class="learn-go" aria-hidden="true">↗</span>' +
        '</a>';
    }
    box.innerHTML = rows;
    card.hidden = (rows === '');
  }

  /**
   * 常驻预算状态条 + 看板预算卡状态芯片。
   * 与看板共用 getOverview()，任何视图（聊天/看板/目标）下都保持最新，
   * 解决原设计「聊天时看不到核心预算」的问题。
   */
  function renderBudgetBar(ov) {
    var bar = $('budgetBar');
    if (!bar) { return; }
    var bs = ov.budgetState;
    var total = state.budget.total;
    var ratio = total > 0 ? Math.max(0, Math.min(1, bs.remaining / total)) : 0;
    var label = bs.isOver ? '已超支' : (bs.status === 'tight' ? '紧张' : '安全');

    bar.className = 'budget-bar state-' + bs.status;
    $('bbAmount').textContent = money(bs.remaining);
    $('bbDaily').textContent = money(bs.dailyAllowance);
    $('bbDays').textContent = ov.cycle.remainingDays + ' 天';
    $('bbFill').style.width = (ratio * 100).toFixed(1) + '%';

    var chip = $('bbStatus');
    if (chip) { chip.textContent = label; }
    var stateChip = $('budgetStateChip');
    if (stateChip) {
      stateChip.textContent = label;
      stateChip.className = 'badge state-' + bs.status;
    }
  }

  function renderDashboard() {
    var ov = getOverview();
    var bs = ov.budgetState;
    var total = state.budget.total;

    renderBudgetBar(ov);
    renderDealsMini();
    renderSavingsMini(ov);

    /* ---- 预算环 ---- */
    var ring = $('ringBar');
    var ratio = total > 0 ? Math.max(0, Math.min(1, bs.remaining / total)) : 0;
    if (ring) {
      ring.style.strokeDasharray = RING_C + ' ' + RING_C;
      ring.style.strokeDashoffset = String(RING_C * (1 - ratio));
      ring.style.stroke = bs.status === 'danger' ? '#EF5350' : (bs.status === 'tight' ? '#FF8A3D' : '#07C160');
    }
    $('ringRemaining').textContent = money(bs.remaining);
    $('ringPercent').textContent = '剩余 ' + Math.round(ratio * 100) + '%';

    var badge = $('cycleBadge');
    badge.textContent = '第 ' + ov.cycle.passedDays + ' / ' + ov.cycle.totalDays + ' 天';
    badge.className = 'badge' + (bs.status === 'danger' ? ' danger' : (bs.status === 'tight' ? ' warn' : ''));

    $('statDaily').textContent = money(bs.dailyAllowance);
    $('statToday').textContent = money(bs.todaySpent);
    $('statDays').textContent = ov.cycle.remainingDays + ' 天';
    $('budgetCycle').textContent = '周期 ' + ov.cycle.start + ' ~ ' + ov.cycle.end +
      (ov.cycle.isCustom ? '（自定义起点）' : '') +
      ' · 总预算 ' + money(total) + ' · 已花 ' + money(ov.cycleAgg.expense);
    $('cycleBadge').title = ov.cycle.isCustom
      ? '当前周期从 ' + ov.cycle.start + ' 起算（生活费到账日）'
      : '按发钱日 ' + state.budget.payday + ' 号计算的周期';

    /* ---- 收支概览 ---- */
    renderIncomeCard(ov);

    /* ---- 理财课 · 视频（看板常驻入口） ---- */
    renderLearnCard();

    /* ---- 恩格尔 ---- */
    var engelCard = $('engelCard');
    var engelPercent = Math.round(ov.engel.percent);
    $('engelBadge').textContent = '餐饮占比 ' + engelPercent + '%';
    $('engelFill').style.width = Math.min(100, engelPercent) + '%';
    if (ov.engel.alert) {
      engelCard.className = 'card card-engel alert';
      $('engelBadge').className = 'badge badge-soft warn';
      var food = ENG.round2(ov.cycleAgg.byCategory['餐饮'] || 0);
      // 业务规则 3：餐饮占比 > 60% 时提示，文案按《记账与预算业务规则》
      $('engelText').textContent = '本月餐饮占比过高，建议多去南海北区食堂少点外卖。本月餐饮已花 ' +
        money(food) + '，把外卖和奶茶压掉两成，还能省回约 ' + money(food * 0.2) + '。';
    } else {
      engelCard.className = 'card card-engel';
      $('engelBadge').className = 'badge badge-soft';
      $('engelText').textContent = ov.cycleAgg.expense > 0
        ? '餐饮占比 ' + engelPercent + '%，还在健康区间。囤一点食堂早餐券，能把这个数字再压下去。'
        : '本周期还没有支出记录，先记一笔试试？';
    }

    /* ---- 分类占比 ---- */
    renderDonut(ov);

    /* ---- 近 7 日趋势 ---- */
    renderTrend(ov);

    /* ---- 流水 ---- */
    renderBillList();

    /* ---- 成就 ---- */
    renderAchievement();
  }

  function donutSvgHtml(slices, size, strokeWidth, viewBoxSize) {
    var vb = viewBoxSize || 100;
    var cx = vb / 2;
    var cy = vb / 2;
    var r = (vb - strokeWidth) / 2;
    var c = 2 * Math.PI * r;
    var total = 0;
    var i;
    for (i = 0; i < slices.length; i++) { total += slices[i].value; }
    if (total <= 0) { return ''; }
    var parts = [];
    var offset = 0;
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" stroke="#EEF1F4" stroke-width="' + strokeWidth + '"></circle>');
    for (i = 0; i < slices.length; i++) {
      var len = slices[i].value / total * c;
      if (len <= 0) { continue; }
      var opacity = 1;
      if (highlightCategory && slices[i].key && slices[i].key !== highlightCategory) { opacity = 0.22; }
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" stroke="' + slices[i].color +
        '" stroke-width="' + strokeWidth + '" stroke-dasharray="' + len + ' ' + (c - len) +
        '" stroke-dashoffset="' + (-offset) + '" opacity="' + opacity + '"></circle>');
      offset += len;
    }
    return parts.join('');
  }

  function getCategorySlices(byCategory) {
    var slices = [];
    var i;
    for (i = 0; i < DATA.CATEGORIES.length; i++) {
      var key = DATA.CATEGORIES[i].key;
      var value = ENG.round2(byCategory[key] || 0);
      if (value > 0) {
        slices.push({ key: key, value: value, color: DATA.CATEGORIES[i].color });
      }
    }
    slices.sort(function (a, b) { return b.value - a.value; });
    return slices;
  }

  function renderDonut(ov) {
    var svg = $('donutChart');
    var legend = $('legendList');
    var slices = getCategorySlices(ov.cycleAgg.byCategory);
    var totalValue = ov.cycleAgg.expense;

    if (slices.length === 0) {
      svg.innerHTML = '<circle cx="80" cy="80" r="70" stroke="#EEF1F4" stroke-width="20"></circle>';
      $('donutTotal').textContent = money(0);
      legend.innerHTML = '<li class="empty">本周期还没有支出记录</li>';
      return;
    }

    svg.innerHTML = donutSvgHtml(slices, 160, 20, 160);
    $('donutTotal').textContent = money(totalValue);

    var html = '';
    var i;
    for (i = 0; i < slices.length; i++) {
      var pct = totalValue > 0 ? (slices[i].value / totalValue * 100) : 0;
      html += '<li data-cat="' + esc(slices[i].key) + '"' +
        (highlightCategory === slices[i].key ? ' class="active"' : '') + '>' +
        '<span class="dot" style="background:' + slices[i].color + '"></span>' +
        '<span class="lg-name">' + esc(slices[i].key) + '</span>' +
        '<span class="lg-amount">' + money(slices[i].value) + '</span>' +
        '<span class="lg-percent">' + pct.toFixed(0) + '%</span>' +
        '</li>';
    }
    legend.innerHTML = html;
  }

  function renderTrend(ov) {
    var svg = $('trendChart');
    var days = [];
    var i;
    var sum = 0;
    var max = 1;
    for (i = 6; i >= 0; i--) {
      var d = ENG.addDays(ov.today, -i);
      var ds = ENG.formatDate(d);
      var value = ENG.round2(ov.allAgg.dailyMap[ds] || 0);
      days.push({ date: ds, label: ds.slice(5), value: value, isToday: i === 0 });
      sum += value;
      if (value > max) { max = value; }
    }
    $('trendSum').textContent = '合计 ' + money(sum);

    var W = 320;
    var H = 150;
    var padL = 6;
    var padR = 6;
    var padT = 18;
    var padB = 24;
    var chartW = W - padL - padR;
    var chartH = H - padT - padB;
    var step = chartW / days.length;
    var barW = Math.min(20, step * 0.46);
    var scaleMax = max * 1.15;

    var parts = [];
    parts.push('<line x1="' + padL + '" y1="' + (padT + chartH) + '" x2="' + (W - padR) + '" y2="' + (padT + chartH) +
      '" stroke="#EEF1F4" stroke-width="1"></line>');

    for (i = 0; i < days.length; i++) {
      var day = days[i];
      var cx = padL + step * i + step / 2;
      var h = day.value > 0 ? Math.max(3, day.value / scaleMax * chartH) : 2;
      var y = padT + chartH - h;
      var color = day.isToday ? '#07C160' : '#D7DDE5';
      if (day.isToday && day.value > max * 0.6) { color = '#FF8A3D'; }
      parts.push('<rect x="' + (cx - barW / 2) + '" y="' + y + '" width="' + barW + '" height="' + h +
        '" rx="4" fill="' + color + '"></rect>');
      if (day.value > 0) {
        parts.push('<text x="' + cx + '" y="' + (y - 5) + '" text-anchor="middle" font-size="8.5" fill="#8A93A0">' +
          (day.value >= 1000 ? Math.round(day.value / 100) / 10 + 'k' : Math.round(day.value)) + '</text>');
      }
      parts.push('<text x="' + cx + '" y="' + (H - 7) + '" text-anchor="middle" font-size="9" fill="' +
        (day.isToday ? '#07C160' : '#A9B1BC') + '"' + (day.isToday ? ' font-weight="600"' : '') + '>' +
        (day.isToday ? '今天' : day.label) + '</text>');
    }
    svg.innerHTML = parts.join('');
  }

  function renderBillList() {
    var list = $('billList');
    var sorted = state.bills.slice().sort(function (a, b) {
      if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    var recent = sorted.slice(0, 8);
    if (recent.length === 0) {
      list.innerHTML = '<li class="empty">还没有账单，去左边说一句话吧</li>';
      return;
    }
    var html = '';
    var i;
    for (i = 0; i < recent.length; i++) {
      var b = recent[i];
      var isIncome = b.type === 'income';
      html += '<li class="bill-item">' +
        '<span class="bill-dot" style="background:' + (isIncome ? '#07C160' : categoryColor(b.category)) + '"></span>' +
        '<span class="bill-main">' +
        '<span class="bill-note">' + esc(b.note) + '</span>' +
        '<span class="bill-meta">' + esc(b.date) + ' · ' + esc(isIncome ? '收入' : b.category) + '</span>' +
        '</span>' +
        '<span class="bill-amount' + (isIncome ? ' income' : '') + '">' +
        (isIncome ? '+' : '-') + money(b.amount) + '</span>' +
        '</li>';
    }
    list.innerHTML = html;
  }

  function renderAchievement() {
    var box = $('achieveCard');
    box.innerHTML = '' +
      '<div class="card-head"><h3>我的成就</h3><span class="hint">一点一点攒出来的</span></div>' +
      '<div class="achieve-grid">' +
      '  <div><b>' + state.bills.length + '</b><small>累计记账笔数</small></div>' +
      '  <div><b>' + state.blockedCount + '</b><small>冷静期拦下</small></div>' +
      '  <div><b>' + money(state.savedMoney) + '</b><small>省下的钱</small></div>' +
      '</div>';
  }

  /* ================================================================== */
  /* 简洁版 · 日常型（单功能单屏）渲染                                     */
  /* ================================================================== */

  var SP_QUICK_CATS = ['餐饮', '交通', '购物', '其他'];
  var SP_CAT_ICON = {
    '餐饮': 'i-cat-food', '社交': 'i-cat-social', '购物': 'i-cat-shop', '学习': 'i-cat-study', '交通': 'i-cat-transit',
    '娱乐': 'i-cat-fun', '居住': 'i-cat-home', '医疗': 'i-cat-med', '其他': 'i-cat-other', '收入': 'i-cat-income'
  };
  var simpleListYM = null; /* {y, m} 明细页当前月份 */

  function spIsIncome(b) { return b.type === 'income'; }
  function spCatIcon(cat) {
    var k = SP_CAT_ICON[cat] || 'i-cat-other';
    return '<svg class="cat-ico" viewBox="0 0 24 24"><use href="#' + k + '"/></svg>';
  }
  function spTimeOf(b) {
    if (!b.createdAt) { return ''; }
    var d = new Date(b.createdAt);
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /** 简洁版四屏统一渲染入口（与完整版共用同一套账单/预算数据） */
  function renderSimple() {
    renderSimpleHome();
    renderSimpleList();
    renderSimpleBudget();
    renderSimpleProfile();
    checkRadioGroup('spUiMode', getUiMode());
    /* 停在「省钱」屏时，账本变化（入账 / 打卡）也要同步到面板，避免看到旧数字 */
    if (DOC.body && DOC.body.getAttribute('data-view') === 'ssave') { renderSaveHubPanel(); }
  }

  function spBillListHtml(bills, emptyText) {
    if (!bills.length) { return '<li class="sp-empty">' + esc(emptyText || '暂无记录') + '</li>'; }
    var html = '';
    var i;
    for (i = 0; i < bills.length; i++) {
      var b = bills[i];
      var inc = spIsIncome(b);
      var cat = inc ? '收入' : b.category;
      var title = inc ? (b.source || b.note || '收入') : (b.note || b.category);
      var time = spTimeOf(b);
      html += '<li class="sp-bill">' +
        '<span class="sp-bill-ico" style="background:' + (inc ? '#07C160' : categoryColor(b.category)) + '1f">' + spCatIcon(cat) + '</span>' +
        '<span class="sp-bill-main"><b>' + esc(title) + '</b><small>' +
        (time ? esc(time) + ' · ' : '') + esc(cat) + '</small></span>' +
        '<span class="sp-bill-amt' + (inc ? ' inc' : '') + '">' + (inc ? '+' : '-') + money(b.amount) + '</span>' +
        '</li>';
    }
    return html;
  }

  /** 记账（首页）：剩余金额 + 快捷分类 + 今日流水 */
  function renderSimpleHome() {
    var ov = getOverview();
    var bs = ov.budgetState;
    $('spRemain').textContent = money(bs.remaining);
    $('spDaily').textContent = money(bs.dailyAllowance);
    var d = ov.today;
    var week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    $('spDateLine').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + week + ' · 今天想记点什么？';
    var q = '';
    var i;
    for (i = 0; i < SP_QUICK_CATS.length; i++) {
      var c = SP_QUICK_CATS[i];
      q += '<button type="button" class="sp-q" data-cat="' + esc(c) + '">' +
        '<span class="sp-q-ico" style="background:' + categoryColor(c) + '1f;color:' + categoryColor(c) + '">' + spCatIcon(c) + '</span>' +
        esc(c) + '</button>';
    }
    $('spQuick').innerHTML = q;
    var today = ov.todayStr;
    var todays = state.bills.filter(function (b) { return b.date === today; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    $('spTodayBills').innerHTML = spBillListHtml(todays, '今天还没有记账，点「记一笔」开始吧');
  }

  /** 明细：按月分组流水 + 收支汇总 */
  function renderSimpleList() {
    var now = new Date();
    if (!simpleListYM) { simpleListYM = { y: now.getFullYear(), m: now.getMonth() }; }
    var y = simpleListYM.y, m = simpleListYM.m;
    $('spMonthLabel').textContent = y + '年' + (m + 1) + '月';
    var prefix = y + '-' + (m + 1 < 10 ? '0' : '') + (m + 1) + '-';
    var monthBills = state.bills.filter(function (b) { return b.date.indexOf(prefix) === 0; });
    var exp = 0, inc = 0, i;
    for (i = 0; i < monthBills.length; i++) {
      if (spIsIncome(monthBills[i])) { inc += monthBills[i].amount; } else { exp += monthBills[i].amount; }
    }
    $('spMExpense').textContent = money(ENG.round2(exp));
    $('spMIncome').textContent = money(ENG.round2(inc));
    var byDate = {};
    monthBills.forEach(function (b) { (byDate[b.date] = byDate[b.date] || []).push(b); });
    var dates = Object.keys(byDate).sort().reverse();
    if (!dates.length) {
      $('spListBody').innerHTML = '<div class="sp-empty sp-empty-block">本月还没有记账，记一笔就会出现在这里</div>';
      return;
    }
    var todayStr = ENG.formatDate(new Date());
    var yestStr = ENG.formatDate(new Date(Date.now() - 86400000));
    var html = '';
    for (i = 0; i < dates.length; i++) {
      var ds = dates[i];
      var label = ds === todayStr ? '今天' : (ds === yestStr ? '昨天' : ds);
      var de = 0, di = 0;
      byDate[ds].forEach(function (b) { if (spIsIncome(b)) { di += b.amount; } else { de += b.amount; } });
      var net = ENG.round2(di - de);
      var sumTxt = (net >= 0 ? '+' : '-') + money(Math.abs(net));
      html += '<div class="sp-day"><div class="sp-day-head"><b>' + esc(label) + '</b><span>' + sumTxt + '</span></div>' +
        '<ul class="sp-bills">' + spBillListHtml(byDate[ds].sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })) + '</ul></div>';
    }
    $('spListBody').innerHTML = html;
  }

  /** 预算：环形图 + 分类占比 */
  function renderSimpleBudget() {
    var ov = getOverview();
    var bs = ov.budgetState;
    var total = state.budget.total;
    var spent = ov.cycleAgg.expense;
    var pct = total > 0 ? Math.min(100, Math.round(spent / total * 100)) : 0;
    $('spRingPct').textContent = pct + '%';
    $('spSpent').textContent = money(spent);
    $('spTotal').textContent = money(total);
    $('spBRemain').textContent = money(bs.remaining);
    $('spBDaily').textContent = money(bs.dailyAllowance);
    $('spBDays').textContent = ov.cycle.remainingDays + ' 天';
    var ring = $('spRingBar');
    var C = 2 * Math.PI * 58;
    var ratio = total > 0 ? Math.max(0, Math.min(1, spent / total)) : 0;
    if (ring) {
      ring.style.strokeDasharray = C + ' ' + C;
      ring.style.strokeDashoffset = String(C * (1 - ratio));
      ring.style.stroke = pct >= 90 ? '#EF5350' : (pct >= 70 ? '#FF8A3D' : '#07C160');
    }
    var slices = getCategorySlices(ov.cycleAgg.byCategory);
    var h = '';
    if (!slices.length) { h = '<li class="sp-empty">本周期还没有支出记录</li>'; }
    var i;
    for (i = 0; i < slices.length; i++) {
      var p = spent > 0 ? Math.round(slices[i].value / spent * 100) : 0;
      h += '<li><span class="sp-cb-name"><i class="sp-cb-dot" style="background:' + slices[i].color + '"></i>' + esc(slices[i].key) + '</span>' +
        '<span class="sp-cb-bar"><i style="width:' + p + '%;background:' + slices[i].color + '"></i></span>' +
        '<span class="sp-cb-pct">' + p + '%</span></li>';
    }
    $('spCatBars').innerHTML = h;
  }

  /** 我的：资料卡 + 统计 + 界面风格切换 + 菜单 */
  function renderSimpleProfile() {
    var pf = getSettings().profile || {};
    $('spPAva').textContent = pf.avatar || '我';
    $('spPName').textContent = pf.nickname || '记账小助手';
    var dates = {};
    var i;
    for (i = 0; i < state.bills.length; i++) { dates[state.bills[i].date] = 1; }
    $('spStatDays').textContent = Object.keys(dates).length;
    var now = new Date();
    var prefix = now.getFullYear() + '-' + (now.getMonth() + 1 < 10 ? '0' : '') + (now.getMonth() + 1) + '-';
    var cnt = 0;
    for (i = 0; i < state.bills.length; i++) { if (state.bills[i].date.indexOf(prefix) === 0) { cnt++; } }
    $('spStatCount').textContent = cnt;
    $('spStatSaved').textContent = money(state.savedMoney || 0);
  }

  /** 简洁版各屏事件绑定（在 init 里调用一次） */
  function bindSimpleEvents() {
    $('tabbarSimple').addEventListener('click', function (e) {
      /* 省钱已是普通视图（data-view="ssave"），这里只需处理 data-view，
         不再有弹层分支：切换与高亮统一由 switchView 负责。 */
      var tab = e.target.closest ? e.target.closest('.tab[data-view]') : null;
      if (tab) { switchView(tab.getAttribute('data-view')); }
    });
    $('spBtnAdd').addEventListener('click', function () { openQuickAddModal(); });
    $('spBtnAi').addEventListener('click', function () { switchView('sai'); });
    $('spBtnMe').addEventListener('click', function () { switchView('sprofile'); });
    $('spQuick').addEventListener('click', function (e) {
      var q = e.target.closest ? e.target.closest('.sp-q[data-cat]') : null;
      if (q) { openQuickAddModal(q.getAttribute('data-cat')); }
    });
    $('spMonthPrev').addEventListener('click', function () {
      simpleListYM.m--; if (simpleListYM.m < 0) { simpleListYM.m = 11; simpleListYM.y--; }
      renderSimpleList();
    });
    $('spMonthNext').addEventListener('click', function () {
      simpleListYM.m++; if (simpleListYM.m > 11) { simpleListYM.m = 0; simpleListYM.y++; }
      renderSimpleList();
    });
    $('spBtnBudget').addEventListener('click', openDrawer);
    $('spMenuBudget').addEventListener('click', openDrawer);
    $('spMenuCoach').addEventListener('click', function () { switchView('scoach'); });
    $('spMenuGoals').addEventListener('click', function () { switchView('sgoals'); });
    $('spGoalsBack').addEventListener('click', function () { goBackView(); });
    $('spMenuExport').addEventListener('click', function () { exportAllCsv(); });
    $('spMenuAi').addEventListener('click', function () { switchView('sai'); });
    $('spMenuSaveHub').addEventListener('click', function () { switchView('ssave'); });
    $('spMenuAbout').addEventListener('click', openTermsModal);
    $('btnAiBack').addEventListener('click', function () { goBackView(); });
    $('spUiSeg').addEventListener('change', function (e) {
      var input = (e.target && e.target.closest) ? e.target.closest('input[name="spUiMode"]') : null;
      if (!input) { return; }
      setUiMode(input.value);
    });
  }

  /* ================================================================== */
  /* 目标池                                                              */
  /* ================================================================== */

  function renderGoals() {
    var list = $('goalList');
    var ov = getOverview();
    if (state.goals.length === 0) {
      list.innerHTML = '<div class="empty">还没有目标，点右上角「+ 新目标」加一个吧</div>';
      return;
    }
    var html = '';
    var i;
    for (i = 0; i < state.goals.length; i++) {
      var g = state.goals[i];
      var p = ENG.getGoalProjection(g, ov.monthlySurplus, ov.today);
      var tip;
      var warnCls = '';
      if (p.need <= 0) {
        tip = '🎉 已达成目标，还多存了 ' + money(Math.max(0, g.saved - g.target)) + '。';
      } else if (p.monthsLeft === null) {
        tip = '当前月结余为负，先让结余转正，再谈攒钱。';
        warnCls = ' warn';
      } else {
        tip = '按当前速度还需约 ' + p.monthsLeft + ' 个月';
        if (p.monthsToDeadline !== null) {
          tip += '（距目标日还有 ' + p.monthsToDeadline + ' 个月）';
        }
        if (p.lateMonths !== null && p.lateMonths > 0) {
          tip += '，按当前速度会晚 ' + p.lateMonths + ' 个月，建议每月多存 ' + money(p.extraPerMonth) + '。';
          warnCls = ' warn';
        } else {
          tip += '，节奏刚好。';
        }
      }

      html += '<div class="goal-item">' +
        '<div class="goal-top">' +
        '<span class="goal-name">' + esc(g.name) + '</span>' +
        '<span class="goal-actions">' +
        '<button type="button" class="btn-mini" data-goal-add="' + esc(g.id) + '">+ 存钱</button>' +
        '<button type="button" class="goal-del" data-goal-del="' + esc(g.id) + '" title="删除目标"><svg viewBox="0 0 24 24"><use href="#i-trash"/></svg></button>' +
        '</span>' +
        '</div>' +
        '<div class="goal-bar"><i style="width:' + p.percent + '%"></i></div>' +
        '<div class="goal-meta">' +
        '<span><b>' + money(g.saved) + '</b> / ' + money(g.target) + '</span>' +
        '<span>' + p.percent.toFixed(1) + '%</span>' +
        '</div>' +
        '<div class="goal-tip' + warnCls + '">' + esc(tip) + '</div>' +
        '</div>';
    }
    list.innerHTML = html;
  }

  function findGoal(id) {
    var i;
    for (i = 0; i < state.goals.length; i++) {
      if (state.goals[i].id === id) { return state.goals[i]; }
    }
    return null;
  }

  /* ================================================================== */
  /* 弹窗                                                                */
  /* ================================================================== */

  function openModal(html) {
    var mask = $('modalMask');
    var box = $('modalBox');
    box.innerHTML = html;
    mask.hidden = false;
    return box;
  }

  function closeModal() {
    var mask = $('modalMask');
    var box = $('modalBox');
    mask.hidden = true;
    box.innerHTML = '';
  }

  /** 轻提示 Toast：2.4s 自动消失（设计稿三型：ok / warn / danger） */
  function showToast(text, type) {
    var root = $('toastRoot');
    if (!root) { return; }
    var el = DOC.createElement('div');
    el.className = 'toast ' + (type === 'warn' ? 'warn' : (type === 'danger' ? 'danger' : 'ok'));
    el.textContent = text;
    root.appendChild(el);
    setTimeout(function () {
      el.classList.add('leaving');
      setTimeout(function () {
        if (el.parentNode) { el.parentNode.removeChild(el); }
      }, 280);
    }, 2400);
  }

  /**
   * 快捷记账面板（顶栏「＋ 记一笔」）：金额 / 分类 / 备注 / 日期。
   * 直接走 commitBill 落账，提交后聊天空出回执、预算条即时刷新。
   */
  function openQuickAddModal(presetCategory) {
    var todayStr = ENG.formatDate(new Date());
    var options = '';
    var i;
    for (i = 0; i < DATA.CATEGORIES.length; i++) {
      options += '<option value="' + esc(DATA.CATEGORIES[i].key) + '">' + esc(DATA.CATEGORIES[i].key) + '</option>';
    }
    var box = openModal('' +
      '<h4>记一笔</h4>' +
      '<p>金额和分类必填，备注可选。记完预算条会立刻更新。</p>' +
      '<label class="field"><span>金额（¥）</span><input id="qaAmount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00" /></label>' +
      '<label class="field"><span>分类</span><select id="qaCategory">' + options + '</select></label>' +
      '<label class="field"><span>备注</span><input id="qaNote" type="text" placeholder="例如：黄焖鸡米饭" maxlength="30" /></label>' +
      '<label class="field"><span>日期</span><input id="qaDate" type="date" value="' + todayStr + '" /></label>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-ok" data-act="quick-add-save">记好了</button>' +
      '</div>');

    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="quick-add-save"]').addEventListener('click', function () {
      var amount = Number(box.querySelector('#qaAmount').value);
      if (!isFinite(amount) || amount <= 0) {
        showToast('请先填写有效金额', 'warn');
        box.querySelector('#qaAmount').focus();
        return;
      }
      var category = box.querySelector('#qaCategory').value;
      var note = box.querySelector('#qaNote').value.trim();
      var date = box.querySelector('#qaDate').value || todayStr;
      var bill = commitBill({ amount: amount, category: category, note: note, date: date });
      closeModal();
      var ov = getOverview();
      addAIMessage(aiBubble('已记下 <b>' + money(bill.amount) + '</b>（' + esc(category) +
        (note ? ' · ' + esc(note) : '') + '）。本周期还剩 <b>' + money(ov.budgetState.remaining) +
        '</b>，日均可用 <b>' + money(ov.budgetState.dailyAllowance) + '</b>。'));
      renderAll();
      showToast('已记下 ' + money(bill.amount), 'ok');
    });
    setTimeout(function () {
      var amountInput = box.querySelector('#qaAmount');
      if (amountInput) { amountInput.focus(); }
      if (presetCategory) {
        var catSel = box.querySelector('#qaCategory');
        if (catSel) { catSel.value = presetCategory; }
      }
    }, 50);
  }

  /** 点击常驻预算条 → 切到看板并高亮「预算焦点卡」 */
  function focusBudgetCard() {
    switchView('dash');
    var card = DOC.querySelector('#panelDash .card-budget');
    if (!card) { return; }
    card.classList.remove('flash');
    void card.offsetWidth; /* 重置 CSS 动画 */
    card.classList.add('flash');
    if (typeof card.scrollIntoView === 'function') {
      try {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (e) {
        card.scrollIntoView();
      }
    }
  }

  function openGoalModal() {
    var todayStr = ENG.formatDate(new Date());
    var box = openModal('' +
      '<h4>新的理财目标</h4>' +
      '<p>给它一个名字，设定金额和日期，我帮你算每月该存多少。</p>' +
      '<label class="field"><span>目标名称</span><input id="gName" type="text" placeholder="例如：相机 / 旅行 / iPad" /></label>' +
      '<label class="field"><span>目标金额（¥）</span><input id="gTarget" type="number" min="1" step="10" inputmode="decimal" /></label>' +
      '<label class="field"><span>已攒金额（¥）</span><input id="gSaved" type="number" min="0" step="10" inputmode="decimal" value="0" /></label>' +
      '<label class="field"><span>目标日期</span><input id="gDeadline" type="date" min="' + todayStr + '" value="' + todayStr + '" /></label>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-ok" data-act="goal-save">保存</button>' +
      '</div>');

    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="goal-save"]').addEventListener('click', function () {
      var name = box.querySelector('#gName').value.trim();
      var target = Number(box.querySelector('#gTarget').value);
      var saved = Number(box.querySelector('#gSaved').value);
      var deadline = box.querySelector('#gDeadline').value;
      if (!name) {
        box.querySelector('#gName').focus();
        return;
      }
      if (!isFinite(target) || target <= 0) {
        box.querySelector('#gTarget').focus();
        return;
      }
      state.goals.push({
        id: uid('goal'),
        name: name,
        target: ENG.round2(target),
        saved: isFinite(saved) && saved > 0 ? ENG.round2(saved) : 0,
        deadline: /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : ''
      });
      saveState();
      closeModal();
      renderGoals();
      addAIMessage(aiBubble('目标「' + esc(name) + '」已建好，目标 ' + money(target) + '。我会在每个记账日帮你盯着进度。'));
    });
    var nameInput = box.querySelector('#gName');
    if (nameInput) { nameInput.focus(); }
  }

  function openDepositModal(goalId) {
    var goal = findGoal(goalId);
    if (!goal) { return; }
    var need = ENG.round2(Math.max(0, goal.target - goal.saved));
    var box = openModal('' +
      '<h4>给「' + esc(goal.name) + '」存一笔</h4>' +
      '<p>还差 ' + money(need) + ' 就能达成目标。</p>' +
      '<label class="field"><span>本次存入金额（¥）</span><input id="dAmount" type="number" min="1" step="10" inputmode="decimal" /></label>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-ok" data-act="deposit-save">存入</button>' +
      '</div>');

    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="deposit-save"]').addEventListener('click', function () {
      var amount = Number(box.querySelector('#dAmount').value);
      if (!isFinite(amount) || amount <= 0) {
        box.querySelector('#dAmount').focus();
        return;
      }
      goal.saved = ENG.round2(goal.saved + amount);
      saveState();
      closeModal();
      renderGoals();
      var left = ENG.round2(Math.max(0, goal.target - goal.saved));
      addAIMessage(aiBubble('已存入 ' + money(amount) + '，目标「' + esc(goal.name) + '」现在攒到 ' +
        money(goal.saved) + '，' + (left > 0 ? '还差 ' + money(left) + '。' : '已经达成啦 🎉')));
    });
    var input = box.querySelector('#dAmount');
    if (input) { input.focus(); }
  }

  function confirmReset() {
    var box = openModal('' +
      '<h4>重置演示数据？</h4>' +
      '<p>会清空当前所有账单、目标与成就，并重新灌入一套演示数据。此操作不可撤销。</p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-danger" data-act="reset-ok">确认重置</button>' +
      '</div>');
    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="reset-ok"]').addEventListener('click', function () {
      state = seedState();
      highlightCategory = null;
      undoStack = [];
      saveState();
      closeModal();
      renderAll();
      addAIMessage(aiBubble('演示数据已经重置好了，账单、目标、成就都回到了初始状态。'));
    });
  }

  /* ================================================================== */
  /* 设置抽屉                                                            */
  /* ================================================================== */

  function openDrawer() {
    $('setTotal').value = String(state.budget.total);
    $('setPayday').value = String(state.budget.payday);
    $('setCooldown').value = String(state.budget.cooldownThreshold);
    renderCycleInfo();
    var cred = OCR.getCredentials();
    $('setOcrId').value = cred.secretId || '';
    $('setOcrKey').value = cred.secretKey || '';
    $('setOcrRegion').value = cred.region || 'ap-guangzhou';
    renderOcrState();
    var mask = $('drawerMask');
    mask.hidden = false;
    setTimeout(function () {
      mask.classList.add('show');
      $('settingsDrawer').classList.add('open');
      $('settingsDrawer').setAttribute('aria-hidden', 'false');
    }, 10);
  }

  /** 设置抽屉顶部的周期说明 */
  function renderCycleInfo() {
    var ov = getOverview();
    var el = $('cycleInfo');
    if (el) {
      el.textContent = '本周期：' + ov.cycle.start + ' ~ ' + ov.cycle.end +
        (ov.cycle.isCustom ? '（自定义起点）' : '（按发钱日 ' + state.budget.payday + ' 号）');
    }
    var resetBtn = $('btnCycleReset');
    if (resetBtn) {
      if (ov.cycle.isCustom) {
        resetBtn.removeAttribute('hidden');
      } else {
        resetBtn.setAttribute('hidden', 'hidden');
      }
    }
  }

  /** 云 OCR 凭据状态文案 */
  function renderOcrState() {
    var el = $('ocrState');
    if (!el) { return; }
    var cap = OCR.capabilities();
    el.textContent = cap.cloud
      ? '当前：已配置云 OCR（' + (OCR.getCredentials().region || 'ap-guangzhou') + '）'
      : '当前：未配置云 OCR（不会发网络请求）。不配置时，截屏识别只能用示例小票或手动录入。';
  }

  function saveOcrCredentials() {
    var id = String($('setOcrId').value || '').trim();
    var key = String($('setOcrKey').value || '').trim();
    var region = String($('setOcrRegion').value || '').trim() || 'ap-guangzhou';
    if (!id || !key) {
      $('ocrState').textContent = 'SecretId 与 SecretKey 都要填，否则云端识别不可用。';
      return;
    }
    var ok = OCR.saveCredentials({ secretId: id, secretKey: key, region: region });
    renderOcrState();
    if (!ok) {
      $('ocrState').textContent = '已存在内存里，但写入 localStorage 失败（可能是隐私模式），关掉页面就失效。';
    }
  }

  function clearOcrCredentials() {
    OCR.clearCredentials();
    $('setOcrId').value = '';
    $('setOcrKey').value = '';
    $('setOcrRegion').value = '';
    renderOcrState();
  }

  function closeDrawer() {
    var mask = $('drawerMask');
    mask.classList.remove('show');
    $('settingsDrawer').classList.remove('open');
    $('settingsDrawer').setAttribute('aria-hidden', 'true');
    setTimeout(function () { mask.hidden = true; }, 220);
  }

  function saveSettings() {
    var total = Number($('setTotal').value);
    var payday = Number($('setPayday').value);
    var cooldown = Number($('setCooldown').value);
    state.budget.total = clampNumber(total, 0, 9999999, state.budget.total);
    state.budget.payday = Math.round(clampNumber(payday, 1, 28, state.budget.payday));
    state.budget.cooldownThreshold = clampNumber(cooldown, 0, 9999999, state.budget.cooldownThreshold);
    saveState();
    closeDrawer();
    renderAll();
    var ov = getOverview();
    addAIMessage(aiBubble('设置已更新：生活费 ' + money(state.budget.total) + '，发钱日 ' +
      state.budget.payday + ' 号，冷静期阈值 ' + money(state.budget.cooldownThreshold) +
      '。当前周期 ' + esc(ov.cycle.start) + ' ~ ' + esc(ov.cycle.end) +
      (ov.cycle.isCustom ? '（自定义起点）' : '') + '，看板已重算。'));
    showToast('设置已保存，预算已重算', 'ok');
  }

  /* ================================================================== */
  /* 完整设置界面（setPage* / setGroup*，与预算抽屉相互独立）             */
  /* ================================================================== */

  /** 可选头像（emoji，演示用） */
  var PROFILE_AVATARS = ['🙂', '😎', '🐶', '🐱', '🐰', '🦊', '🐼', '🦉', '🌟', '💰'];
  /** 字体大小档位 -> body 上的 class（样式在 styles.css） */
  var FONT_SCALE_CLASS = { sm: 'font-scale-sm', md: '', lg: 'font-scale-lg', xl: 'font-scale-xl' };
  /** 应用版本号（关于页展示 & 检查更新提示） */
  var APP_VERSION = 'v1.0.0';
  /** 反馈本地存储 key */
  var FEEDBACK_KEY = 'ledger.feedback';

  /* 系统深色偏好监听（深色模式选「跟随系统」时用） */
  var themeMediaQuery = null;
  try {
    themeMediaQuery = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
  } catch (e) {
    themeMediaQuery = null;
  }

  /** 取当前设置（带默认值兜底，旧存档没有 settings 也能用） */
  function getSettings() {
    if (!state || typeof state !== 'object') { return normalizeSettings(null); }
    if (!state.settings || typeof state.settings !== 'object') {
      state.settings = normalizeSettings(null);
    }
    return state.settings;
  }

  /** 归一化设置、持久化、应用外观并刷新设置页 */
  function persistSettings() {
    state.settings = normalizeSettings(state.settings);
    saveState();
    applyAppearance();
    renderSettingsPage();
  }

  /** 当前生效的主题：system 时跟随系统偏好 */
  function resolveTheme() {
    var mode = getSettings().theme;
    if (mode === 'dark') { return 'dark'; }
    if (mode === 'light') { return 'light'; }
    if (themeMediaQuery && typeof themeMediaQuery.matches === 'boolean') {
      return themeMediaQuery.matches ? 'dark' : 'light';
    }
    return 'light';
  }

  /** 把主题与字体档位应用到 <html data-theme> / body class 上 */
  function applyAppearance() {
    var root = DOC.documentElement;
    if (root) { root.setAttribute('data-theme', resolveTheme()); }
    var body = DOC.body;
    if (!body) { return; }
    body.classList.remove('font-scale-sm', 'font-scale-lg', 'font-scale-xl');
    var cls = FONT_SCALE_CLASS[getSettings().fontScale];
    if (cls) { body.classList.add(cls); }
  }

  /** 取当前 UI 类型（简洁版 / 完整版），缺省回退到完整版 */
  function getUiMode() {
    return (state && state.uiMode === 'simple') ? 'simple' : 'full';
  }

  /** 把 UI 类型应用到 <body data-ui-mode>，并在两套界面间切换到合法默认视图 */
  function applyUiMode() {
    var mode = getUiMode();
    DOC.body.setAttribute('data-ui-mode', mode);
    mountShellPanels();
    var v = DOC.body.getAttribute('data-view');
    var ok = (mode === 'simple') ? SIMPLE_VIEWS[v] : FULL_VIEWS[v];
    if (!ok) { switchView(mode === 'simple' ? 'shome' : 'chat'); }
    renderSimple();
  }

  /** 双 UI 挂载：简洁版把聊天面板、专家面板、省钱面板、目标卡移进简洁外壳
   *  （分别作为 AI 对话记账 / 理财专家 / 省钱 / 攒钱目标四屏）；完整版移回双栏布局原位与弹层里。
   *  节点移动不破坏其内部事件绑定与按 ID 的渲染。 */
  function mountShellPanels() {
    var simple = (getUiMode() === 'simple');
    var chat = $('panelChat');
    var coach = $('panelCoach');
    var goal = $('goalCard');
    var shell = $('simpleShell');
    var layout = $('panelDash') && $('panelDash').parentNode;
    var dashScroll = $('panelDash') && $('panelDash').querySelector('.dash-scroll');
    var goalsBody = $('spGoalsBody');
    var saveSheet = $('saveHubSheet');
    var saveBody = $('spSaveBody');
    var saveMask = $('saveHubMask');
    if (simple && shell) {
      if (chat && chat.parentNode !== shell) { shell.insertBefore(chat, $('tabbarSimple')); }
      if (coach && coach.parentNode !== shell) { shell.insertBefore(coach, $('tabbarSimple')); }
      if (goal && goalsBody && goal.parentNode !== goalsBody) { goalsBody.appendChild(goal); }
      /* 省钱面板：简洁版是独立页面，整块搬进 #spSaveBody（不再是弹层）。
         搬走后遮罩里就没有内容，必须强制收起，否则会留下空遮罩盖住页面。 */
      if (saveSheet && saveBody) {
        if (saveSheet.parentNode !== saveBody) { saveBody.appendChild(saveSheet); }
        /* 作为普通区块时它不是模态对话框，避免读屏软件报「模态」 */
        saveSheet.setAttribute('aria-modal', 'false');
        if (saveMask) { saveMask.hidden = true; }
      }
    } else if (layout) {
      if (chat && chat.parentNode !== layout) { layout.insertBefore(chat, $('panelDash')); }
      if (coach && coach.parentNode !== layout) { layout.appendChild(coach); }
      if (goal && dashScroll && goal.parentNode !== dashScroll) { dashScroll.appendChild(goal); }
      /* 完整版：省钱面板回到遮罩里，恢复弹层语义 */
      if (saveSheet) {
        if (saveMask && saveSheet.parentNode !== saveMask) { saveMask.appendChild(saveSheet); }
        saveSheet.setAttribute('aria-modal', 'true');
      }
    }
  }

  /** 切换 UI 类型并持久化（共用同一套账单数据，切换不丢数据） */
  function setUiMode(mode) {
    if (mode !== 'simple' && mode !== 'full') { return; }
    if (!state) { return; }
    state.uiMode = mode;
    // 两套界面的视图互不通用，清空历史避免「返回」落到另一套界面的视图上
    viewHistory.length = 0;
    saveState();
    applyUiMode();
    showToast(mode === 'simple' ? '已切换到简洁版（日常型）' : '已切换到完整版（报表型）', 'ok');
  }

  /** 系统深色偏好变化时，若设置为「跟随系统」则实时切换 */
  function onSystemThemeChange() {
    if (getSettings().theme === 'system') { applyAppearance(); }
  }

  function openSettingsPage() {
    renderSettingsPage();
    $('settingsMask').hidden = false;
  }

  function closeSettingsPage() {
    $('settingsMask').hidden = true;
  }

  /** 单选组（radio）按值勾选 */
  function checkRadioGroup(name, value) {
    var inputs = DOC.querySelectorAll('input[name="' + name + '"]');
    var i;
    for (i = 0; i < inputs.length; i++) {
      inputs[i].checked = (inputs[i].value === value);
    }
  }

  /** 按当前 state.settings 刷新设置页各控件的显示值 */
  function renderSettingsPage() {
    var st = getSettings();
    $('setProfileValue').textContent = st.profile.nickname;
    $('setProfileDesc').textContent = '当前头像 ' + st.profile.avatar + ' · 点击修改';
    $('setSwitchPush').checked = st.notify.push;
    $('setSwitchRemind').checked = st.notify.remind;
    $('setSwitchOverspend').checked = st.notify.overspend;
    checkRadioGroup('setThemeMode', st.theme);
    checkRadioGroup('setFontScale', st.fontScale);
    checkRadioGroup('setLang', st.lang);
    checkRadioGroup('setUiMode', state.uiMode);
    $('setSwitchAlbum').checked = st.privacy.album;
    $('setSwitchClipboard').checked = st.privacy.clipboard;
    $('setCacheValue').textContent = estimateCacheSize();
  }

  /** 设置页所有事件绑定（在 bindEvents 里调用一次） */
  function bindSettingsEvents() {
    $('btnCloseSetPage').addEventListener('click', closeSettingsPage);
    $('settingsMask').addEventListener('click', function (e) {
      if (e.target === $('settingsMask')) { closeSettingsPage(); }
    });

    /* ---- 账号与安全 ---- */
    $('rowSetProfile').addEventListener('click', openProfileModal);
    $('rowSetBind').addEventListener('click', function () {
      showToast('演示版本暂不支持真实绑定');
    });
    $('rowSetPassword').addEventListener('click', function () {
      showToast('演示版本暂不支持修改密码');
    });

    /* ---- 通用与偏好：三个通知开关 ---- */
    $('setSwitchPush').addEventListener('change', function () {
      getSettings().notify.push = this.checked;
      persistSettings();
    });
    $('setSwitchRemind').addEventListener('change', function () {
      getSettings().notify.remind = this.checked;
      persistSettings();
    });
    $('setSwitchOverspend').addEventListener('change', function () {
      getSettings().notify.overspend = this.checked;
      persistSettings();
    });

    /* ---- 深色模式 / 字体大小 / 语言：分段单选（change 会冒泡） ---- */
    $('setThemeSeg').addEventListener('change', function (e) {
      var input = (e.target && e.target.closest) ? e.target.closest('input[name="setThemeMode"]') : null;
      if (!input) { return; }
      getSettings().theme = input.value;
      persistSettings();
      showToast(input.value === 'dark' ? '已切换到深色模式'
        : (input.value === 'light' ? '已切换到浅色模式' : '深色模式：跟随系统'));
    });
    $('setFontSeg').addEventListener('change', function (e) {
      var input = (e.target && e.target.closest) ? e.target.closest('input[name="setFontScale"]') : null;
      if (!input) { return; }
      getSettings().fontScale = input.value;
      persistSettings();
      showToast('字体大小已切换');
    });
    $('setLangSeg').addEventListener('change', function (e) {
      var input = (e.target && e.target.closest) ? e.target.closest('input[name="setLang"]') : null;
      if (!input) { return; }
      getSettings().lang = input.value;
      persistSettings();
      if (input.value === 'en') { showToast('演示版本暂仅支持简体中文'); }
    });
    $('setUiModeSeg').addEventListener('change', function (e) {
      var input = (e.target && e.target.closest) ? e.target.closest('input[name="setUiMode"]') : null;
      if (!input) { return; }
      setUiMode(input.value);
    });

    /* ---- 数据与隐私 ---- */
    $('rowSetCache').addEventListener('click', clearAppCache);
    $('setSwitchAlbum').addEventListener('change', function () {
      getSettings().privacy.album = this.checked;
      persistSettings();
      showToast(this.checked ? '已允许读取相册' : '已关闭读取相册，截屏记账将不可用');
    });
    $('setSwitchClipboard').addEventListener('change', function () {
      getSettings().privacy.clipboard = this.checked;
      persistSettings();
    });
    $('rowSetTerms').addEventListener('click', openTermsModal);
    $('rowSetExport').addEventListener('click', exportPersonalInfo);
    $('rowSetDeleteAccount').addEventListener('click', confirmDeleteAccount);

    /* ---- 帮助与反馈 / 关于 ---- */
    $('btnSetFeedback').addEventListener('click', submitSettingsFeedback);
    $('btnSetCheckUpdate').addEventListener('click', function () {
      showToast('已是最新版本（演示）· ' + APP_VERSION);
    });

    /* 系统深色偏好变化（兼容旧版 Safari 的 addListener） */
    if (themeMediaQuery) {
      if (typeof themeMediaQuery.addEventListener === 'function') {
        themeMediaQuery.addEventListener('change', onSystemThemeChange);
      } else if (typeof themeMediaQuery.addListener === 'function') {
        themeMediaQuery.addListener(onSystemThemeChange);
      }
    }
  }

  /** 头像与昵称编辑弹层 */
  function openProfileModal() {
    var st = getSettings();
    var avatars = PROFILE_AVATARS.map(function (a) {
      return '<button type="button" class="avatar-pick' + (a === st.profile.avatar ? ' active' : '') +
        '" data-avatar="' + a + '" aria-label="选择头像">' + a + '</button>';
    }).join('');
    var box = openModal('' +
      '<h4>头像与昵称</h4>' +
      '<p>选一个喜欢的头像，再取个昵称。</p>' +
      '<div class="avatar-picker" id="avatarPicker">' + avatars + '</div>' +
      '<label class="field"><span>昵称（最多 12 个字）</span>' +
      '<input id="setNickInput" type="text" maxlength="12" value="' + esc(st.profile.nickname) + '" /></label>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-ok" data-act="profile-save">保存</button>' +
      '</div>');
    var picked = st.profile.avatar;
    box.querySelector('#avatarPicker').addEventListener('click', function (e) {
      var btn = (e.target && e.target.closest) ? e.target.closest('[data-avatar]') : null;
      if (!btn) { return; }
      picked = btn.getAttribute('data-avatar');
      var all = box.querySelectorAll('.avatar-pick');
      var i;
      for (i = 0; i < all.length; i++) { all[i].classList.remove('active'); }
      btn.classList.add('active');
    });
    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="profile-save"]').addEventListener('click', function () {
      var name = String(box.querySelector('#setNickInput').value || '').trim();
      if (!name) {
        box.querySelector('#setNickInput').focus();
        showToast('昵称不能为空');
        return;
      }
      st.profile.nickname = name.slice(0, 12);
      st.profile.avatar = picked;
      persistSettings();
      closeModal();
      showToast('资料已更新');
    });
    var input = box.querySelector('#setNickInput');
    if (input) { input.focus(); }
  }

  /** 用户协议与隐私政策（演示占位文本） */
  function openTermsModal() {
    openModal('' +
      '<h4>用户协议与隐私政策</h4>' +
      '<p>【演示占位文本】本应用为「AI 记账 · 创新应用大赛」参赛作品，仅用于功能演示。</p>' +
      '<p>1. 所有账单、目标与设置数据仅保存在你的浏览器 localStorage 中，不上传服务器。</p>' +
      '<p>2. 截屏识别功能会将图片发送至第三方云服务做文字识别，请勿上传含敏感信息的图片。</p>' +
      '<p>3. AI 给出的记账建议仅供参考，不构成专业理财或投资建议。</p>' +
      '<p>4. 正式版本的协议与隐私政策以线上页面为准。</p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-ok" data-act="modal-cancel">我知道了</button>' +
      '</div>');
  }

  /** 估算非账本缓存占用（主账本 key 不计入；UTF-16 粗估 2 字节/字符） */
  function estimateCacheSize() {
    var total = 0;
    try {
      var keys = Object.keys(global.localStorage);
      var i;
      for (i = 0; i < keys.length; i++) {
        if (keys[i] === STORAGE_KEY) { continue; }
        var val = global.localStorage.getItem(keys[i]);
        total += (keys[i].length + (val ? val.length : 0)) * 2;
      }
    } catch (e) {
      return '—';
    }
    if (total < 1024) { return total + ' B'; }
    return (total / 1024).toFixed(1) + ' KB';
  }

  /** 清理缓存：只删账本主 key 之外的本地数据，账本绝不碰 */
  function clearAppCache() {
    var removed = 0;
    try {
      var keys = Object.keys(global.localStorage);
      var i;
      for (i = 0; i < keys.length; i++) {
        if (keys[i] === STORAGE_KEY) { continue; }
        global.localStorage.removeItem(keys[i]);
        removed++;
      }
    } catch (e) {
      showToast('清理失败：当前浏览器不允许操作本地存储');
      return;
    }
    $('setCacheValue').textContent = estimateCacheSize();
    showToast(removed > 0 ? '已清理 ' + removed + ' 项缓存，账本数据完好' : '当前没有可清理的缓存');
  }

  /** 意见反馈：存 localStorage（ledger.feedback 数组），仅本地演示 */
  function submitSettingsFeedback() {
    var input = $('setFeedbackInput');
    var text = String(input.value || '').trim();
    if (!text) {
      showToast('先写点建议再提交吧');
      input.focus();
      return;
    }
    var list = [];
    try {
      var raw = global.localStorage.getItem(FEEDBACK_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) { list = parsed; }
    } catch (e) {
      list = [];
    }
    list.push({ text: text.slice(0, 500), at: new Date().toISOString() });
    try {
      global.localStorage.setItem(FEEDBACK_KEY, JSON.stringify(list));
      input.value = '';
      $('setCacheValue').textContent = estimateCacheSize();
      showToast('已收到反馈（本地演示）');
    } catch (e2) {
      showToast('保存失败：当前浏览器不支持本地存储');
    }
  }

  /** 个人信息导出：账本统计概览 + 设置，不含账单明细与敏感信息 */
  function exportPersonalInfo() {
    var ov = getOverview();
    var st = getSettings();
    var payload = {
      app: 'AI 校园记账管家',
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      overview: {
        billCount: state.bills.length,
        cycleStart: ov.cycle.start,
        cycleEnd: ov.cycle.end,
        budgetTotal: state.budget.total,
        cycleExpense: ov.cycleAgg.expense,
        cycleIncome: ov.cycleAgg.income,
        goalCount: state.goals.length
      },
      settings: {
        profile: st.profile,
        theme: st.theme,
        fontScale: st.fontScale,
        lang: st.lang,
        notify: st.notify,
        privacy: st.privacy
      }
    };
    downloadJson('personal-info.json', payload);
  }

  /** 注销账号：二次确认后清空 localStorage 全部数据并刷新 */
  function confirmDeleteAccount() {
    var box = openModal('' +
      '<h4>注销账号？</h4>' +
      '<p>将清空本机所有数据（账单、目标、设置、反馈），并刷新页面。此操作不可撤销。</p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-danger" data-act="delete-ok">确认注销</button>' +
      '</div>');
    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="delete-ok"]').addEventListener('click', function () {
      try {
        global.localStorage.clear();
      } catch (e) { /* 隐私模式下忽略，依旧执行刷新 */ }
      closeModal();
      closeSettingsPage();
      global.location.reload();
    });
  }

  /** 下载 JSON 文件 */
  function downloadJson(filename, obj) {
    try {
      var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
      var url = global.URL.createObjectURL(blob);
      var a = DOC.createElement('a');
      a.href = url;
      a.download = filename;
      DOC.body.appendChild(a);
      a.click();
      DOC.body.removeChild(a);
      setTimeout(function () { global.URL.revokeObjectURL(url); }, 5000);
      showToast('已导出个人信息 JSON（不含账单明细与敏感信息）');
    } catch (e) {
      showToast('导出失败：当前浏览器不支持文件下载');
    }
  }

  /* 轻提示统一走 toastRoot 容器版 showToast（三型：ok / warn / danger） */

  /* ================================================================== */
  /* 快捷指令响应                                                        */
  /* ================================================================== */

  function showBalanceCard() {
    var ov = getOverview();
    var bs = ov.budgetState;
    var ratio = state.budget.total > 0 ? Math.max(0, Math.min(100, bs.remaining / state.budget.total * 100)) : 0;
    var barColor = bs.status === 'danger' ? '#EF5350' : (bs.status === 'tight' ? '#FF8A3D' : '#07C160');
    var html = '' +
      '<div class="bubble ai">帮你查了下这个周期（' + esc(ov.cycle.start) + ' ~ ' + esc(ov.cycle.end) + '）👇</div>' +
      '<div class="bill-card">' +
      '  <div class="bill-card-head"><span>周期剩余 / 总预算</span><span>还剩 ' + ov.cycle.remainingDays + ' 天</span></div>' +
      '  <div class="bill-card-main">' +
      '    <span class="bill-card-note">' + money(bs.remaining) + ' / ' + money(state.budget.total) + '</span>' +
      '  </div>' +
      '  <div class="engel-bar" style="margin-top:9px"><i style="width:' + ratio + '%;background:' + barColor + '"></i></div>' +
      '  <div class="bill-card-tags">' +
      '    <span class="tag green">日均可用 ' + money(bs.dailyAllowance) + '</span>' +
      '    <span class="tag">今日已花 ' + money(bs.todaySpent) + '</span>' +
      '    <span class="tag">今天还能花 ' + money(bs.todayRemain) + '</span>' +
      '  </div>' +
      '</div>';
    addAIMessage(html);
    addAIMessage(aiBubble(ov.sentence));
  }

  function showPieCard() {
    var ov = getOverview();
    var slices = getCategorySlices(ov.cycleAgg.byCategory);
    if (slices.length === 0) {
      addAIMessage(aiBubble('本周期还没记账呢，先记一笔我就能画饼图了。'));
      return;
    }
    var svg = '<svg viewBox="0 0 100 100">' +
      '<g transform="rotate(-90 50 50)">' + donutSvgHtml(slices, 100, 20, 100) + '</g></svg>';
    var legend = '';
    var i;
    for (i = 0; i < slices.length && i < 6; i++) {
      var pct = ov.cycleAgg.expense > 0 ? (slices[i].value / ov.cycleAgg.expense * 100) : 0;
      legend += '<div><i style="background:' + slices[i].color + '"></i>' + esc(slices[i].key) +
        ' ' + money(slices[i].value) + '（' + pct.toFixed(0) + '%）</div>';
    }
    var html = '<div class="mini-pie">' + svg + '<div class="mini-pie-legend">' + legend + '</div></div>';
    addAIMessage(html);

    var top = slices[0];
    var topPct = ov.cycleAgg.expense > 0 ? (top.value / ov.cycleAgg.expense * 100) : 0;
    addAIMessage(aiBubble('本周期一共花了 ' + money(ov.cycleAgg.expense) + '，最大头是 <span class="hl">' +
      esc(top.key) + '</span>（' + money(top.value) + '，占 ' + topPct.toFixed(0) + '%）。' +
      (ov.engel.alert ? '餐饮占比偏高，注意别把社交预算吃掉。' : '结构还算健康。')));
  }

  function showEntryGuide() {
    var html = '' +
      '<div class="bubble ai">直接说一句话就行，比如这几句 👇</div>' +
      '<div class="msg-actions">' +
      '  <button type="button" class="btn-mini" data-cmd="午饭食堂 15">午饭食堂 15</button>' +
      '  <button type="button" class="btn-mini" data-cmd="昨天打车15，奶茶12">昨天打车15，奶茶12</button>' +
      '  <button type="button" class="btn-mini" data-cmd="买了杯星巴克32">买了杯星巴克32</button>' +
      '</div>';
    addAIMessage(html);
  }

  function showParseFailure(text) {
    var html = '' +
      '<div class="bubble ai">我没听清金额，换个说法？比如「午饭食堂 15」。</div>' +
      '<div class="msg-actions">' +
      '  <button type="button" class="btn-mini" data-cmd="午饭食堂 15">午饭食堂 15</button>' +
      '  <button type="button" class="btn-mini" data-cmd="昨天打车 15">昨天打车 15</button>' +
      '  <button type="button" class="btn-mini" data-cmd="游戏皮肤 99">游戏皮肤 99</button>' +
      '</div>';
    addAIMessage(html);
    var hint = String(text || '').trim();
    if (hint) {
      addAIMessage(aiBubble('（你刚才说的是「' + esc(hint) + '」，我在里面没找到金额。）'));
    }
  }

  function showGoalGuide() {
    addAIMessage(aiBubble('想攒钱买点什么？点下面按钮填一下，我帮你算每月该存多少。'));
    openGoalModal();
  }

  /* ================================================================== */
  /* 收入录入 & 周期重置                                                 */
  /* ================================================================== */

  /** 按 id 找账单 */
  function billById(id) {
    var i;
    for (i = 0; i < state.bills.length; i++) {
      if (state.bills[i].id === id) { return state.bills[i]; }
    }
    return null;
  }

  /** 记收入表单 */
  function openIncomeModal() {
    var todayStr = ENG.formatDate(new Date());
    var radios = '';
    var i;
    for (i = 0; i < DATA.INCOME_SOURCES.length; i++) {
      var s = DATA.INCOME_SOURCES[i];
      radios += '<label class="radio-item">' +
        '<input type="radio" name="incomeSource" value="' + esc(s) + '"' + (i === 0 ? ' checked' : '') + ' />' +
        '<span>' + esc(s) + '</span>' +
        '</label>';
    }

    var box = openModal('' +
      '<h4>记一笔收入</h4>' +
      '<p>生活费、兼职、奖学金都记在这里，不会算进支出统计。</p>' +
      '<label class="field"><span>金额（¥）</span>' +
      '<input data-field="amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="例如 2000" /></label>' +
      '<div class="field"><span>来源</span><div class="radio-group">' + radios + '</div></div>' +
      '<label class="field"><span>日期</span>' +
      '<input data-field="date" type="date" max="' + todayStr + '" value="' + todayStr + '" /></label>' +
      '<label class="field"><span>备注（可选）</span>' +
      '<input data-field="note" type="text" placeholder="例如 10 月生活费" /></label>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">取消</button>' +
      '<button type="button" class="btn-ok" data-act="income-save">确认入账</button>' +
      '</div>');

    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="income-save"]').addEventListener('click', function () {
      var amountInput = box.querySelector('[data-field="amount"]');
      var amount = Number(amountInput.value);
      if (!isFinite(amount) || amount <= 0) {
        amountInput.focus();
        return;
      }
      var checked = box.querySelector('input[name="incomeSource"]:checked');
      var source = checked ? checked.value : '其他';
      var date = box.querySelector('[data-field="date"]').value;
      var note = box.querySelector('[data-field="note"]').value.trim();
      closeModal();
      switchView('chat');
      startFlow([{
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayStr,
        amount: ENG.round2(amount),
        category: DATA.INCOME_CATEGORY,
        source: source,
        note: note || (source + '到账'),
        motivation: '刚需',
        want: false,
        type: 'income'
      }]);
    });

    var focusInput = box.querySelector('[data-field="amount"]');
    if (focusInput) { focusInput.focus(); }
  }

  /**
   * 是否要追问「这笔是新的生活费到账吗」。
   * 条件：收入 && 金额 ≥ 300 &&（来源是生活费 或 备注含 生活费/到账/打钱/给我转）
   * 且同一笔只问一次（askedCycle）。
   */
  function shouldAskCycleReset(bill) {
    if (!bill || bill.type !== 'income') { return false; }
    if (bill.askedCycle) { return false; }
    if (Number(bill.amount) < 300) { return false; }
    var note = String(bill.note || '');
    if (bill.source === '生活费') { return true; }
    return /生活费|到账|打钱|给我转/.test(note);
  }

  /** 入账后追问（大白话），同一笔只问一次 */
  function maybeAskCycleReset(bill) {
    if (!shouldAskCycleReset(bill)) { return; }
    bill.askedCycle = true;
    saveState();

    var html = '' +
      '<div class="ask-card" data-bill="' + esc(bill.id) + '">' +
      '  <div class="ask-title">这笔 ' + money(bill.amount) + ' 是新的生活费到账吗？</div>' +
      '  <div class="ask-text">要不要<b>从现在起重新算一个周期</b>？（就是把预算也换成这笔钱，日均重新算一遍）</div>' +
      '  <div class="ask-actions">' +
      '    <button type="button" class="btn-mini primary" data-act="cycle-yes" data-bill="' + esc(bill.id) + '">要，从现在重新算</button>' +
      '    <button type="button" class="btn-mini" data-act="cycle-no" data-bill="' + esc(bill.id) + '">不用，只记这一笔</button>' +
      '  </div>' +
      '</div>';
    addAIMessage(aiBubble('🤔 多问一句：') + html);
  }

  /**
   * 处理「重新算周期 / 只记流水」。
   * @param {string} billId
   * @param {boolean} yes
   */
  function resolveCycleReset(billId, yes) {
    var bill = billById(billId);
    if (!bill) { return; }
    if (!yes) {
      addAIMessage(aiBubble('行，这笔只当流水记着，预算没动。'));
      return;
    }
    var todayStr = ENG.formatDate(new Date());
    // 起点不能晚于今天，否则 getCycle 会忽略（回退发钱日）
    var start = bill.date > todayStr ? todayStr : bill.date;
    state.budget.cycleStart = start;
    state.budget.total = ENG.round2(bill.amount);
    saveState();
    var ov = getOverview();
    renderAll();
    addAIMessage(aiBubble('好，新一轮开始：' + money(state.budget.total) + ' 从 ' +
      esc(ov.cycle.start) + ' 用到 ' + esc(ov.cycle.end) + '，还有 ' + ov.cycle.remainingDays +
      ' 天，日均 ' + money(ov.budgetState.dailyAllowance) + '。'));
  }

  /** 恢复按发钱日推算 */
  function restorePaydayCycle() {
    state.budget.cycleStart = '';
    saveState();
    renderAll();
    renderCycleInfo();
    var ov = getOverview();
    addAIMessage(aiBubble('已经恢复按发钱日 ' + state.budget.payday + ' 号算周期：' +
      esc(ov.cycle.start) + ' ~ ' + esc(ov.cycle.end) + '，还剩 ' + ov.cycle.remainingDays + ' 天。'));
  }

  /* ================================================================== */
  /* 账单分析                                                            */
  /* ================================================================== */

  function openAnalysisSheet() {
    $('analysisMask').hidden = false;
    // 默认直接分析当前账本（无需导入）；没有记录时才停留在导入模式
    if (state.bills.length > 0) {
      analysisMode = 'current';
      analyzeCurrentBills();
    } else if (analysisData) {
      analysisMode = 'imported';
      renderAnalysis();
    } else {
      analysisMode = 'imported';
      renderAnalysis();
    }
    syncAnalysisTabs();
  }

  function closeAnalysisSheet() {
    $('analysisMask').hidden = true;
  }

  /** 把当前账本（state.bills）转成 analysis 模块可用的 rows，并触发分析 */
  function analyzeCurrentBills() {
    var bills = state.bills || [];
    var rows = bills.map(function (b) {
      var isIncome = b.type === 'income';
      return {
        date: b.date,
        amount: b.amount,
        category: isIncome ? DATA.INCOME_CATEGORY : b.category,
        type: isIncome ? 'income' : 'expense',
        counterparty: '',
        desc: b.note || '',
        note: b.note || '',
        worth: b.worth || '',
        month: (b.date || '').slice(0, 7)
      };
    });
    var monthSet = {};
    var i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].month) { monthSet[rows[i].month] = true; }
    }
    var monthList = Object.keys(monthSet).sort();
    var month = monthList.length ? monthList[monthList.length - 1] : ENG.formatDate(new Date()).slice(0, 7);
    analysisData = {
      rows: rows,
      files: [{
        name: '当前账本', ok: true, reason: '', encoding: '', headerRow: 0,
        totalRows: rows.length, skipped: 0, skippedBefore: 0, transferIncomeCount: 0,
        columns: {}, delimiter: ',', records: rows.length
      }],
      duplicates: [],
      months: monthList,
      month: month,
      source: 'current'
    };
    renderAnalysis();
  }

  /** 切换分析模式标签的选中态 */
  function syncAnalysisTabs() {
    var tabs = DOC.querySelectorAll('[data-act="an-mode"]');
    for (var i = 0; i < tabs.length; i++) {
      var m = tabs[i].getAttribute('data-mode');
      tabs[i].classList.toggle('active', m === analysisMode);
    }
  }

  /** 统计「值不值」自评 */
  function worthStats(bills) {
    var s = { worth: 0, mid: 0, waste: 0, none: 0, wasteAmount: 0, totalExpense: 0 };
    for (var i = 0; i < bills.length; i++) {
      var b = bills[i];
      if (b.type === 'income') { continue; }
      s.totalExpense += b.amount;
      if (b.worth === 'worth') { s.worth += 1; }
      else if (b.worth === 'mid') { s.mid += 1; }
      else if (b.worth === 'waste') { s.waste += 1; s.wasteAmount += b.amount; }
      else { s.none += 1; }
    }
    s.wasteRate = s.totalExpense > 0 ? (s.wasteAmount / s.totalExpense * 100) : 0;
    return s;
  }

  /** 「值不值」自评区块 HTML */
  function worthSectionHtml(s) {
    if (s.totalExpense <= 0 && s.none === 0) {
      return emptyLine('当前账本还没有支出记录');
    }
    var rated = s.worth + s.mid + s.waste;
    return '<div class="worth-stats">' +
      '<div class="worth-grid">' +
      '  <div class="wcell w-worth"><b>' + s.worth + '</b><small>值 ✅</small></div>' +
      '  <div class="wcell w-mid"><b>' + s.mid + '</b><small>一般</small></div>' +
      '  <div class="wcell w-waste"><b>' + s.waste + '</b><small>不值 ❌</small></div>' +
      '  <div class="wcell"><b>' + s.none + '</b><small>未评价</small></div>' +
      '</div>' +
      '<div class="worth-bar"><i style="width:' + s.wasteRate.toFixed(1) + '%"></i></div>' +
      '<p class="worth-text">在已评价的支出里，你给 <b>' + s.waste + '</b> 笔打了「不值」，合计 <b>' +
        money(s.wasteAmount) + '</b>，占支出 <b>' + s.wasteRate.toFixed(1) + '%</b>。' +
        (s.none > 0 ? '还有 ' + s.none + ' 笔没评价，回聊天里给它们打个分吧～' : '评价得很全面，继续保持！') +
      '</p>' +
      '</div>';
  }

  /** 把文件读成 ArrayBuffer 再交给 analysis.parseFile（解码在纯函数里完成） */
  function handleAnalysisFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (files.length === 0) { return; }
    var metas = [];
    var pending = files.length;
    var statusEl = $('analysisStatus');
    if (statusEl) { statusEl.textContent = '正在解析 ' + files.length + ' 个文件…'; }

    function done() {
      pending -= 1;
      if (pending > 0) { return; }
      var built = ANA.buildRows(metas);
      var monthCount = {};
      var i;
      for (i = 0; i < built.rows.length; i++) {
        var mk = built.rows[i].month || built.rows[i].date.slice(0, 7);
        monthCount[mk] = (monthCount[mk] || 0) + 1;
      }
      var monthList = Object.keys(monthCount).sort();
      // 默认看「记录最多的那个月」（平手取较新的月份），避免默认落到只有 1 条记录的月份
      var month = monthList.length > 0 ? monthList[monthList.length - 1] : ENG.formatDate(new Date()).slice(0, 7);
      var bestCount = -1;
      for (i = 0; i < monthList.length; i++) {
        if (monthCount[monthList[i]] >= bestCount) {
          bestCount = monthCount[monthList[i]];
          month = monthList[i];
        }
      }
      analysisData = {
        rows: built.rows,
        files: built.files,
        duplicates: built.duplicates,
        months: monthList,
        month: month,
        source: 'imported'
      };
      analysisMode = 'imported';
      renderAnalysis();
      syncAnalysisTabs();
    }

    files.forEach(function (file, index) {
      var reader = new FileReader();
      reader.onload = function () {
        var parsed;
        try {
          parsed = ANA.parseFile({ name: file.name, bytes: reader.result });
        } catch (e) {
          parsed = { name: file.name, ok: false, reason: '解析失败：' + (e && e.message ? e.message : '未知错误'), records: [], skipped: 0 };
        }
        metas[index] = parsed;
        done();
      };
      reader.onerror = function () {
        metas[index] = { name: file.name, ok: false, reason: '读取文件失败', records: [], skipped: 0 };
        done();
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /** 折叠区块 */
  function reportSection(title, inner, open) {
    return '<details class="report-sec"' + (open ? ' open' : '') + '>' +
      '<summary>' + title + '</summary>' +
      '<div class="sec-body">' + inner + '</div>' +
      '</details>';
  }

  function emptyLine(text) {
    return '<div class="sec-empty">' + esc(text) + '</div>';
  }

  /** 解析失败时的诊断卡片：把「静默空白」变成明确的「为什么没识别」。
   *  未选择文件时不渲染任何卡片（拖拽区 + 状态行已有引导），只更新状态文字。 */
  function analysisFailCard(data, statusEl) {
    if (!data || !data.files || data.files.length === 0) {
      if (statusEl) {
        statusEl.textContent = '还没有导入文件。导出账单时请选择「CSV（用做个人对账）」，不要用 PDF / Excel。';
      }
      // 分析页（导入模式）与顶栏导入页的拖拽区、状态行已有引导，
      // 这里不再重复渲染「还没有可分析的账单文件」大卡片，避免整页冗余。
      return '';
    }
    var bad = data.files.filter(function (f) { return !f.ok; });
    var good = data.files.filter(function (f) { return f.ok; });
    var lines = '';
    if (bad.length > 0) {
      lines += '<div class="pf-sub">以下文件没能解析出记录：</div>';
      bad.forEach(function (f) {
        lines += '<div class="pf-item">' +
          '<div class="pf-name">❌ ' + esc(f.name) + '</div>' +
          '<div class="pf-reason">' + esc(f.reason || '解析失败') + '</div>';
        if (f.preview) {
          lines += '<pre class="pf-preview">' + esc(f.preview) + '</pre>';
        }
        lines += '</div>';
      });
    }
    if (good.length > 0 && data.rows.length === 0) {
      lines += '<div class="pf-sub">已识别文件但筛选后没有记录（可能都被月份筛选或去重过滤了）。</div>';
    }
    if (statusEl) {
      statusEl.textContent = bad.length > 0
        ? '有 ' + bad.length + ' 个文件未解析出记录，详见下方说明。'
        : '还没有解析出有效记录。';
    }
    return '<div class="parse-fail">' +
      '<div class="pf-emoji"><svg viewBox="0 0 24 24"><use href="#i-sad"/></svg></div>' +
      '<div class="pf-title">这份文件没能解析出账单记录</div>' +
      lines +
      '<p class="pf-tip">常见原因：① 导出时选了 <b>PDF / Excel</b>，请改选 <b>CSV</b>；' +
      '② 微信/支付宝需选「用做个人对账」的明细；③ 文件编码异常。' +
      '如果还有问题，把文件前 2 行发给我，我帮你适配格式。</p>' +
      '</div>';
  }

  function barHtml(label, value, max, color) {
    var pct = max > 0 ? Math.max(2, value / max * 100) : 0;
    return '<div class="bar-row">' +
      '<span class="bar-label">' + esc(label) + '</span>' +
      '<span class="bar-track"><i style="width:' + pct.toFixed(1) + '%;background:' + color + '"></i></span>' +
      '<span class="bar-value">' + money(value) + '</span>' +
      '</div>';
  }

  /** 渲染整个分析 sheet */
  function renderAnalysis() {
    var reportEl = $('analysisReport');
    var statusEl = $('analysisStatus');
    var toolbar = $('analysisToolbar');
    if (!reportEl) { return; }

    // 以「当前激活的标签」为准，而不是以数据残留判断：
    // 否则从「当前账本」切到「导入 CSV」时，analysisData 还是账本数据，会误显当前账本内容。
    var isCurrent = (analysisMode === 'current');
    var dropEl = $('analysisDrop');
    var bannerEl = $('analysisCurrentBanner');
    var importBtn = $('btnAnalysisImport');
    var clearBtn = $('btnAnalysisClear');
    if (dropEl) { dropEl.hidden = isCurrent; }
    if (bannerEl) {
      bannerEl.hidden = !isCurrent;
      if (isCurrent) {
        bannerEl.textContent = '📒 正在分析你当前账本里已记的 ' + (state.bills || []).length +
          ' 笔记录（直接来自账本，无需导入）';
      }
    }
    if (importBtn) { importBtn.hidden = isCurrent; }
    if (clearBtn) { clearBtn.hidden = isCurrent; }

    if (!analysisData || !analysisData.rows || analysisData.rows.length === 0) {
      var failHtml;
      if (isCurrent) {
        if (statusEl) { statusEl.textContent = '当前账本还没有记录。'; }
        failHtml = '<div class="parse-fail"><div class="pf-emoji">📒</div>' +
          '<div class="pf-title">账本还是空的</div>' +
          '<p class="pf-tip">回到聊天说一句「中午黄焖鸡18」就能记账；也可以切到上方「导入 CSV」把微信 / 支付宝账单导进来。</p></div>';
      } else {
        failHtml = analysisFailCard(analysisData, statusEl);
      }
      reportEl.innerHTML = failHtml;
      if (toolbar) { toolbar.hidden = true; }
      return;
    }

    if (toolbar) { toolbar.hidden = isCurrent ? true : false; }
    var excludeDup = !!($('analysisExcludeDup') && $('analysisExcludeDup').checked);
    var rep = ANA.report(analysisData.rows, {
      month: analysisData.month,
      excludeDuplicates: excludeDup,
      files: analysisData.files
    });
    analysisData.report = rep;

    if (statusEl) {
      var okCount = analysisData.files.filter(function (f) { return f.ok; }).length;
      var extraNotes = [];
      if (rep.parseInfo.excludedTransfer > 0) {
        extraNotes.push(rep.parseInfo.excludedTransfer + ' 条转账/还款不计入统计');
      }
      if (rep.parseInfo.excludedDuplicate > 0) {
        extraNotes.push(rep.parseInfo.excludedDuplicate + ' 条疑似重复' +
          (excludeDup ? '已排除' : '仅标记未排除'));
      }
      var statusText = '已解析 ' + okCount + ' / ' + analysisData.files.length + ' 个文件，' +
        rep.meta.validCount + ' 条有效记录' +
        (extraNotes.length ? '（另有 ' + extraNotes.join('、') + '）' : '') +
        '。';
      if (rep.parseInfo.transferIncomeCount > 0) {
        statusText += '其中 ' + rep.parseInfo.transferIncomeCount +
          ' 条为转账型收入，已计入；若为本人账户互转请手动排除。';
      }
      statusEl.textContent = statusText + '数据只在本机，没有上传。';
    }
    if (isCurrent && statusEl) {
      statusEl.textContent = '数据来自你当前账本（' + analysisData.rows.length +
        ' 条记录），仅在本地分析，没有上传。';
    }

    var ov = rep.overview;
    var monthOptions = (analysisData.months || [ov.month]).map(function (m) {
      return '<option value="' + esc(m) + '"' + (m === ov.month ? ' selected' : '') + '>' + esc(m) + '</option>';
    }).join('');

    var hintEl = $('analysisMonthHint');
    if (hintEl) {
      hintEl.textContent = '统计月份 ' + ov.month + ' · 与上月 ' + ov.prevMonth + ' 对比';
    }

    var html = '<div class="report-top">' +
      '<label class="month-pick">统计月份 <select data-act="analysis-month">' + monthOptions + '</select></label>' +
      '<span class="hint">共 ' + rep.meta.rowCount + ' 条原始记录</span>' +
      '</div>';

    /* ---- 建议 ---- */
    var budgetState = ENG.getBudgetState({
      total: state.budget.total,
      spent: ov.expense,
      remainingDays: getOverview().cycle.remainingDays,
      todaySpent: 0
    });
    var insightList = ANA.insights(rep, budgetState);
    if (insightList.length > 0) {
      html += '<div class="insight-box"><div class="insight-title">给你的 ' + insightList.length + ' 条建议</div>';
      insightList.forEach(function (it) {
        html += '<div class="insight-item ' + (it.level === 'warn' ? 'warn' : 'tip') + '">' +
          '<div class="insight-head">' + (it.level === 'warn' ? '⚠️ ' : '💡 ') + esc(it.title) + '</div>' +
          '<div class="insight-evidence">' + esc(it.evidence) + '</div>' +
          '<div class="insight-action">' + esc(it.action) + '</div>' +
          '</div>';
      });
      html += '</div>';
    }

    /* ---- 1. 总览 ---- */
    var prevText = '—';
    if (ov.hasPrev) {
      prevText = ov.expenseDeltaPercent === null
        ? '—'
        : (ov.expenseDeltaPercent >= 0 ? '+' : '') + ov.expenseDeltaPercent.toFixed(1) + '%';
    }
    html += reportSection('1. 总览', '' +
      '<div class="stat-grid">' +
      '  <div><b>' + money(ov.expense) + '</b><small>总支出</small></div>' +
      '  <div><b class="pos">' + money(ov.income) + '</b><small>总收入</small></div>' +
      '  <div><b class="' + (ov.balance < 0 ? 'neg' : '') + '">' + money(ov.balance) + '</b><small>结余</small></div>' +
      '  <div><b>' + ov.count + '</b><small>支出笔数</small></div>' +
      '</div>' +
      '<div class="kv-list">' +
      '  <div class="kv"><span>笔均</span><b>' + money(ov.avgPerTx) + '</b></div>' +
      '  <div class="kv"><span>日均（' + ov.activeDays + ' 个有记录的天）</span><b>' + money(ov.avgPerDay) + '</b></div>' +
      '  <div class="kv"><span>与上月（' + ov.prevMonth + '）支出对比</span><b>' + prevText + '</b></div>' +
      '  <div class="kv"><span>储蓄率</span><b>' + (ov.savingsRate === null ? '—' : ov.savingsRate.toFixed(1) + '%') + '</b></div>' +
      '</div>', true);

    /* ---- 2. 分类占比与环比 ---- */
    var cats = rep.categories || [];
    var catBody = '';
    if (cats.length === 0) {
      catBody = emptyLine('本月没有支出记录');
    } else {
      var maxCat = cats[0].amount;
      var i;
      for (i = 0; i < cats.length; i++) {
        var c = cats[i];
        catBody += barHtml(c.category, c.amount, maxCat, categoryColor(c.category));
      }
      catBody += '<table class="report-table"><thead><tr>' +
        '<th>分类</th><th>金额</th><th>占比</th><th>笔数</th><th>笔均</th><th>环比</th>' +
        '</tr></thead><tbody>';
      for (i = 0; i < cats.length; i++) {
        var cc = cats[i];
        catBody += '<tr><td>' + esc(cc.category) + '</td>' +
          '<td>' + money(cc.amount) + '</td>' +
          '<td>' + cc.percent.toFixed(1) + '%</td>' +
          '<td>' + cc.count + '</td>' +
          '<td>' + money(cc.avg) + '</td>' +
          '<td class="' + (cc.deltaPercent === null ? '' : (cc.deltaPercent > 0 ? 'neg' : 'pos')) + '">' +
          (cc.deltaPercent === null ? '—' : (cc.deltaPercent >= 0 ? '+' : '') + cc.deltaPercent.toFixed(1) + '%') +
          '</td></tr>';
      }
      catBody += '</tbody></table>';
    }
    html += reportSection('2. 分类占比与环比', catBody, true);

    /* ---- 3. Top 10 单笔大额 ---- */
    var topBody = '';
    if (rep.topExpenses.length === 0) {
      topBody = emptyLine('本月没有支出记录');
    } else {
      topBody = '<table class="report-table"><thead><tr><th>日期</th><th>对方</th><th>说明</th><th>金额</th></tr></thead><tbody>';
      rep.topExpenses.forEach(function (x) {
        topBody += '<tr><td>' + esc(x.date) + '</td>' +
          '<td>' + esc(x.counterparty || '—') + '</td>' +
          '<td>' + esc(x.desc || '—') + '</td>' +
          '<td>' + money(x.amount) + '</td></tr>';
      });
      topBody += '</tbody></table>';
    }
    html += reportSection('3. Top 10 单笔大额', topBody, false);

    /* ---- 4. Top 10 高频商户 ---- */
    var merBody = '';
    if (rep.topMerchants.length === 0) {
      merBody = emptyLine('没有可统计的商户');
    } else {
      merBody = '<table class="report-table"><thead><tr><th>商户</th><th>笔数</th><th>金额</th><th>笔均</th></tr></thead><tbody>';
      rep.topMerchants.forEach(function (x) {
        merBody += '<tr><td>' + esc(x.name) + '</td><td>' + x.count + '</td>' +
          '<td>' + money(x.amount) + '</td><td>' + money(x.avg) + '</td></tr>';
      });
      merBody += '</tbody></table>';
    }
    html += reportSection('4. Top 10 高频商户', merBody, false);

    /* ---- 5. 周末 vs 工作日 ---- */
    var wv = rep.weekendVsWeekday;
    html += reportSection('5. 周末 vs 工作日', '' +
      '<table class="report-table"><thead><tr><th>口径</th><th>笔数</th><th>合计</th><th>天数</th><th>日均</th></tr></thead><tbody>' +
      '<tr><td>周末</td><td>' + wv.weekend.count + '</td><td>' + money(wv.weekend.amount) +
      '</td><td>' + wv.weekend.days + '</td><td><b>' + money(wv.weekend.avg) + '</b></td></tr>' +
      '<tr><td>工作日</td><td>' + wv.weekday.count + '</td><td>' + money(wv.weekday.amount) +
      '</td><td>' + wv.weekday.days + '</td><td><b>' + money(wv.weekday.avg) + '</b></td></tr>' +
      '</tbody></table>' +
      '<div class="sec-note">周末日均 / 工作日日均 = ' +
      (wv.ratio === null ? '—' : wv.ratio.toFixed(2) + ' 倍') + '（比的是日均，不是总额）</div>', false);

    /* ---- 6. 订阅型支出 ---- */
    var subBody = '';
    if (rep.subscriptions.length === 0) {
      subBody = emptyLine('未发现连续 3 个月「同商户 + 同金额」的固定扣款');
    } else {
      subBody = '<table class="report-table"><thead><tr><th>商户</th><th>月扣</th><th>连续月数</th><th>本月仍在扣</th><th>折合一年</th></tr></thead><tbody>';
      rep.subscriptions.forEach(function (s) {
        subBody += '<tr><td>' + esc(s.name) + '</td><td>' + money(s.amount) + '</td>' +
          '<td>' + s.months + '</td><td>' + (s.activeThisMonth ? '是' : '否') + '</td>' +
          '<td>' + money(s.annual) + '</td></tr>';
      });
      subBody += '</tbody></table>';
    }
    html += reportSection('6. 订阅型支出', subBody, false);

    /* ---- 7. 异常大额 ---- */
    var anomBody = '';
    if (rep.anomalies.length === 0) {
      anomBody = emptyLine('没有单笔超过该分类笔均 3 倍的支出');
    } else {
      anomBody = '<table class="report-table"><thead><tr><th>日期</th><th>对方</th><th>分类</th><th>金额</th><th>其余笔均</th><th>倍数</th></tr></thead><tbody>';
      rep.anomalies.forEach(function (a) {
        anomBody += '<tr><td>' + esc(a.date) + '</td><td>' + esc(a.counterparty || '—') + '</td>' +
          '<td>' + esc(a.category) + '</td><td>' + money(a.amount) + '</td>' +
          '<td>' + money(a.othersAvg) + '</td><td>' + a.times.toFixed(1) + '×</td></tr>';
      });
      anomBody += '</tbody></table>';
    }
    html += reportSection('7. 异常大额', anomBody, false);

    /* ---- 8. 疑似重复 ---- */
    var dupBody = '';
    if (rep.duplicates.length === 0) {
      dupBody = emptyLine('未发现同日期 + 同金额 + 同对方的重复记录');
    } else {
      dupBody = '<div class="sec-note">共 ' + rep.duplicates.length + ' 组疑似重复，默认只标记不删除；勾选上方开关可排除后重新统计。</div>';
      rep.duplicates.forEach(function (g) {
        dupBody += '<div class="dup-item"><b>' + esc(g.date) + '　' + money(g.amount) + '　' +
          esc(g.counterparty || '—') + '</b><ul>';
        g.items.forEach(function (it) {
          dupBody += '<li>' + esc(it.file) + ' 第 ' + it.row + ' 行：' + esc(it.desc || '—') + '</li>';
        });
        dupBody += '</ul></div>';
      });
    }
    html += reportSection('8. 疑似重复', dupBody, false);

    /* ---- 9. 解析情况 ---- */
    var fileBody = '<table class="report-table"><thead><tr><th>文件</th><th>编码</th><th>表头行</th><th>有效</th><th>前置说明行</th><th>无效数据行</th><th>列映射</th></tr></thead><tbody>';
    rep.parseInfo.files.forEach(function (f) {
      fileBody += '<tr><td>' + esc(f.name) + '</td><td>' + esc(f.encoding || '—') + '</td>' +
        '<td>' + (f.headerRow || '—') + '</td><td>' + f.records + '</td>' +
        '<td>' + (f.skippedBefore || 0) + '</td><td>' + (f.skipped || 0) + '</td>' +
        '<td class="col-map">' + esc(ANA.columnMapText(f.columns, true)) + '</td></tr>';
    });
    fileBody += '</tbody></table>';
    if (rep.parseInfo.files.some(function (f) { return !f.ok; })) {
      fileBody += '<div class="sec-note warn-text">未解析成功的文件：' +
        rep.parseInfo.files.filter(function (f) { return !f.ok; })
          .map(function (f) { return esc(f.name + '（' + (f.reason || '未知原因') + '）'); }).join('、') + '</div>';
    }
    html += reportSection('9. 解析情况', fileBody, false);

    /* ---- 值不值 · 我的自评（仅当前账本模式） ---- */
    if (isCurrent) {
      var ws = worthStats(state.bills);
      html += reportSection('值不值 · 我的自评', worthSectionHtml(ws), true);
    }

    reportEl.innerHTML = html;
  }

  /** 导出分析报告 Markdown */
  function exportAnalysisMarkdown() {
    if (!analysisData || !analysisData.report) {
      addAIMessage(aiBubble('还没有可以导出的分析结果，先导入一份账单 CSV 吧。'));
      return;
    }
    var text = ANA.toMarkdown(analysisData.report);
    downloadText('账单分析_' + (analysisData.report.overview.month || 'report') + '.md', text, 'text/markdown;charset=utf-8');
  }

  /** 把导入记录并入账本（二次确认） */
  function confirmImportAnalysis() {
    if (!analysisData || !analysisData.rows || analysisData.rows.length === 0) {
      addAIMessage(aiBubble('还没有可并入的导入记录。'));
      return;
    }
    var excludeDup = !!($('analysisExcludeDup') && $('analysisExcludeDup').checked);
    var drafts = ANA.rowsToBills(analysisData.rows, {
      month: analysisData.month,
      excludeDuplicates: excludeDup
    });
    if (drafts.length === 0) {
      addAIMessage(aiBubble('这个月没有可并入的支出/收入记录。'));
      return;
    }
    var box = openModal('' +
      '<h4>把 ' + drafts.length + ' 条记录并入账本？</h4>' +
      '<p><b>这会让本周期预算统计发生变化</b>：并入的支出会立刻占用预算额度，日均可用会重新计算。</p>' +
      '<p>只并入 ' + esc(analysisData.month) + ' 的记录，转账 / 还款类已在导入时排除。此操作不会自动去重，重复导入会产生重复账单。</p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn-cancel" data-act="modal-cancel">再想想</button>' +
      '<button type="button" class="btn-ok" data-act="import-ok">确认并入</button>' +
      '</div>');
    box.querySelector('[data-act="modal-cancel"]').addEventListener('click', closeModal);
    box.querySelector('[data-act="import-ok"]').addEventListener('click', function () {
      var i;
      var count = 0;
      for (i = 0; i < drafts.length; i++) {
        commitBill(drafts[i]);
        count += 1;
      }
      closeModal();
      renderAll();
      closeAnalysisSheet();
      addAIMessage(aiBubble('已把 ' + count + ' 条记录并入账本（' + esc(analysisData.month) +
        '），预算统计已重新计算。如果数字不对，可以用「重置演示数据」回到初始状态。'));
    });
  }

  /** 清空导入（只清分析缓存，不动账本） */
  function clearAnalysis() {
    analysisData = null;
    var statusEl = $('analysisStatus');
    if (statusEl) { statusEl.textContent = '还没有导入文件。导出账单时请选择「CSV」，不要用 PDF。'; }
    var fileInput = $('analysisFile');
    if (fileInput) { fileInput.value = ''; }
    var toolbar = $('analysisToolbar');
    if (toolbar) { toolbar.hidden = true; }
    var reportEl = $('analysisReport');
    if (reportEl) { reportEl.innerHTML = ''; }
  }

  /* ================================================================== */
  /* 导入账单（微信 / 支付宝 / 银行 CSV）→ 直接并入账本                    */
  /* ================================================================== */

  var importState = null;

  function openImportSheet() {
    $('importMask').hidden = false;
    renderImportPreview();
  }

  function closeImportSheet() {
    $('importMask').hidden = true;
  }

  /** 把用户选择的文件读成二进制后交给 analysis.parseFile（解码在纯函数里完成） */
  function handleImportFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (files.length === 0) { return; }
    var metas = [];
    var pending = files.length;
    var statusEl = $('importStatus');
    if (statusEl) { statusEl.textContent = '正在解析 ' + files.length + ' 个文件…'; }

    function done() {
      pending -= 1;
      if (pending > 0) { return; }
      var built = ANA.buildRows(metas);
      var monthCount = {};
      var i;
      for (i = 0; i < built.rows.length; i++) {
        var mk = built.rows[i].month || built.rows[i].date.slice(0, 7);
        monthCount[mk] = (monthCount[mk] || 0) + 1;
      }
      var monthList = Object.keys(monthCount).sort();
      // 默认看「记录最多的那个月」（平手取较新月份）
      var month = monthList.length > 0 ? monthList[monthList.length - 1] : ENG.formatDate(new Date()).slice(0, 7);
      var bestCount = -1;
      for (i = 0; i < monthList.length; i++) {
        if (monthCount[monthList[i]] >= bestCount) {
          bestCount = monthCount[monthList[i]];
          month = monthList[i];
        }
      }
      importState = {
        rows: built.rows,
        files: built.files,
        duplicates: built.duplicates,
        months: monthList,
        month: month
      };
      renderImportPreview();
    }

    files.forEach(function (file, index) {
      var reader = new FileReader();
      reader.onload = function () {
        var parsed;
        try {
          parsed = ANA.parseFile({ name: file.name, bytes: reader.result });
        } catch (e) {
          parsed = { name: file.name, ok: false, reason: '解析失败：' + (e && e.message ? e.message : '未知错误'), records: [], skipped: 0 };
        }
        metas[index] = parsed;
        done();
      };
      reader.onerror = function () {
        metas[index] = { name: file.name, ok: false, reason: '读取文件失败', records: [], skipped: 0 };
        done();
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /** 计算「将要导入」的账单草稿，并与账本已有记录按 日期+金额+备注 去重 */
  function computeImportDrafts() {
    if (!importState || !importState.rows) { return { toImport: [], skipDup: 0 }; }
    var excludeFileDup = !!($('importExcludeFileDup') && $('importExcludeFileDup').checked);
    var excludeLedgerDup = !!($('importExcludeDup') && $('importExcludeDup').checked);
    var month = importState.month;
    var drafts = ANA.rowsToBills(importState.rows, {
      month: month,
      excludeDuplicates: excludeFileDup
    });
    var ledgerKeys = {};
    state.bills.forEach(function (b) {
      ledgerKeys[b.date + '|' + ENG.round2(b.amount).toFixed(2) + '|' + String(b.note || '').trim()] = true;
    });
    var toImport = [];
    var skipDup = 0;
    drafts.forEach(function (d) {
      var key = d.date + '|' + ENG.round2(d.amount).toFixed(2) + '|' + String(d.note || '').trim();
      if (excludeLedgerDup && ledgerKeys[key]) { skipDup += 1; return; }
      toImport.push(d);
    });
    return { toImport: toImport, skipDup: skipDup };
  }

  /** 渲染导入预览：解析统计 + 月份/去重控件 + 预览列表 */
  function renderImportPreview() {
    var reportEl = $('importReport');
    var statusEl = $('importStatus');
    var controls = $('importControls');
    if (!reportEl) { return; }

    if (!importState || !importState.rows || importState.rows.length === 0) {
      if (controls) { controls.hidden = true; }
      reportEl.innerHTML = analysisFailCard(importState, statusEl);
      return;
    }

    var rows = importState.rows;
    var computed = computeImportDrafts();
    var toImport = computed.toImport;
    var skipDup = computed.skipDup;

    var inc = 0, exp = 0, excl = 0;
    rows.forEach(function (r) {
      if (r.excluded) { excl += 1; }
      else if (r.type === 'income') { inc += 1; }
      else { exp += 1; }
    });

    if (statusEl) {
      var okCount = importState.files.filter(function (f) { return f.ok; }).length;
      var badFiles = importState.files.filter(function (f) { return !f.ok; });
      var msg = '已解析 ' + okCount + ' / ' + importState.files.length + ' 个文件，共 ' + rows.length + ' 条记录。';
      if (badFiles.length > 0) {
        msg += '（' + badFiles.length + ' 个文件未识别：' +
          badFiles.map(function (f) { return esc(f.name) + (f.reason ? '(' + esc(f.reason) + ')' : ''); }).join('、') + '）';
      }
      statusEl.textContent = msg;
    }

    if (controls) {
      controls.hidden = false;
      var sel = $('importMonth');
      if (sel) {
        sel.innerHTML = (importState.months || []).map(function (m) {
          return '<option value="' + m + '"' + (m === importState.month ? ' selected' : '') + '>' + m + '</option>';
        }).join('');
      }
    }

    var html = '';
    html += '<div class="import-summary">';
    html += '  <div class="isum isum-inc"><b>' + inc + '</b><small>收入</small></div>';
    html += '  <div class="isum isum-exp"><b>' + exp + '</b><small>支出</small></div>';
    html += '  <div class="isum isum-excl"><b>' + excl + '</b><small>已排除(转账/还款)</small></div>';
    html += '  <div class="isum isum-imp"><b>' + toImport.length + '</b><small>将导入</small></div>';
    if (skipDup > 0) { html += '  <div class="isum isum-skip"><b>' + skipDup + '</b><small>与账本重复</small></div>'; }
    html += '</div>';
    html += '<p class="import-note">将导入 <b>' + toImport.length + '</b> 条到 <b>' + esc(importState.month) + '</b>' +
      (skipDup > 0 ? '（已跳过 ' + skipDup + ' 条与账本重复的）' : '') + '。转账 / 还款已自动排除，导入后预算统计立即重算。</p>';

    var preview = toImport.slice(0, 40);
    if (preview.length > 0) {
      html += '<div class="import-list">';
      preview.forEach(function (d) {
        var cls = d.type === 'income' ? 'in' : 'out';
        var sign = d.type === 'income' ? '+' : '-';
        html += '<div class="import-row ' + cls + '">' +
          '<span class="ir-date">' + esc(d.date) + '</span>' +
          '<span class="ir-note">' + esc(d.note || d.category) + '</span>' +
          '<span class="ir-cat">' + esc(d.category) + '</span>' +
          '<span class="ir-amt">' + sign + money(d.amount) + '</span>' +
          '</div>';
      });
      if (toImport.length > preview.length) {
        html += '<div class="import-more">…还有 ' + (toImport.length - preview.length) + ' 条</div>';
      }
      html += '</div>';
    } else {
      html += '<div class="sec-empty">没有可导入的记录（可能都被月份筛选或去重过滤掉了）。</div>';
    }

    reportEl.innerHTML = html;
    importState._toImport = toImport;
    importState._skipDup = skipDup;
  }

  /** 确认把预览中的记录并入账本 */
  function confirmImportBills() {
    if (!importState || !importState.rows || importState.rows.length === 0) {
      addAIMessage(aiBubble('还没有可导入的记录。'));
      return;
    }
    var toImport = importState._toImport;
    if (!toImport || toImport.length === 0) {
      addAIMessage(aiBubble('没有可导入的记录（可能都和账本重复，或被月份筛选过滤掉了）。'));
      return;
    }
    var count = 0;
    toImport.forEach(function (d) {
      commitBill(d, true); // 导入批量账单不进单步撤回栈
      count += 1;
    });
    renderAll();
    closeImportSheet();
    addAIMessage(aiBubble('已导入 ' + count + ' 条账单（' + esc(importState.month) +
      '）。转账 / 还款已自动排除，预算统计已重新计算。回到聊天可以给每笔「值不值」打分～'));
    importState = null;
  }

  /** 清空导入（只清缓存，不动账本） */
  function clearImport() {
    importState = null;
    var statusEl = $('importStatus');
    if (statusEl) { statusEl.textContent = '还没有选择文件。'; }
    var fileInput = $('importFile');
    if (fileInput) { fileInput.value = ''; }
    var controls = $('importControls');
    if (controls) { controls.hidden = true; }
    var reportEl = $('importReport');
    if (reportEl) { reportEl.innerHTML = ''; }
  }

  /* ================================================================== */
  /* 截屏记账（三层降级）                                                */
  /* ================================================================== */

  var ocrPendingFile = null;
  var ocrDemoIndex = -1;
  /** 演示结果与用户图片并存时置 true：禁止预览图再被"读图完成"回调重新显示 */
  var ocrPreviewSuppressed = false;

  function ocrSourceText(source) {
    if (source === 'native') { return '本地识别（零网络）'; }
    if (source === 'cloud') { return '云端 OCR'; }
    if (source === 'demo') { return '演示样例'; }
    return '未知来源';
  }

  /**
   * 打开弹窗时就把「这台设备能做什么」说清楚，别让用户点了「开始识别」才发现不行。
   * @return {string}
   */
  /* 兼容旧调用点：刷新 OCR 弹窗里的能力提示（实际能力来自 WorkBuddy 云服务） */
  function refreshBackendCaps() {
    if ($('ocrMask') && !$('ocrMask').hidden) {
      $('ocrStatus').className = ocrCapabilityClass();
      $('ocrStatus').textContent = ocrCapabilityText();
    }
  }

  function ocrCapabilityText() {
    var cap = OCR.capabilities();
    if (cap.native) { return '可以离线识别：这台设备支持本地文字识别，截图不会离开这台设备。'; }
    if (cloudReady && visionAvailable) {
      return '将用 WorkBuddy 视觉大模型识别（需要联网）：截图会发给云端识别，金额/分类仍需你确认。';
    }
    if (cloudReady) {
      return '已连接 WorkBuddy 云服务，可以试试截图识别（若当前模型不支持看图，会提示你手动录入）。';
    }
    if (cap.cloud) { return '将用云端识别（需要联网）：会调用已配置的云 OCR，图片会上传。'; }
    return '正在连接 WorkBuddy 云服务…若长时间未连上，请用线上版本打开本应用：' + CLOUD_APP_URL;
  }

  /** 能力不足时状态行用警示色，避免用户以为"点一下就好" */
  function ocrCapabilityClass() {
    var cap = OCR.capabilities();
    var ok = cap.native || cap.cloud || cloudOcrAvailable();
    return ok ? 'ocr-status' : 'ocr-status warn';
  }

  /**
   * 把 detect() 内部（面向开发）的 reason 翻译成人话，只影响展示层。
   * 典型场景：显式 native / cloud 模式失败时会把底层 reason 直接冒到 UI 上。
   * @param {string} reason
   * @return {string}
   */
  function humanizeOcrReason(reason) {
    var s = String(reason === undefined || reason === null ? '' : reason);
    if (!s) { return '识别没有成功，可以直接手动录入。'; }
    var pairs = [
      [/当前浏览器不支持本地文字识别（TextDetector）/g, '这台设备的浏览器不支持离线识别文字'],
      [/当前浏览器不支持本地文字识别\(TextDetector\)/g, '这台设备的浏览器不支持离线识别文字'],
      [/无法读取图片（需要可用的图片文件）/g, '没能读到这张图片，请重新选一张截图'],
      [/本地识别没有读到文字/g, '这台设备的本地识别没有从图片里读到文字（图片可能太模糊、字太小）'],
      [/本地识别没有返回结果/g, '这台设备的本地识别没有返回结果'],
      [/还没有配置云 OCR 凭据/g, '还没有配置云 OCR'],
      [/当前浏览器不支持 Web Crypto，无法签名/g, '这台设备的浏览器缺少云 OCR 需要的加密能力'],
      [/当前环境不支持网络请求/g, '这台设备当前不允许发起网络请求']
    ];
    var i;
    for (i = 0; i < pairs.length; i++) {
      s = s.replace(pairs[i][0], pairs[i][1]);
    }
    return s;
  }

  function renderOcrSamples() {
    var host = $('ocrDemoList');
    if (!host) { return; }
    var html = '<span class="ocr-demo-label">演示样例：</span>';
    OCR.SAMPLES.forEach(function (s, i) {
      html += '<button type="button" class="chip" data-act="ocr-sample" data-index="' + i + '">' +
        esc(s.title) + '</button>';
    });
    host.innerHTML = html;
  }

  function openOcrModal() {
    /* 隐私开关：关闭「允许读取相册」时不允许进入截屏记账 */
    if (!getSettings().privacy.album) {
      showToast('已关闭「允许读取相册」，截屏记账不可用；可在 设置 → 数据与隐私 中打开');
      return;
    }
    ocrPendingFile = null;
    ocrImageDataUrl = '';
    ocrDraft = null;
    ocrDemoIndex = -1;
    ocrPreviewSuppressed = false;
    $('ocrMask').hidden = false;
    var preview = $('ocrPreview');
    preview.hidden = true;
    preview.removeAttribute('src');
    $('ocrResult').innerHTML = '';
    $('ocrStatus').className = ocrCapabilityClass();
    $('ocrStatus').textContent = ocrCapabilityText();
    var fileInput = $('ocrFile');
    if (fileInput) { fileInput.value = ''; }
    renderOcrSamples();
    var runBtn = $('btnOcrRun');
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '开始识别'; }
  }

  function closeOcrModal() {
    $('ocrMask').hidden = true;
    ocrPendingFile = null;
    ocrImageDataUrl = '';
    ocrDraft = null;
    ocrPreviewSuppressed = false;
  }

  function handleOcrFile(file) {
    if (!file) { return; }
    if (String(file.type || '').indexOf('image') === -1) {
      $('ocrStatus').textContent = '这个文件不是图片，请选择截图（png / jpg）。';
      return;
    }
    ocrPendingFile = file;
    ocrDemoIndex = -1;
    ocrPreviewSuppressed = false;
    /* 换了新图：清掉上一次的结果卡，避免"旧结果（可能是示例）"和新图片同时在场 */
    $('ocrResult').innerHTML = '';
    var reader = new FileReader();
    reader.onload = function () {
      ocrImageDataUrl = String(reader.result || '');
      var preview = $('ocrPreview');
      preview.src = ocrImageDataUrl;
      preview.hidden = ocrPreviewSuppressed;
      var cap = OCR.capabilities();
      var backendOk = cloudOcrAvailable();
      var canOcr = cap.native || cap.cloud || backendOk;
      $('ocrStatus').className = ocrCapabilityClass();
      $('ocrStatus').textContent = canOcr
        ? '图片已就绪，点「开始识别」。'
        : '图片已就绪，但这台设备/后端都没有可用的文字识别能力 —— 你可以直接用示例小票演示或手动录入。';
    };
    reader.onerror = function () {
      $('ocrStatus').textContent = '读取图片失败，请重新选择。';
    };
    reader.readAsDataURL(file);
  }

  /**
   * 失败原因归到哪一层：读不到图 / 云端失败 / 本地失败 / 设备没能力。
   * 文案不能写死 —— 已配置云 OCR、只是云端请求失败（跨域/断网）的用户，
   * 不该被告知"缺少本地识别能力"再被建议"去配置云 OCR"。
   * @param {Object} result detect() 的失败结果（含 reason / tried / details）
   * @return {{title:string, status:string}}
   */
  function ocrFailureAttribution(result) {
    var reason = String((result && result.reason) || '');
    var tried = (result && result.tried) ? result.tried : [];
    var cap = OCR.capabilities();
    /* 「云端被尝试过」判定：优先看 tried，退回看 reason 里是否带云端原因 */
    var cloudTried = tried.indexOf('cloud') !== -1 || tried.indexOf('backend') !== -1 ||
      reason.indexOf('云端') !== -1 || reason.indexOf('后端') !== -1 || reason.indexOf('视觉') !== -1 ||
      reason.indexOf('WorkBuddy') !== -1;

    if (reason.indexOf('没有可用的图片数据') !== -1 || reason.indexOf('重新选一张截图') !== -1) {
      return {
        title: '没能读到这张截图 —— 请重新选一张图片',
        status: '这张图没能读到，重新选一张截图再试，或者直接手动录入。'
      };
    }
    if (cap.cloud && cloudTried) {
      return {
        title: '云端识别没成功 —— 凭据已配置，但这次请求失败',
        status: '没识别成功。不是你操作错了：凭据已配置，但这次云端请求失败了 —— ' +
          '检查一下网络或跨域限制，也可以核对凭据是否正确，或直接手动录入。'
      };
    }
    /* 走的是 WorkBuddy 云服务（免密钥）但没连上 / 调用失败：引导用线上版本打开 */
    if (reason.indexOf('WorkBuddy 云服务') !== -1 || reason.indexOf('云端') !== -1 || reason.indexOf('Vision') !== -1) {
      return {
        title: 'WorkBuddy 云服务没能识别 —— 可能没连上，或当前模型不支持看图',
        status: '没识别成功。不是你操作错了：已尝试用 WorkBuddy 云服务识别，但连接或调用失败了 —— ' +
          '请用线上版本打开本应用（' + CLOUD_APP_URL + '），确认能联网，或直接手动录入。'
      };
    }
    if (cap.native) {
      return {
        title: '本地识别没成功 —— 不是你操作的问题，这张图可能太模糊',
        status: '没识别成功。不是你操作错了：这台设备的本地识别没从图片里读出文字，' +
          '换一张更清晰的截图，或直接手动录入。'
      };
    }
    return {
      title: '没识别成功 —— 不是你操作的问题，是这台设备缺少本地识别能力',
      status: '没识别成功。不是你操作错了：这台设备没有可用的文字识别能力，' +
        '请用线上版本打开本应用以启用 WorkBuddy 云服务视觉识别（' + CLOUD_APP_URL + '），' +
        '也可以看示例小票或手动录入。'
    };
  }

  /**
   * 失败态卡片：一定要给出「下一步能做什么」，且第一条动作就是示例演示。
   * @param {string} reason 失败原因（会自动翻译成人话）
   * @param {string} [title] 卡片标题
   */
  function showOcrError(reason, title) {
    var host = $('ocrResult');
    /* 现在截图识别走 WorkBuddy 云服务（免密钥），没有「腾讯云 OCR 设置」可配；
       失败时这条按钮改为「打开线上版本」，引导用户用被云服务认可的来源打开。 */
    var useCloudApp = !!global.AJ_BACKEND_OCR;
    var cloudLabel = OCR.hasCredentials() ? '检查云 OCR 设置' : (useCloudApp ? '打开线上版本' : '配置云 OCR');
    var cloudAct = useCloudApp ? 'ocr-cloud-app' : 'ocr-cloud-config';
    host.innerHTML = '<div class="ocr-error">' +
      '<div class="ocr-error-title">' + esc(title || '这次没成功') + '</div>' +
      '<div class="ocr-error-text">' + esc(humanizeOcrReason(reason || '识别失败')) + '</div>' +
      '<div class="ocr-actions">' +
      '<button type="button" class="btn-mini primary" data-act="ocr-sample" data-index="0">用示例小票演示</button>' +
      '<button type="button" class="btn-mini" data-act="' + cloudAct + '">' + esc(cloudLabel) + '</button>' +
      '<button type="button" class="btn-mini" data-act="ocr-manual">手动录入</button>' +
      '</div></div>';
  }

  /** 用被云服务认可的线上来源打开本应用（AI 功能必须用它）。 */
  function openCloudAppLink() {
    try {
      if (typeof window.open === 'function') { window.open(CLOUD_APP_URL, '_blank'); }
    } catch (e) { /* 忽略弹窗被拦截 */ }
  }

  /**
   * 失败态「配置云 OCR」：关掉识别弹窗，打开设置抽屉并滚到云 OCR 区。
   * 抽屉里输入框有 id，用 closest 找区块，避免为了锚点多加 DOM 结构。
   */
  function openOcrCloudSettings() {
    closeOcrModal();
    openDrawer();
    var idInput = $('setOcrId');
    var section = idInput && idInput.closest ? idInput.closest('.drawer-group') : null;
    var target = section || idInput;
    if (!target) { return; }
    setTimeout(function () {
      if (typeof target.scrollIntoView === 'function') {
        try {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (e) {
          target.scrollIntoView();
        }
      }
      if (section) {
        section.classList.add('flash');
        setTimeout(function () { section.classList.remove('flash'); }, 1400);
      }
      if (idInput) { idInput.focus(); }
    }, 180);
  }

  function ocrConfidenceText(c) {
    if (c === 'high') { return { text: '置信度 高', cls: 'conf-high' }; }
    if (c === 'medium') { return { text: '置信度 中', cls: 'conf-medium' }; }
    return { text: '置信度 低', cls: 'conf-low' };
  }

  function renderOcrConfirm(result, parsed) {
    var conf = ocrConfidenceText(parsed.confidence);
    var categoryGuess = NLP.classify((parsed.merchant || '') + ' ' + (parsed.raw || ''));
    if (DATA.CATEGORY_KEYS.indexOf(categoryGuess) === -1) { categoryGuess = '其他'; }
    var options = DATA.CATEGORIES.map(function (c) {
      return '<option value="' + esc(c.key) + '"' + (c.key === categoryGuess ? ' selected' : '') + '>' +
        esc(c.key) + '</option>';
    }).join('');
    var todayStr = ENG.formatDate(new Date());
    var minStr = ENG.formatDate(new Date(Date.now() - 365 * 24 * 3600 * 1000));
    var dateValue = parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : todayStr;

    var html = '<div class="ocr-card">';

    /* 双保险：演示结果绝不能和用户上传的图片并存，否则用户会以为
       "我这张图被识别成了示例里的金额"。真的出现这种组合时，
       收起预览图并明确告知这是内置示例。 */
    if (result.source === 'demo' && ocrImageDataUrl) {
      var previewEl = $('ocrPreview');
      ocrPreviewSuppressed = true;
      if (previewEl) { previewEl.hidden = true; }
      html += '<div class="ocr-warn ocr-warn-demo">⚠️ 这是内置示例，不是你上传的截图，仅用于演示流程</div>';
    }

    html += '<div class="ocr-card-head">' +
      '<span class="conf ' + conf.cls + '">' + conf.text + '</span>' +
      '<span class="hint">' + esc(ocrSourceText(result.source)) + '</span>' +
      '</div>';

    if (parsed.confidence === 'low') {
      html += '<div class="ocr-warn">识别可能不准，请核对金额再确认。</div>';
    }
    if (parsed.dateWarn) {
      html += '<div class="ocr-warn">' + esc(parsed.dateWarn) + '</div>';
    }

    html += '<div class="ocr-grid">' +
      '<label class="field"><span>金额（¥）</span>' +
      '<input data-field="amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="' +
      parsed.amount.toFixed(2) + '" /></label>' +
      '<label class="field"><span>分类</span>' +
      '<select data-field="category">' + options + '</select></label>' +
      '<label class="field"><span>日期</span>' +
      '<input data-field="date" type="date" min="' + minStr + '" max="' + todayStr + '" value="' + dateValue + '" /></label>' +
      '<label class="field"><span>备注</span>' +
      '<input data-field="note" type="text" value="' + esc(parsed.merchant || '截图记账') + '" /></label>' +
      '</div>';

    if (parsed.payMethod) {
      html += '<div class="ocr-meta">支付方式：' + esc(parsed.payMethod) + '</div>';
    }

    html += '<details class="ocr-raw"><summary>识别原文</summary><pre>' + esc(parsed.raw) + '</pre></details>' +
      '<div class="ocr-actions">' +
      '<button type="button" class="btn-mini primary" data-act="ocr-confirm">确认记账</button>' +
      '<button type="button" class="btn-mini" data-act="ocr-retry">重新识别</button>' +
      '</div></div>';

    $('ocrResult').innerHTML = html;
    $('ocrStatus').textContent = '识别完成，核对下面的金额和分类，确认后会走正常入账流程。';
  }

  function handleOcrResult(result) {
    if (!result || !result.ok) {
      var attribution = ocrFailureAttribution(result);
      showOcrError(
        (result && result.reason) || '识别失败，可以直接手动录入。',
        attribution.title
      );
      $('ocrStatus').className = 'ocr-status warn';
      $('ocrStatus').textContent = attribution.status;
      return;
    }
    var parsed = OCR.parseReceipt(result.text, new Date());
    if (!parsed.ok) {
      showOcrError(parsed.reason + '。这张图可能是菜单、聊天记录或者太模糊了，建议手动录入。',
        '没读到金额 —— 这张图可能不是消费凭证');
      $('ocrStatus').className = 'ocr-status warn';
      $('ocrStatus').textContent = '没有读到金额。';
      return;
    }
    ocrDraft = parsed;
    renderOcrConfirm(result, parsed);
  }

  function runOcr() {
    if (!ocrPendingFile && !ocrImageDataUrl && ocrDemoIndex < 0) {
      $('ocrStatus').textContent = '先选一张截图（或点下面的示例小票）再识别。';
      return;
    }
    var runBtn = $('btnOcrRun');
    if (runBtn) { runBtn.disabled = true; }
    $('ocrResult').innerHTML = '';
    $('ocrStatus').className = 'ocr-status loading';
    $('ocrStatus').textContent = '识别中…';

    var task;
    if (ocrDemoIndex >= 0) {
      task = OCR.detect({ mode: 'demo', demoIndex: ocrDemoIndex });
    } else {
      /* auto 模式：没有可用识别能力时返回失败，由 UI 引导下一步；
         这里不再传 demoIndex —— 传了就给了"静默回落示例"的口子。 */
      task = OCR.detect({ mode: 'auto', file: ocrPendingFile, dataUrl: ocrImageDataUrl });
    }

    task.then(function (result) {
      if (runBtn) { runBtn.disabled = false; }
      $('ocrStatus').className = 'ocr-status';
      handleOcrResult(result);
    }).catch(function (err) {
      if (runBtn) { runBtn.disabled = false; }
      $('ocrStatus').className = 'ocr-status';
      showOcrError('识别流程异常：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  /** 确认截图记账：金额/分类/备注可编辑，最终仍走既有入账 + 冷静期流程 */
  function confirmOcrBill() {
    var host = $('ocrResult');
    var amountInput = host.querySelector('[data-field="amount"]');
    var amount = Number(amountInput ? amountInput.value : 0);
    if (!isFinite(amount) || amount <= 0) {
      if (amountInput) {
        amountInput.focus();
        $('ocrStatus').textContent = '金额需要大于 0。';
      }
      return;
    }
    var category = host.querySelector('[data-field="category"]').value;
    var date = host.querySelector('[data-field="date"]').value;
    var note = host.querySelector('[data-field="note"]').value.trim();
    var motive = NLP.detectMotivation(note + ' ' + (ocrDraft ? ocrDraft.raw : ''));
    var draft = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ENG.formatDate(new Date()),
      amount: ENG.round2(amount),
      category: DATA.CATEGORY_KEYS.indexOf(category) !== -1 ? category : '其他',
      note: note || category,
      motivation: motive.motivation,
      want: motive.want,
      type: 'expense'
    };
    closeOcrModal();
    switchView('chat');
    startFlow([draft]);
  }

  /** 下载文本文件 */
  function downloadText(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      var url = global.URL.createObjectURL(blob);
      var a = DOC.createElement('a');
      a.href = url;
      a.download = filename;
      DOC.body.appendChild(a);
      a.click();
      DOC.body.removeChild(a);
      setTimeout(function () { global.URL.revokeObjectURL(url); }, 5000);
      return true;
    } catch (e) {
      addAIMessage(aiBubble('导出失败了：当前浏览器可能不支持文件下载。'));
      return false;
    }
  }

  /* ================================================================== */
  /* 省钱雷达：活动日历 + 比价计算器                                      */
  /* ================================================================== */

  var dealsTab = 'today';
  var dealsLastResult = null;
  var dealsForm = {
    item: '充电宝',
    budget: '',
    rows: [
      { platform: '淘宝', price: '', spec: '10000mAh', ship: '', coupon: '', need: '' },
      { platform: '拼多多', price: '', spec: '10000mAh', ship: '', coupon: '', need: '' },
      { platform: '京东', price: '', spec: '10000mAh', ship: '', coupon: '', need: '' }
    ]
  };
  var DEAL_PLATFORMS = ['淘宝', '天猫', '京东', '拼多多', '抖音', '唯品会', '美团', '饿了么', '线下门店'];

  function dealsNow() { return new Date(); }
  function dealsReady() { return DEALS && typeof DEALS.compareOffers === 'function'; }

  /** 统一处理卡片/面板里的动作按钮 */
  function handleDealAct(act) {
    if (!act) { return; }
    if (act === 'open-today' || act === 'open-deals') { openDealsSheet('today'); return; }
    if (act === 'open-calendar') { openDealsSheet('calendar'); return; }
    if (act === 'open-compare') { openDealsSheet('compare'); return; }
    if (act === 'close') { closeDealsSheet(); return; }
    if (act === 'record') { recordDealBill(); return; }
  }

  /* 省钱雷达入口已并入「省钱」面板：这里只做薄封装，调用点全部保持不变 */
  function openDealsSheet(tab) { openSaveHub('radar', tab); }

  function closeDealsSheet() { closeSaveHub(); }

  function renderDealsSheet() {
    var d = dealsNow();
    $('dealsHeadDate').textContent = DEALS.dateKey(d) + ' ' + DEALS.weekdayCn(d);
    var tabs = DOC.querySelectorAll('#dealsTabs .atab');
    var i;
    for (i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-deal-tab') === dealsTab);
    }
    var pane = $('dealsPane');
    if (dealsTab === 'calendar') { pane.innerHTML = dealsCalendarHtml(d); }
    else if (dealsTab === 'compare') { pane.innerHTML = dealsCompareHtml(d); }
    else if (dealsTab === 'about') { pane.innerHTML = dealsAboutHtml(d); }
    else { pane.innerHTML = dealsTodayHtml(d); }
  }

  /** 今天：限时活动 + 未来 7 天 + 常驻活动 */
  function dealsTodayHtml(d) {
    var all = DEALS.dealsOn(d);
    var limited = all.filter(function (x) { return x.type !== 'always'; });
    var always = all.filter(function (x) { return x.type === 'always'; });
    var np = DEALS.nextPromo(d);
    var html = '';

    if (np) {
      html += '<div class="deals-promo-banner">' +
        '<b>' + esc(np.promo.name) + (np.days === 0 ? ' 就是今天' : ' 还有 ' + np.days + ' 天') + '</b>' +
        '<span>' + esc(np.promo.depth) + ' · 适合买：' + esc(np.promo.bestFor) + '</span>' +
        '</div>';
    }

    html += '<div class="deals-sec">今天的限时活动</div>';
    if (!limited.length) {
      var kfc = DEALS.nextOf('kfc', d);
      html += '<div class="deals-empty">今天是' + esc(DEALS.weekdayCn(d)) +
        '，没有固定的限时活动（肯德基在周四、麦当劳在周一、瑞幸 / 库迪在周二）。<br>' +
        '最近一场：<b>肯德基疯狂星期四 ' + esc(DEALS.dateKey(kfc)) + '（' + esc(DEALS.weekdayCn(kfc)) +
        '）</b>，还有 ' + DEALS.daysBetween(d, kfc) + ' 天。</div>';
    } else {
      limited.forEach(function (it) {
        html += '<div class="deal-item">' +
          '<div class="di-head"><span class="di-emoji">' + esc(it.emoji) + '</span>' +
          '<b>' + esc(it.name) + ' · ' + esc(it.title) + '</b>' +
          '<span class="di-tag">' + esc(it.tag) + '</span></div>' +
          (it.place ? '<div class="di-place">📍 ' + esc(it.place) + '</div>' : '') +
          '<p>' + esc(it.what) + '</p>' +
          '<p class="di-how">👉 ' + esc(it.how) + '</p>' +
          '<p class="di-tip">⚠ ' + esc(it.tip) + '</p>' +
          (it.coach ? '<p class="di-coach">🎓 ' + esc(it.coach) + '</p>' : '') +
          '</div>';
      });
    }

    var up = DEALS.upcoming(8, d).filter(function (x) { return x.items.length && x.offset > 0; });
    if (up.length) {
      html += '<div class="deals-sec">接下来 7 天</div><div class="deals-up">';
      up.forEach(function (day) {
        var names = day.items.map(function (x) { return x.name + '·' + x.title; }).join('；');
        var tag = day.items.length > 1 ? day.items.length + ' 场' : day.items[0].tag;
        html += '<div class="deals-up-row">' +
          '<span class="du-date">' + esc(day.date.slice(5)) + '<small>' + esc(day.weekday) + '</small></span>' +
          '<span class="du-text">' + esc(names) + '</span>' +
          '<span class="du-tag">' + esc(tag) + '</span>' +
          '</div>';
      });
      html += '</div>';
    }

    if (always.length) {
      html += '<div class="deals-sec">常驻优惠（不用等）</div><div class="deals-pills">';
      always.forEach(function (it) {
        html += '<span class="deals-pill" title="' + esc(it.tip) + '">' + esc(it.emoji) + ' ' +
          esc(it.name) + '·' + esc(it.title) + (it.place ? '（' + esc(it.place) + '）' : '') + '</span>';
      });
      html += '</div>';
    }

    html += '<p class="deals-note">活动日期由本地日历按「每周几 / 每月几号」计算，真实有效不联网也不会过期；' +
      '具体单品、价格与参与门店以官方页面为准——这里不编价格。</p>';
    return html;
  }

  /** 14 天日历 */
  function dealsCalendarHtml(d) {
    var days = DEALS.upcoming(14, d);
    var html = '<div class="deals-cal">';
    days.forEach(function (day) {
      var isToday = day.offset === 0;
      html += '<div class="deals-cal-row' + (isToday ? ' is-today' : '') + '">' +
        '<div class="dc-day"><b>' + esc(day.date.slice(5)) + '</b><small>' + esc(day.weekday) +
        (isToday ? ' · 今天' : '') + '</small></div>' +
        '<div class="dc-items">';
      if (!day.items.length) {
        html += '<span class="dc-none">—</span>';
      } else {
        day.items.forEach(function (it) {
          html += '<span class="dc-chip ' + (it.type === 'promo' ? 'is-promo' : '') + '">' +
            esc(it.emoji) + ' ' + esc(it.name) + '·' + esc(it.title) + '</span>';
        });
      }
      html += '</div></div>';
    });
    html += '</div>';
    html += '<p class="deals-note">日历由日期算法生成：周四 = 校门口肯德基，周一 = 阳光广场麦当劳，周二 = 阳光广场瑞幸 / 库迪；' +
      '大促只标「预热开始」和「当天」，不重复刷屏。</p>';
    return html;
  }

  /** 比价计算器 */
  function dealsCompareHtml(d) {
    var html = '';
    html += '<div class="dc-grid">' +
      '<label class="dc-field"><span>买什么</span>' +
      '<input id="dcItem" type="text" value="' + esc(dealsForm.item) + '" placeholder="如 充电宝 10000mAh" /></label>' +
      '<label class="dc-field"><span>预算（¥，选填）</span>' +
      '<input id="dcBudget" type="number" inputmode="decimal" value="' + esc(dealsForm.budget) + '" placeholder="如 100" /></label>' +
      '</div>';

    html += '<div class="deals-sec">各平台报价（你看到的价，不是猜的）</div><div class="dc-offers" id="dcOffers">';
    dealsForm.rows.forEach(function (r, idx) {
      html += dealOfferRowHtml(r, idx);
    });
    html += '</div>';

    html += '<div class="dcz-actions">' +
      '<button class="btn-mini primary" id="btnDealCalc" type="button">算一算</button>' +
      '<button class="btn-mini" id="btnDealDemo" type="button">填示例（充电宝）</button>' +
      '<button class="btn-mini" id="btnDealAdd" type="button">+ 加一个平台</button>' +
      '</div>';

    html += '<div id="dealsResult">' + (dealsLastResult ? dealResultHtml(dealsLastResult) : '') + '</div>';

    var band = DEALS.findBand(dealsForm.item);
    if (band) {
      html += '<p class="deals-note">「' + esc(band.name) + '」价格带参考：入门 ' + band.low[0] + '-' + band.low[1] +
        ' 元 / 中档 ' + band.mid[0] + '-' + band.mid[1] + ' 元 / 高档 ' + band.high[0] + '-' + band.high[1] +
        ' 元，通常 ' + esc(band.channel) + ' 更便宜。</p>';
    }
    html += '<p class="deals-note">口径：到手价 = 标价 × 需买件数 + 运费 − 券；规格不同的只能比折合单价。' +
      '本工具不抓电商页面、不保证最低价，请以下单页实时价为准。</p>';
    return html;
  }

  function dealOfferRowHtml(r, idx) {
    var opts = '';
    DEAL_PLATFORMS.forEach(function (p) {
      opts += '<option value="' + esc(p) + '"' + (r.platform === p ? ' selected' : '') + '>' + esc(p) + '</option>';
    });
    return '<div class="dc-offer" data-offer>' +
      '<div class="dco-main">' +
      '<select class="dc-plat">' + opts + '</select>' +
      '<input class="dc-price" type="number" inputmode="decimal" placeholder="价格" value="' + esc(r.price) + '" />' +
      '<input class="dc-spec" type="text" placeholder="规格 10000mAh / 12包" value="' + esc(r.spec) + '" />' +
      '</div>' +
      '<div class="dco-extra">' +
      '<input class="dc-ship" type="number" inputmode="decimal" placeholder="运费" value="' + esc(r.ship) + '" />' +
      '<input class="dc-coupon" type="number" inputmode="decimal" placeholder="券" value="' + esc(r.coupon) + '" />' +
      '<input class="dc-need" type="number" inputmode="numeric" placeholder="需买N件" value="' + esc(r.need) + '" />' +
      (idx > 0 ? '<button class="dc-del" type="button" data-del-row="' + idx + '" aria-label="删除这行"><svg viewBox="0 0 24 24"><use href="#i-trash"/></svg></button>' : '<span class="dc-del-ph"></span>') +
      '</div></div>';
  }

  /** 把表单当前值读回 dealsForm，避免切 tab 丢输入 */
  function syncDealForm() {
    var itemEl = $('dcItem');
    if (itemEl) { dealsForm.item = itemEl.value.trim(); }
    var budgetEl = $('dcBudget');
    if (budgetEl) { dealsForm.budget = budgetEl.value.trim(); }
    var rows = DOC.querySelectorAll('#dcOffers [data-offer]');
    if (rows.length) {
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        out.push({
          platform: rows[i].querySelector('.dc-plat').value,
          price: rows[i].querySelector('.dc-price').value,
          spec: rows[i].querySelector('.dc-spec').value,
          ship: rows[i].querySelector('.dc-ship').value,
          coupon: rows[i].querySelector('.dc-coupon').value,
          need: rows[i].querySelector('.dc-need').value
        });
      }
      dealsForm.rows = out;
    }
  }

  function runDealCompare() {
    if (!dealsReady()) { return; }
    syncDealForm();
    var offers = [];
    dealsForm.rows.forEach(function (r) {
      if (String(r.price).trim() === '') { return; }
      offers.push({
        platform: r.platform,
        price: r.price,
        spec: r.spec,
        ship: r.ship || 0,
        coupon: r.coupon || 0,
        needQty: r.need || 1
      });
    });
    if (!offers.length) {
      $('dealsResult').innerHTML = '<div class="deals-empty">先填至少一个平台的价格，我才算得出来。' +
        '价格不用精确到分，看到多少填多少。</div>';
      return;
    }
    var res = DEALS.compareOffers(offers, {
      item: dealsForm.item || '这个商品',
      budget: dealsForm.budget
    });
    dealsLastResult = res;
    var box = $('dealsResult');
    box.innerHTML = dealResultHtml(res);
    if (box.scrollIntoView) {
      try { box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* 老浏览器忽略 */ }
    }
  }

  function dealResultHtml(r) {
    var html = '<div class="dc-result">';
    html += '<div class="dc-headline' + (r.comparable ? '' : ' is-warn') + '">' +
      (r.comparable ? '✅ ' : '⚠️ ') + esc(r.headline) + '</div>';

    if (r.rows && r.rows.length) {
      html += '<div class="dc-table">' +
        '<div class="dc-tr dc-th"><span>平台 / 商品</span><span>到手价</span><span>折合单价</span></div>';
      r.rows.forEach(function (row, i) {
        html += '<div class="dc-tr' + (i === 0 ? ' is-best' : '') + '">' +
          '<span class="dc-td-plat"><b>' + esc(row.platform) + '</b>' +
          (row.title ? '<small>' + esc(row.title) + '</small>' : '') +
          (row.needQty > 1 ? '<em class="dc-need-tag">需买 ' + row.needQty + ' 件</em>' : '') +
          '</span>' +
          '<span class="dc-td-eff">¥' + DEALS.fmt(row.eff) + '</span>' +
          '<span class="dc-td-per">' + esc(DEALS.perLabel(row)) + '</span>' +
          '</div>';
      });
      html += '</div>';
    }

    if (r.budget) {
      html += '<p class="dc-line ' + (r.budget.ok ? 'is-good' : 'is-bad') + '">💰 ' + esc(r.budget.text) + '</p>';
    }
    if (r.band) {
      html += '<p class="dc-line">📊 这个价属于「' + esc(r.band.band) + '」的 <b>' + esc(r.band.label) + '</b> 档：' +
        esc(r.band.text) + '。</p>';
    }
    if (r.timing && r.timing.text) {
      html += '<p class="dc-line">⏰ ' + esc(r.timing.text) + '</p>';
    }
    if (r.sublines && r.sublines.length) {
      html += '<ul class="dc-list">';
      r.sublines.forEach(function (s) { html += '<li>' + esc(s) + '</li>'; });
      html += '</ul>';
    }
    if (r.warnings && r.warnings.length) {
      html += '<ul class="dc-list is-warn">';
      r.warnings.forEach(function (s) { html += '<li>⚠ ' + esc(s) + '</li>'; });
      html += '</ul>';
    }
    if (r.ok && r.best) {
      html += '<div class="dcz-actions">' +
        '<button class="btn-mini primary" type="button" data-deal-act="record">把这笔记进账本</button>' +
        '<button class="btn-mini" type="button" data-deal-act="open-today">今天还有什么优惠</button>' +
        '</div>' +
        '<p class="deals-note">「记进账本」按最低到手 ¥' + DEALS.fmt(r.best.eff) +
        ' 记一笔购物支出，记完可以给它打「值不值」。</p>';
    }
    html += '<p class="deals-note">以上价格来自你填写的报价；活动与折扣随时变动，请以下单页面为准。</p>';
    html += '</div>';
    return html;
  }

  function fillDealDemo() {
    dealsForm.item = '充电宝 10000mAh';
    dealsForm.budget = '100';
    dealsForm.rows = [
      { platform: '淘宝', price: '89', spec: '10000mAh', ship: '', coupon: '', need: '' },
      { platform: '拼多多', price: '79', spec: '10000mAh', ship: '', coupon: '5', need: '' },
      { platform: '京东', price: '99', spec: '10000mAh', ship: '', coupon: '', need: '2' }
    ];
    $('dealsPane').innerHTML = dealsCompareHtml(dealsNow());
    runDealCompare();
  }

  function recordDealBill() {
    if (!dealsLastResult || !dealsLastResult.ok || !dealsLastResult.best) { return; }
    var res = dealsLastResult;
    var amount = Math.round(res.best.eff * 100) / 100;
    closeDealsSheet();
    switchView('chat');
    startFlow([{
      date: ENG.formatDate(new Date()),
      amount: amount,
      category: '购物',
      note: res.item || '购物',
      motivation: '刚需',
      want: false,
      type: 'expense'
    }]);
  }

  function dealsAboutHtml() {
    return '<div class="deals-about">' +
      '<div class="deals-sec">数据从哪来（三条路径，各自标注）</div>' +
      '<div class="deal-item">' +
      '<div class="di-head"><svg class="di-emoji" viewBox="0 0 24 24"><use href="#i-abacus"/></svg><b>路径三 · 真实日期算法</b><span class="di-tag">已实现</span></div>' +
      '<p>疯狂星期四 = <code>weekday()==3</code>（周四）、麦当劳「13.9 元随心配」= 每周一、瑞幸 / 库迪 9.9 元 = 每周二、双11 = 11-11。' +
      '日期全部由代码算出，指定任意日期都能算出下一次是哪天，不依赖网络、不会过期。</p>' +
      '<p class="di-how">产出：14 天日历 + 「真实商家日历.csv」（可下载，Excel 直接打开）</p>' +
      '</div>' +
      '<div class="deal-item">' +
      '<div class="di-head"><svg class="di-emoji" viewBox="0 0 24 24"><use href="#i-plug"/></svg><b>路径二 · 比价 API</b><span class="di-tag">已实现</span></div>' +
      '<p>本机有一套同口径引擎（前端 deals.js / 后端 deals_engine.py + deals_api.py），' +
      '把「标价 + 运费 − 券 × 件数」算成到手价，再按规格折单价、判定可比性。' +
      '大模型可以通过 HTTP 直接调这些接口，不用自己算数。</p>' +
      '<p class="di-how">接口：<code>/api/deals/today</code> <code>/api/deals/calendar</code> ' +
      '<code>/api/deals/compare</code> <code>/api/deals/quote</code> <code>/api/deals/ask</code></p>' +
      '</div>' +
      '<div class="deal-item">' +
      '<div class="di-head"><svg class="di-emoji" viewBox="0 0 24 24"><use href="#i-robot"/></svg><b>路径一 · 大模型 + 工具调用</b><span class="di-tag">已实现</span></div>' +
      '<p>后端 <code>/api/deals/ask</code> 用 tool-calling 把「查日历、算比价」注册成工具，' +
      '模型先调工具拿真实日期与计算结果，再组织成一句话——不是让模型凭记忆瞎说。' +
      '没配大模型时自动降级为本地确定性回答。</p>' +
      '<p class="di-how">没配 LLM_API_KEY 也能用；配了则模型自己决定查日历还是算比价</p>' +
      '</div>' +
      '<div class="deals-sec">我刻意不做的事</div>' +
      '<ul class="dc-list">' +
      '<li>不抓电商页面、不绕反爬：价格会过期，抓取也不合规；</li>' +
      '<li>不编价格：没有真实报价时，只给价格带参考并告诉你还差什么；</li>' +
      '<li>不硬下结论：规格口径对不上（比如「12 包」vs「6 提」）就明说比不了；</li>' +
      '<li>不承诺最低价、不导流、不发店铺链接。</li>' +
      '</ul>' +
      '<p class="deals-note">想接真实价格？在 deals_api.py 的 .env 里配 PRICE_API_URL / PRICE_API_KEY / PRICE_FIELD_MAP，' +
      '把官方接口的返回字段映射进来即可，比价引擎不用改一行。</p>' +
      '</div>';
  }

  /** 看板上的省钱雷达小卡 */
  function renderDealsMini() {
    var box = $('dealsMini');
    if (!box || !dealsReady()) { return; }
    var d = dealsNow();
    var list = DEALS.dealsOn(d).filter(function (x) { return x.type !== 'always'; });
    var np = DEALS.nextPromo(d);
    var kfc = DEALS.nextOf('kfc', d);
    var html = '';
    if (list.length) {
      list.slice(0, 2).forEach(function (it) {
        html += '<div class="dm-line"><span class="dm-dot"></span><b>' + esc(it.name) + '</b> ' +
          esc(it.title) + '<em>' + esc(it.tag) + '</em></div>';
      });
    } else {
      html += '<div class="dm-line"><span class="dm-dot"></span>今天没有固定限时活动，下一场是 <b>肯德基疯狂星期四 ' +
        esc(DEALS.dateKey(kfc).slice(5)) + '</b>（' + DEALS.daysBetween(d, kfc) + ' 天后）</div>';
    }
    if (np) {
      html += '<div class="dm-line dm-promo"><span class="dm-dot"></span>' + esc(np.promo.name) +
        ' 还有 <b>' + np.days + '</b> 天 · ' + esc(np.promo.depth) + '</div>';
    }
    html += '<div class="dm-line dm-tip">💡 ' + esc(DEALS.timingAdvice(0, d).text) + '</div>';
    box.innerHTML = html;
  }

  /** 聊天入口：今天有什么优惠 */
  function showDealsTodayCard() {
    switchView('chat');
    if (!dealsReady()) { addAIMessage(aiBubble('省钱雷达没加载起来，刷新页面再试。')); return; }
    addAIMessage(aiBubble(DEALS.todayCardHtml(dealsNow())));
  }

  /** 聊天入口：疯狂星期四 */
  function showKfcDealsCard() {
    switchView('chat');
    if (!dealsReady()) { addAIMessage(aiBubble('省钱雷达没加载起来，刷新页面再试。')); return; }
    addAIMessage(aiBubble(DEALS.kfcCardHtml(dealsNow())));
  }

  /** 聊天入口：比价（先从话里抽商品名与预算，再让用户填报价） */
  function showDealCompareFromText(raw) {
    switchView('chat');
    if (!dealsReady()) { addAIMessage(aiBubble('省钱雷达没加载起来，刷新页面再试。')); return; }
    var text = String(raw || '');
    var budget = '';
    var mb = text.match(/(\d+(?:\.\d+)?)\s*(?:块|元|rmb|RMB)/);
    if (mb) { budget = mb[1]; }
    var item = text
      .replace(/我想买一个|我想买个|我想买|想买一个|想买个|想买|要买|打算买|准备买|入手/g, ' ')
      .replace(/比个价|帮我比价|比价|帮忙|帮我|查一下|看一下|多少钱划算|多少钱|划算吗|划算不划算|划算|哪家便宜|哪里便宜|便宜|买一个|买个|买|一个|的|吗|呢|？|\?/g, ' ')
      .replace(/\d+(?:\.\d+)?\s*(?:块|元|rmb|RMB)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (item.length < 2) { item = '这个商品'; }
    dealsForm.item = item;
    if (budget) { dealsForm.budget = budget; }
    addAIMessage(aiBubble(DEALS.compareIntroHtml(item, budget, dealsNow())));
  }

  /* ================================================================== */
  /* 省钱图谱：今日清单 / 100 条图谱 / 打卡省钱账                          */
  /* ================================================================== */

  var savingsTab = 'today';
  var savingsCat = '';
  var savingsQuery = '';
  /** 图谱里已展开详情的条目 id（仅内存，不持久化） */
  var savingsOpen = {};
  /** 省钱账是否展开全部记录（默认只显示最近 12 条） */
  var savingsBookAll = false;
  /** 正在手改金额的那条记录 { id, date } | null —— 只影响渲染，不持久化 */
  var savingsEdit = null;

  function savingsReady() { return !!(SAV && SAV.READY); }

  /**
   * 今日清单的上下文：把账本信息翻译成引擎需要的打分条件。
   * 这样「你 62% 的钱花在餐饮」才能反过来决定推哪几条动作。
   */
  function savingsCtx(ov) {
    ov = ov || getOverview();
    var byCat = ov.cycleAgg.byCategory || {};
    var topCat = '', topVal = 0, k;
    for (k in byCat) {
      if (!Object.prototype.hasOwnProperty.call(byCat, k)) { continue; }
      if (byCat[k] > topVal) { topVal = byCat[k]; topCat = k; }
    }
    return {
      now: new Date(),
      logs: savingsDb.logs,
      topCat: topCat,
      catSpend: byCat,
      budgetStatus: ov.budgetState.status,
      limit: 5
    };
  }

  function savingsDay() { return SAV.dateKey(new Date()); }

  /** 今天已打卡的记录（含条目对象，用于「今天已打卡」区和撤销） */
  function savingsTodayDone() {
    var day = savingsDay();
    var out = [];
    for (var i = 0; i < savingsDb.logs.length; i++) {
      var r = savingsDb.logs[i];
      if (r.date !== day) { continue; }
      var e = SAV.byId(r.id);
      if (e) { out.push({ entry: e, rec: r }); }
    }
    return out;
  }

  function savingsSumSummary() {
    var ov = getOverview();
    return SAV.summary(savingsDb.logs, { cycleStart: ov.cycle.start, cycleEnd: ov.cycle.end });
  }

  /* ---------------- 开关 ---------------- */

  /**
   * 省钱面板的一级视图：'radar'（省钱雷达）| 'graph'（省钱图谱）。
   * 两个功能原本各占一个全屏 sheet，顶栏和「我的」菜单各有入口，占地且重复；
   * 现在合并为一个面板，用一级分段控件（#saveHubSeg）切换，内部结构不变。
   */
  var saveHubView = 'radar';

  /**
   * 打开省钱面板，可直接指定落到哪一侧、以及该侧的二级 tab。
   * 完整版：面板在 #saveHubMask 里，按弹层显示。
   * 简洁版：面板已由 mountShellPanels 搬进 #spSaveBody（独立页面），
   *         没有遮罩可弹，改为切到 ssave 屏，由 renderSaveHubPanel 统一重绘。
   * @param {string} view 'radar' | 'graph'，非法值一律按 'radar'
   * @param {string=} tab 二级 tab（today / calendar / compare / about …）
   */
  function openSaveHub(view, tab) {
    var next = (view === 'graph') ? 'graph' : 'radar';
    /* 先做就绪校验再落状态：否则提前 return 后 saveHubView 与画面会不一致 */
    if (next === 'radar' && !dealsReady()) {
      addAIMessage(aiBubble('省钱雷达模块没加载起来，刷新一下页面再试。'));
      return;
    }
    if (next === 'graph' && !savingsReady()) {
      degradeSavingsUi();
      addAIMessage(aiBubble('省钱图谱模块没加载起来，刷新一下页面再试。'));
      return;
    }
    saveHubView = next;
    if (saveHubView === 'radar') { dealsTab = tab || dealsTab || 'today'; }
    else { savingsTab = tab || savingsTab || 'today'; }
    var sheet = $('saveHubSheet');
    if (sheet) { sheet.setAttribute('data-hub', saveHubView); }
    var segs = DOC.querySelectorAll('#saveHubSeg .shs');
    for (var i = 0; i < segs.length; i++) {
      var on = segs[i].getAttribute('data-hub') === saveHubView;
      segs[i].classList.toggle('active', on);
      segs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var radarView = $('saveHubViewRadar');
    var graphView = $('saveHubViewGraph');
    if (radarView) { radarView.hidden = (saveHubView !== 'radar'); }
    if (graphView) { graphView.hidden = (saveHubView !== 'graph'); }
    if (getUiMode() === 'simple') {
      /* 简洁版没有遮罩：切到「省钱」屏即可，内容由 switchView → renderSaveHubPanel 重绘。
         绝不能把 #saveHubMask 打开 —— 面板不在里面，只会留下空遮罩盖住整页。 */
      switchView('ssave');
    } else {
      $('saveHubMask').hidden = false;
      if (saveHubView === 'radar') { renderDealsSheet(); } else { renderSavingsSheet(); }
    }
    if (saveHubView === 'graph' && savingsRecovered) {
      savingsRecovered = false;
      showToast('省钱打卡记录格式异常，已重置（账单数据没受影响）');
    }
  }

  /**
   * 简洁版「省钱」屏的内容渲染。
   * 面板常驻在 #spSaveBody 内，这里只按当前一级视图（radar / graph）重绘，
   * 不碰遮罩、不弹层 —— 与完整版的 openSaveHub 分开，避免两套语义互相污染。
   */
  function renderSaveHubPanel() {
    if (saveHubView === 'graph') {
      if (savingsReady()) { renderSavingsSheet(); }
    } else if (dealsReady()) {
      renderDealsSheet();
    }
  }

  /**
   * 一级分段控件切换。点当前已激活的那一侧不重绘，避免无谓的 DOM 重建。
   * @param {string} view 'radar' | 'graph'
   */
  function switchSaveHub(view) {
    if (view === saveHubView) { return; }
    openSaveHub(view);
  }

  /** 关闭省钱面板（雷达/图谱共用同一个面板，关闭即整体收起） */
  function closeSaveHub() {
    $('saveHubMask').hidden = true;
    /* 关面板就丢掉未保存的改金额状态，下次打开是干净的 */
    savingsEdit = null;
  }

  /* 省钱图谱入口已并入「省钱」面板：同样只做薄封装，调用点保持不变 */
  function openSavingsSheet(tab) { openSaveHub('graph', tab); }

  function closeSavingsSheet() { closeSaveHub(); }

  /**
   * 降级：savings.js 没加载起来时，把纯图谱入口置灰，
   * 而不是留一个点了没反应（或报错）的按钮。账本功能完全不受影响。
   * 注意：#btnSaveHub / #spMenuSaveHub 同时承载省钱雷达，雷达模块正常时不该被拖死，故不在此列。
   */
  function degradeSavingsUi() {
    var ids = ['btnSavingsCard'];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (!el) { continue; }
      el.disabled = true;
      el.title = '省钱图谱模块未加载';
      el.style.opacity = '0.45';
      el.style.pointerEvents = 'none';
    }
    var mini = $('savingsMini');
    if (mini) { mini.innerHTML = '<div class="dm-line">省钱图谱模块未加载，其他功能正常</div>'; }
  }

  function renderSavingsSheet() {
    if (!savingsReady()) { return; }
    var tabs = DOC.querySelectorAll('#savingsTabs .atab');
    var i;
    for (i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-sv-tab') === savingsTab);
    }
    var st = $('savingsHeadStat');
    if (st) { st.textContent = savingsHeadStatText(); }

    var pane = $('savingsPane');
    if (!pane) { return; }
    var body = pane.parentNode;
    var keepTop = body ? body.scrollTop : 0;

    if (savingsTab === 'map') { pane.innerHTML = savingsMapHtml(); }
    else if (savingsTab === 'index') { pane.innerHTML = savingsIndexHtml(); }
    else if (savingsTab === 'book') { pane.innerHTML = savingsBookHtml(); }
    else if (savingsTab === 'about') { pane.innerHTML = savingsAboutHtml(); }
    else { pane.innerHTML = savingsTodayHtml(); }

    if (body) { body.scrollTop = keepTop; }
  }

  function savingsHeadStatText() {
    var s = savingsSumSummary();
    return '累计省下 ' + money(s.totalSaved) + ' · 打卡 ' + s.count + ' 次';
  }

  /**
   * 单条记录的金额标签。
   * 大促 / 年卡型条目金额记 0（总额不是「今天省了多少」），这里用「大促」「全年」
   * 这种标签替代「—」，否则用户会以为打卡没生效。
   */
  function savingsAmountLabel(entry, saved) {
    if (saved > 0) { return '¥' + SAV.fmt(saved); }
    if (entry && entry.save && entry.save.once) {
      var label = entry.save.onceLabel || '一次性省';
      return label.replace(/可省$/, '').replace(/省$/, '') || '一次性';
    }
    return '—';
  }

  /* ---------------- 今天 ---------------- */

  function savingsTodayHtml() {
    var ctx = savingsCtx();
    var sum = savingsSumSummary();
    var done = savingsTodayDone();
    var html = '';

    html += '<div class="sv-hero">' +
      '<div class="sv-hero-num"><b>' + money(sum.monthSaved) + '</b><small>本周期省下</small></div>' +
      '<div class="sv-hero-num"><b>' + sum.monthCount + '</b><small>本周期打卡</small></div>' +
      '<div class="sv-hero-num"><b>' + money(sum.totalSaved) + '</b><small>累计省下</small></div>' +
      '</div>';

    html += SAV.todayCardHtml(ctx);

    if (done.length) {
      var dSum = 0, i;
      for (i = 0; i < done.length; i++) { dSum += (done[i].rec.saved || 0); }
      html += '<div class="sv-sec">今天已打卡 ' + done.length + ' 条 · 约省 ' + money(dSum) + '</div>';
      html += '<div class="sv-done-list">';
      for (i = 0; i < done.length; i++) {
        var m = SAV.catMeta(done[i].entry.cat);
        html += '<div class="sv-done-row">' +
          '<span class="sv-done-ico">' + esc(m.emoji) + '</span>' +
          '<span class="sv-done-title">' + esc(done[i].entry.title) + '</span>' +
          '<span class="sv-done-save">' + savingsAmountLabel(done[i].entry, done[i].rec.saved) + '</span>' +
          '<button type="button" class="btn-mini" data-sv-act="toggle" data-sv-id="' + esc(done[i].entry.id) + '">撤销</button>' +
          '</div>';
      }
      html += '</div>';
    }

    return html;
  }

  /* ---------------- 图谱 ---------------- */

  function savingsFiltered() {
    var list = savingsCat ? SAV.byCat(savingsCat) : SAV.ENTRIES;
    if (savingsQuery) { return SAV.search(list, savingsQuery); }
    return list;
  }

  function savingsMapHtml() {
    var list = savingsFiltered();
    var html = '';

    html += '<div class="sv-filter">' +
      '<input type="search" id="svSearch" class="sv-search" placeholder="搜「奶茶」「打印」「周四」…" value="' +
      esc(savingsQuery) + '" autocomplete="off" />' +
      '<span class="sv-count" id="svCount">' + list.length + ' 条</span>' +
      '</div>';

    html += '<div class="sv-chips" id="svChips">';
    html += '<button type="button" class="sv-chip' + (savingsCat ? '' : ' active') + '" data-sv-cat="">全部 ' +
      SAV.ENTRIES.length + '</button>';
    SAV.CATS.forEach(function (c) {
      html += '<button type="button" class="sv-chip' + (savingsCat === c.key ? ' active' : '') +
        '" data-sv-cat="' + esc(c.key) + '">' + esc(c.emoji) + ' ' + esc(c.name) + '</button>';
    });
    html += '</div>';

    html += '<div class="sv-list" id="svList">' + savingsListHtml() + '</div>';
    return html;
  }

  function savingsListHtml() {
    var list = savingsFiltered();
    if (!list.length) {
      return '<div class="sv-empty">没找到「' + esc(savingsQuery || '该分类') + '」相关的动作。<br>' +
        '<span class="hint">换个说法试试，比如「奶茶」可以搜「茶饮」「瑞幸」「霸王茶姬」。</span></div>';
    }
    var day = savingsDay();
    var html = '', i;
    for (i = 0; i < list.length; i++) {
      var e = list[i];
      var chk = SAV.isChecked(savingsDb.logs, e.id, day);
      html += SAV.entryCardHtml(e, { checked: chk, q: savingsQuery });
      if (savingsOpen[e.id]) { html += savingsDetailHtml(e); }
    }
    return html;
  }

  /** 详情：把「怎么操作」拆成可核对的字段，避免用户被一句口号忽悠 */
  function savingsDetailHtml(e) {
    var day = savingsDay();
    var hits = 0;
    for (var i = 0; i < savingsDb.logs.length; i++) {
      if (savingsDb.logs[i].id === e.id) { hits++; }
    }
    var rows = [
      ['完整做法', e.action],
      ['什么时候能用', SAV.triggerText(e)],
      ['用在哪', SAV.sceneText(e)],
      ['能省多少', SAV.saveRangeText(e)],
      ['门槛', e.gate],
      ['适合谁', e.who],
      ['坑在哪', e.risk],
      ['关联账本分类', (e.billCats || []).join(' / ') || '—'],
      ['数据来源', e.source || '—'],
      ['我的打卡', hits ? '共 ' + hits + ' 次' + (SAV.isChecked(savingsDb.logs, e.id, day) ? '（今天已打卡）' : '') : '还没打卡过']
    ];
    var html = '<div class="sv-detail">';
    for (var k = 0; k < rows.length; k++) {
      html += '<div class="sv-detail-row"><span class="sv-detail-k">' + esc(rows[k][0]) + '</span>' +
        '<span class="sv-detail-v">' + esc(rows[k][1]) + '</span></div>';
    }
    html += '</div>';
    return html;
  }

  /* ---------------- 所有省钱大全（速查索引） ---------------- */

  /**
   * 大全 = 100 条压成一张「一行一条」的速查表。
   * 与「图谱」的分工：图谱是卡片（做法 / 门槛 / 坑，一条占一屏），
   * 大全是索引（一眼扫完 100 条，点任意一条跳回图谱看详情）。
   */
  function savingsIndexHtml() {
    var sum = savingsSumSummary();
    var ctx = savingsCtx();
    var today = SAV.rankToday(SAV.ENTRIES, ctx);
    var day = savingsDay();
    var html = '';

    html += '<div class="sv-hero">' +
      '<div class="sv-hero-num"><b>' + SAV.ENTRIES.length + '</b><small>条动作 · ' + SAV.CATS.length + ' 类</small></div>' +
      '<div class="sv-hero-num"><b>' + today.length + '</b><small>今天能用</small></div>' +
      '<div class="sv-hero-num"><b>' + sum.count + '</b><small>累计打卡</small></div>' +
      '</div>';

    html += '<div class="sv-idx-tools">' +
      '<button type="button" class="btn-mini primary" data-sv-act="export-md">导出 Markdown</button>' +
      '<button type="button" class="btn-mini" data-sv-act="export-csv">导出打卡 CSV</button>' +
      '<span class="sv-count">点任意一条 → 跳到图谱看详情</span>' +
      '</div>';

    SAV.CATS.forEach(function (c) {
      var list = SAV.byCat(c.key);
      html += '<section class="sv-idx-cat">';
      html += '<div class="sv-idx-head"><b>' + esc(c.emoji) + ' ' + esc(c.name) + '</b>' +
        '<span class="sv-count">' + list.length + ' 条</span></div>';
      html += '<div class="sv-idx-list">';
      list.forEach(function (e) {
        var chk = SAV.isChecked(savingsDb.logs, e.id, day);
        html += '<button type="button" class="sv-idx-row' + (chk ? ' is-checked' : '') + '"' +
          ' data-sv-act="jump" data-sv-id="' + esc(e.id) + '">' +
          '<span class="sv-idx-t">' + esc(e.title) + '</span>' +
          '<span class="sv-idx-s">' + esc(SAV.saveText(e)) + '</span>' +
          '<span class="sv-idx-w">' + esc(SAV.triggerText(e)) + '</span>' +
          '</button>';
      });
      html += '</div></section>';
    });

    html += '<p class="sv-note">这就是全部 ' + SAV.ENTRIES.length + ' 条，按 10 类排。' +
      '「导出 Markdown」会带上你的打卡记录，可以直接贴进群聊或笔记。</p>';
    return html;
  }

  /* ---------------- 省钱账 ---------------- */

  function savingsBookHtml() {
    var sum = savingsSumSummary();
    if (!sum.count) {
      return '<div class="sv-empty">还没有打卡记录。<br>' +
        '<span class="hint">去「今天」点一条做过的动作，就开始记你的省钱账了。</span></div>';
    }
    var html = '';
    html += '<div class="sv-hero">' +
      '<div class="sv-hero-num"><b>' + money(sum.totalSaved) + '</b><small>累计省下（不清零）</small></div>' +
      '<div class="sv-hero-num"><b>' + sum.count + '</b><small>总打卡次数</small></div>' +
      '<div class="sv-hero-num"><b>' + sum.monthCount + '</b><small>本周期打卡</small></div>' +
      '</div>';

    /* 分类分布：只画有记录的，按金额降序（金额相同按条数） */
    var rows = [];
    for (var k in sum.byCat) {
      if (!Object.prototype.hasOwnProperty.call(sum.byCat, k)) { continue; }
      rows.push({ cat: k, count: sum.byCat[k].count, saved: sum.byCat[k].saved });
    }
    rows.sort(function (a, b) { return (b.saved - a.saved) || (b.count - a.count); });
    var maxSaved = rows.length ? Math.max(rows[0].saved, 1) : 1;

    html += '<div class="sv-sec">省在哪</div><div class="sv-bars">';
    rows.forEach(function (r) {
      var m = SAV.catMeta(r.cat);
      var w = Math.max(2, Math.round(r.saved / maxSaved * 100));
      html += '<div class="sv-bar-row">' +
        '<span class="sv-bar-name">' + esc(m.emoji) + ' ' + esc(m.name) + '</span>' +
        '<span class="sv-bar-track"><i style="width:' + w + '%"></i></span>' +
        '<span class="sv-bar-val">' + money(r.saved) + '<small>' + r.count + ' 次</small></span>' +
        '</div>';
    });
    html += '</div>';

    /* 最近打卡：倒序；默认 12 条，可展开全部（全部时才可能翻到老记录改金额） */
    var all = savingsDb.logs.slice().reverse();
    var recent = savingsBookAll ? all : all.slice(0, 12);
    html += '<div class="sv-sec">最近打卡' + (savingsBookAll ? '' : '（最近 ' + recent.length + ' 条）') + '</div>';
    html += '<div class="sv-done-list">';
    recent.forEach(function (r) {
      var e = SAV.byId(r.id);
      if (!e) { return; }
      var m = SAV.catMeta(e.cat);
      if (savingsEdit && savingsEdit.id === r.id && savingsEdit.date === r.date) {
        html += savingsEditRowHtml(e, r);
        return;
      }
      html += '<div class="sv-done-row">' +
        '<span class="sv-done-ico">' + esc(m.emoji) + '</span>' +
        '<span class="sv-done-title">' + esc(e.title) +
        '<small class="sv-done-date">' + esc(r.date.slice(5)) + '</small></span>' +
        '<span class="sv-done-save">' + savingsAmountLabel(e, r.saved) + '</span>' +
        '<button type="button" class="btn-mini" data-sv-act="edit-amount" ' +
        'data-sv-id="' + esc(r.id) + '" data-sv-date="' + esc(r.date) + '">改</button>' +
        '</div>';
    });
    html += '</div>';

    if (all.length > 12) {
      html += '<button type="button" class="btn-mini sv-more" data-sv-act="toggle-all">' +
        (savingsBookAll ? '收起，只看最近 12 条' : '展开全部 ' + all.length + ' 条') + '</button>';
    }

    var zeroCnt = 0;
    savingsDb.logs.forEach(function (r) { if (!(r.saved > 0)) { zeroCnt++; } });
    if (zeroCnt) {
      html += '<p class="sv-note">其中 <b>' + zeroCnt + '</b> 条只计次数、不计金额：' +
        '大促 / 年卡型（双 11、健身房年卡）省的是「整场活动 / 全年的总额」，' +
        '记进来会让累计金额虚高；长期习惯型（保温杯、图书馆）本来就算不出钱数。</p>';
    }

    html += '<p class="sv-note">「累计省下」不会随预算周期清零；「本周期省下」跟着发钱日走。' +
      '这两个数和冷静期「拦下多少钱」是分开记的——一个是本来就要买、买对了省下的，一个是想买但没买省下的。</p>';
    return html;
  }

  /**
   * 行内改金额的编辑行。
   * 清空输入框 = 恢复引擎估算（不是「改成 0」），这样用户改错了能一键回到默认值。
   */
  function savingsEditRowHtml(e, r) {
    var m = SAV.catMeta(e.cat);
    var once = !!(e.save && e.save.once);
    var est = SAV.estimateSave(e);
    var hint;
    if (once) { hint = '这类是整场 / 全年总额，默认不计金额；想记就自己填'; }
    else if (est === null) { hint = '这条算不出金额，可以自己填一个'; }
    else { hint = '引擎估算 ¥' + SAV.fmt(est) + '，可改；清空恢复估算'; }

    return '<div class="sv-done-row sv-edit-row">' +
      '<span class="sv-done-ico">' + esc(m.emoji) + '</span>' +
      '<span class="sv-done-title">' + esc(e.title) +
      '<small class="sv-edit-hint">' + esc(hint) + '</small></span>' +
      '<input class="sv-edit-input" id="svEditInput" type="number" inputmode="decimal" min="0" step="0.5" placeholder="金额" ' +
      'value="' + (r.saved > 0 ? SAV.fmt(r.saved) : '') + '" ' +
      'data-sv-id="' + esc(r.id) + '" data-sv-date="' + esc(r.date) + '" />' +
      '<button type="button" class="btn-mini primary" data-sv-act="save-amount">存</button>' +
      '<button type="button" class="btn-mini" data-sv-act="cancel-amount">×</button>' +
      '</div>';
  }

  /**
   * 手改某条记录的金额。
   * 边界：非数字 / 负数 / 过大的数一律拒绝并提示，不写库；
   *      清空 = 恢复引擎估算（once 型回到 0 且 manual=false）。
   */
  function updateSavingsAmount(raw) {
    var input = $('svEditInput');
    var id = input ? input.getAttribute('data-sv-id') : '';
    var date = input ? input.getAttribute('data-sv-date') : '';
    var e = SAV.byId(id);
    if (!e) { return false; }

    var idx = -1, i;
    for (i = 0; i < savingsDb.logs.length; i++) {
      if (savingsDb.logs[i].id === id && savingsDb.logs[i].date === date) { idx = i; break; }
    }
    if (idx === -1) {
      savingsEdit = null;
      renderSavingsSheet();
      showToast('这条记录找不到了，刷新一下再试');
      return false;
    }

    var txt = String(raw === undefined || raw === null ? (input ? input.value : '') : raw).trim();
    var next, manual;

    if (txt === '') {
      /* 恢复引擎估算：金额回到估算值，manual 必须是 false —— 这不是「用户手填的数」，
         CSV 里要如实标「否」，否则统计会把估算当成手改过的数据。 */
      var once = !!(e.save && e.save.once);
      var est = SAV.estimateSave(e);
      next = (est !== null && !once) ? est : 0;
      manual = false;
    } else {
      var n = Number(txt.replace(/[^\d.]/g, ''));
      if (txt.replace(/[^\d.]/g, '') !== txt || !isFinite(n) || n < 0) {
        showToast('金额只能填 0 或正数');
        return false;
      }
      if (n > 99999) {
        showToast('金额太大了，是不是多打了个 0');
        return false;
      }
      next = Math.round(n * 100) / 100;
      manual = true;
    }

    savingsDb.logs[idx].saved = next;
    savingsDb.logs[idx].manual = manual;
    savingsDb.updatedAt = Date.now();
    saveSavingsDb();
    savingsEdit = null;
    renderSavingsSheet();
    renderSavingsMini();
    showToast(txt === '' ? '已恢复引擎估算' : '已改成 ' + money(next));
    return true;
  }

  /* ---------------- 口径说明 ---------------- */

  function savingsAboutHtml() {
    var sum = savingsSumSummary();
    var html = '';
    html += '<div class="sv-about">';
    html += '<p><b>这 100 条从哪来？</b>来自《大学生全网省钱与防割韭菜图谱》100 条实操，按「连锁快餐 / 简餐外卖 / 校园食堂 / 茶饮咖啡 / 零食夜市 / 商超日用 / 娱乐社交 / 交通出行 / 学习考证 / 促销节点」10 类各 10 条整理。</p>';
    html += '<p><b>金额怎么算的？</b>每条动作带一个估算方式：</p>' +
      '<ul class="sv-ul">' +
      '<li><b>固定省额</b>：原文给了明确差价，直接算。</li>' +
      '<li><b>折扣比</b>：原文说「打几折」且能给到原价基准，才乘出金额；给不出基准就只显示折扣，不硬凑钱数。</li>' +
      '<li><b>区间</b>：原文只说「省几十」这类，取区间中位数，界面上显示区间。</li>' +
      '<li><b>无法量化</b>：保温杯、图书馆这类长期习惯，照样能打卡，但不进金额累计——否则等于编数字。</li>' +
      '</ul>';
    html += '<p><b>三个标签什么意思？</b></p>' +
      '<ul class="sv-ul">' +
      '<li><span class="sv-tag sv-tag-varies">力度常变</span> 会员日折扣、百亿补贴这类，力度每期不同，别拿旧价当承诺。</li>' +
      '<li><span class="sv-tag sv-tag-local">以你学校为准</span> 依赖具体校区 / 门店（食堂档口、教师食堂、南城香），到店先确认。</li>' +
      '<li>无标签 = 规则稳定，按日期算就行。</li>' +
      '</ul>';
    html += '<p><b>红线：</b>所有金额都是估算区间，不承诺最低价，不写死平台实时价。真下单前以商家当期页面为准。</p>';
    html += '<p><b>活动日期</b>由本地日期算法推算（周几 / 每月几号 / 固定月日 / 时间区间），不联网抓取，所以离线也能用。</p>';
    html += '<p class="sv-note">你现在的打卡库：' + sum.count + ' 条记录，累计 ' + money(sum.totalSaved) +
      '；存放于浏览器本地，键名 <code>ai_jizhang_savings_v1</code>，与账单分开。清掉它不会影响你的账本。</p>';
    html += '</div>';
    return html;
  }

  /* ---------------- 打卡 ---------------- */

  /**
   * 打卡 / 撤销。同一条目同一自然日只保留一条记录，所以第二次点就是撤销（幂等）。
   *
   * ⚠️ 金额口径（踩过坑）：
   *   `once` 型条目（双 11 / 年卡 / 报班）的 save 是**整场活动 / 全年的总额**，
   *   不是「今天做这一下省了多少」。若直接拿 estimateSave 入库，点一次「双 11」
   *   就会往省钱账里加 ¥300，累计金额瞬间失真、分类条形也被促销类霸榜。
   *   所以 once 型只记打卡次数、金额记 0，并在提示里说清楚。
   *   `none` 型（保温杯 / 图书馆）本来就算不出金额，同样记 0。
   */
  function toggleSavings(id) {
    if (!savingsReady()) { return; }
    var e = SAV.byId(id);
    if (!e) { return; }
    var day = savingsDay();
    var est = SAV.estimateSave(e);
    var once = !!(e.save && e.save.once);
    /* 传 undefined 而不是 0：引擎估算不是「用户手动改的金额」，CSV 里要如实标「否」 */
    var savedArg = (once || est === null) ? undefined : est;
    var res = SAV.toggleCheck(savingsDb.logs, id, day, savedArg);
    savingsDb.logs = res.logs;
    saveSavingsDb();

    if (res.action === 'add') {
      if (once) {
        showToast('已打卡：' + e.title + '（大促 / 年卡总额不计入省钱账）');
      } else {
        showToast('已打卡：' + e.title + (est ? ' · 记下约省 ' + money(est) : ''));
      }
    } else {
      showToast('已撤销：' + e.title);
    }
    renderSavingsSheet();
    renderSavingsMini();
  }

  function savingsExportCsv() {
    if (!savingsDb.logs.length) { showToast('还没有打卡记录'); return; }
    var rows = [['日期', '动作', '分类', '估算省下', '是否手动改过']];
    savingsDb.logs.forEach(function (r) {
      var e = SAV.byId(r.id);
      rows.push([
        r.date,
        e ? e.title : r.id,
        e ? SAV.catMeta(e.cat).name : '未知',
        r.saved > 0 ? r.saved.toFixed(2) : '',
        r.manual ? '是' : '否'
      ]);
    });
    downloadCsv('我的省钱记录.csv', rows);
    showToast('已导出 ' + savingsDb.logs.length + ' 条打卡记录');
  }

  /**
   * 导出「所有省钱大全」Markdown：100 条全量 + 我的打卡次数。
   * 为什么用 .md 而不是 .txt：能直接贴进群聊 / 飞书 / Notion，标题层级不丢。
   */
  function savingsExportMarkdown() {
    if (!savingsReady()) { return; }
    var md = SAV.toMarkdown({ logs: savingsDb.logs, now: new Date() });
    var name = '所有省钱大全-' + SAV.dateKey(new Date()) + '.md';
    if (downloadText(name, md, 'text/markdown;charset=utf-8')) {
      showToast('已导出 ' + SAV.ENTRIES.length + ' 条 · ' + Math.round(md.length / 1024) + ' KB');
    }
  }

  /* ---------------- 看板小卡 / 聊天入口 ---------------- */

  function renderSavingsMini(ov) {
    var box = $('savingsMini');
    if (!box) { return; }
    if (!savingsReady()) {
      box.innerHTML = '<div class="dm-line">省钱图谱没加载起来，刷新页面再试</div>';
      return;
    }
    var ctx = savingsCtx(ov);
    var list = SAV.rankToday(SAV.ENTRIES, ctx);
    var sum = savingsSumSummary();
    var html = '', i;

    if (!list.length) {
      html += '<div class="dm-line">今天的动作都打完卡了 🎉</div>';
    } else {
      for (i = 0; i < list.length && i < 3; i++) {
        html += '<div class="dm-line"><span class="dm-dot"></span><b>' +
          esc(list[i].title) + '</b> <em>' + esc(SAV.saveText(list[i])) + '</em></div>';
      }
    }
    html += '<div class="dm-line dm-tip">💡 本周期省下 ' + money(sum.monthSaved) +
      ' · 累计打卡 ' + sum.count + ' 次</div>';
    box.innerHTML = html;
  }

  /** 聊天入口：今天怎么省（文字版，不塞按钮，避免聊天区还要单独绑事件） */
  function showSavingsTodayCard() {
    switchView('chat');
    if (!savingsReady()) {
      addAIMessage(aiBubble('省钱图谱没加载起来，刷新页面再试。'));
      return;
    }
    var ctx = savingsCtx();
    var list = SAV.rankToday(SAV.ENTRIES, ctx);
    if (!list.length) {
      addAIMessage(aiBubble('今天的动作都打完卡了 🎉<br>点顶部「省钱」→「省钱图谱」分段，翻翻别的分类，或者明天再来。'));
      return;
    }
    var hitN = 0, i;
    for (i = 0; i < list.length; i++) {
      if (list[i].trigger && SAV.matchTrigger(list[i], new Date())) { hitN++; }
    }
    var html = hitN
      ? '今天命中 <b>' + hitN + '</b> 条踩点优惠，先看这几条：'
      : '今天没有踩点的规则优惠，下面这几条随时都能用：';
    html += '<div class="sv-chat-list">';
    for (i = 0; i < list.length; i++) {
      html += '<div class="sv-chat-row"><b>' + esc(list[i].title) + '</b>' +
        '<span>' + esc(SAV.saveText(list[i])) + '</span>' +
        '<i>' + esc(list[i].action) + '</i></div>';
    }
    html += '</div>';
    html += '<span class="hint">点顶部「省钱」→「省钱图谱」，可以看全部 100 条，做过的动作点一下打卡，我帮你记省了多少。</span>';
    addAIMessage(aiBubble(html));
  }

  /** 聊天入口：按关键词搜图谱 */
  function showSavingsSearch(kw) {
    switchView('chat');
    if (!savingsReady()) {
      addAIMessage(aiBubble('省钱图谱没加载起来，刷新页面再试。'));
      return;
    }
    var q = String(kw || '').trim();
    var list = SAV.search(SAV.ENTRIES, q);
    if (!list.length) {
      addAIMessage(aiBubble('图谱里没搜到「' + esc(q) + '」。<br>换个说法试试：奶茶 / 打印 / 食堂 / 外卖 / 健身房 / 高铁。'));
      return;
    }
    var top = list.slice(0, 3);
    var html = '「' + esc(q) + '」相关动作，最值得先看这 ' + top.length + ' 条：<div class="sv-chat-list">';
    top.forEach(function (e) {
      html += '<div class="sv-chat-row"><b>' + esc(e.title) + '</b>' +
        '<span>' + esc(SAV.saveText(e)) + ' · ' + esc(SAV.triggerText(e)) + '</span>' +
        '<i>' + esc(e.action) + '</i></div>';
    });
    html += '</div>';
    if (list.length > top.length) {
      html += '<span class="hint">还有 ' + (list.length - top.length) + ' 条，点顶部「省钱」→「省钱图谱」搜「' + esc(q) + '」看全部。</span>';
    }
    addAIMessage(aiBubble(html));
  }

  function showSavingsGraph() { openSavingsSheet('map'); }
  function showSavingsIndex() { openSavingsSheet('index'); }
  function showSavingsBook() { openSavingsSheet('book'); }
  function showSavingsPanelToday() { openSavingsSheet('today'); }

  /* ================================================================== */
  /* 消息路由                                                            */
  /* ================================================================== */

  var EXACT_COMMANDS = {
    '查余额': showBalanceCard,
    '余额': showBalanceCard,
    '还能花多少': showBalanceCard,
    '本月花销饼图': showPieCard,
    '饼图': showPieCard,
    '记一笔': showEntryGuide,
    '记收入': openIncomeModal,
    '记一笔收入': openIncomeModal,
    '账单分析': openAnalysisSheet,
    '导入账单': openImportSheet,
    '截屏记账': openOcrModal,
    '截图记账': openOcrModal,
    '我想攒钱': showGoalGuide,
    '我想攒钱买': showGoalGuide,
    '省钱图谱': showSavingsGraph,
    '省钱清单': showSavingsPanelToday,
    '今天怎么省': showSavingsPanelToday,
    '我的省钱账': showSavingsBook,
    '所有省钱大全': showSavingsIndex,
    '省钱大全': showSavingsIndex,
    '理财课': showLearnGuide,
    '理财学院': showLearnGuide,
    '设置': openSettingsPage,
    '设置预算': openDrawer
  };

  /**
   * 判断一句话是否命中「本地命令」（无需云端即可处理的明确指令）。
   * 命中返回对应的处理函数，否则返回 null（应交给云端 / NLP 解析）。
   */
  function localCommandName(raw) {
    var text = String(raw || '').trim();
    if (!text) { return null; }
    if (Object.prototype.hasOwnProperty.call(EXACT_COMMANDS, text)) {
      return EXACT_COMMANDS[text];
    }
    var compact = text.replace(/\s+/g, '');
    if (compact === '查余额' || compact === '余额' || compact === '还能花多少' || compact === '还能花多少钱' ||
      compact === '我还剩多少' || compact === '看余额') { return showBalanceCard; }
    if (compact.indexOf('饼图') !== -1 || compact === '本月花销' || compact === '花销占比') { return showPieCard; }
    if (compact.indexOf('设置预算') !== -1 || compact === '预算设置') { return openDrawer; }
    if (compact === '设置' || compact === '系统设置' || compact === '偏好设置' ||
      compact === '通用设置' || compact === '打开设置') { return openSettingsPage; }
    if (compact.indexOf('我想攒钱') !== -1 || compact.indexOf('攒钱买') !== -1) { return showGoalGuide; }
    if (compact.indexOf('记收入') !== -1 || compact.indexOf('记一笔收入') !== -1) { return openIncomeModal; }
    if (compact.indexOf('账单分析') !== -1) { return openAnalysisSheet; }
    if (compact.indexOf('导入') !== -1 && compact.indexOf('账单') !== -1) { return openImportSheet; }
    if (compact.indexOf('截屏记账') !== -1 || compact.indexOf('截图记账') !== -1) { return openOcrModal; }
    /* ---- 业务规则：句子里带金额的一律当成记账 ---- */
    // 提到这里是因为下面每条「省钱 / 优惠」分支都必须先过它：
    // 例「肯德基疯狂星期四 25」要记一笔餐饮，不能被活动卡或图谱抢走。
    var hasAmount = /(\d+(\.\d+)?)\s*(元|块|块钱)?/.test(compact) &&
      !/(多少钱|贵吗|便宜吗|什么时候|哪天|几天|多久|划算吗|比价|哪家便宜)/.test(compact);
    /* ---- 省钱图谱：必须排在专家「省钱」分支之前，否则「省钱攻略 奶茶」会被专家抢走 ---- */
    if (!hasAmount) {
      var svIdx = compact.indexOf('省钱攻略');
      if (svIdx !== -1 && compact.length > svIdx + 4) {
        var svKw = compact.slice(svIdx + 4);
        return function () { showSavingsSearch(svKw); };
      }
      if (compact.indexOf('所有省钱') !== -1 || compact.indexOf('省钱大全') !== -1 ||
        compact.indexOf('省钱宝典') !== -1) {
        return showSavingsIndex;
      }
      if (compact.indexOf('省钱图谱') !== -1) {
        return showSavingsGraph;
      }
      if (compact.indexOf('省钱账') !== -1 || compact.indexOf('省了多少钱') !== -1 ||
        compact.indexOf('省下多少') !== -1) {
        return showSavingsBook;
      }
    }
    /* ---- 理财专家：省钱 / 赚钱 / 剁手冷静法 ---- */
    if (compact === '理财课' || compact === '理财学院' || compact === '看理财课' ||
      compact === '视频学习') { return showLearnGuide; }
    if (compact.indexOf('剁手冷静法') !== -1 || compact.indexOf('冷静期') !== -1) { return showCoolingGuide; }
    if (compact.indexOf('省钱') !== -1 && /(怎么|如何|怎样|方法|攻略|技巧|建议|教我)/.test(compact)) {
      return showSaveMoneyGuide;
    }
    if (compact.indexOf('赚钱') !== -1 && /(怎么|如何|怎样|方法|路子|攻略|建议|教我)/.test(compact)) {
      return showMakeMoneyGuide;
    }
    if (compact === '省钱' || compact === '省钱攻略' || compact === '省钱方法') { return showSaveMoneyGuide; }
    if (compact === '搞钱' || compact === '搞钱路子' || compact === '赚钱方法') { return showMakeMoneyGuide; }
    /* ---- 省钱雷达：活动日历 / 会员日 / 比价 ---- */
    if (hasAmount) { return null; }
    if (/省钱雷达|优惠提醒|打折日|会员日|今日优惠|今天.*(优惠|特价|打折)|有什么优惠|有啥优惠|优惠活动/.test(compact)) {
      return showDealsTodayCard;
    }
    if (compact.indexOf('疯狂星期四') !== -1 || compact.indexOf('肯德基') !== -1 ||
      compact.indexOf('周四吃') !== -1) {
      return showKfcDealsCard;
    }
    if (compact.indexOf('比价') !== -1 || compact.indexOf('哪家便宜') !== -1 ||
      compact.indexOf('哪里便宜') !== -1 || compact.indexOf('多少钱划算') !== -1 ||
      compact.indexOf('划算吗') !== -1 || compact.indexOf('划算不划算') !== -1) {
      return function () { showDealCompareFromText(text); };
    }
    return null;
  }

  function routeCommand(raw) {
    var text = String(raw || '').trim();
    if (!text) { return; }

    var fn = localCommandName(text);
    if (fn) { fn(); return; }

    var parsed = NLP.parseBill(text);
    if (parsed.items.length === 0) {
      showParseFailure(text);
      return;
    }
    startFlow(parsed.items);
  }

  /* ================================================================== */
  /* CSV 导出                                                            */
  /* ================================================================== */

  function csvCell(value) {
    var s = String(value === undefined || value === null ? '' : value);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function toCsv(rows) {
    var lines = [];
    var i;
    for (i = 0; i < rows.length; i++) {
      var cells = [];
      var j;
      for (j = 0; j < rows[i].length; j++) {
        cells.push(csvCell(rows[i][j]));
      }
      lines.push(cells.join(','));
    }
    return '\ufeff' + lines.join('\r\n');
  }

  function downloadCsv(filename, rows) {
    var content = toCsv(rows);
    try {
      var blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
      var url = global.URL.createObjectURL(blob);
      var a = DOC.createElement('a');
      a.href = url;
      a.download = filename;
      DOC.body.appendChild(a);
      a.click();
      DOC.body.removeChild(a);
      setTimeout(function () { global.URL.revokeObjectURL(url); }, 5000);
    } catch (e) {
      addAIMessage(aiBubble('导出失败了：当前浏览器可能不支持文件下载。'));
    }
  }

  function exportAllCsv() {
    var ov = getOverview();
    // 前 6 列顺序保持与 v1 完全一致，只在末尾追加「收支」「商家」，避免破坏既有消费方
    var billsRows = [['id', '日期', '金额', '分类', '备注', '消费动机', '收支', '商家']];
    var sorted = state.bills.slice().sort(function (a, b) {
      if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    var i;
    for (i = 0; i < sorted.length; i++) {
      var b = sorted[i];
      billsRows.push([
        b.id,
        b.date,
        b.amount.toFixed(2),
        b.category,
        b.note,
        b.type === 'income' ? '收入' : b.motivation,
        b.type === 'income' ? '收入' : '支出',
        b.merchant || ''
      ]);
    }

    var budgetsRows = [['分类', '预算金额', '已花金额']];
    for (i = 0; i < DATA.CATEGORIES.length; i++) {
      var key = DATA.CATEGORIES[i].key;
      var ratio = DATA.CATEGORY_BUDGET_RATIO[key] || 0;
      budgetsRows.push([
        key,
        ENG.round2(state.budget.total * ratio).toFixed(2),
        ENG.round2(ov.cycleAgg.byCategory[key] || 0).toFixed(2)
      ]);
    }

    var goalsRows = [['目标名称', '目标金额', '已攒金额']];
    for (i = 0; i < state.goals.length; i++) {
      goalsRows.push([
        state.goals[i].name,
        state.goals[i].target.toFixed(2),
        state.goals[i].saved.toFixed(2)
      ]);
    }

    downloadCsv('bills.csv', billsRows);
    setTimeout(function () { downloadCsv('budgets.csv', budgetsRows); }, 350);
    setTimeout(function () { downloadCsv('goals.csv', goalsRows); }, 700);

    addAIMessage(aiBubble('已导出 3 个 CSV：bills.csv、budgets.csv、goals.csv（带 UTF-8 BOM，Excel 打开不会乱码）。'));
  }

  /* ================================================================== */
  /* 语音输入                                                            */
  /* ================================================================== */

  function setupVoice() {
    var btn = $('btnMic');
    var SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    if (!SR) {
      btn.classList.add('disabled');
      btn.disabled = true;
      btn.title = '当前浏览器不支持语音';
      return;
    }
    var rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = function (event) {
      var text = event.results[0][0].transcript;
      if (text) { handleSend(text); }
    };
    rec.onerror = function () {
      btn.classList.remove('listening');
    };
    rec.onend = function () {
      btn.classList.remove('listening');
    };
    btn.addEventListener('click', function () {
      try {
        btn.classList.add('listening');
        rec.start();
      } catch (e) {
        btn.classList.remove('listening');
      }
    });
  }

  /* ================================================================== */
  /* 事件绑定                                                            */
  /* ================================================================== */

  /* ================================================================== */
  /* 云端对话（WorkBuddy 云服务，失败回退本地 routeCommand）           */
  /* ================================================================== */

  /**
   * 构造给大模型的精简上下文快照（只取展示/记账需要的最小字段）。
   * @return {Object|null}
   */
  function buildContext() {
    if (!state) { return null; }
    var ov = getOverview();
    var i;
    var recent = state.bills.slice().sort(function (a, b) {
      if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
      return (b.createdAt || 0) - (a.createdAt || 0);
    }).slice(0, 5).map(function (b) {
      return { category: b.category, amount: b.amount, note: b.note, date: b.date };
    });
    var goals = (state.goals || []).map(function (g) {
      return { name: g.name, target: g.target, saved: g.saved };
    });
    return {
      budgetTotal: state.budget ? state.budget.total : null,
      remaining: ov ? ov.remaining : null,
      todaySpent: ov ? ov.todaySpent : null,
      cycleStart: ov ? ov.cycleStart : null,
      cycleEnd: ov ? ov.cycleEnd : null,
      billCount: state.bills.length,
      recentBills: recent,
      goals: goals
    };
  }

  /** 把后端返回的 action 映射到本地的命令函数 */
  var COMMAND_MAP = {
    balance: showBalanceCard,
    pie: showPieCard,
    income: openIncomeModal,
    ocr: openOcrModal,
    analysis: openAnalysisSheet,
    goals: showGoalGuide,
    settings: openSettingsPage
  };

  /**
   * 把一条消息发给 WorkBuddy 云服务对话模型，渲染回复并执行 actions；
   * 任何失败都回退到本地 routeCommand，保证「开箱即用」。
   * @param {string} text
   */
  function sendToAssistant(text) {
    var raw = String(text || '').trim();
    if (!raw) { return; }

    // 明确是本地命令（记收入 / 查余额 / 设置预算 / 账单分析 / 截屏记账 / 我想攒钱 …）直接本地处理：
    // 不走云端、不出现「思考中」，彻底避免云端挂起导致的卡死，也更跟手。
    var localFn = localCommandName(raw);
    if (localFn) { localFn(); return; }

    // 理财专家：「想买 XX」-> 先走剁手冷静法三步问答，而不是直接记账
    var wantBuy = COACH.isWantBuy(raw);
    if (wantBuy) { startCoolingFlow(wantBuy.item, wantBuy.price); return; }

    // 自由文本记账：本地 NLP 能解析出账单条目时直接本地处理（秒回、不出现「思考中」）。
    // 只有真正需要对话理解的问句才走云端，避免无谓的云端延迟。
    var parsed = NLP.parseBill(raw);
    if (parsed.items.length > 0) { startFlow(parsed.items); return; }

    // 先插一个「思考中」气泡，拿到结果后只替换气泡里的文字（保留时间戳）
    addAIMessage(aiBubble('账小助正在思考…'));
    var thinkingRow = chatListEl().lastElementChild;

    // 防止云端（流式）长时间无响应导致一直「思考中」：handled 锁定后，超时与云端结果只会生效一次
    var handled = false;

    function setReply(t) {
      if (thinkingRow && thinkingRow.parentNode) {
        var bubble = thinkingRow.querySelector ? thinkingRow.querySelector('.bubble') : null;
        if (bubble) { bubble.textContent = t; return; }
      }
      addAIMessage(aiBubble(esc(t)));
    }

    function clearThinking() {
      if (thinkingRow && thinkingRow.parentNode) {
        thinkingRow.parentNode.removeChild(thinkingRow);
      }
    }

    // 本地兜底：云端未就绪 / 失败 / 超时 -> 用本地 routeCommand 处理
    function fallback() {
      if (handled) { return; }
      handled = true;
      clearThinking();
      routeCommand(raw);
    }

    function onCloudDone(json) {
      if (handled) { return; }
      if (!json || json.fallback === true) {
        // 云服务未就绪或上游失败 -> 本地兜底
        fallback();
        return;
      }
      var reply = json.reply;
      var actions = Array.isArray(json.actions) ? json.actions : [];

      if (!reply && actions.length === 0) {
        // 云端既没文字也没动作 -> 本地兜底
        fallback();
        return;
      }

      // 云端结果可用，锁定，超时不再回退
      handled = true;

      if (reply) {
        setReply(reply);
      } else {
        // 没有文字回复时把「思考中」气泡去掉，避免残留
        clearThinking();
      }

      actions.forEach(function (a) {
        if (!a || !a.type) { return; }
        if (a.type === 'add_bill') {
          var category = (DATA.CATEGORY_KEYS.indexOf(a.category) !== -1) ? a.category : '其他';
          var dateOk = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || ''));
          var draft = {
            amount: Number(a.amount),
            category: category,
            note: a.note || category || '记账',
            date: dateOk ? a.date : ENG.formatDate(new Date()),
            motivation: (a.motivation === '情绪') ? '情绪' : '刚需',
            want: !!a.want,
            type: 'expense'
          };
          startFlow([draft]);
        } else if (a.type === 'command') {
          var fn = COMMAND_MAP[a.name];
          if (fn) { fn(); }
        }
      });
    }

    if (typeof global.AJ !== 'object' || typeof global.AJ.ask !== 'function') { fallback(); return; }

    // 兜底超时：云端（流式）长时间不返回时，回退到本地 routeCommand，避免一直「思考中」
    var safetyTimer = setTimeout(function () { fallback(); }, 12000);

    // 直接调用 WorkBuddy 云服务（免密钥）对话接口；失败或未就绪时回退本地 routeCommand
    var cloudPromise;
    try {
      cloudPromise = global.AJ.ask(raw, buildContext());
    } catch (e) {
      clearTimeout(safetyTimer);
      fallback();
      return;
    }
    Promise.resolve(cloudPromise).then(function (json) {
      clearTimeout(safetyTimer);
      onCloudDone(json);
    }).catch(function () {
      clearTimeout(safetyTimer);
      fallback();
    });
  }

  function handleSend(text) {
    var raw = String(text || '').trim();
    if (!raw) { return; }
    addUserMessage(raw);
    $('chatInput').value = '';
    // 快捷指令 chips：当前发出的指令高亮为激活态（绿底），与设计稿一致
    var chips = DOC.querySelectorAll('#quickChips .chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].getAttribute('data-cmd') === raw);
    }
    switchView('chat');
    // 改为请求后端；后端不可用或返回 fallback 时，sendToAssistant 内部回退到本地逻辑
    sendToAssistant(raw);
  }

  function switchView(view, fromBack) {
    if (!FULL_VIEWS[view] && !SIMPLE_VIEWS[view]) { return; }
    // 双 UI 门控：把视图请求映射到当前 UI 类型下可见的等价屏幕，
    // 避免代码路径（OCR / 指令 / 返回）把用户切到被隐藏的面板而留空白
    if (getUiMode() === 'simple') {
      if (!SIMPLE_VIEWS[view]) {
        // 完整版视图 → 简洁版等价屏：聊天→AI 对话、看板→预算、目标→攒钱目标、专家→理财专家
        view = ({ chat: 'sai', dash: 'sbudget', goals: 'sgoals', coach: 'scoach' })[view] || 'shome';
      }
    } else if (!FULL_VIEWS[view]) {
      view = 'chat';
    }
    var prev = DOC.body.getAttribute('data-view');
    // 记录进入子视图前的视图，供「返回」按钮使用（fromBack 为 true 时不重复入栈）
    if (prev && prev !== view && !fromBack) {
      viewHistory.push(prev);
      if (viewHistory.length > 20) { viewHistory.shift(); }
    }
    DOC.body.setAttribute('data-view', view);
    var tabs = DOC.querySelectorAll('#tabbar .tab, #tabbarSimple .tab');
    var i;
    for (i = 0; i < tabs.length; i++) {
      // 用 classList.toggle 保留 tab 上的其他类（如 ui-full-only），避免整类名覆盖导致门控失效
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-view') === view);
    }
    /* 简洁版「省钱」屏：面板常驻在 #spSaveBody 内，切进来时补一次渲染，
       保证首次进入与数据变更后看到的都是最新内容（不弹遮罩、不调 openSaveHub）。 */
    if (view === 'ssave') { renderSaveHubPanel(); }
  }

  /** 「返回」按钮：回到进入当前子视图前的视图；没有历史时回当前 UI 类型的首页 */
  function goBackView() {
    var prev = viewHistory.pop() || (getUiMode() === 'simple' ? 'shome' : 'chat');
    switchView(prev, true);
  }

  function bindEvents() {
    $('btnSend').addEventListener('click', function () {
      handleSend($('chatInput').value);
    });

    $('chatInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        handleSend($('chatInput').value);
      }
    });

    $('quickChips').addEventListener('click', function (e) {
      var target = e.target.closest ? e.target.closest('[data-cmd]') : null;
      if (target) {
        handleSend(target.getAttribute('data-cmd'));
      }
    });

    chatListEl().addEventListener('click', function (e) {
      var dealAct = e.target.closest ? e.target.closest('[data-deal-act]') : null;
      if (dealAct) {
        handleDealAct(dealAct.getAttribute('data-deal-act'));
        return;
      }
      var target = e.target.closest ? e.target.closest('[data-cmd]') : null;
      if (target) {
        handleSend(target.getAttribute('data-cmd'));
        return;
      }
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!act) { return; }
      var name = act.getAttribute('data-act');
      if (name === 'learn-all') {
        /* 聊天气泡里的「去理财学院看全部」：视图映射交给 switchView（简洁版自动到 scoach） */
        openAcademy();
        return;
      }
      if (name === 'undo') {
        deleteBill(act.getAttribute('data-bill'));
        return;
      }
      if (name === 'worth') {
        setBillWorth(act.getAttribute('data-bill'), act.getAttribute('data-val'));
        return;
      }
      if (name === 'cycle-yes' || name === 'cycle-no') {
        var billId = act.getAttribute('data-bill') || '';
        var yes = name === 'cycle-yes';
        var askCard = act.closest ? act.closest('.ask-card') : null;
        if (askCard) {
          askCard.innerHTML = '<div class="ask-done">' +
            (yes ? '已选择：从现在重新算周期' : '已选择：只记这一笔') + '</div>';
        }
        resolveCycleReset(billId, yes);
        return;
      }
      if (name === 'cooldown-buy') {
        act.parentNode.innerHTML = '<span class="tag">已选择：仍然记下这笔</span>';
        resolveCooldown(true);
      } else if (name === 'cooldown-skip') {
        act.parentNode.innerHTML = '<span class="tag green">已选择：先不买，省下了</span>';
        resolveCooldown(false);
      } else if (name === 'cool-next') {
        if (cooling) { renderCoolingQuestion(); }
      } else if (name === 'cool-answer') {
        coolingAnswer(act.getAttribute('data-val'), act);
      } else if (name === 'cool-record') {
        coolingRecord();
      } else if (name === 'cool-skip') {
        coolingSkip();
      } else if (name === 'cool-start') {
        startCoolingFlow('想买的东西', 0);
      }
    });

    $('legendList').addEventListener('click', function (e) {
      var li = e.target.closest ? e.target.closest('li[data-cat]') : null;
      if (!li) { return; }
      var cat = li.getAttribute('data-cat');
      highlightCategory = (highlightCategory === cat) ? null : cat;
      renderDonut(getOverview());
    });

    $('goalList').addEventListener('click', function (e) {
      var addBtn = e.target.closest ? e.target.closest('[data-goal-add]') : null;
      if (addBtn) {
        openDepositModal(addBtn.getAttribute('data-goal-add'));
        return;
      }
      var delBtn = e.target.closest ? e.target.closest('[data-goal-del]') : null;
      if (delBtn) {
        var id = delBtn.getAttribute('data-goal-del');
        var goal = findGoal(id);
        if (!goal) { return; }
        var next = [];
        var i;
        for (i = 0; i < state.goals.length; i++) {
          if (state.goals[i].id !== id) { next.push(state.goals[i]); }
        }
        state.goals = next;
        saveState();
        renderGoals();
        addAIMessage(aiBubble('目标「' + esc(goal.name) + '」已删除。想重新开始随时告诉我。'));
      }
    });

    $('btnAddGoal').addEventListener('click', openGoalModal);
    $('btnSettings').addEventListener('click', openSettingsPage);
    $('btnCloseDrawer').addEventListener('click', closeDrawer);
    $('drawerMask').addEventListener('click', closeDrawer);
    $('btnSaveSettings').addEventListener('click', saveSettings);
    $('btnCycleReset').addEventListener('click', restorePaydayCycle);
    $('btnSaveOcr').addEventListener('click', saveOcrCredentials);
    $('btnClearOcr').addEventListener('click', clearOcrCredentials);

    /* ---- 顶栏「＋ 记一笔」快捷记账 ---- */
    $('btnQuickAdd').addEventListener('click', openQuickAddModal);

    /* ---- 设置抽屉 · 数据管理 ---- */
    $('btnDrawerExport').addEventListener('click', exportAllCsv);
    $('btnDrawerImport').addEventListener('click', openImportSheet);
    $('btnDrawerReset').addEventListener('click', confirmReset);

    /* ---- 常驻预算条：点击/回车跳到看板预算焦点卡 ---- */
    var budgetBar = $('budgetBar');
    if (budgetBar) {
      budgetBar.addEventListener('click', focusBudgetCard);
      budgetBar.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.keyCode === 13) {
          e.preventDefault();
          focusBudgetCard();
        }
      });
    }

    /* ---- 完整设置界面 ---- */
    bindSettingsEvents();

    /* ---- 顶部工具栏：截屏记账 / 账单分析 / 理财专家 / 更多菜单 ---- */
    $('btnOcr').addEventListener('click', openOcrModal);
    $('btnAnalysis').addEventListener('click', openAnalysisSheet);
    $('btnCoach').addEventListener('click', function () { switchView('coach'); });
    /* 看板「理财课 · 视频」卡的「全部 ›」：进理财学院并定位到学院区。
       按钮是静态节点（不会被 innerHTML 重建），只绑一次，不存在重复绑定。 */
    $('btnLearnAll').addEventListener('click', openAcademy);
    $('btnAskCoach').addEventListener('click', showAskCoachIntro);
    /* 专家面板「‹ 返回」：桌面端无底部导航，靠它回到进入专家前的视图 */
    $('btnCoachBack').addEventListener('click', goBackView);

    /* ---- 省钱：一个入口 + 一级分段（雷达 / 图谱），两个功能共用一个面板 ---- */
    $('btnSaveHub').addEventListener('click', function () { openSaveHub('radar'); });
    $('btnCloseSaveHub').addEventListener('click', closeSaveHub);
    $('saveHubSeg').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-hub]') : null;
      if (b) { switchSaveHub(b.getAttribute('data-hub')); }
    });
    $('saveHubMask').addEventListener('click', function (e) {
      if (e.target === $('saveHubMask')) { closeSaveHub(); }
    });

    /* ---- 省钱雷达：切 tab / 比价计算 / 导出日历 ---- */
    $('btnDealsCard').addEventListener('click', function () { openSaveHub('radar'); });
    $('dealsTabs').addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('[data-deal-tab]') : null;
      if (!tab) { return; }
      syncDealForm();
      dealsTab = tab.getAttribute('data-deal-tab');
      renderDealsSheet();
    });
    $('dealsPane').addEventListener('click', function (e) {
      var del = e.target.closest ? e.target.closest('[data-del-row]') : null;
      if (del) {
        syncDealForm();
        dealsForm.rows.splice(Number(del.getAttribute('data-del-row')), 1);
        renderDealsSheet();
        return;
      }
      var act = e.target.closest ? e.target.closest('[data-deal-act]') : null;
      if (act) {
        var before = dealsLastResult;
        handleDealAct(act.getAttribute('data-deal-act'));
        if (dealsLastResult !== before && dealsTab === 'compare') { renderDealsSheet(); }
        return;
      }
      var target = e.target.id;
      if (target === 'btnDealCalc') { runDealCompare(); }
      else if (target === 'btnDealDemo') { fillDealDemo(); }
      else if (target === 'btnDealAdd') {
        syncDealForm();
        if (dealsForm.rows.length >= 6) { showToast('最多比 6 个平台，够用了'); return; }
        dealsForm.rows.push({
          platform: '抖音',
          price: '',
          spec: dealsForm.rows[0] ? dealsForm.rows[0].spec : '',
          ship: '', coupon: '', need: ''
        });
        renderDealsSheet();
      }
    });
    $('btnDealsCsv').addEventListener('click', function () {
      if (!dealsReady()) { return; }
      var text = DEALS.calendarCsv(new Date(), 56);
      downloadText('真实商家日历.csv', text, 'text/csv;charset=utf-8');
      showToast('已生成未来 56 天日历（日期由代码算出）');
    });
    $('btnDealsAskKfc').addEventListener('click', function () {
      closeDealsSheet();
      showKfcDealsCard();
    });

    /* ---- 省钱图谱：切 tab / 搜索 / 分类 / 打卡 / 导出（入口已并入省钱面板） ---- */
    $('btnSavingsCard').addEventListener('click', function () { openSaveHub('graph'); });
    $('savingsTabs').addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('[data-sv-tab]') : null;
      if (!tab) { return; }
      savingsTab = tab.getAttribute('data-sv-tab');
      savingsEdit = null;
      renderSavingsSheet();
    });
    $('savingsPane').addEventListener('click', function (e) {
      /* 分类筛选：只重画 chips 与列表，不动搜索框，避免输入焦点丢失 */
      var chip = e.target.closest ? e.target.closest('[data-sv-cat]') : null;
      if (chip) {
        savingsCat = chip.getAttribute('data-sv-cat') || '';
        var chips = DOC.querySelectorAll('#svChips .sv-chip');
        for (var ci = 0; ci < chips.length; ci++) {
          chips[ci].classList.toggle('active', chips[ci].getAttribute('data-sv-cat') === savingsCat);
        }
        var l0 = $('svList');
        if (l0) { l0.innerHTML = savingsListHtml(); }
        var c0 = $('svCount');
        if (c0) { c0.textContent = savingsFiltered().length + ' 条'; }
        return;
      }
      var act = e.target.closest ? e.target.closest('[data-sv-act]') : null;
      if (!act) { return; }
      var id = act.getAttribute('data-sv-id');
      var what = act.getAttribute('data-sv-act');
      if (what === 'toggle') { toggleSavings(id); return; }
      if (what === 'edit-amount') {
        savingsEdit = { id: id, date: act.getAttribute('data-sv-date') };
        renderSavingsSheet();
        var inp = $('svEditInput');
        if (inp) { inp.focus(); if (inp.select) { inp.select(); } }
        return;
      }
      if (what === 'save-amount') { updateSavingsAmount(); return; }
      if (what === 'cancel-amount') { savingsEdit = null; renderSavingsSheet(); return; }
      if (what === 'toggle-all') { savingsBookAll = !savingsBookAll; renderSavingsSheet(); return; }
      if (what === 'export-md') { savingsExportMarkdown(); return; }
      if (what === 'export-csv') { savingsExportCsv(); return; }
      if (what === 'jump') {
        var target = SAV.byId(id);
        if (!target) { return; }
        savingsCat = target.cat;
        savingsQuery = '';
        savingsOpen[id] = true;
        savingsTab = 'map';
        renderSavingsSheet();
        var card = DOC.querySelector('#svList .sv-card[data-sv-id="' + id + '"]');
        if (card && card.scrollIntoView) { card.scrollIntoView({ block: 'start' }); }
        return;
      }
      if (what === 'detail') {
        savingsOpen[id] = !savingsOpen[id];
        /* 只重画列表，保持滚动位置 */
        var l1 = $('svList');
        if (l1) {
          var body = $('savingsPane').parentNode;
          var keep = body ? body.scrollTop : 0;
          l1.innerHTML = savingsListHtml();
          if (body) { body.scrollTop = keep; }
        }
        return;
      }
    });
    $('savingsPane').addEventListener('input', function (e) {
      if (!e.target || e.target.id !== 'svSearch') { return; }
      savingsQuery = e.target.value || '';
      var l = $('svList');
      if (l) { l.innerHTML = savingsListHtml(); }
      var c = $('svCount');
      if (c) { c.textContent = savingsFiltered().length + ' 条'; }
    });
    /* 改金额：回车保存、ESC 取消（ESC 要拦住，否则会把整个面板关掉） */
    $('savingsPane').addEventListener('keydown', function (e) {
      if (!e.target || e.target.id !== 'svEditInput') { return; }
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        updateSavingsAmount();
      } else if (e.key === 'Escape' || e.keyCode === 27) {
        if (e.stopPropagation) { e.stopPropagation(); }
        savingsEdit = null;
        renderSavingsSheet();
      }
    });
    $('btnSavingsCsv').addEventListener('click', savingsExportCsv);
    $('btnSavingsAsk').addEventListener('click', function () {
      closeSavingsSheet();
      showSavingsTodayCard();
    });
    /* ---- 理财学院：折叠展开 + 资源区复制 ---- */
    $('coachAcademy').addEventListener('click', function (e) {
      var tgt = e.target;
      var copyBtn = (tgt && tgt.closest) ? tgt.closest('[data-copy]') : null;
      if (copyBtn) {
        e.preventDefault();
        coachCopyResource(copyBtn);
        return;
      }
      var head = (tgt && tgt.closest) ? tgt.closest('.coach-lesson-head') : null;
      if (!head) { return; }
      var lesson = head.closest ? head.closest('.coach-lesson') : null;
      if (lesson) { lesson.classList.toggle('open'); }
    });
    $('btnUndo').addEventListener('click', undoLast);
    $('btnMore').addEventListener('click', function (e) {
      e.stopPropagation();
      var menu = $('moreMenu');
      menu.hidden = !menu.hidden;
      $('btnMore').classList.toggle('active', !menu.hidden);
    });
    $('moreMenu').addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('[data-act]') : null;
      $('moreMenu').hidden = true;
      $('btnMore').classList.remove('active');
      if (!item) { return; }
      var act = item.getAttribute('data-act');
      if (act === 'export') { exportAllCsv(); }
      if (act === 'import') { openImportSheet(); }
      if (act === 'reset') { confirmReset(); }
    });
    DOC.addEventListener('click', function (e) {
      var menu = $('moreMenu');
      if (!menu || menu.hidden) { return; }
      if (e.target === $('btnMore') || (e.target.closest && e.target.closest('#moreMenu'))) { return; }
      menu.hidden = true;
      $('btnMore').classList.remove('active');
    });

    /* ---- 账单分析 sheet ---- */
    $('btnCloseAnalysis').addEventListener('click', closeAnalysisSheet);
    var analysisTabsEl = $('analysisTabs');
    if (analysisTabsEl) {
      analysisTabsEl.addEventListener('click', function (e) {
        var t = e.target.closest ? e.target.closest('[data-act="an-mode"]') : null;
        if (!t) { return; }
        var mode = t.getAttribute('data-mode');
        if (mode === 'current') {
          analysisMode = 'current';
          if (state.bills.length > 0) { analyzeCurrentBills(); }
          else { analysisData = null; renderAnalysis(); }
        } else {
          analysisMode = 'imported';
          // 切到「导入 CSV」但还没导入过文件时，清掉可能是「当前账本」的残留数据，
          // 否则 renderAnalysis 会拿旧账本数据渲染成当前账本内容。
          if (!analysisData || analysisData.source !== 'imported') {
            analysisData = null;
          }
          renderAnalysis();
        }
        syncAnalysisTabs();
      });
    }
    $('analysisMask').addEventListener('click', function (e) {
      if (e.target === $('analysisMask')) { closeAnalysisSheet(); }
    });
    $('analysisDrop').addEventListener('click', function () {
      $('analysisFile').click();
    });
    $('analysisFile').addEventListener('change', function () {
      handleAnalysisFiles(this.files);
      this.value = '';
    });
    $('analysisExcludeDup').addEventListener('change', renderAnalysis);
    $('analysisReport').addEventListener('change', function (e) {
      var sel = e.target.closest ? e.target.closest('[data-act="analysis-month"]') : null;
      if (!sel || !analysisData) { return; }
      analysisData.month = sel.value;
      renderAnalysis();
    });
    $('btnAnalysisExport').addEventListener('click', exportAnalysisMarkdown);
    $('btnAnalysisImport').addEventListener('click', confirmImportAnalysis);
    $('btnAnalysisClear').addEventListener('click', clearAnalysis);

    /* ---- 导入账单 sheet ---- */
    $('btnCloseImport').addEventListener('click', closeImportSheet);
    $('importMask').addEventListener('click', function (e) {
      if (e.target === $('importMask')) { closeImportSheet(); }
    });
    $('importDrop').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function () {
      handleImportFiles(this.files);
      this.value = '';
    });
    $('importExcludeDup').addEventListener('change', renderImportPreview);
    $('importExcludeFileDup').addEventListener('change', renderImportPreview);
    $('importMonth').addEventListener('change', function () {
      if (!importState) { return; }
      importState.month = this.value;
      renderImportPreview();
    });
    $('btnImportConfirm').addEventListener('click', confirmImportBills);
    $('btnImportClear').addEventListener('click', clearImport);
    ['importDrop'].forEach(function (id) {
      var zone = $(id);
      ['dragenter', 'dragover'].forEach(function (evt) {
        zone.addEventListener(evt, function (e) { e.preventDefault(); zone.classList.add('dragging'); });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        zone.addEventListener(evt, function (e) { e.preventDefault(); zone.classList.remove('dragging'); });
      });
      zone.addEventListener('drop', function (e) {
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) { handleImportFiles(dt.files); }
      });
    });

    /* 拖拽上传（分析 + 截图共用视觉语言） */
    ['analysisDrop'].forEach(function (id) {
      var zone = $(id);
      ['dragenter', 'dragover'].forEach(function (evt) {
        zone.addEventListener(evt, function (e) {
          e.preventDefault();
          zone.classList.add('dragging');
        });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        zone.addEventListener(evt, function (e) {
          e.preventDefault();
          zone.classList.remove('dragging');
        });
      });
      zone.addEventListener('drop', function (e) {
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
          handleAnalysisFiles(dt.files);
        }
      });
    });

    /* ---- 截屏记账弹窗 ---- */
    $('btnCloseOcr').addEventListener('click', closeOcrModal);
    $('btnOcrCancel').addEventListener('click', closeOcrModal);
    $('btnOcrRun').addEventListener('click', runOcr);
    $('ocrMask').addEventListener('click', function (e) {
      if (e.target === $('ocrMask')) { closeOcrModal(); }
    });
    $('ocrDrop').addEventListener('click', function () {
      $('ocrFile').click();
    });
    $('ocrFile').addEventListener('change', function () {
      if (this.files && this.files.length > 0) { handleOcrFile(this.files[0]); }
    });
    ['dragenter', 'dragover'].forEach(function (evt) {
      $('ocrDrop').addEventListener(evt, function (e) {
        e.preventDefault();
        $('ocrDrop').classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      $('ocrDrop').addEventListener(evt, function (e) {
        e.preventDefault();
        $('ocrDrop').classList.remove('dragging');
      });
    });
    $('ocrDrop').addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) { handleOcrFile(dt.files[0]); }
    });
    $('ocrDemoList').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act="ocr-sample"]') : null;
      if (!btn) { return; }
      ocrDemoIndex = Number(btn.getAttribute('data-index'));
      ocrPendingFile = null;
      ocrImageDataUrl = '';
      ocrPreviewSuppressed = false;
      $('ocrPreview').hidden = true;
      $('ocrResult').innerHTML = '';
      $('ocrStatus').className = 'ocr-status';
      $('ocrStatus').textContent = '已选择示例小票「' + OCR.SAMPLES[ocrDemoIndex].title + '」，点「开始识别」看结果。';
    });
    $('ocrResult').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) { return; }
      var act = btn.getAttribute('data-act');
      if (act === 'ocr-confirm') {
        confirmOcrBill();
      } else if (act === 'ocr-retry') {
        $('ocrResult').innerHTML = '';
        $('ocrStatus').textContent = '可以重新选图，或再点一次「开始识别」。';
      } else if (act === 'ocr-cloud-config') {
        openOcrCloudSettings();
      } else if (act === 'ocr-cloud-app') {
        openCloudAppLink();
      } else if (act === 'ocr-giveup' || act === 'ocr-manual') {
        closeOcrModal();
        switchView('chat');
        addAIMessage(aiBubble('行，直接在下面输入就行，比如「午饭食堂 15」，我马上给你记上。'));
        var input = $('chatInput');
        if (input) { input.focus(); }
      } else if (act === 'ocr-sample') {
        var idx = Number(btn.getAttribute('data-index') || 0);
        ocrDemoIndex = idx;
        ocrPendingFile = null;
        ocrImageDataUrl = '';
        ocrPreviewSuppressed = false;
        $('ocrPreview').hidden = true;
        runOcr();
      }
    });

    /* Ctrl+V 粘贴截图 */
    DOC.addEventListener('paste', function (e) {
      if ($('ocrMask').hidden) { return; }
      var cd = e.clipboardData || global.clipboardData;
      if (!cd || !cd.items) { return; }
      var i;
      for (i = 0; i < cd.items.length; i++) {
        if (cd.items[i].type && cd.items[i].type.indexOf('image') === 0) {
          var file = cd.items[i].getAsFile();
          if (file) {
            e.preventDefault();
            handleOcrFile(file);
            return;
          }
        }
      }
    });

    $('modalMask').addEventListener('click', function (e) {
      if (e.target === $('modalMask')) { closeModal(); }
    });

    DOC.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        closeModal();
        if (!$('analysisMask').hidden) { closeAnalysisSheet(); }
        if (!$('saveHubMask').hidden) { closeSaveHub(); }
        if (!$('ocrMask').hidden) { closeOcrModal(); }
        if ($('settingsDrawer').classList.contains('open')) { closeDrawer(); }
        if ($('modalMask').hidden && !$('settingsMask').hidden) { closeSettingsPage(); }
      }
    });

    $('tabbar').addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('.tab[data-view]') : null;
      if (tab) { switchView(tab.getAttribute('data-view')); }
    });
  }

  /* ================================================================== */
  /* 欢迎语 & 启动                                                       */
  /* ================================================================== */

  function addWelcome() {
    var ov = getOverview();
    addAIMessage(aiBubble('你好呀，我是账小助 👋<br>一句话就能记账，试试「中午食堂 15」。<br>想省钱 / 搞钱，去底部「理财专家」找我，剁手前也可以先让我把把关。'));
    addAIMessage(aiBubble('当前周期 ' + esc(ov.cycle.start) + ' ~ ' + esc(ov.cycle.end) + '，总预算 ' +
      money(state.budget.total) + '，已花 ' + money(ov.cycleAgg.expense) + '。' + ov.sentence));
  }

  function init() {
    loadState();
    loadSavingsDb();
    if (!savingsReady()) { degradeSavingsUi(); }
    if (!storageOK) { showStorageTip(); }
    applyAppearance();
    applyUiMode();
    var ring = $('ringBar');
    if (ring) {
      ring.style.strokeDasharray = RING_C + ' ' + RING_C;
      ring.style.strokeDashoffset = String(RING_C);
    }
    setupVoice();
    bindEvents();
    bindSimpleEvents();
    renderAll();
    addWelcome();
    // 默认视图按 UI 类型分流：简洁版进「记账」首页，完整版进聊天（修复简洁版刷新后落空白）
    switchView(getUiMode() === 'simple' ? 'shome' : 'chat');
    initCloud();
  }

  if (DOC.readyState === 'loading') {
    DOC.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
