/**
 * ocr.js — 消费截图识别记账（三层降级）
 *
 * 全局命名空间：window.AJ.ocr
 * Node 单测：require('./ocr.js')
 *
 * 三层降级：
 *   ① 浏览器原生 window.TextDetector —— 本地识别，零网络
 *   ② 云 OCR（腾讯云 GeneralBasicOCR，可选）—— 用户配置凭据后才可能发请求
 *   ③ 演示模式 —— 内置 3 份示例小票文本，**仅由用户显式选择时触发**
 *
 * ⚠️ 演示模式绝不作为 auto 的自动回落：没有可用识别能力时返回 ok:false /
 *    source:'none'，UI 会引导用户「看示例 / 配云 OCR / 手动录入」。
 *    拿示例数据冒充用户图片的识别结果属于不可接受的误导。
 *
 * ⚠️ 本文件是全项目唯一允许出现 fetch 的文件。
 *    未配置凭据时 detect() 绝不发起任何网络请求。
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);

  /** 凭据单独存一个 key，与账本数据隔离 */
  var CRED_KEY = 'ai_jizhang_ocr';
  var CLOUD_ENDPOINT = 'https://ocr.tencentcloudapi.com';
  var CLOUD_HOST = 'ocr.tencentcloudapi.com';
  var CLOUD_SERVICE = 'ocr';
  var CLOUD_ACTION = 'GeneralBasicOCR';
  var CLOUD_VERSION = '2018-11-19';

  /** 内存兜底（无 localStorage 或读写失败时使用） */
  var memCred = { secretId: '', secretKey: '', region: 'ap-guangzhou' };

  /* ================================================================== */
  /* 演示样例（3 份，覆盖 high / medium / low 三种置信度）               */
  /* ================================================================== */

  /** 本地时区的 YYYY-MM-DD */
  function formatDay(date) {
    var d = (date instanceof Date) ? date : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /**
   * 构造 3 份演示样例。
   * 日期必须按「调用时」现算：写死往年日期会让用户确认入账后
   * 看板的「今日支出 / 本周期支出」毫无变化，演示时像是功能坏了。
   * @param {Date} [now]
   * @return {Array<Object>}
   */
  function buildSamples(now) {
    var base = (now instanceof Date) ? now : new Date();
    var today = formatDay(base);
    var shortDay = pad2(base.getMonth() + 1) + '-' + pad2(base.getDate());
    return [
      {
        id: 'sample_wx',
        title: '微信支付凭证',
        expect: 'high',
        text: [
          '微信支付',
          '商户名称：三食堂麻辣香锅',
          '支付金额 ¥32.00',
          '支付时间 ' + today + ' 12:30',
          '支付方式：零钱'
        ].join('\n')
      },
      {
        id: 'sample_alipay',
        title: '支付宝账单详情',
        expect: 'medium',
        text: [
          '支付宝',
          '订单号 2025102122001456789012',
          '商户名称：瑞幸咖啡',
          '商品说明：生椰拿铁 x2',
          '订单金额 38.00',
          '优惠 -6.00',
          '合计 32.00',
          '实付 32.00',
          '交易时间 ' + shortDay + ' 12:30'
        ].join('\n')
      },
      {
        id: 'sample_canteen',
        title: '食堂小票',
        expect: 'low',
        text: [
          '校园食堂',
          '黄焖鸡 18.00',
          '米饭 2.00',
          '紫菜蛋花汤 3.00'
        ].join('\n')
      }
    ];
  }

  /* ================================================================== */
  /* 通用工具                                                            */
  /* ================================================================== */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function round2(n) {
    var v = Number(n);
    if (!isFinite(v)) { return 0; }
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  /** 全角数字 / 符号 → 半角（1:1 替换，不改变长度） */
  function normalizeWidth(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/[\uFF10-\uFF19]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      })
      .replace(/\uFF0E/g, '.')
      .replace(/\uFF1A/g, ':')
      .replace(/\uFF0C/g, ',')
      .replace(/\uFF0D/g, '-')
      .replace(/\uFFE5/g, '¥');
  }

  function errorMessage(err) {
    if (!err) { return '未知错误'; }
    if (typeof err === 'string') { return err; }
    if (err.message) { return String(err.message); }
    return String(err);
  }

  /* ================================================================== */
  /* 小票文本解析                                                        */
  /* ================================================================== */

  /**
   * 金额标签优先级（数字越大越可信）。
   * 「实付 / 支付金额」优先于「合计 / 总计」，因为合计里可能含优惠前的原价。
   */
  var AMOUNT_LABELS = [
    { word: '实付', score: 100 },
    { word: '支付金额', score: 96 },
    { word: '付款金额', score: 94 },
    { word: '消费金额', score: 90 },
    { word: '本次支付', score: 90 },
    { word: '实收', score: 86 },
    { word: '应收', score: 80 },
    { word: '合计', score: 76 },
    { word: '总计', score: 74 },
    { word: '小计', score: 70 },
    { word: '金额', score: 60 }
  ];

  var MERCHANT_HINTS = ['店', '餐厅', '超市', '咖啡', '食堂', '小吃', '便利店', '餐', '奶茶', '药房', '书店', '水果', '烘焙'];
  var MERCHANT_PREFIX = /^(商户名称|商户|收款方|商家|店铺|收款单位)\s*[:：]\s*/;

  /**
   * 抽取金额。
   * @param {string} text 已归一化文本
   * @return {?{amount:number, label:string, score:number, byMax:boolean}}
   */
  function extractAmount(text) {
    var best = null;
    var i;
    for (i = 0; i < AMOUNT_LABELS.length; i++) {
      var def = AMOUNT_LABELS[i];
      var re = new RegExp(def.word + '\\s*[:：]?\\s*[¥￥]?\\s*(-?\\d+(?:\\.\\d{1,2})?)', 'g');
      var m;
      var last = null;
      while ((m = re.exec(text)) !== null) {
        var v = Number(m[1]);
        if (isFinite(v) && v > 0) {
          last = { value: v, label: def.word, score: def.score };
        }
      }
      if (last && (!best || last.score > best.score)) {
        best = { amount: round2(last.value), label: last.label, score: last.score, byMax: false };
      }
    }
    if (best) { return best; }

    /* 兜底：去掉日期 / 时间 / 长订单号后，取最大数字 */
    var cleaned = String(text)
      .replace(/\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}/g, ' ')
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
      .replace(/\d{7,}/g, ' ');

    var candidates = [];
    var reMoney = /[¥￥]\s*(\d+(?:\.\d{1,2})?)/g;
    var mm;
    while ((mm = reMoney.exec(cleaned)) !== null) {
      var mv = Number(mm[1]);
      if (isFinite(mv) && mv > 0) { candidates.push(mv); }
    }
    if (candidates.length === 0) {
      var reDecimal = /(\d+\.\d{1,2})/g;
      while ((mm = reDecimal.exec(cleaned)) !== null) {
        var dv = Number(mm[1]);
        if (isFinite(dv) && dv > 0) { candidates.push(dv); }
      }
    }
    if (candidates.length === 0) {
      var reInt = /(?:^|[^\d.])(\d{1,6})(?![\d.])/g;
      while ((mm = reInt.exec(cleaned)) !== null) {
        var iv = Number(mm[1]);
        if (isFinite(iv) && iv > 0) { candidates.push(iv); }
      }
    }
    if (candidates.length === 0) { return null; }
    var max = 0;
    for (i = 0; i < candidates.length; i++) {
      if (candidates[i] > max) { max = candidates[i]; }
    }
    return { amount: round2(max), label: '', score: 0, byMax: true };
  }

  /**
   * 抽取商户名：优先带「商户 / 收款方」前缀的行，其次命中行业关键词的行，最后取首行。
   * @param {string} text
   * @return {{merchant:string, hasHint:boolean}}
   */
  function extractMerchant(text) {
    var rawLines = String(text).split(/\r?\n/);
    var lines = [];
    var i;
    for (i = 0; i < rawLines.length; i++) {
      var t = rawLines[i].trim();
      if (t) { lines.push(t); }
    }
    for (i = 0; i < lines.length; i++) {
      if (MERCHANT_PREFIX.test(lines[i])) {
        var stripped = lines[i].replace(MERCHANT_PREFIX, '').trim();
        if (stripped) { return { merchant: stripped, hasHint: true }; }
      }
    }
    for (i = 0; i < lines.length; i++) {
      var j;
      for (j = 0; j < MERCHANT_HINTS.length; j++) {
        if (lines[i].indexOf(MERCHANT_HINTS[j]) !== -1) {
          return { merchant: lines[i], hasHint: true };
        }
      }
    }
    for (i = 0; i < lines.length; i++) {
      // 纯数字 / 纯时间 / 支付渠道名不作为商户
      if (/^[\d\s.:½¥￥-]+$/.test(lines[i])) { continue; }
      if (/^(微信支付|支付宝|微信|账单详情|支付凭证|交易详情|收银台)$/.test(lines[i])) { continue; }
      return { merchant: lines[i], hasHint: false };
    }
    return { merchant: '', hasHint: false };
  }

  /**
   * 抽取日期：优先完整日期（含年份），否则 MM-DD 补当前年份。
   * @param {string} text
   * @param {Date} now
   * @return {{date:string, full:boolean, hasTime:boolean}}
   */
  function extractDate(text, now) {
    var base = now instanceof Date ? now : new Date();
    var m = String(text).match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
    if (m) {
      return {
        date: Number(m[1]) + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3])),
        full: true,
        hasTime: /\d{1,2}:\d{2}/.test(text)
      };
    }
    var short = String(text).match(/(\d{1,2})\s*[-/月]\s*(\d{1,2})(?!\s*[-/:])/);
    if (short) {
      return {
        date: base.getFullYear() + '-' + pad2(Number(short[1])) + '-' + pad2(Number(short[2])),
        full: false,
        hasTime: /\d{1,2}:\d{2}/.test(text)
      };
    }
    return { date: '', full: false, hasTime: false };
  }

  /** 支付方式 */
  function extractPayMethod(text) {
    var s = String(text);
    if (/云闪付/.test(s)) { return '云闪付'; }
    if (/微信/.test(s)) { return '微信支付'; }
    if (/支付宝/.test(s)) { return '支付宝'; }
    if (/银行卡|储蓄卡|信用卡|银联/.test(s)) { return '银行卡'; }
    if (/现金/.test(s)) { return '现金'; }
    return '';
  }

  /**
   * 解析小票 OCR 文本。
   * @param {string} text
   * @param {Date} [now] 补年份用（便于测试）
   * @return {{ok:boolean, amount?:number, merchant?:string, date?:string, payMethod?:string,
   *           confidence?:string, raw:string, reason?:string, label?:string}}
   */
  function parseReceipt(text, now) {
    var raw = String(text === undefined || text === null ? '' : text);
    if (!raw.trim()) {
      return { ok: false, reason: '未识别到金额', raw: raw };
    }
    var normalized = normalizeWidth(raw);
    var amountInfo = extractAmount(normalized);
    if (!amountInfo || !amountInfo.amount) {
      return { ok: false, reason: '未识别到金额', raw: raw };
    }

    var merchantInfo = extractMerchant(normalized);
    var dateInfo = extractDate(normalized, now);
    var payMethod = extractPayMethod(normalized);

    var confidence;
    if (amountInfo.label && dateInfo.full) {
      confidence = 'high';
    } else if (amountInfo.label) {
      confidence = 'medium';
    } else if (!amountInfo.byMax && dateInfo.date) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    /* 识别出的日期比「去年」还早：多半是小票年份印错或截图里混进了旧订单号。
       保留原值但降一档置信度并给出提示，不静默接受。 */
    var dateWarn = '';
    if (dateInfo.date) {
      var base = (now instanceof Date) ? now : new Date();
      var year = Number(String(dateInfo.date).slice(0, 4));
      if (isFinite(year) && year < base.getFullYear() - 1) {
        dateWarn = '识别到的日期较早（' + dateInfo.date + '），请核对';
        if (confidence === 'high') { confidence = 'medium'; }
        else if (confidence === 'medium') { confidence = 'low'; }
      }
    }

    return {
      ok: true,
      amount: amountInfo.amount,
      merchant: merchantInfo.merchant,
      date: dateInfo.date,
      payMethod: payMethod,
      confidence: confidence,
      dateWarn: dateWarn,
      label: amountInfo.label,
      raw: raw
    };
  }

  /* ================================================================== */
  /* 凭据管理（localStorage key: ai_jizhang_ocr）                        */
  /* ================================================================== */

  function getStorage() {
    try {
      if (global && global.localStorage) { return global.localStorage; }
    } catch (e) {
      return null;
    }
    return null;
  }

  /** @return {{secretId:string, secretKey:string, region:string}} */
  function getCredentials() {
    var store = getStorage();
    if (store) {
      try {
        var raw = store.getItem(CRED_KEY);
        if (raw) {
          var obj = JSON.parse(raw);
          if (obj && typeof obj === 'object') {
            return {
              secretId: String(obj.secretId || ''),
              secretKey: String(obj.secretKey || ''),
              region: String(obj.region || 'ap-guangzhou')
            };
          }
        }
      } catch (e) {
        // 读失败 → 用内存副本
      }
    }
    return {
      secretId: memCred.secretId,
      secretKey: memCred.secretKey,
      region: memCred.region || 'ap-guangzhou'
    };
  }

  /**
   * 保存凭据（只存本机浏览器，仅本地调用）。
   * @param {{secretId:string, secretKey:string, region:string}} cred
   * @return {boolean} 是否成功写入 localStorage
   */
  function saveCredentials(cred) {
    var obj = {
      secretId: String((cred && cred.secretId) || ''),
      secretKey: String((cred && cred.secretKey) || ''),
      region: String((cred && cred.region) || 'ap-guangzhou')
    };
    memCred = obj;
    var store = getStorage();
    if (!store) { return false; }
    try {
      store.setItem(CRED_KEY, JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 清除凭据 */
  function clearCredentials() {
    memCred = { secretId: '', secretKey: '', region: 'ap-guangzhou' };
    var store = getStorage();
    if (!store) { return true; }
    try {
      store.removeItem(CRED_KEY);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 是否已配置可用凭据 */
  function hasCredentials() {
    var c = getCredentials();
    return !!(c.secretId && c.secretKey);
  }

  /** 当前能力矩阵（UI 用） */
  function capabilities() {
    var native = (typeof global !== 'undefined' && typeof global.TextDetector === 'function');
    var cloud = hasCredentials();
    return {
      native: native,
      cloud: cloud,
      demo: true,
      recommended: native ? 'native' : (cloud ? 'cloud' : 'demo')
    };
  }

  /* ================================================================== */
  /* ① 浏览器原生识别（零网络）                                          */
  /* ================================================================== */

  /**
   * @param {Blob|File} file
   * @return {Promise<{ok:boolean, source:string, text:string, reason:string}>}
   */
  function detectNative(file) {
    return new Promise(function (resolve) {
      var TD = (typeof global !== 'undefined') ? global.TextDetector : null;
      var createBitmap = (typeof global !== 'undefined') ? global.createImageBitmap : null;
      if (typeof TD !== 'function') {
        resolve({ ok: false, source: 'native', text: '', reason: '当前浏览器不支持本地文字识别（TextDetector）' });
        return;
      }
      if (typeof createBitmap !== 'function' || !file) {
        resolve({ ok: false, source: 'native', text: '', reason: '无法读取图片（需要可用的图片文件）' });
        return;
      }
      var bitmapPromise;
      try {
        bitmapPromise = createBitmap(file);
      } catch (e) {
        resolve({ ok: false, source: 'native', text: '', reason: '图片解码失败：' + errorMessage(e) });
        return;
      }
      bitmapPromise.then(function (bitmap) {
        var detector;
        try {
          detector = new TD();
        } catch (e) {
          return { ok: false, source: 'native', text: '', reason: '本地识别器初始化失败：' + errorMessage(e) };
        }
        return detector.detect(bitmap).then(function (items) {
          var texts = [];
          var i;
          for (i = 0; i < (items || []).length; i++) {
            if (items[i] && items[i].rawValue) { texts.push(String(items[i].rawValue)); }
          }
          if (texts.length === 0) {
            return { ok: false, source: 'native', text: '', reason: '本地识别没有读到文字' };
          }
          return { ok: true, source: 'native', text: texts.join('\n'), reason: '' };
        });
      }).then(function (result) {
        resolve(result);
      }).catch(function (err) {
        resolve({ ok: false, source: 'native', text: '', reason: '本地识别失败：' + errorMessage(err) });
      });
    });
  }

  /* ================================================================== */
  /* ② 云 OCR（腾讯云 GeneralBasicOCR / TC3-HMAC-SHA256）                */
  /* ================================================================== */

  function utf8Bytes(str) {
    return new TextEncoder().encode(String(str));
  }

  function toHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = '';
    var i;
    for (i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      out += h.length === 1 ? '0' + h : h;
    }
    return out;
  }

  function sha256Hex(input) {
    var data = (typeof input === 'string') ? utf8Bytes(input) : input;
    return global.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      return toHex(buf);
    });
  }

  function hmacSha256(keyBytes, msg) {
    return global.crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']
    ).then(function (key) {
      return global.crypto.subtle.sign('HMAC', key, utf8Bytes(msg));
    }).then(function (sig) {
      return new Uint8Array(sig);
    });
  }

  /**
   * 构造腾讯云 TC3-HMAC-SHA256 签名所需 Header。
   * @param {{secretId:string, secretKey:string, region:string, payload:string}} opts
   * @return {Promise<Object>} fetch headers
   */
  function buildTc3Headers(opts) {
    var secretId = opts.secretId;
    var secretKey = opts.secretKey;
    var region = opts.region || 'ap-guangzhou';
    var payload = opts.payload;
    var timestamp = Math.floor(Date.now() / 1000);
    var d = new Date(timestamp * 1000);
    var date = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    var actionLower = CLOUD_ACTION.toLowerCase();
    var contentType = 'application/json; charset=utf-8';
    var signedHeaders = 'content-type;host;x-tc-action';
    var canonicalHeaders = 'content-type:' + contentType + '\n' +
      'host:' + CLOUD_HOST + '\n' +
      'x-tc-action:' + actionLower + '\n';
    var canonicalRequest = 'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n';
    var credentialScope = date + '/' + CLOUD_SERVICE + '/tc3_request';

    return sha256Hex(payload).then(function (hashedPayload) {
      var fullCanonical = canonicalRequest + hashedPayload;
      return sha256Hex(fullCanonical);
    }).then(function (hashedCanonical) {
      var stringToSign = 'TC3-HMAC-SHA256\n' + timestamp + '\n' + credentialScope + '\n' + hashedCanonical;
      return hmacSha256(utf8Bytes('TC3' + secretKey), date).then(function (secretDate) {
        return hmacSha256(secretDate, CLOUD_SERVICE);
      }).then(function (secretService) {
        return hmacSha256(secretService, 'tc3_request');
      }).then(function (secretSigning) {
        return hmacSha256(secretSigning, stringToSign);
      }).then(function (signatureBytes) {
        var signature = toHex(signatureBytes);
        var authorization = 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + credentialScope +
          ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
        return {
          'Content-Type': contentType,
          'Host': CLOUD_HOST,
          'X-TC-Action': CLOUD_ACTION,
          'X-TC-Version': CLOUD_VERSION,
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Region': region,
          'Authorization': authorization
        };
      });
    });
  }

  /**
   * 云 OCR 识别。未配置凭据 / 无图片时立即返回结构化错误，不做任何网络请求。
   * @param {string} dataUrl 'data:image/png;base64,...'
   * @return {Promise<{ok:boolean, source:string, text:string, reason:string}>}
   */
  function detectCloud(dataUrl) {
    var cred = getCredentials();
    if (!cred.secretId || !cred.secretKey) {
      return Promise.resolve({
        ok: false,
        source: 'cloud',
        text: '',
        reason: '还没有配置云 OCR 凭据，云端识别不可用'
      });
    }
    if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('base64,') === -1) {
      return Promise.resolve({
        ok: false,
        source: 'cloud',
        text: '',
        reason: '没有可识别的图片数据，请重新选择图片'
      });
    }
    if (typeof global.fetch !== 'function') {
      return Promise.resolve({ ok: false, source: 'cloud', text: '', reason: '当前环境不支持网络请求' });
    }
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.resolve({
        ok: false,
        source: 'cloud',
        text: '',
        reason: '当前浏览器不支持 Web Crypto，无法签名，云端识别不可用'
      });
    }

    var base64 = dataUrl.split('base64,')[1] || '';
    var payload = JSON.stringify({ ImageBase64: base64 });
    var headers;

    return buildTc3Headers({
      secretId: cred.secretId,
      secretKey: cred.secretKey,
      region: cred.region,
      payload: payload
    }).then(function (h) {
      headers = h;
      return global.fetch(CLOUD_ENDPOINT, {
        method: 'POST',
        headers: headers,
        body: payload
      });
    }).then(function (resp) {
      if (!resp || !resp.json) {
        return { ok: false, source: 'cloud', text: '', reason: '云端返回格式异常' };
      }
      return resp.json().then(function (json) {
        var r = json && json.Response ? json.Response : null;
        if (!r) {
          return { ok: false, source: 'cloud', text: '', reason: '云端返回为空' };
        }
        if (r.Error) {
          return {
            ok: false,
            source: 'cloud',
            text: '',
            reason: '云端识别失败：' + (r.Error.Message || r.Error.Code || '未知错误')
          };
        }
        var detections = r.TextDetections || [];
        var texts = [];
        var i;
        for (i = 0; i < detections.length; i++) {
          if (detections[i] && detections[i].DetectedText) {
            texts.push(String(detections[i].DetectedText));
          }
        }
        if (texts.length === 0) {
          return { ok: false, source: 'cloud', text: '', reason: '云端没有识别到文字' };
        }
        return { ok: true, source: 'cloud', text: texts.join('\n'), reason: '' };
      });
    }).catch(function (err) {
      return {
        ok: false,
        source: 'cloud',
        text: '',
        reason: '云端识别失败，可能是跨域限制或网络问题，已保留手动录入入口（' + errorMessage(err) + '）'
      };
    });
  }

  /**
   * 走 WorkBuddy 云服务视觉大模型识别截图文字（免密钥，由 app.js 注入 global.AJ.visionOcr）。
   * 与 detectCloud 返回同一套结构化结果；任何失败都返回 ok:false，便于上层降级。
   * @param {string} dataUrl 'data:image/png;base64,...'
   * @return {Promise<{ok:boolean, source:string, text:string, reason:string}>}
   */
  function detectBackend(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('base64,') === -1) {
      return Promise.resolve({
        ok: false,
        source: 'backend',
        text: '',
        reason: '没有可识别的图片数据'
      });
    }
    if (typeof global.AJ === 'object' && typeof global.AJ.visionOcr === 'function') {
      return global.AJ.visionOcr(dataUrl);
    }
    return Promise.resolve({
      ok: false,
      source: 'backend',
      text: '',
      reason: 'WorkBuddy 云服务未连接（请用 python server.py 启动本页并确认能联网）'
    });
  }

  /**
   * 按开关选择云端识别实现：
   *   - 启用了后端 OCR（global.AJ_BACKEND_OCR 为真，即由 server.py 托管页面）走 WorkBuddy 云服务视觉模型
   *   - 否则保留浏览器直连腾讯云 detectCloud（用 file:// 直接打开页面时）
   */
  function cloudDetect(dataUrl) {
    return (global && global.AJ_BACKEND_OCR) ? detectBackend(dataUrl) : detectCloud(dataUrl);
  }

  /* ================================================================== */
  /* ③ 演示模式                                                          */
  /* ================================================================== */

  /**
   * @param {number} index 0-2
   * @param {Date} [now] 用于生成演示样例里的日期
   * @return {{ok:boolean, source:string, text:string, reason:string, sample:Object}}
   */
  function detectDemo(index, now) {
    var samples = buildSamples(now);
    var i = Number(index);
    if (!isFinite(i) || i < 0 || i >= samples.length) { i = 0; }
    var sample = samples[i];
    return {
      ok: true,
      source: 'demo',
      text: sample.text,
      reason: '',
      sample: { id: sample.id, title: sample.title, expect: sample.expect }
    };
  }

  /* ================================================================== */
  /* 统一入口                                                            */
  /* ================================================================== */

  /**
   * auto 模式下三层（原生 / 云 / 演示）全部不可用时给用户看的总说明。
   * 演示样例（demo）**只能由用户显式选择**（mode:'demo' 或点示例小票）触发，
   * auto 分支绝不再回落到 demo —— 否则用户上传自己的截图会被"识别"成
   * 内置样例的金额和商户，看起来像真的识别成功，属于最严重的信任问题。
   */
  var NO_CAPABILITY_REASON = '当前浏览器没有可用的文字识别能力：Windows 版 Chrome 不支持本地文字识别' +
    '（TextDetector），且 WorkBuddy 云服务也未连接。请用线上版本打开本应用以启用视觉识别，' +
    '或点下面的「示例小票」看演示效果，或直接手动录入。';

  /**
   * 构造结构化失败结果。text 恒为空字符串，绝不携带任何示例文本。
   * @param {string} reason 面向用户的说明
   * @param {Array<string>} tried 尝试/考察过的层（'native' | 'cloud'）
   * @param {Array<string>} details 各层原始原因（面向开发/排查）
   * @return {{ok:boolean, source:string, text:string, reason:string, tried:Array<string>, details:Array<string>}}
   */
  function failureResult(reason, tried, details) {
    return {
      ok: false,
      source: 'none',
      text: '',
      reason: reason,
      tried: (tried || []).slice(),
      details: (details || []).slice()
    };
  }

  /**
   * 拼接 auto 模式失败说明：分「本地失败 / 云端失败 / 都失败」三种口径，
   * 并把各层原始 reason 带上，便于用户和我们自己判断到底卡在哪。
   * @param {string} nativeReason 本地层失败原因（未尝试时传空串）
   * @param {string} cloudReason 云端层失败原因（未尝试时传空串）
   * @return {string}
   */
  function composeFailureReason(nativeReason, cloudReason) {
    var head;
    if (nativeReason && cloudReason) {
      head = '本地识别和云端识别都没有成功，所以没能识别这张截图。';
    } else if (cloudReason) {
      head = '云端识别没有成功，所以没能识别这张截图。';
    } else if (nativeReason) {
      head = '本地识别没有成功，也没有可用的云端识别（WorkBuddy 云服务未连接），所以没能识别这张截图。';
    } else {
      head = NO_CAPABILITY_REASON;
    }
    var parts = [];
    if (nativeReason) { parts.push('本地：' + nativeReason); }
    if (cloudReason) { parts.push('云端：' + cloudReason); }
    var detail = parts.length > 0 ? '（' + parts.join('；') + '）' : '';
    return head + detail + '可以点「用示例小票演示」看流程，或直接手动录入。';
  }

  /**
   * 三层降级的统一识别入口。**永不 reject**，失败也返回结构化对象。
   *
   * 重要：mode:'auto' 在没有可用识别能力时返回 ok:false / source:'none'，
   * 不会返回演示样例。演示样例只走 mode:'demo'。
   *
   * @param {{mode?:string, file?:Object, dataUrl?:string, demoIndex?:number, now?:Date}} [opts]
   *        mode: 'auto'（默认）| 'native' | 'cloud' | 'demo'
   * @return {Promise<{ok:boolean, source:string, text:string, reason:string, tried?:Array<string>}>}
   */
  function detect(opts) {
    var o = opts || {};
    var mode = o.mode || 'auto';

    return Promise.resolve().then(function () {
      /* 显式演示入口：用户主动点示例小票时走这里，路径保持不变 */
      if (mode === 'demo') { return detectDemo(o.demoIndex, o.now); }
      if (mode === 'native') { return detectNative(o.file); }
      if (mode === 'cloud') { return cloudDetect(o.dataUrl); }

      var nativeAvailable = (typeof global !== 'undefined' && typeof global.TextDetector === 'function');
      /* 云端可用性：旧版「腾讯云 OCR 凭据」或新版「WorkBuddy 云服务视觉识别」二者其一即可。
         注意：hasCredentials() 只认腾讯云凭据；现在截图识别走 WorkBuddy 云服务（免密钥），
         只要 app.js 已注入 global.AJ.visionOcr 就视为云端可用 —— 否则 auto 模式永远走不到云端。 */
      var wbCloudFn = (typeof global !== 'undefined' && global.AJ && typeof global.AJ.visionOcr === 'function');
      var cloudAvailable = !!o.dataUrl && (hasCredentials() || (global.AJ_BACKEND_OCR && wbCloudFn));

      /* 已配云端但没拿到图片数据：说明问题在图片，不在能力 */
      if (!nativeAvailable && hasCredentials() && !o.dataUrl) {
        return failureResult(
          '没有可用的图片数据，没法调用云端识别。请重新选择一张截图，或直接用示例小票 / 手动录入。',
          ['cloud'],
          ['没有可识别的图片数据']
        );
      }

      /* 三层里没有一层可用：直说不可用，绝不拿示例数据冒充识别结果 */
      if (!nativeAvailable && !cloudAvailable) {
        return failureResult(NO_CAPABILITY_REASON, ['native', 'cloud'], []);
      }

      /**
       * 本地不可用 / 本地失败后走云端；云端也失败则返回失败。
       * @param {string} nativeReason 本地层失败原因（本地根本不可用时为空串）
       * @return {Promise<Object>}
       */
      function tryCloud(nativeReason) {
        if (!cloudAvailable) {
          var triedLocal = nativeReason ? ['native'] : ['native', 'cloud'];
          var detailsLocal = nativeReason ? [nativeReason] : [];
          return Promise.resolve(
            failureResult(composeFailureReason(nativeReason, ''), triedLocal, detailsLocal)
          );
        }
        return cloudDetect(o.dataUrl).then(function (cloudRes) {
          if (cloudRes && cloudRes.ok) { return cloudRes; }
          var cloudReason = (cloudRes && cloudRes.reason) || '云端识别没有返回结果';
          var tried = nativeReason ? ['native', 'cloud'] : ['cloud'];
          var details = nativeReason ? [nativeReason, cloudReason] : [cloudReason];
          return failureResult(composeFailureReason(nativeReason, cloudReason), tried, details);
        });
      }

      if (!nativeAvailable) {
        /* 没有原生识别：只可能走云端 */
        return tryCloud('');
      }

      /* 有原生识别：先本地，本地失败再考虑云端，两者都失败 → 返回失败 */
      return detectNative(o.file).then(function (res) {
        if (res && res.ok) { return res; }
        return tryCloud((res && res.reason) || '本地识别没有返回结果');
      });
    }).catch(function (err) {
      return failureResult(
        '识别流程出现异常：' + errorMessage(err) + '，不是你操作的问题，可以直接手动录入。',
        [],
        [errorMessage(err)]
      );
    });
  }

  var API = {
    buildSamples: buildSamples,
    formatDay: formatDay,
    CRED_KEY: CRED_KEY,
    parseReceipt: parseReceipt,
    extractAmount: extractAmount,
    extractMerchant: extractMerchant,
    extractDate: extractDate,
    extractPayMethod: extractPayMethod,
    detect: detect,
    detectNative: detectNative,
    detectCloud: detectCloud,
    detectBackend: detectBackend,
    cloudDetect: cloudDetect,
    detectDemo: detectDemo,
    hasCredentials: hasCredentials,
    getCredentials: getCredentials,
    saveCredentials: saveCredentials,
    clearCredentials: clearCredentials,
    capabilities: capabilities,
    buildTc3Headers: buildTc3Headers,
    normalizeWidth: normalizeWidth
  };

  /* SAMPLES 用 getter 暴露：每次访问都以「今天」为基准重新构造，
     避免页面长期开着或写死日期导致演示样例的日期过期。 */
  Object.defineProperty(API, 'SAMPLES', {
    enumerable: true,
    get: function () { return buildSamples(new Date()); }
  });

  if (isNode) {
    module.exports = API;
  } else {
    global.AJ = global.AJ || {};
    global.AJ.ocr = API;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
