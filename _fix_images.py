# -*- coding: utf-8 -*-
import re, os

root = r'D:\Program Files\PythonStudy\Kards'
path = os.path.join(root, 'index.html')

with open(path, encoding='utf-8') as f:
    t = f.read()

mapping = {
    '断水.jpg': '断水.png',
    '闪电战.jpg': '闪电战.png',
    '战术打击.jpg': '战术打击.png',
    '侦察队.jpg': '侦察队.png',
    'IS-3.jpg': 'IS-3.png',
    '不惜代价.jpg': '不惜代价.png',
    '冬季攻势.jpg': '冬季攻势.png',
    '钢铁洪流.jpg': '钢铁洪流.png',
    '工人们联合.jpg': '工人们联合.png',
    '近卫第8步兵师.jpg': '近卫第8步兵师.png',
    '人海战术.jpg': '人海战术.png',
    '血红的镰刀.jpg': '血红的镰刀.png',
    '雷达警报.jpg': '雷达警报.png',
    '牛津.jpg': '牛津.png',
    '拖延战术.jpg': '拖延战术.png',
    '战争机器.jpg': '战争机器.png',
    '战争债券.jpg': '战争债券.png',
    'images/UI/被守护.jpg': 'images/UI/被守护.png',
    'images/UI/守护.jpg': 'images/UI/守护.png',
    'images/UI/闪击.jpg': 'images/UI/闪击.png',
    'images/UI/冲击.jpg': 'images/UI/冲击.png',
    'images/UI/伏击.jpg': 'images/UI/伏击.png',
    'images/UI/烟幕.jpg': 'images/UI/烟幕.png',
    'images/UI/压制.jpg': 'images/UI/压制.png',
    "images/UI/重甲'+lv+'.jpg": "images/UI/重甲'+lv+'.png",
    'images/Germany/D_I_MG42Team.png': 'images/Germany/D_I_Volksgrenadier.jpg',
    'images/Japan/丛林突袭.png': 'images/Japan/扩张.jpg',
    'images/Soviet_Union/S_I_Partisan.png': 'images/Soviet_Union/S_I_RedArmy.jpg',
    'images/Soviet_Union/近卫步兵.jpg': 'images/Soviet_Union/S_I_GuardsFlag.jpg',
    'images/UK/B_I_DesertRat.png': 'images/UK/B_I_BritInfantry.jpg',
    'images/UK/B_I_Paratrooper.png': 'images/UK/苏格兰伞兵.jpg',
}

absent = []
for k, v in mapping.items():
    if k in t:
        t = t.replace(k, v)
    else:
        absent.append(k)

with open(path, 'w', encoding='utf-8') as f:
    f.write(t)

print('已替换并写回 index.html')
if absent:
    print('下列键在文件中未匹配（需人工检查）:')
    for a in absent:
        print('  ', a)
else:
    print('所有键均匹配替换，无遗漏。')

# 校验
rx = re.compile(r'images/[A-Za-z0-9_\-./\u4e00-\u9fa5]+')
refs = sorted(set(rx.findall(t)))
missing = []
img_dir = os.path.join(root, 'images')
for r in refs:
    rel = r[len('images/'):]
    if not os.path.exists(os.path.join(img_dir, rel)):
        missing.append(r)
print('总引用(去重):', len(refs))
if missing:
    print('== 仍缺失的引用 ==')
    for m in missing:
        print('  ', m)
else:
    print('== 校验通过：所有图片引用均命中本地文件 ==')