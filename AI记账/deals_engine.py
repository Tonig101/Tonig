#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deals_engine.py — 省钱雷达后端引擎（纯标准库，零依赖，可单独跑）

和前端 deals.js 同一套口径，做三件事：

  1) 真实日期日历：肯德基疯狂星期四 = 每周四、京东 PLUS 会员日 = 每月 8 号……
     用 datetime.weekday() 直接算，指定任意日期都能算出下一次是哪天，不会过期。
  2) 大促节点：双11 / 618 / 38节 / 双12 / 年货节 / 开学季，固定月日按年滚动。
  3) 比价口径：到手价（标价×件数+运费-券）、按规格折单价、可比性判定（NOT_COMPARABLE）、
     排名、"需买N件"门槛识别。

刻意不做的事：不抓电商实时价、不编价格。实时价只能来自用户抄来的报价或你自配的
官方接口（见 deals_api.py 的 PRICE_PROVIDER），引擎本身只做计算。

用法：
    python deals_engine.py --today 2026-10-24                 # 打印今天的活动
    python deals_engine.py --weeks 8 --csv 真实商家日历.csv    # 生成真实日历 CSV
    python deals_engine.py --demo                              # 跑一组比价自测
    python deals_engine.py --json '{"item":"充电宝","offers":[...]}'
"""

import argparse
import csv
import datetime
import json
import re
import sys

WEEK_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

# =====================================================================
# 一、规律型商家活动（日期按周/按月算，永不过期）
# =====================================================================

MERCHANTS = [
    {
        'id': 'kfc', 'name': '肯德基', 'emoji': '🍗', 'cat': '快餐',
        'place': '校门口商业街',
        'title': '疯狂星期四', 'rule': {'type': 'weekly', 'weekday': 3},  # 0=周一 … 6=周日
        'what': '每周四的限定特价套餐日',
        'how': '校门口商业街店，走过去就行；App 里先领券再下单',
        'tip': '比点外卖便宜至少 15 元（省了配送费），建议步行前往；热门单品中午就卖完了',
        'coach': '疯狂星期四确实比外卖便宜 15 元以上，但每月控制在 1-2 次，别每周都去。',
        'certainty': 'stable', 'source': '肯德基 App / 门店活动',
    },
    {
        'id': 'mcd', 'name': '麦当劳', 'emoji': '🍟', 'cat': '快餐',
        'place': '阳光广场',
        'title': '13.9 元随心配（周一）', 'rule': {'type': 'weekly', 'weekday': 0},
        'what': '每周一的 13.9 元套餐组合',
        'how': '阳光广场店，周一点「1+1 随心配 / 13.9 元专区」，比单点省 10 元左右',
        'tip': '适合月初手头紧的时候去吃；先看组合内容，别为了凑套餐加购不需要的东西',
        'coach': '月初预算紧张时的兜底方案；比单点省 10 元左右，但注意套餐里有没有本来不打算买的东西。',
        'certainty': 'varies', 'source': '麦当劳 App / 阳光广场门店',
    },
    {
        'id': 'luckin', 'name': '瑞幸 / 库迪', 'emoji': '☕', 'cat': '饮品',
        'place': '阳光广场',
        'title': '9.9 元两杯 / 8.8 元券（周二）', 'rule': {'type': 'weekly', 'weekday': 1},
        'what': '周二 9.9 元两杯活动，另有不定期 8.8 元券',
        'how': '和舍友拼单，人均不到 5 元；走过去也就几分钟',
        'tip': '每周最多 2 杯；用瑞幸 / 库迪代替喜茶、奈雪，单杯省 15-20 元',
        'coach': '和舍友拼单，人均不到 5 元，是奶茶的最优解；但每周控制在 2 杯以内。',
        'certainty': 'varies', 'source': '瑞幸 / 库迪 App 活动页',
    },
    {
        'id': 'zym', 'name': '赵一鸣零食', 'emoji': '🍬', 'cat': '零食',
        'place': '阳光广场',
        'title': '会员日折扣 / 满减', 'rule': {'type': 'always'},
        'what': '不定期会员日折扣与满减',
        'how': '囤零食去赵一鸣比校内便利店便宜；只买清单上的东西',
        'tip': '别囤太多——零食是隐形支出，逛着逛着拿一堆最容易超支',
        'coach': '比校内便利店便宜，但零食是隐形支出：只买清单上的，别逛着逛着拿一堆。',
        'certainty': 'varies', 'source': '赵一鸣门店会员日公告',
    },
    {
        'id': 'zunte', 'name': '尊特优选', 'emoji': '🏬', 'cat': '超市',
        'place': '第二饭堂三楼',
        'title': '校内最大超市', 'rule': {'type': 'always'},
        'what': '校内最大的超市，东西最全',
        'how': '急用才去，不急的等网购（拼多多百亿补贴）',
        'tip': '价格不一定最优，图的是方便；同样的东西润泰超市通常更便宜',
        'coach': '着急用才去，价格不一定最优；不急的下单网购，价格通常更便宜。',
        'certainty': 'stable', 'source': '校内实地',
    },
    {
        'id': 'convenience', 'name': '校内便利店', 'emoji': '🏪', 'cat': '超市',
        'place': '各饭堂旁（一饭三、一饭四最方便）',
        'title': '应急零食 / 水 / 纸巾', 'rule': {'type': 'always'},
        'what': '饭堂旁的校内便利店',
        'how': '买水、买纸巾可以；别在这买整箱饮料',
        'tip': '溢价明显，比润泰超市贵；整箱饮料拼多多送到菜鸟驿站更便宜',
        'coach': '溢价最明显的点位，只适合应急；整箱饮料走网购，均价能省一半。',
        'certainty': 'stable', 'source': '校内实地',
    },
    {
        'id': 'runtop', 'name': '润泰超市', 'emoji': '🛒', 'cat': '超市',
        'place': '正门斜对面 150 米',
        'title': '日常生活用品', 'rule': {'type': 'always'},
        'what': '校外超市，日用品价格比校内便宜',
        'how': '买洗发水、纸巾这类日用品可以走到校门对面去买',
        'tip': '比校内尊特优选便宜；走过去也就几分钟，顺路蹲的话不亏',
        'coach': '买日用品可以走过去，比校内超市便宜；周末顺便去买，一趟搞定一个月用量。',
        'certainty': 'stable', 'source': '校内实地',
    },
    {
        'id': 'dormstore', 'name': '宿舍楼下小卖部', 'emoji': '🏠', 'cat': '超市',
        'place': '宿舍楼下',
        'title': '应急泡面 / 水', 'rule': {'type': 'always'},
        'what': '深夜应急的泡面和水',
        'how': '深夜饿了应急可以买一次',
        'tip': '长期在这买零食会悄悄掏空钱包，记账时往往连笔记都懒得记',
        'coach': '深夜应急可以，但长期在这买零食会悄悄掏空钱包——记得单独记一笔，月底复盘会吓你一跳。',
        'certainty': 'stable', 'source': '校内实地',
    },
]

PROMOS = [
    {'id': 'double11', 'name': '双11', 'month': 11, 'day': 11, 'warmup': 12,
     'depth': '全品类，全年深度最大', 'best_for': '大件、囤货、服饰'},
    {'id': 'double12', 'name': '双12', 'month': 12, 'day': 12, 'warmup': 5,
     'depth': '约 5%-15%，力度弱于双11', 'best_for': '补漏、小件'},
    {'id': 'newyear', 'name': '年货节', 'month': 1, 'day': 10, 'warmup': 10,
     'depth': '食品 / 礼盒约 10%-25%', 'best_for': '食品、年礼'},
    {'id': 'w38', 'name': '38节', 'month': 3, 'day': 8, 'warmup': 7,
     'depth': '美妆个护约 15%-30%', 'best_for': '美妆、个护'},
    {'id': 'p618', 'name': '618', 'month': 6, 'day': 18, 'warmup': 20,
     'depth': '数码家电约 15%-30%', 'best_for': '数码、家电、大件'},
    {'id': 'school', 'name': '开学季', 'month': 8, 'day': 25, 'warmup': 10,
     'depth': '文具 / 数码约 10%-20%', 'best_for': '学生用品、笔记本'},
]

BANDS = [
    {'keys': ['充电宝', '移动电源'], 'name': '充电宝（10000mAh）',
     'low': (40, 80), 'mid': (80, 150), 'high': (150, 300), 'channel': '拼多多百亿补贴 / 京东大促'},
    {'keys': ['蓝牙耳机', '无线耳机', '耳机'], 'name': '蓝牙耳机',
     'low': (50, 150), 'mid': (150, 500), 'high': (500, 1500), 'channel': '拼多多百亿补贴（标品）'},
    {'keys': ['保温杯', '水杯'], 'name': '保温杯（500ml）',
     'low': (30, 60), 'mid': (60, 150), 'high': (150, 400), 'channel': '拼多多百亿补贴 / 淘宝第三方'},
    {'keys': ['洗衣液'], 'name': '洗衣液（3L 装）',
     'low': (15, 25), 'mid': (25, 45), 'high': (45, 80), 'channel': '拼多多 / 抖音直播间'},
    {'keys': ['洗发水'], 'name': '洗发水（500ml）',
     'low': (20, 40), 'mid': (40, 80), 'high': (80, 200), 'channel': '拼多多百亿补贴'},
    {'keys': ['电动牙刷'], 'name': '电动牙刷',
     'low': (80, 150), 'mid': (150, 350), 'high': (350, 800), 'channel': '拼多多百亿补贴'},
    {'keys': ['空气炸锅'], 'name': '空气炸锅',
     'low': (150, 300), 'mid': (300, 600), 'high': (600, 1200), 'channel': '拼多多 / 京东大促'},
    {'keys': ['运动鞋', '跑鞋'], 'name': '运动鞋',
     'low': (100, 250), 'mid': (250, 600), 'high': (600, 1500), 'channel': '唯品会 / 淘宝第三方'},
    {'keys': ['笔记本', '电脑', '平板'], 'name': '笔记本（学生本）',
     'low': (2500, 3500), 'mid': (3500, 5500), 'high': (5500, 9000), 'channel': '京东教育优惠 / 618'},
]

# =====================================================================
# 二、日期工具
# =====================================================================


def to_date(d=None):
    if d is None:
        return datetime.date.today()
    if isinstance(d, datetime.datetime):
        return d.date()
    if isinstance(d, datetime.date):
        return d
    return datetime.date.fromisoformat(str(d)[:10])


def weekday_cn(d):
    return WEEK_CN[to_date(d).weekday()]


def match_rule(m, d):
    d = to_date(d)
    r = m['rule']
    if r['type'] == 'always':
        return True
    if r['type'] == 'weekly':
        return d.weekday() == r['weekday']
    if r['type'] == 'monthly':
        return d.day == r['day']
    return False


def next_of(merchant_id, frm=None):
    m = next((x for x in MERCHANTS if x['id'] == merchant_id), None)
    if not m:
        return None
    start = to_date(frm)
    if m['rule']['type'] == 'always':
        return start
    for i in range(400):
        d = start + datetime.timedelta(days=i)
        if match_rule(m, d):
            return d
    return None


def next_promo(frm=None):
    start = to_date(frm)
    best = None
    for y in (start.year, start.year + 1):
        for p in PROMOS:
            try:
                dt = datetime.date(y, p['month'], p['day'])
            except ValueError:
                continue
            days = (dt - start).days
            if days < 0:
                continue
            if best is None or days < best['days']:
                best = {'promo': p, 'date': dt, 'days': days, 'warming': days <= p['warmup']}
    return best


def deals_on(d=None):
    d = to_date(d)
    out = []
    for m in MERCHANTS:
        if not match_rule(m, d):
            continue
        always = m['rule']['type'] == 'always'
        if always:
            tag = '常驻'
        elif m['rule']['type'] == 'weekly':
            tag = '每周' + WEEK_CN[m['rule']['weekday']]
        else:
            tag = '每月 %d 号' % m['rule']['day']
        out.append({
            'type': 'always' if always else m['rule']['type'],
            'id': m['id'], 'name': m['name'], 'emoji': m['emoji'], 'cat': m['cat'],
            'place': m.get('place', ''), 'coach': m.get('coach', ''),
            'title': m['title'], 'what': m['what'], 'how': m['how'], 'tip': m['tip'],
            'certainty': m['certainty'], 'source': m['source'], 'tag': tag,
        })
    np_ = next_promo(d)
    if np_ and np_['days'] == 0:
        out.append({'type': 'promo', 'id': np_['promo']['id'], 'name': '电商大促', 'emoji': '🔥',
                    'cat': '电商', 'title': np_['promo']['name'] + ' 当天',
                    'what': np_['promo']['depth'], 'how': '当天为正式活动日，注意尾款与满减门槛',
                    'tip': '大促当天不是所有品类都最便宜，先看历史价', 'certainty': 'stable',
                    'source': '平台官方活动页', 'tag': '今天'})
    elif np_ and np_['days'] == np_['promo']['warmup']:
        out.append({'type': 'promo', 'id': np_['promo']['id'], 'name': '电商大促', 'emoji': '⏳',
                    'cat': '电商', 'title': np_['promo']['name'] + ' 预热开始（还有 %d 天）' % np_['days'],
                    'what': np_['promo']['depth'], 'how': '先加购物车、领券，正式开卖再付',
                    'tip': '预热期的预售价未必最低', 'certainty': 'stable',
                    'source': '平台官方活动页', 'tag': '预热'})
    return out


def upcoming(days=14, frm=None):
    start = to_date(frm)
    out = []
    for i in range(days):
        d = start + datetime.timedelta(days=i)
        items = [x for x in deals_on(d) if x['type'] != 'always']
        out.append({'date': d.isoformat(), 'weekday': weekday_cn(d), 'offset': i, 'items': items})
    return out


# =====================================================================
# 三、比价口径引擎
# =====================================================================

RE_MULTI = re.compile(r'(\d+)\s*[包瓶罐盒装袋提]?\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*(ml|毫升|l|L|升|g|克|kg|千克|公斤)')
RE_MULTI_REV = re.compile(r'(\d+(?:\.\d+)?)\s*(ml|毫升|l|L|升|g|克|kg|千克|公斤)\s*[xX×*]\s*(\d+)\s*[包瓶罐盒装袋]?')
RE_PREFIX = re.compile(r'(\d+(?:\.\d+)?)\s*[包瓶罐盒袋箱筒听提条支]\s*装\s*(\d+(?:\.\d+)?)\s*(ml|毫升|l|L|升|g|克|kg|千克|公斤)')
RE_COUNT_MULTI = re.compile(r'(\d+(?:\.\d+)?)\s*(抽|张|片|卷|包|袋|盒|瓶|罐|听|筒|条|个|只|支|枚|件)\s*[xX×*]?\s*(\d+(?:\.\d+)?)\s*(提|箱|组|套|袋|包|盒|件)')
RE_JIN_MULTI = re.compile(r'(\d+(?:\.\d+)?)\s*斤\s*[xX×*]\s*(\d+)')
RE_JIN = re.compile(r'(\d+(?:\.\d+)?)\s*斤')
RE_MAH = re.compile(r'(\d+(?:\.\d+)?)\s*(mah|毫安时|毫安)', re.I)
RE_VOL = re.compile(r'(\d+(?:\.\d+)?)\s*(ml|毫升|l|L|升|g|克|kg|千克|公斤)')
RE_COUNT = re.compile(r'(\d+(?:\.\d+)?)\s*(包|抽|张|提|片|枚|卷|条|双|只|个|支|盒|袋|瓶|罐|听|筒|箱|组|套|件)')
RE_NEED1 = re.compile(r'(?:需买|需购买|需要买|必须买|至少买|最少买|买够|买满|满|囤)\s*(\d+)\s*(?:件|个|盒|包|提|瓶|罐|袋|组|箱|套)')
RE_NEED2 = re.compile(r'(\d+)\s*(?:件|个|盒|包|提|瓶|罐|袋|组|箱|套)\s*(?:起|以上|起售|起购)')

CN_DIGIT = {'零': '0', '一': '1', '二': '2', '两': '2', '三': '3', '四': '4',
            '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10'}


def to_num(v, default=None):
    if v is None or v == '':
        return default
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    s = str(v).translate(str.maketrans('０１２３４５６７８９．', '0123456789.')).replace(',', '')
    m = re.search(r'-?\d+(?:\.\d+)?', s)
    if not m:
        return default
    try:
        return float(m.group(0))
    except ValueError:
        return default


def norm_spec_text(spec):
    s = re.sub(r'\s+', '', str(spec or ''))
    s = re.sub(r'包邮|包运费|免邮|包退|包换|包安装|包配送', '', s)
    s = re.sub(r'[零一二两三四五六七八九十](?=[包瓶罐盒袋箱筒听提条支个只张片抽卷])',
               lambda m: CN_DIGIT.get(m.group(0), m.group(0)), s)
    return s


def parse_spec(spec):
    """规格 -> (数量, 单位)；单位可能是 ml / g / mAh / 计数单位。"""
    s = norm_spec_text(spec)
    if not s:
        return None, None

    def vol(qty, unit):
        u = unit.lower()
        if u in ('l', '升'):
            return qty * 1000, 'ml'
        if u in ('kg', '千克', '公斤'):
            return qty * 1000, 'g'
        return qty, ('ml' if u in ('ml', '毫升') else 'g')

    m = RE_MULTI.search(s)
    if m:
        return vol(float(m.group(1)) * float(m.group(2)), m.group(3))
    m = RE_MULTI_REV.search(s)
    if m:
        return vol(float(m.group(1)) * float(m.group(3)), m.group(2))
    m = RE_PREFIX.search(s)
    if m:
        return vol(float(m.group(1)) * float(m.group(2)), m.group(3))
    m = RE_COUNT_MULTI.search(s)
    if m:
        return float(m.group(3)), m.group(4)
    m = RE_JIN_MULTI.search(s)
    if m:
        return float(m.group(1)) * 500 * float(m.group(2)), 'g'
    m = RE_JIN.search(s)
    if m:
        return float(m.group(1)) * 500, 'g'
    m = RE_MAH.search(s)
    if m:
        return float(m.group(1)), 'mAh'
    m = RE_VOL.search(s)
    if m:
        return vol(float(m.group(1)), m.group(2))
    m = RE_COUNT.search(s)
    if m:
        return float(m.group(1)), m.group(2)
    return None, None


def parse_need(text):
    s = str(text or '')
    m = RE_NEED1.search(s) or RE_NEED2.search(s)
    if not m:
        return 1
    try:
        n = int(float(m.group(1)))
        return n if n >= 1 else 1
    except ValueError:
        return 1


def per_price(r):
    if r['qty'] and r['qty'] > 0:
        return r['eff'] / (r['qty'] * r['needQty'])
    return None


def per_label(r):
    p = per_price(r)
    if p is None:
        return '—'
    if r['unit'] in ('ml', 'g'):
        return '%.2f 元/100%s' % (p * 100, r['unit'])
    if r['unit'] == 'mAh':
        return '%.2f 元/1000mAh' % (p * 1000)
    return '%.3f 元/%s' % (p, r['unit'])


def find_band(item):
    s = str(item or '').lower()
    for b in BANDS:
        for k in b['keys']:
            if k.lower() in s:
                return b
    return None


def judge_price(item, price):
    b = find_band(item)
    try:
        p = float(price)
    except (TypeError, ValueError):
        return None
    if not b or p <= 0:
        return None
    if p <= b['low'][1]:
        level, label = 'entry', '入门档'
    elif p <= b['mid'][1]:
        level, label = 'mid', '中档'
    elif p <= b['high'][1]:
        level, label = 'high', '高档'
    else:
        level, label = 'over', '偏贵'
    return {'band': b['name'], 'level': level, 'label': label,
            'range': b['low'] + b['mid'] + b['high'], 'channel': b['channel']}


def timing_advice(price, frm=None):
    np_ = next_promo(frm)
    if not np_:
        return {'text': '按需买就行，暂时算不出最近的大促节点。', 'days': None}
    days, name = np_['days'], np_['promo']['name']
    p = float(price or 0)
    if p >= 500:
        if days <= 30:
            text = '单价 %.0f 元属大件，距 %s 只剩 %d 天——不急就等，大促通常有直降或满减。' % (p, name, days)
        else:
            text = '单价 %.0f 元属大件，但距 %s 还有 %d 天，等下去时间成本过高——现在买，记得看有没有价保。' % (p, name, days)
    elif 0 < p < 100:
        text = '单价 %.0f 元属小件，跨平台价差通常只有几块——不用为省这点钱等 %d 天，现在比完价就买。' % (p, days)
    elif days <= 20:
        text = '距 %s 还有 %d 天——不急着用可以等；急用现在买。' % (name, days)
    else:
        text = '距最近的 %s 还有 %d 天，比较远——按需买就行。' % (name, days)
    return {'text': text, 'promo': name, 'days': days,
            'date': np_['date'].isoformat(), 'depth': np_['promo']['depth']}


def compare_offers(offers, item='未命名商品', budget=None, frm=None):
    """比价核心：到手价 -> 单价折算 -> 可比性判定 -> 排名 -> 结论。

    返回 {ok, mode, comparable, headline, rows, warnings, timing, budget, band}
    mode: single / total / unit / partial / total_nospec / mixed
    comparable=False（mixed）时禁止下"谁更便宜"的结论。
    """
    rows, skipped = [], []
    for i, o in enumerate((offers or [])[:20], 1):
        if not isinstance(o, dict):
            skipped.append('第 %d 条：不是对象，已跳过' % i)
            continue
        price = to_num(o.get('price'))
        if price is None or price <= 0:
            skipped.append('第 %d 条：没读到有效价格，已跳过' % i)
            continue
        ship = to_num(o.get('ship'), 0.0) or 0.0
        coupon = to_num(o.get('coupon'), 0.0) or 0.0
        need = to_num(o.get('needQty'), None)
        if need is None:
            need = parse_need('%s %s' % (o.get('title') or '', o.get('spec') or ''))
        need = max(1, int(round(need or 1)))
        qty, unit = parse_spec(o.get('spec'))
        if need == 1:
            need2 = parse_need(str(o.get('spec') or ''))
            if need2 > 1:
                need = need2
        eff = max(0.0, price * need + ship - coupon)
        rows.append({'platform': str(o.get('platform') or '未知平台'),
                     'title': str(o.get('title') or '').strip(),
                     'price': price, 'ship': ship, 'coupon': coupon,
                     'needQty': need, 'spec': str(o.get('spec') or ''),
                     'eff': eff, 'qty': qty, 'unit': unit})

    if not rows:
        return {'ok': False, 'mode': 'empty', 'comparable': False, 'item': item,
                'headline': '这几条里没读到有效价格——按「平台 + 价格 + 规格」给我，例如：淘宝 89 包邮 10000mAh。',
                'rows': [], 'warnings': skipped, 'timing': timing_advice(0, frm)}

    groups = {}
    for r in rows:
        if r['qty'] and r['unit']:
            groups.setdefault(r['unit'], []).append(r)
    main_unit, main_group = None, []
    for u, grp in groups.items():
        if len(grp) > len(main_group):
            main_unit, main_group = u, grp
    covered = bool(main_group) and len(main_group) == len(rows)
    same_qty = covered and len({round(r['qty'], 3) for r in main_group}) == 1
    same_need = covered and len({r['needQty'] for r in main_group}) == 1

    if len(rows) == 1:
        mode = 'single'
    elif len(main_group) >= 2 and covered and same_qty and same_need:
        mode = 'total'
    elif len(main_group) >= 2 and covered:
        mode = 'unit'
    elif len(main_group) >= 2:
        mode = 'partial'
    elif not groups:
        mode = 'total_nospec'
    else:
        mode = 'mixed'

    if mode in ('unit', 'partial'):
        rows.sort(key=lambda r: (per_price(r) is None, per_price(r) if per_price(r) is not None else r['eff']))
    else:
        rows.sort(key=lambda r: r['eff'])

    best, worst = rows[0], rows[-1]
    save = worst['eff'] - best['eff']
    multi = len(rows) >= 2 and save > 0.005

    def tag(r):
        return '[%s]%s' % (r['platform'], (' ' + r['title']) if r['title'] else '')

    sublines, warnings = [], []
    if mode == 'unit':
        cands = sorted(main_group, key=lambda r: per_price(r))
        headline = '按折合单价，%s 最划算：%s；最贵的是 [%s] %s。' % (
            tag(cands[0]), per_label(cands[0]), cands[-1]['platform'], per_label(cands[-1]))
        sublines.append('各家规格数量不一样，只比总价会看错——总价最低的那家单价未必最低。')
        best = cands[0]
    elif mode == 'partial':
        cands = sorted(main_group, key=lambda r: per_price(r))
        headline = '能对上的 %d 条（都是「%s」）里，%s 最划算：%s。' % (
            len(main_group), main_unit, tag(cands[0]), per_label(cands[0]))
        others = [r for r in rows if r not in main_group]
        sublines.append('另有 %d 条规格不同或没写（%s），没法放进来一起比——补上规格我再算。'
                        % (len(others), '、'.join('[%s]' % r['platform'] for r in others)))
        best = cands[0]
    elif mode == 'mixed':
        headline = '这几条规格口径对不上（有的是「包」、有的是「提/瓶/克」，或者根本没写规格），没法直接说谁更便宜。'
        sublines.append('把规格对齐再看：要么都比「每包多少钱」，要么都按同一件数比总价。')
    elif mode == 'total_nospec':
        headline = '%s 到手价最低 %.2f 元%s。' % (tag(best), best['eff'],
                                             ('，比最贵的 [%s] 省 %.2f 元' % (worst['platform'], save)) if multi else '')
        sublines.append('⚠ 没给规格（多少包 / 多少 ml），各家规格不一样时总价差没意义——补上规格我按单价重算。')
    elif multi:
        headline = '%s 到手价最低 %.2f 元，比最贵的 [%s] 省 %.2f 元。' % (tag(best), best['eff'], worst['platform'], save)
    elif len(rows) >= 2:
        headline = '各家到手价基本持平（差不到 5 分钱），按运费、售后、发货地选即可。'
    else:
        headline = '只收到 1 条报价（%s 到手 %.2f 元），暂时没法比出贵不贵——再给一个平台的价格就能比。' % (tag(best), best['eff'])

    if any(r['ship'] > 0 for r in rows) and any(r['ship'] == 0 for r in rows):
        sublines.append('有的包邮有的要运费——运费算进来才是到手价（上面已算）。')
    if len(rows) >= 2 and save <= 3:
        sublines.append('价差不到 3 块，优先选运费险 / 七天无理由 / 旗舰店，退货成本比差价重要。')
    if any(r['coupon'] > 0 for r in rows):
        sublines.append('券有门槛和有效期；跨店满减要凑单的话，别为凑单买用不上的东西。')
    if any(r['needQty'] > 1 for r in rows):
        sublines.append('有的平台要一次买够 N 件才给这个价（明细里标了「需买N件」）——囤不了那么多，单价可能不如看着便宜。')

    use_per = mode in ('unit', 'partial')
    pool = sorted([(per_price(r) if use_per else r['eff']) for r in (main_group if use_per else rows)
                   if (per_price(r) if use_per else r['eff']) is not None])
    med = 0.0
    if len(pool) >= 3:
        n = len(pool)
        med = pool[n // 2] if n % 2 else (pool[n // 2 - 1] + pool[n // 2]) / 2
    for r in rows:
        v = per_price(r) if use_per else r['eff']
        shown = per_label(r) if use_per else ('%.2f 元' % r['eff'])
        if med > 0 and v is not None and v < 0.5 * med:
            warnings.append('[%s] %s 明显低于同口径中位价——可能规格不同 / 临期 / 二手 / 仿品，下单前核对店铺资质与规格。'
                            % (r['platform'], shown))
        elif med > 0 and v is not None and v > 1.6 * med:
            warnings.append('[%s] %s 明显高于同口径中位价，没有品牌 / 售后优势可以放弃。' % (r['platform'], shown))
        if r['coupon'] > 0 and r['coupon'] >= r['price'] * r['needQty'] + r['ship']:
            warnings.append('[%s] 券额 ≥ 应付款，数据异常，请核对活动真实性。' % r['platform'])
    if mode == 'mixed':
        warnings.append('本次规格口径不一致，上面的排序只能参考，不能当作「谁更便宜」的依据。')

    budget_info = None
    b = to_num(budget)
    if b and b > 0:
        if best['eff'] <= b:
            budget_info = {'budget': b, 'diff': round(b - best['eff'], 2), 'ok': True,
                           'text': '最低到手 %.2f 元，比预算 %.2f 元还低 %.2f 元——预算内。'
                                   % (best['eff'], b, b - best['eff'])}
        else:
            budget_info = {'budget': b, 'diff': round(best['eff'] - b, 2), 'ok': False,
                           'text': '最低到手 %.2f 元，超预算 %.2f 元——要么降规格，要么等大促。'
                                   % (best['eff'], best['eff'] - b)}

    for r in rows:
        r['per'] = per_price(r)
        r['perLabel'] = per_label(r)
        r['eff'] = round(r['eff'], 2)

    return {
        'ok': True, 'item': item, 'mode': mode,
        'comparable': mode != 'mixed',
        'headline': headline, 'sublines': sublines, 'warnings': warnings,
        'skipped': skipped, 'rows': rows,
        'best': {'platform': best['platform'], 'title': best['title'],
                 'eff': round(best['eff'], 2), 'perLabel': per_label(best)},
        'save': round(save, 2), 'budget': budget_info,
        'timing': timing_advice(best['eff'], frm),
        'band': judge_price(item, best['eff']),
    }


# =====================================================================
# 四、真实商家日历 CSV（日期由代码算出，不是手抄）
# =====================================================================

CSV_HEADER = ['日期', '星期', '活动类型', '商家/平台', '地点', '活动名称', '怎么用', '教练建议', '核实渠道']


def calendar_rows(days=56, frm=None):
    start = to_date(frm)
    rows = [CSV_HEADER,
            ['（生成时间）', start.isoformat(), '代码计算', '—', '—',
             '未来 %d 天' % days, '常驻活动只在首日列一次', '—', '本地日历算法']]
    always = [x for x in deals_on(start) if x['type'] == 'always']
    for i in range(days):
        d = start + datetime.timedelta(days=i)
        for it in [x for x in deals_on(d) if x['type'] != 'always']:
            rows.append([d.isoformat(), weekday_cn(d),
                         {'promo': '大促', 'monthly': '每月固定'}.get(it['type'], '每周固定'),
                         it['name'], it.get('place', '—'), it['title'], it['how'],
                         it.get('coach', '—'), it['source']])
        if i == 0:
            for a in always:
                rows.append([d.isoformat(), weekday_cn(d), '常驻（每日）',
                             a['name'], a.get('place', '—'), a['title'], a['how'],
                             a.get('coach', '—'), a['source']])
    return rows


def write_calendar_csv(path, days=56, frm=None):
    rows = calendar_rows(days, frm)
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        csv.writer(f).writerows(rows)
    return len(rows) - len(CSV_HEADER)


# =====================================================================
# 五、CLI
# =====================================================================


def _print_today(d):
    print('=== %s %s ===' % (d.isoformat(), weekday_cn(d)))
    for it in deals_on(d):
        print('  [%s] %s · %s' % (it['tag'], it['name'], it['title']))
    np_ = next_promo(d)
    if np_:
        print('最近大促：%s（还有 %d 天，%s）' % (np_['promo']['name'], np_['days'], np_['promo']['depth']))
    kfc = next_of('kfc', d)
    print('下一次疯狂星期四：%s（%s），还有 %d 天'
          % (kfc.isoformat(), weekday_cn(kfc), (kfc - d).days))


def _demo():
    print('--- 示例1：充电宝（京东需买 2 件，不能当单件价）---')
    r = compare_offers([
        {'platform': '淘宝', 'title': '充电宝 10000mAh', 'price': 89, 'spec': '10000mAh'},
        {'platform': '拼多多', 'title': '同款百亿补贴', 'price': 79, 'coupon': 5, 'spec': '10000mAh'},
        {'platform': '京东', 'title': '同款自营', 'price': 99, 'spec': '10000mAh', 'needQty': 2},
    ], item='充电宝', budget=100)
    print(r['mode'], r['headline'])
    for x in r['rows']:
        print('  [%s] 到手 %.2f（需买%d件） %s' % (x['platform'], x['eff'], x['needQty'], x['perLabel']))
    print('预算：', r['budget']['text'])
    print('时机：', r['timing']['text'])
    print()
    print('--- 示例2：纸巾（规格不同，只能比单价）---')
    r2 = compare_offers([
        {'platform': '拼多多', 'price': 12.99, 'spec': '12包'},
        {'platform': '天猫', 'price': 42.23, 'spec': '24包'},
        {'platform': '京东', 'price': 18.93, 'spec': '280抽6提', 'needQty': 4},
    ], item='抽纸')
    print(r2['mode'], r2['headline'])
    for x in r2['rows']:
        print('  [%s] 到手 %.2f（需买%d件） %s' % (x['platform'], x['eff'], x['needQty'], x['perLabel']))
    print()
    print('--- 示例3：口径对不上，拒绝下结论 ---')
    r3 = compare_offers([
        {'platform': '淘宝', 'price': 39.9, 'spec': '2瓶装500ml'},
        {'platform': '拼多多', 'price': 59, 'spec': '12包'},
    ], item='洗衣液')
    print(r3['mode'], 'comparable=', r3['comparable'], r3['headline'])


def main():
    ap = argparse.ArgumentParser(description='省钱雷达引擎：活动日历 + 比价口径（不联网、不编价）')
    ap.add_argument('--today', help='指定当天日期 YYYY-MM-DD（默认今天）')
    ap.add_argument('--weeks', type=int, default=0, help='打印未来 N 周的活动')
    ap.add_argument('--csv', help='生成真实商家日历 CSV 的路径')
    ap.add_argument('--days', type=int, default=56, help='CSV 覆盖天数（默认 56 = 8 周）')
    ap.add_argument('--json', help='直接传入比价 JSON：{"item":"..","budget":100,"offers":[...]}')
    ap.add_argument('--demo', action='store_true', help='跑一组口径自测')
    args = ap.parse_args()

    d = to_date(args.today)
    if args.json:
        try:
            payload = json.loads(args.json)
        except Exception as e:  # noqa: BLE001
            print('JSON 解析失败：%s' % e)
            return 0
        r = compare_offers(payload.get('offers'), payload.get('item') or '未命名商品',
                           payload.get('budget'), d)
        print(r['headline'])
        for x in r.get('rows', []):
            print('  [%s] 到手 %.2f（需买%d件）%s' % (x['platform'], x['eff'], x['needQty'], x['perLabel']))
        for s in r.get('sublines', []):
            print('  ·', s)
        for w in r.get('warnings', []):
            print('  ⚠', w)
        return 0
    if args.demo:
        _demo()
        return 0
    if args.csv:
        n = write_calendar_csv(args.csv, args.days, d)
        print('已生成 %s（%d 行，从 %s 起 %d 天）' % (args.csv, n, d.isoformat(), args.days))
        if not args.weeks:
            return 0
    if args.weeks:
        for day in upcoming(args.weeks * 7, d):
            if not day['items']:
                continue
            print('%s %s  %s' % (day['date'], day['weekday'],
                                 ' | '.join('%s/%s' % (x['name'], x['title']) for x in day['items'])))
        return 0
    _print_today(d)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print('【提示】引擎出错了：%s\n请检查参数；日历功能不依赖网络，可重试。' % str(e)[:120])
        sys.exit(0)
