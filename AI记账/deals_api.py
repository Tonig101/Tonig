#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deals_api.py — 省钱雷达 HTTP 服务（给大模型当"工具/连接器"用）

一句话：把「今天有什么优惠 / 疯狂星期几 / 三家谁便宜」变成大模型可以调用的真实 API。

启动：
    python deals_api.py                 # 默认 http://127.0.0.1:8010
    python deals_api.py --port 8010

接口：
    GET  /api/deals/merchants          商家活动规则清单（每周四 / 每月8号…）
    GET  /api/deals/promos             大促节点（双11 / 618…）+ 倒计时
    GET  /api/deals/today?date=        指定日期的活动（默认今天）
    GET  /api/deals/calendar?days=14   未来 N 天逐日日历
    GET  /api/deals/calendar.csv       下载真实商家日历 CSV（日期由代码算）
    POST /api/deals/compare            比价：到手价 / 单价 / 可比性判定 / 排名
    GET  /api/deals/quote?item=&price=&budget=   这个价划不划算（价格带 + 预算 + 时机）
    POST /api/deals/ask                大模型工具调用（tool-calling）：模型自己决定查日历还是算比价

关于"实时价"的诚实说明：
    本服务**不抓电商页面、不编价格**。价格只有两个来源——
      ① 用户/前端传进来的报价（offers）；
      ② 你自己配置的官方接口（PRICE_API_URL + PRICE_API_KEY + 字段映射），
         配了就把真实报价喂给同一个比价引擎，没配就明确告诉用户"缺报价"。
    这样演示时是真实数据，不会因为"随口编一个 89 元"被评委当场问住。

环境变量：
    LLM_BASE_URL / LLM_API_KEY / LLM_MODEL      （/api/deals/ask 用，OpenAI 兼容）
    PRICE_API_URL / PRICE_API_KEY / PRICE_FIELD_MAP （可选：接你自己的价格接口）
    DEALS_API_PORT                               （默认 8010）
"""

import argparse
import json
import os
import re
import sys

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:  # noqa: BLE001
    pass

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

import deals_engine as E

try:
    import requests
except Exception:  # noqa: BLE001
    requests = None

app = FastAPI(title='省钱雷达 API', version='1.0.0',
              description='商家活动日历 + 比价口径引擎（不联网抓价、不编造价格）')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


def _env(name, default=''):
    v = os.environ.get(name)
    return v.strip() if isinstance(v, str) else default


# =====================================================================
# 基础接口
# =====================================================================

@app.get('/')
def root():
    return {
        'name': '省钱雷达 API',
        'version': '1.0.0',
        'note': '活动日期本地按周/按月算；价格只做口径计算，不抓电商页面、不编价。',
        'endpoints': ['/api/deals/merchants', '/api/deals/promos', '/api/deals/today',
                      '/api/deals/calendar', '/api/deals/calendar.csv',
                      '/api/deals/compare', '/api/deals/quote', '/api/deals/ask'],
    }


@app.get('/api/health')
def health():
    return {'status': 'ok', 'llm': bool(_env('LLM_API_KEY')),
            'price_api': bool(_env('PRICE_API_URL'))}


@app.get('/api/deals/merchants')
def merchants():
    out = []
    for m in E.MERCHANTS:
        item = {k: v for k, v in m.items() if k != 'rule'}
        r = m['rule']
        if r['type'] == 'weekly':
            item['when'] = '每周' + E.WEEK_CN[r['weekday']]
            item['weekday'] = r['weekday'] + 1
        elif r['type'] == 'monthly':
            item['when'] = '每月 %d 号' % r['day']
            item['day'] = r['day']
        else:
            item['when'] = '常驻（每天有效）'
        item['next'] = E.next_of(m['id']).isoformat()
        out.append(item)
    return {'count': len(out), 'merchants': out}


@app.get('/api/deals/promos')
def promos():
    np_ = E.next_promo()
    return {
        'promos': [dict(p) for p in E.PROMOS],
        'next': None if not np_ else {
            'name': np_['promo']['name'], 'date': np_['date'].isoformat(),
            'days': np_['days'], 'warming': np_['warming'], 'depth': np_['promo']['depth'],
        },
    }


@app.get('/api/deals/today')
def today(date: str = Query(None, description='YYYY-MM-DD，默认今天')):
    try:
        d = E.to_date(date)
    except Exception:  # noqa: BLE001
        d = E.to_date()
    np_ = E.next_promo(d)
    kfc = E.next_of('kfc', d)
    return {
        'date': d.isoformat(),
        'weekday': E.weekday_cn(d),
        'deals': E.deals_on(d),
        'always': [x for x in E.deals_on(d) if x['type'] == 'always'],
        'next_promo': None if not np_ else {
            'name': np_['promo']['name'], 'date': np_['date'].isoformat(),
            'days': np_['days'], 'warming': np_['warming'],
            'depth': np_['promo']['depth'], 'best_for': np_['promo']['best_for'],
        },
        'kfc_next': {'date': kfc.isoformat(), 'weekday': E.weekday_cn(kfc),
                     'days': (kfc - d).days},
        'source': '日期由本地日历按周/按月计算；具体单品与价格以官方页面为准。',
    }


@app.get('/api/deals/calendar')
def calendar(days: int = Query(14, ge=1, le=90), frm: str = Query(None, alias='from')):
    try:
        d = E.to_date(frm)
    except Exception:  # noqa: BLE001
        d = E.to_date()
    return {'from': d.isoformat(), 'days': days, 'calendar': E.upcoming(days, d)}


@app.get('/api/deals/calendar.csv')
def calendar_csv(days: int = Query(56, ge=1, le=180), frm: str = Query(None, alias='from')):
    try:
        d = E.to_date(frm)
    except Exception:  # noqa: BLE001
        d = E.to_date()
    rows = E.calendar_rows(days, d)
    text = '\r\n'.join(','.join('"%s"' % str(c).replace('"', '""') if (',' in str(c) or '"' in str(c)) else str(c)
                                for c in row) for row in rows)
    return PlainTextResponse('\ufeff' + text, media_type='text/csv; charset=utf-8',
                             headers={'Content-Disposition':
                                      'attachment; filename="merchant-calendar.csv"'})


# =====================================================================
# 比价
# =====================================================================

@app.post('/api/deals/compare')
async def compare(req: Request):
    try:
        body = await req.json()
    except Exception:  # noqa: BLE001
        body = {}
    if isinstance(body, list):
        body = {'offers': body}
    if not isinstance(body, dict):
        return JSONResponse({'error': '请求体应为对象：{"item":"..","budget":100,"offers":[...]}'}, 400)
    offers = body.get('offers') or body.get('报价') or []
    if not isinstance(offers, list) or not offers:
        return JSONResponse({'error': '至少给一条报价：{"platform":"淘宝","price":89,"spec":"10000mAh"}'}, 400)
    return E.compare_offers(offers, body.get('item') or '未命名商品',
                            body.get('budget'), body.get('today'))


def _fetch_live_offers(item):
    """可选：接你自己的官方价格接口。没配置就返回 (None, 原因)。

    配置方式（.env）：
        PRICE_API_URL=https://api.example.com/search?q={item}
        PRICE_API_KEY=xxxx
        PRICE_FIELD_MAP={"list":"data.items","platform":"mall","title":"name",
                         "price":"price","spec":"spec","ship":"freight","coupon":"coupon"}
    支持 {item} / {q} 占位符；字段用点号取嵌套。
    """
    url_tpl = _env('PRICE_API_URL')
    if not url_tpl:
        return None, '未配置 PRICE_API_URL（不会去抓电商页面）'
    if not requests:
        return None, '缺少 requests 依赖'
    import urllib.parse
    url = url_tpl.replace('{item}', urllib.parse.quote(str(item))).replace('{q}', urllib.parse.quote(str(item)))
    headers = {'User-Agent': 'deals-radar/1.0'}
    token = _env('PRICE_API_KEY')
    if token:
        headers['Authorization'] = 'Bearer ' + token
    try:
        resp = requests.get(url, headers=headers, timeout=8)
        data = resp.json()
    except Exception as e:  # noqa: BLE001
        return None, '价格接口请求失败：%s' % str(e)[:100]

    try:
        mapping = json.loads(_env('PRICE_FIELD_MAP') or '{}')
    except Exception:  # noqa: BLE001
        mapping = {}

    def pick(obj, path, default=None):
        cur = obj
        for part in str(path).split('.'):
            if isinstance(cur, dict):
                cur = cur.get(part)
            else:
                return default
        return default if cur is None else cur

    lst = pick(data, mapping.get('list', 'data'), None)
    if not isinstance(lst, list):
        return None, '价格接口返回结构不是列表（用 PRICE_FIELD_MAP.list 指定路径）'
    offers = []
    for row in lst[:10]:
        if not isinstance(row, dict):
            continue
        offers.append({
            'platform': pick(row, mapping.get('platform', 'platform'), '未知平台'),
            'title': pick(row, mapping.get('title', 'title'), ''),
            'price': pick(row, mapping.get('price', 'price'), None),
            'spec': pick(row, mapping.get('spec', 'spec'), ''),
            'ship': pick(row, mapping.get('ship', 'ship'), 0),
            'coupon': pick(row, mapping.get('coupon', 'coupon'), 0),
        })
    if not offers:
        return None, '价格接口没有返回可用报价'
    return offers, None


@app.get('/api/deals/quote')
def quote(item: str = Query(..., description='商品名，如 充电宝'),
          price: float = Query(None, description='你看到的价格；不填则只给价格带'),
          budget: float = Query(None, description='预算'),
          date: str = Query(None)):
    try:
        d = E.to_date(date)
    except Exception:  # noqa: BLE001
        d = E.to_date()
    band = E.find_band(item)
    judged = E.judge_price(item, price) if price else None
    live, err = _fetch_live_offers(item)
    result = {
        'item': item,
        'date': d.isoformat(),
        'band': None if not band else {
            'name': band['name'], 'low': band['low'], 'mid': band['mid'],
            'high': band['high'], 'channel': band['channel'],
            'note': '经验价格带，只用于判断"这个价大概在什么档"，不是报价',
        },
        'judge': judged,
        'timing': E.timing_advice(price or 0, d),
        'price_source': None,
        'need': None,
        'compare': None,
    }
    if live:
        result['price_source'] = 'PRICE_API_URL（你配置的官方接口）'
        result['compare'] = E.compare_offers(live, item, budget, d)
    elif price:
        result['price_source'] = '用户提供（price 参数）'
        result['need'] = '这只是单平台单条报价，给不了"谁更便宜"——再给 1-2 个平台同规格的价，或直接 POST /api/deals/compare。'
        result['compare'] = E.compare_offers(
            [{'platform': '你提供的报价', 'price': price}], item, budget, d)
    else:
        result['price_source'] = '无'
        result['need'] = ('没有实时报价可拿（%s）。把三个平台的价发我，我立刻算到手价与单价排名。' % (err or '未提供'))
    return result


# =====================================================================
# /api/deals/ask —— 大模型 tool-calling（模型自己决定查日历还是算比价）
# =====================================================================

TOOLS = [
    {
        'type': 'function',
        'function': {
            'name': 'get_today_deals',
            'description': '查询某一天有哪些商家优惠活动（疯狂星期四、会员日、大促预热等）。日期由本地日历计算，真实有效。',
            'parameters': {
                'type': 'object',
                'properties': {
                    'date': {'type': 'string', 'description': 'YYYY-MM-DD，留空表示今天'},
                },
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'get_deal_calendar',
            'description': '查询未来 N 天的活动日历（哪天是周四/周三/会员日/大促）。',
            'parameters': {
                'type': 'object',
                'properties': {'days': {'type': 'integer', 'description': '1-60，默认 14'}},
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'compare_prices',
            'description': '比价：给定各平台报价（价格、规格、运费、券、需买几件），算到手价、折单价、排名，并判断规格是否可比。',
            'parameters': {
                'type': 'object',
                'properties': {
                    'item': {'type': 'string'},
                    'budget': {'type': 'number'},
                    'offers': {
                        'type': 'array',
                        'items': {
                            'type': 'object',
                            'properties': {
                                'platform': {'type': 'string'},
                                'title': {'type': 'string'},
                                'price': {'type': 'number'},
                                'spec': {'type': 'string', 'description': '规格原文，如 10000mAh / 12包 / 500ml'},
                                'ship': {'type': 'number'},
                                'coupon': {'type': 'number'},
                                'needQty': {'type': 'integer', 'description': '需买几件才给这个价'},
                            },
                            'required': ['platform', 'price'],
                        },
                    },
                },
                'required': ['item', 'offers'],
            },
        },
    },
]

SYSTEM = (
    '你是「省钱雷达」助手，面向大学生。规则（必须遵守）：\n'
    '1) 日期/星期/活动相关问题，先调用 get_today_deals 或 get_deal_calendar，按工具返回的真实日期回答，不要凭记忆。\n'
    '2) 价格：你**不能编造**任何商品价格。用户给了各平台报价就调 compare_prices 算；没给就说明"需要你抄一下价格"，'
    '并告诉他格式（平台 + 价格 + 规格）。\n'
    '3) 规格不可比（工具返回 comparable=false）时，明确说"暂时比不了/口径对不上"，不要硬给结论。\n'
    '4) 回答简洁口语化，一句话给结论，再给 2-3 条要点；结尾注明"具体以官方页面为准"。\n'
    '5) 不导流、不发店铺链接、不承诺全网最低价。'
)


def _tool_call(name, args):
    try:
        if name == 'get_today_deals':
            d = E.to_date(args.get('date'))
            np_ = E.next_promo(d)
            return {'date': d.isoformat(), 'weekday': E.weekday_cn(d),
                    'deals': E.deals_on(d),
                    'next_promo': None if not np_ else {
                        'name': np_['promo']['name'], 'days': np_['days']}}
        if name == 'get_deal_calendar':
            days = int(args.get('days') or 14)
            return {'days': days, 'calendar': E.upcoming(min(days, 60))}
        if name == 'compare_prices':
            return E.compare_offers(args.get('offers') or [], args.get('item') or '未命名商品',
                                    args.get('budget'))
    except Exception as e:  # noqa: BLE001
        return {'error': str(e)[:120]}
    return {'error': '未知工具：%s' % name}


def _llm_call(messages, tools=None):
    base = _env('LLM_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
    key = _env('LLM_API_KEY')
    model = _env('LLM_MODEL', 'gpt-4o-mini')
    if not key or not requests:
        return None, 'LLM 未配置（LLM_API_KEY）'
    payload = {'model': model, 'messages': messages, 'temperature': 0.3}
    if tools:
        payload['tools'] = tools
        payload['tool_choice'] = 'auto'
    try:
        r = requests.post(base + '/chat/completions', timeout=int(_env('LLM_TIMEOUT', '30') or 30),
                          headers={'Content-Type': 'application/json',
                                   'Authorization': 'Bearer ' + key},
                          json=payload)
        if r.status_code != 200:
            return None, '上游 HTTP %s: %s' % (r.status_code, r.text[:200])
        return r.json()['choices'][0]['message'], None
    except Exception as e:  # noqa: BLE001
        return None, '调用失败：%s' % str(e)[:120]


def _rule_based_answer(message, date=None):
    """没有大模型时的确定性回答：只用本地日历，绝不编价格。"""
    d = E.to_date(date)
    text = str(message or '')
    if re.search(r'星期|会员日|优惠|活动|打折|今天吃|吃啥|吃什么|特价', text):
        items = [x for x in E.deals_on(d) if x['type'] != 'always']
        np_ = E.next_promo(d)
        lines = ['%s %s 的活动：' % (d.isoformat(), E.weekday_cn(d))]
        if items:
            lines += ['· %s %s（%s）' % (x['name'], x['title'], x['tag']) for x in items]
        else:
            kfc = E.next_of('kfc', d)
            lines.append('· 今天没有固定的限时活动；下一次疯狂星期四 %s（%s），还有 %d 天'
                         % (kfc.isoformat(), E.weekday_cn(kfc), (kfc - d).days))
        if np_:
            lines.append('· 最近大促：%s，还有 %d 天（%s）' % (np_['promo']['name'], np_['days'], np_['promo']['depth']))
        lines.append('具体单品与价格以官方页面为准；要算"哪家便宜"，把各平台价格发我。')
        return '\n'.join(lines)
    if re.search(r'比价|便宜|划算|多少钱|价格', text):
        band = E.find_band(text)
        if band:
            return ('「%s」主流价格带：入门 %d-%d / 中档 %d-%d / 高档 %d-%d 元，通常 %s 更便宜。\n'
                    '要我算准，把平台 + 价格 + 规格发我（例：淘宝 89 包邮 10000mAh / 拼多多 79 / 京东 99 需买 2 件）。'
                    % (band['name'], band['low'][0], band['low'][1], band['mid'][0], band['mid'][1],
                       band['high'][0], band['high'][1], band['channel']))
        return ('把各平台报价按「平台 + 价格 + 规格」发我，我算到手价、折单价、排最便宜的；'
                '规格对不上我会直接说"没法比"，不硬凑结论。')
    return ('我是省钱雷达：可以查今天/未来几天的商家活动（疯狂星期四、会员日、大促），'
            '也可以帮你把几个平台的报价算成到手价和单价。你想查哪个？')


@app.post('/api/deals/ask')
async def ask(req: Request):
    try:
        body = await req.json()
    except Exception:  # noqa: BLE001
        body = {}
    message = str(body.get('message') or '').strip()
    if not message:
        return JSONResponse({'error': 'message 不能为空'}, 400)
    if not _env('LLM_API_KEY'):
        return {'reply': _rule_based_answer(message, body.get('date')),
                'mode': 'rule_based', 'note': '未配置 LLM_API_KEY，使用本地确定性回答（不编价格）'}

    messages = [{'role': 'system', 'content': SYSTEM},
                {'role': 'user', 'content': message}]
    trace = []
    for _ in range(4):
        msg, err = _llm_call(messages, TOOLS)
        if err:
            return {'reply': _rule_based_answer(message, body.get('date')),
                    'mode': 'rule_based', 'note': err, 'trace': trace}
        calls = msg.get('tool_calls') or []
        if not calls:
            return {'reply': msg.get('content') or '', 'mode': 'llm', 'trace': trace}
        messages.append({'role': 'assistant', 'content': msg.get('content'), 'tool_calls': calls})
        for c in calls:
            fn = c.get('function', {})
            name = fn.get('name')
            try:
                args = json.loads(fn.get('arguments') or '{}')
            except Exception:  # noqa: BLE001
                args = {}
            result = _tool_call(name, args)
            trace.append({'tool': name, 'args': args})
            messages.append({'role': 'tool', 'tool_call_id': c.get('id'),
                             'content': json.dumps(result, ensure_ascii=False)})
    return {'reply': '工具调用轮次超限，请简化问题再试。', 'mode': 'llm', 'trace': trace}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='省钱雷达 API 服务')
    ap.add_argument('--port', type=int, default=int(_env('DEALS_API_PORT', '8010') or 8010))
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    import uvicorn
    print('省钱雷达 API： http://%s:%d  （文档 /docs）' % (args.host, args.port))
    print('提示：不配 LLM_API_KEY 也能用，/api/deals/ask 会走本地确定性回答；'
          '不配 PRICE_API_URL 就不抓价，只做比价计算。')
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')
