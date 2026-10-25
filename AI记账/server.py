# -*- coding: utf-8 -*-
"""
AI 校园记账管家 —— 后端服务（一键启动）

把前端页面（index.html + 一堆 .js/.css）和后端接口打包在一起：
    python server.py
然后浏览器打开 http://127.0.0.1:8000 即可。

接口：
    GET  /                      静态首页（index.html）
    GET  /<file>                静态资源（.js/.css/.html/.png...，禁止访问 .env/server.py）
    POST /api/health            健康检查
    POST /api/chat              接收文字 -> 调用大模型 -> 返回 {reply, actions}
    POST /api/ocr               接收 base64 图片 -> 服务端调用腾讯云 OCR -> 返回 {text}

环境变量（见 .env.example）：
    LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_TIMEOUT
    TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_REGION

未配置密钥时接口会返回 fallback:true（对话）或 error（OCR），
前端会自动回退到本地逻辑，保证「开箱即用」。
"""

import os
import sys
import json
import hmac
import hashlib
import base64
import datetime

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    # python-dotenv 没装也能跑（直接读系统环境变量）
    pass

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
import uvicorn
import requests

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_FILE = os.path.join(BASE_DIR, 'index.html')

# 允许浏览器直接访问的静态文件后缀，避免误泄 .env / server.py 等
ALLOWED_EXT = {
    '.html', '.htm', '.js', '.css', '.png', '.jpg', '.jpeg', '.gif',
    '.svg', '.ico', '.json', '.map', '.woff', '.woff2', '.ttf', '.txt',
    '.csv',   # 真实商家日历.csv 可直接从本地服务下载
}
DENY_NAMES = {'server.py', 'requirements.txt', '.env', '.env.example', '后端启动说明.md'}

app = FastAPI(title='AI 校园记账管家 后端')


def _env(name, default=''):
    v = os.environ.get(name)
    return v.strip() if isinstance(v, str) else default


# =====================================================================
# 静态托管（同时托管前端页面，实现「一键启动」）
# =====================================================================

def _safe_path(rel):
    """把 url 相对路径解析成 BASE_DIR 内的绝对路径，越界则返回 None。"""
    if not rel or rel == '/':
        return INDEX_FILE
    # 去掉查询串/锚点
    rel = rel.split('?', 1)[0].split('#', 1)[0]
    rel = rel.lstrip('/')
    full = os.path.normpath(os.path.join(BASE_DIR, rel))
    if not full.startswith(BASE_DIR):
        return None
    base = os.path.basename(full)
    if base in DENY_NAMES:
        return None
    _, ext = os.path.splitext(full)
    if ext.lower() not in ALLOWED_EXT:
        return None
    return full


@app.get('/')
def index():
    if not os.path.exists(INDEX_FILE):
        return HTMLResponse('<h1>缺少 index.html</h1>', status_code=500)
    return FileResponse(INDEX_FILE)


@app.get('/{path:path}')
def static_file(path: str):
    full = _safe_path('/' + path)
    if not full or not os.path.isfile(full):
        return JSONResponse({'error': 'not found'}, status_code=404)
    return FileResponse(full)


# =====================================================================
# 健康检查
# =====================================================================

@app.post('/api/health')
def health():
    return {'status': 'ok', 'ts': int(datetime.datetime.now().timestamp())}


# =====================================================================
# /api/chat —— 对话（调用 OpenAI 兼容的大模型接口）
# =====================================================================

SYSTEM_PROMPT = (
    '你是「账小助」，一个面向大学生的校园记账 AI 助手。'
    '帮用户一句话记账、查余额、看消费分析、定攒钱目标。'
    '语气简洁、口语化、带一点鼓励，用简体中文回复。\n'
    '你需要把用户的意图整理成结构化 JSON，只输出 JSON，不要任何多余文字。\n'
    'JSON 格式：\n'
    '{\n'
    '  "reply": "<给用户的口语化中文回复，1-3 句>",\n'
    '  "actions": []\n'
    '}\n'
    'actions 数组里每个元素可以是：\n'
    '  记账：{"type":"add_bill","amount":<数字>,"category":<"餐饮"|"交通"|"购物"|"娱乐"|"学习"|"居住"|"医疗"|"社交"|"其他">,"note":<字符串>,"date":<"YYYY-MM-DD"或null>,"motivation":<"刚需"|"情绪">,"want":<true|false>}\n'
    '  命令：{"type":"command","name":<"balance"|"pie"|"income"|"ocr"|"analysis"|"goals"|"settings">}\n'
    '规则：\n'
    '- 用户给出消费/收入信息且能提取金额时，在 actions 里返回 add_bill。金额用正数，收入请额外用 note 注明「收入」。\n'
    '- 用户想看余额/饼图/记收入/截屏记账/账单分析/攒钱目标/设置预算时，在 actions 里返回对应 command。\n'
    '- 普通寒暄只返回 reply，actions 为空数组。\n'
    '- category 只能从给定枚举中取值，无法归类用「其他」。\n'
    '- date 不写时返回 null，由前端按今天处理。'
)


def _call_llm(message, context):
    base_url = _env('LLM_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
    api_key = _env('LLM_API_KEY', '')
    model = _env('LLM_MODEL', 'gpt-4o-mini')
    timeout = int(_env('LLM_TIMEOUT', '30') or 30)

    if not api_key:
        return None, 'LLM 未配置'

    user_content = message
    if context:
        user_content = (
            '【上下文（仅参考，不要原样复述）】\n'
            + json.dumps(context, ensure_ascii=False)
            + '\n\n【用户这句话】\n' + message
        )

    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': user_content},
        ],
        'temperature': 0.7,
        'response_format': {'type': 'json_object'},
    }
    headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + api_key,
    }

    url = base_url + '/chat/completions'
    last_err = None
    # 部分端点不支持 response_format，失败一次则去掉它重试
    for attempt in (payload, {k: v for k, v in payload.items() if k != 'response_format'}):
        try:
            resp = requests.post(url, headers=headers, json=attempt, timeout=timeout)
            if resp.status_code == 200:
                data = resp.json()
                content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
                return content, None
            last_err = '上游返回 HTTP %s: %s' % (resp.status_code, resp.text[:300])
            if resp.status_code == 400 and attempt is not payload:
                return None, last_err
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            if attempt is not payload:
                return None, last_err
    return None, last_err or '上游无响应'


def _parse_llm_json(raw):
    """从模型输出里防御式解析 JSON：去 ``` 围栏、找第一个 { 到最后一个 }。"""
    if not raw:
        return None
    text = raw.strip()
    if text.startswith('```'):
        # 去掉 ```json 或 ``` 围栏
        text = text.strip('`')
        if text.lower().startswith('json'):
            text = text[4:]
        text = text.strip()
    start = text.find('{')
    end = text.rfind('}')
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except Exception:
        return None


@app.post('/api/chat')
async def chat(req: Request):
    try:
        body = await req.json()
    except Exception:
        body = {}
    message = str(body.get('message', '') or '')
    context = body.get('context')

    if not message.strip():
        return JSONResponse({'reply': None, 'fallback': True, 'reason': '空消息'})

    raw, err = _call_llm(message, context)
    if err:
        # 未配置或上游失败 -> 让前端走本地兜底
        return JSONResponse({'reply': None, 'fallback': True, 'reason': err})

    parsed = _parse_llm_json(raw)
    if not parsed:
        return JSONResponse({'reply': None, 'fallback': True, 'reason': '模型返回无法解析为 JSON'})

    reply = parsed.get('reply')
    actions = parsed.get('actions')
    if not isinstance(actions, list):
        actions = []
    return JSONResponse({'reply': reply, 'actions': actions, 'fallback': False})


# =====================================================================
# /api/ocr —— 服务端调用腾讯云 GeneralBasicOCR
# =====================================================================

TC_HOST = 'ocr.tencentcloudapi.com'
TC_ENDPOINT = 'https://' + TC_HOST
TC_SERVICE = 'ocr'
TC_ACTION = 'GeneralBasicOCR'
TC_VERSION = '2018-11-19'

# OCR 方法优先级：auto(默认) 先腾讯云、失败再用视觉大模型；也可强制 tencent / vision
OCR_METHOD = _env('OCR_METHOD', 'auto').lower()


def _ocr_vision(image_data_url, prompt=None):
    """用已配置的视觉大模型（OpenAI 兼容接口）做截图文字识别，复用 LLM_API_KEY。
    这样只要聊天能用，截图识别就能用，无需再单独申请腾讯云账号。"""
    base_url = _env('LLM_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
    api_key = _env('LLM_API_KEY', '')
    model = _env('LLM_MODEL', 'gpt-4o-mini')
    if not api_key:
        return None, '视觉识别未配置（缺少 LLM_API_KEY）'
    if not image_data_url:
        return None, '缺少图片数据'
    system = (
        '你是账单/小票文字识别助手。请逐行转录图片中的全部文字，保持原有顺序，'
        '不要解释、不要编造。重点保留：商户名、金额（含货币符号）、日期、商品名。'
        '只输出转录的文字，行与行之间用换行分隔。'
    )
    user_text = prompt or '请转录这张截图里的全部文字。'
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': image_data_url}},
                {'type': 'text', 'text': user_text},
            ]},
        ],
        'max_tokens': 1024,
    }
    headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api_key}
    timeout = int(_env('LLM_TIMEOUT', '30') or 30)
    try:
        resp = requests.post(base_url + '/chat/completions', headers=headers, json=payload, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return None, '视觉识别请求失败：' + str(e)
    if resp.status_code != 200:
        return None, '视觉识别上游返回 HTTP %s: %s' % (resp.status_code, resp.text[:300])
    data = resp.json()
    content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    if not content or not content.strip():
        return None, '视觉识别没有返回文字'
    return content.strip(), None


def _tc3_sign(secret_id, secret_key, region, payload):
    """复刻 ocr.js 的 TC3-HMAC-SHA256 签名，返回请求头字典。"""
    now = datetime.datetime.utcnow()
    timestamp = int((now - datetime.datetime(1970, 1, 1)).total_seconds())
    date = now.strftime('%Y-%m-%d')
    action_lower = TC_ACTION.lower()
    content_type = 'application/json; charset=utf-8'
    signed_headers = 'content-type;host;x-tc-action'
    canonical_headers = (
        'content-type:' + content_type + '\n'
        + 'host:' + TC_HOST + '\n'
        + 'x-tc-action:' + action_lower + '\n'
    )
    canonical_request = 'POST\n/\n\n' + canonical_headers + '\n' + signed_headers + '\n'

    def sha256_hex(s):
        if isinstance(s, str):
            s = s.encode('utf-8')
        return hashlib.sha256(s).hexdigest()

    hashed_payload = sha256_hex(payload)
    full_canonical = canonical_request + hashed_payload
    hashed_canonical = sha256_hex(full_canonical)

    credential_scope = date + '/' + TC_SERVICE + '/tc3_request'
    string_to_sign = (
        'TC3-HMAC-SHA256\n' + str(timestamp) + '\n'
        + credential_scope + '\n' + hashed_canonical
    )

    def hmac_sha256(key, msg):
        if isinstance(key, str):
            key = key.encode('utf-8')
        if isinstance(msg, str):
            msg = msg.encode('utf-8')
        return hmac.new(key, msg, hashlib.sha256).digest()

    secret_date = hmac_sha256('TC3' + secret_key, date)
    secret_service = hmac_sha256(secret_date, TC_SERVICE)
    secret_signing = hmac_sha256(secret_service, 'tc3_request')
    signature = hmac_sha256(secret_signing, string_to_sign).hex()

    authorization = (
        'TC3-HMAC-SHA256 Credential=' + secret_id + '/' + credential_scope
        + ', SignedHeaders=' + signed_headers + ', Signature=' + signature
    )

    return {
        'Content-Type': content_type,
        'Host': TC_HOST,
        'X-TC-Action': TC_ACTION,
        'X-TC-Version': TC_VERSION,
        'X-TC-Timestamp': str(timestamp),
        'X-TC-Region': region,
        'Authorization': authorization,
    }


@app.post('/api/capabilities')
def capabilities():
    """告诉前端后端当前可用的能力，便于弹窗准确显示状态。"""
    tencent = bool(_env('TENCENT_SECRET_ID') and _env('TENCENT_SECRET_KEY'))
    llm = bool(_env('LLM_API_KEY'))
    if tencent:
        ocr_method = 'tencent'
    elif llm:
        ocr_method = 'vision'
    else:
        ocr_method = 'none'
    return {'chat': llm, 'ocr': ocr_method}


@app.post('/api/ocr')
async def ocr(req: Request):
    secret_id = _env('TENCENT_SECRET_ID', '')
    secret_key = _env('TENCENT_SECRET_KEY', '')
    region = _env('TENCENT_REGION', 'ap-guangzhou')

    try:
        body = await req.json()
    except Exception:
        body = {}
    # 优先用完整 data URL（含 mime 类型，视觉模型需要）；也兼容只传 base64 的情况
    image_data_url = str(body.get('image_data_url', '') or '')
    image_b64 = str(body.get('image_base64', '') or '')
    if not image_data_url and image_b64:
        image_data_url = 'data:image/png;base64,' + image_b64
    if not image_data_url:
        return JSONResponse({'error': '缺少图片数据'})

    use_tencent = bool(secret_id and secret_key)
    use_vision = bool(_env('LLM_API_KEY', ''))
    if OCR_METHOD == 'tencent':
        use_vision = False
    elif OCR_METHOD == 'vision':
        use_tencent = False

    # 路径一：腾讯云 GeneralBasicOCR（便宜、结构化好，需单独密钥）
    if use_tencent:
        base64_part = image_data_url.split('base64,')[1] if 'base64,' in image_data_url else image_b64
        payload = json.dumps({'ImageBase64': base64_part}, ensure_ascii=False)
        headers = _tc3_sign(secret_id, secret_key, region, payload)
        try:
            resp = requests.post(TC_ENDPOINT, headers=headers, data=payload.encode('utf-8'), timeout=20)
            data = resp.json()
        except Exception as e:  # noqa: BLE001
            return JSONResponse({'error': '请求腾讯云失败：' + str(e)})
        r = data.get('Response') if isinstance(data, dict) else None
        if not r:
            return JSONResponse({'error': '云端返回为空'})
        if r.get('Error'):
            err = r['Error']
            return JSONResponse({'error': '云端识别失败：' + str(err.get('Message', err.get('Code', '未知错误')))})
        detections = r.get('TextDetections', []) or []
        texts = [str(d['DetectedText']) for d in detections if d and d.get('DetectedText')]
        if not texts:
            return JSONResponse({'error': '云端没有识别到文字'})
        return JSONResponse({'text': '\n'.join(texts)})

    # 路径二：视觉大模型识别（复用 LLM_API_KEY，gpt-4o-mini 等支持图片的模型）
    if use_vision:
        text, err = _ocr_vision(image_data_url)
        if err:
            return JSONResponse({'error': err})
        return JSONResponse({'text': text})

    return JSONResponse({'error': 'OCR 未配置（在 .env 配置 TENCENT_SECRET_ID/KEY 或 LLM_API_KEY）'})


# =====================================================================
# 一键启动
# =====================================================================

if __name__ == '__main__':
    port = int(_env('PORT', '8000') or 8000)
    # 静态托管已用路由实现，无需额外挂载
    print('AI 校园记账管家 后端已启动： http://127.0.0.1:%d' % port)
    print('（未配置 LLM_API_KEY / TENCENT_SECRET 时，前端会自动回退到本地逻辑）')
    uvicorn.run(app, host='0.0.0.0', port=port, log_level='info')
