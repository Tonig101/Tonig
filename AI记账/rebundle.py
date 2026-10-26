#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
再打包（替代已丢失源模板的 bundle_once.py）。

背景：官方 bundle_once.py 依赖 AI记账.src.html，但该模板已丢失。
本脚本直接在既有单文件 AI记账.html 上，按固定顺序把 16 个本地 JS 内联块
用磁盘最新源码原地替换，实现「改完外部 js → 重新进包」。
同时把唯一的内联 <style> 块用 styles.css 覆盖，保证「改完 css → 重新进包」。

顺序已核验：AI记账.html 里的 <script>...</script> 内联块，第 i 块恰好对应
LOCAL_JS[i]（第 15 块、0 基索引 14 为 cloud-config.js）。任何一步对不上就直接报错退出，
绝不写坏文件。
"""
import os, re, sys, shutil

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "AI记账.html")
CSS_SRC = os.path.join(BASE, "styles.css")

# 共 16 项，顺序必须与 AI记账.src.html 的 <script src> 一致（tone 在 coach 之后，
# wishlist / diagnose 在 piggy 之后）
LOCAL_JS = [
    "data.js", "nlp.js", "engine.js", "coach.js", "tone.js", "deals.js",
    "savings_data.js", "savings.js", "piggy.js", "wishlist.js", "diagnose.js",
    "analysis.js", "ocr.js", "intent.js", "cloud-config.js", "app.js",
]

def blocks_of(html):
    return list(re.finditer(r'<script>\n(.*?)\n  </script>', html, re.S))

def inline_css(html, css):
    """把唯一的 <style> 块内容换成 styles.css，返回 (新 html, 是否成功)"""
    i = html.find("<style>")
    j = html.find("</style>", i + 1)
    if i < 0 or j < 0:
        return html, False
    if html.find("<style>", i + 1) != -1:
        return html, False          # 不止一个 style 块，拒绝猜
    head = html[:i + len("<style>")]
    tail = html[j:]
    return head + "\n" + css.rstrip() + "\n\n  " + tail, True

def sync_sprite(html):
    """把 AI记账.src.html 里的 SVG 图标 sprite 同步进单文件版。

    图标 sprite（<svg class="icon-sprite">…</svg>）既不属于 <style> 也不属于 <script>，
    此前漏掉了这一步：往 src.html 里加 <symbol> 后，单文件版里的 #i-xxx 引用会静默失效
    （<use> 找不到目标 → 什么都不画，控制台也不报错），非常难查。这里按 id 集合校验。
    """
    src = os.path.join(BASE, "AI记账.src.html")
    if not os.path.exists(src):
        print("-- 未找到 AI记账.src.html，跳过 sprite 同步")
        return html, False
    with open(src, "r", encoding="utf-8") as f:
        want = f.read()
    m_new = re.search(r'<svg class="icon-sprite".*?</svg>', want, re.S)
    m_old = re.search(r'<svg class="icon-sprite".*?</svg>', html, re.S)
    if not m_new or not m_old:
        return html, False
    if m_new.group(0) == m_old.group(0):
        return html, False                      # 已一致，无需改动
    return html[:m_old.start()] + m_new.group(0) + html[m_old.end():], True

def main():
    with open(OUT, "r", encoding="utf-8") as f:
        html = f.read()

    ms = blocks_of(html)
    if len(ms) != len(LOCAL_JS):
        print("!! 内联块数量 %d != LOCAL_JS %d，拒绝执行" % (len(ms), len(LOCAL_JS)))
        return 1

    # 顺序自检：第 15 块（0 基索引 14）必须含 cloud-config 的公开配置注释
    # 新增 tone / wishlist / diagnose 三个块后，cloud-config 从索引 11 后移到 14
    if "WorkBuddy 云服务公开配置" not in ms[14].group(1):
        print("!! 第 15 块不是 cloud-config.js，顺序假设失效，拒绝执行")
        return 1

    backups = {}
    for i, name in enumerate(LOCAL_JS):
        p = os.path.join(BASE, name)
        if not os.path.exists(p):
            print("!! 缺失源码文件:", name)
            return 1
        with open(p, "r", encoding="utf-8") as f:
            code = f.read()
        if "</script" in code:
            print("!! %s 含字面量 </script，会截断内联，拒绝执行" % name)
            return 1
        backups[name] = code

    out = []
    last = 0
    for i, m in enumerate(ms):
        out.append(html[last:m.start()])
        out.append("<script>\n" + backups[LOCAL_JS[i]] + "\n  </script>")
        last = m.end()
    out.append(html[last:])
    new_html = "".join(out)

    # 写前再校验一次块数与顺序
    ms2 = blocks_of(new_html)
    if len(ms2) != len(LOCAL_JS):
        print("!! 重建后块数异常，拒绝写入")
        return 1

    # 内联 CSS：与 styles.css 同步
    with open(CSS_SRC, "r", encoding="utf-8") as f:
        css = f.read()
    if "</style" in css:
        print("!! styles.css 含字面量 </style，会截断内联，拒绝执行")
        return 1
    new_html, css_ok = inline_css(new_html, css)
    if not css_ok:
        print("!! <style> 块定位失败，拒绝写入")
        return 1

    # SVG 图标 sprite：与 AI记账.src.html 同步
    new_html, sprite_ok = sync_sprite(new_html)

    # 备份
    bak = OUT + ".bak-rebundle"
    shutil.copyfile(OUT, bak)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(new_html)

    # 写后校验：每块与磁盘源码一致
    ok = True
    with open(OUT, "r", encoding="utf-8") as f:
        final = f.read()
    ms3 = blocks_of(final)
    for i, name in enumerate(LOCAL_JS):
        if ms3[i].group(1).strip() != backups[name].strip():
            print("!! 校验失败:", name); ok = False
    i = final.find("<style>")
    j = final.find("</style>", i + 1)
    css_inlined = final[i + len("<style>"):j].strip() == css.strip()

    # sprite 校验：单文件版里的 symbol id 集合必须覆盖磁盘 JS 里引用的所有 #i-xxx
    used = set(re.findall(r"use href=\"#(i-[a-z0-9-]+)\"", final))
    have = set(re.findall(r"<symbol id=\"(i-[a-z0-9-]+)\"", final))
    missing = sorted(used - have)
    if missing:
        ok = False
        print("!! 引用了不存在的图标:", ", ".join(missing))

    print("内联 JS 块:", len(ms3), "/", len(LOCAL_JS))
    print("逐块与源码一致:", "YES" if ok else "NO")
    print("内联 CSS 与 styles.css 一致:", "YES" if css_inlined else "NO")
    print("图标 sprite:", "已同步" if sprite_ok else "无需改动",
          "（引用 %d 个 / 定义 %d 个）" % (len(used), len(have)))
    print("文件大小: %.2f KB" % (os.path.getsize(OUT) / 1024))
    print("备份: AI记账.html.bak-rebundle")
    return 0 if (ok and css_inlined) else 1

if __name__ == "__main__":
    sys.exit(main())
