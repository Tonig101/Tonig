import csv
import os
import re
from datetime import datetime, date, time, timedelta
from typing import Optional

import gradio as gr

# ============================================================
# 知识库加载模块
# ============================================================

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
VENUE_DATA_PATH = os.path.join(DATA_DIR, "场馆空闲数据.csv")
RULES_PATH = os.path.join(DATA_DIR, "校园场馆预约规则.txt")


def load_venue_data(filepath: str = VENUE_DATA_PATH) -> list[dict]:
    if not os.path.exists(filepath):
        return []
    with open(filepath, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        data = []
        for idx, row in enumerate(reader):
            row["_csv_row"] = idx + 2
            data.append(row)
        return data


def load_rules(filepath: str = RULES_PATH) -> str:
    if not os.path.exists(filepath):
        return "规则文件未找到。"
    with open(filepath, encoding="utf-8") as f:
        return f.read()


# ============================================================
# 核心查询逻辑
# ============================================================

def parse_date(date_str: str) -> Optional[date]:
    today = date.today()
    formats_with_default = [
        ("%Y-%m-%d", None),
        ("%Y/%m/%d", None),
        ("%Y.%m.%d", None),
        ("%Y年%m月%d日", None),
        ("%m-%d", today.year),
        ("%m/%d", today.year),
        ("%m月%d日", today.year),
    ]
    for fmt, default_year in formats_with_default:
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            year = default_year if default_year is not None else dt.year
            return date(year, dt.month, dt.day)
        except ValueError:
            continue
    return None


WEEKDAY_NAMES: dict[str, int] = {
    "周一": 0, "周二": 1, "周三": 2, "周四": 3, "周五": 4, "周六": 5, "周日": 6, "星期天": 6,
    "星期一": 0, "星期二": 1, "星期三": 2, "星期四": 3, "星期五": 4, "星期六": 5, "星期日": 6,
    "礼拜一": 0, "礼拜二": 1, "礼拜三": 2, "礼拜四": 3, "礼拜五": 4, "礼拜六": 5, "礼拜天": 6,
    "周1": 0, "周2": 1, "周3": 2, "周4": 3, "周5": 4, "周6": 5, "周7": 6,
    "星期1": 0, "星期2": 1, "星期3": 2, "星期4": 3, "星期5": 4, "星期6": 5, "星期7": 6,
}


def resolve_weekday(msg: str) -> Optional[date]:
    """从消息中提取星期几，返回最近的对应日期（含今天）"""
    today = date.today()
    for name, weekday in WEEKDAY_NAMES.items():
        if name in msg:
            days_ahead = (weekday - today.weekday()) % 7
            return today + timedelta(days=days_ahead if days_ahead > 0 else 7)
    return None


NUMBER_WORDS: dict[str, int] = {
    "一个人": 1, "一人": 1,
    "两个人": 2, "俩人": 2, "两人": 2,
    "三个人": 3, "三人": 3,
    "四个人": 4, "四人": 4,
    "五个人": 5, "五人": 5,
    "六个人": 6, "六人": 6,
    "七八个人": 7, "七八个": 7,
    "十来个人": 10, "十来人": 10, "十来个": 10, "十多人": 10,
}


def parse_people_count(msg: str) -> Optional[int]:
    """解析人数，支持口语表达"""
    if m := re.search(r"(\d+)\s*人", msg):
        return int(m.group(1))
    for word, num in NUMBER_WORDS.items():
        if word in msg:
            return num
    return None


def match_venue_type(raw_type: str) -> list[str]:
    mapping = {
        "研讨室": ["研讨室"],
        "教室": ["教室"],
        "体育": ["体育场馆"],
        "运动": ["体育场馆"],
        "羽毛球": ["体育场馆"],
        "篮球": ["体育场馆"],
        "体育馆": ["体育场馆"],
        "场馆": ["教室", "研讨室", "体育场馆"],
        "图书馆": ["研讨室"],
        "自习": ["教室", "研讨室"],
    }
    raw_lower = raw_type.strip().lower()
    results = []
    for key, types in mapping.items():
        if key in raw_lower:
            results.extend(types)
    if not results:
        results = ["教室", "研讨室", "体育场馆"]
    return list(set(results))


def parse_user_needs(msg: str) -> dict:
    needs = {
        "min_capacity": 0,
        "prefer_morning": False,
        "prefer_afternoon": False,
        "prefer_evening": False,
        "people_count": 0,
    }
    people_match = re.search(r"(\d+)\s*人", msg)
    if people_match:
        needs["people_count"] = int(people_match.group(1))
        needs["min_capacity"] = int(people_match.group(1))

    msg_lower = msg.lower()
    if any(w in msg_lower for w in ["上午", "早上", "早晨"]):
        needs["prefer_morning"] = True
    if any(w in msg_lower for w in ["下午", "中午"]):
        needs["prefer_afternoon"] = True
    if any(w in msg_lower for w in ["晚上", "傍晚"]):
        needs["prefer_evening"] = True

    return needs


TIME_SLOT_PERIOD = {
    "上午": ("06:00", "12:00"),
    "下午": ("12:00", "18:00"),
    "晚上": ("18:00", "23:59"),
}


def slot_matches_time_pref(slot: dict, needs: dict) -> bool:
    start = slot["开始时间"]
    if needs["prefer_morning"] and start < "12:00":
        return True
    if needs["prefer_afternoon"] and "12:00" <= start < "18:00":
        return True
    if needs["prefer_evening"] and start >= "18:00":
        return True
    if not needs["prefer_morning"] and not needs["prefer_afternoon"] and not needs["prefer_evening"]:
        return True
    return False


def get_unsynchronized_slots(
    target_date: date, preferred_types: list[str], venue_data: list[dict]
) -> list[dict]:
    """找出【数据未同步】的场馆×时段，粒度为时段级别"""
    date_str = target_date.strftime("%Y-%m-%d")

    known_by_type: dict[str, set[str]] = {}
    known_slots: dict[str, set[str]] = {}   # vtype → set of "HH:MM-HH:MM"
    records_on_date: set[tuple[str, str, str]] = set()  # (vname, start, end)
    venues_with_any_data: set[str] = set()

    for row in venue_data:
        vtype = row["类型"]
        vname = row["场馆名称"]
        slot_key = f"{row['开始时间']}-{row['结束时间']}"

        if vtype not in known_by_type:
            known_by_type[vtype] = set()
            known_slots[vtype] = set()
        known_by_type[vtype].add(vname)
        known_slots[vtype].add(slot_key)

        if row["日期"] == date_str:
            records_on_date.add((vname, row["开始时间"], row["结束时间"]))
            venues_with_any_data.add(vname)

    unsync = []
    for vtype in preferred_types:
        known = known_by_type.get(vtype, set())
        slots_set = known_slots.get(vtype, set())
        if not known:
            continue  # 类型不存在 → 在 _run_query_with_session 中单独处理
        for vname in sorted(known):
            if vname not in venues_with_any_data:
                # 全天无数据 → 场馆级别
                unsync.append({
                    "场馆名称": vname, "类型": vtype, "日期": date_str,
                    "时段": "", "is_full_day": True,
                })
            else:
                # 有部分数据 → 逐个时段比对
                for slot_key in sorted(slots_set):
                    start_t, end_t = slot_key.split("-", 1)
                    if (vname, start_t, end_t) not in records_on_date:
                        unsync.append({
                            "场馆名称": vname, "类型": vtype, "日期": date_str,
                            "时段": f"{start_t}-{end_t}", "is_full_day": False,
                        })
    return unsync


def find_available_slots(
    target_date: date,
    preferred_types: list[str],
    all_data: list[dict],
) -> list[dict]:
    available = []
    date_str = target_date.strftime("%Y-%m-%d")
    for row in all_data:
        if row["日期"] == date_str and row["状态"] == "空闲":
            if row["类型"] in preferred_types:
                available.append(row)
    return available


def rule_min_advance_hours(venue_type: str) -> int:
    if venue_type in ("教室", "研讨室"):
        return 2
    elif venue_type == "体育场馆":
        return 1
    return 2


def rule_max_duration_hours(venue_type: str) -> int:
    if venue_type == "教室":
        return 4
    elif venue_type == "研讨室":
        return 3
    elif venue_type == "体育场馆":
        return 2
    return 4


def rule_is_peak(venue_type: str, start_time_str: str, end_time_str: str, target_date: date) -> bool:
    weekday = target_date.weekday()
    is_weekend = weekday >= 5
    s = datetime.strptime(start_time_str, "%H:%M").time()
    e = datetime.strptime(end_time_str, "%H:%M").time()
    if venue_type in ("教室", "研讨室"):
        peak_start = time(14, 0)
        peak_end = time(18, 0)
        return not is_weekend and s < peak_end and e > peak_start
    elif venue_type == "体育场馆":
        peak_start = time(17, 0)
        peak_end = time(19, 0)
        if is_weekend:
            return True
        return s < peak_end and e > peak_start
    return False


def rule_needs_approval(venue_type: str, start_time_str: str, end_time_str: str, target_date: date) -> bool:
    if venue_type in ("教室", "研讨室"):
        return False
    return rule_is_peak(venue_type, start_time_str, end_time_str, target_date)


# ============================================================
# Agent 核心类
# ============================================================

class VenueAgent:
    def __init__(self):
        self.venue_data = load_venue_data()
        self.rules_text = load_rules()
        self._available_dates: Optional[set[str]] = None
        self._demo_state: dict = {}
        self._session: dict = {
            "date": None,
            "date_str": "",
            "time_label": "",
            "venue_types": [],
            "people_count": 0,
            "special_needs": [],
            "last_full_query": "",
            "last_modified_condition": "",
            "consecutive_fail_same_cond": 0,
            "dissatisfaction_count": 0,
            "consecutive_parse_fail": 0,
        }

    @property
    def available_dates(self) -> set[str]:
        if self._available_dates is None:
            self._available_dates = set()
            for row in self.venue_data:
                self._available_dates.add(row["日期"])
        return self._available_dates

    def _detect_partial_update(self, msg: str) -> Optional[str]:
        """检测是不是局部修改，返回确认语或 None"""
        partials = [
            (["换个时间", "换时间", "换个时段", "换时段", "改时间", "改个时间"], "time"),
            (["大一点", "大点的", "大一些", "更大的", "加大"], "capacity_up"),
            (["小一点", "小点的", "小一些", "更小的"], "capacity_down"),
            (["换教室", "改成教室", "教室"], "type_教室"),
            (["换研讨室", "改成研讨室", "研讨室"], "type_研讨室"),
            (["换体育馆", "改成体育馆", "改成体育场馆", "体育"], "type_体育场馆"),
        ]
        for keywords, action in partials:
            for kw in keywords:
                if kw == msg.strip() or msg.strip().startswith(kw):
                    return action
        return None

    def _parse_special_needs(self, msg: str) -> list[str]:
        needs = []
        for kw, label in [("投影", "投影"), ("白板", "白板"), ("空调", "空调"),
                          ("黑板", "黑板"), ("多媒体", "多媒体"), ("话筒", "话筒"),
                          ("音响", "音响"), ("无障碍", "无障碍"), ("钢琴", "钢琴")]:
            if kw in msg:
                needs.append(label)
        return needs

    def _period_from_time_label(self, label: str) -> dict:
        if label == "上午":
            return {"prefer_morning": True, "prefer_afternoon": False, "prefer_evening": False}
        elif label == "晚上":
            return {"prefer_morning": False, "prefer_afternoon": False, "prefer_evening": True}
        else:
            return {"prefer_morning": False, "prefer_afternoon": True, "prefer_evening": False}

    def _label_from_msg(self, msg: str) -> str:
        if any(w in msg for w in ["上午", "早上", "早晨"]):
            return "上午"
        if any(w in msg for w in ["晚上", "傍晚"]):
            return "晚上"
        if any(w in msg for w in ["中午"]):
            return "中午"
        return "下午"

    def _build_full_query(self) -> str:
        s = self._session
        parts = []
        if s["date_str"]:
            parts.append(s["date_str"])
        if s["time_label"]:
            parts.append(s["time_label"])
        if s["people_count"]:
            parts.append(f"{s['people_count']}人")
        if s["venue_types"]:
            parts.append(s["venue_types"][0])
        return " ".join(parts)

    def query(self, user_message: str) -> str:
        msg = user_message.strip()

        if msg.startswith("【演示】"):
            return self._handle_demo(msg[4:].strip())

        # ===== 边界拒绝 =====
        irrelevant_keywords = [
            "老师", "食堂", "好吃", "什么课", "选课", "成绩",
            "社团", "军训", "宿舍", "奖学金", "外卖", "兼职",
            "图书馆借书", "校园网", "哪个老师",
        ]
        for kw in irrelevant_keywords:
            if kw in msg:
                self._session["dissatisfaction_count"] = 0
                return "我只负责场馆空闲查询和预约预警，其他问题建议咨询对应部门。"

        if "直接帮我订" in msg or "帮我订了" in msg or "帮我预约" in msg:
            self._session["dissatisfaction_count"] = 0
            return "我无法代替你完成预约操作，但可以帮你确认时段并整理好信息，复制到预约系统即可。"

        if msg.strip() in ("不对", "没用") or "不对" in msg.split() or "没用" in msg.split():
            self._session["dissatisfaction_count"] += 1
            if self._session["dissatisfaction_count"] >= 2:
                self._session["dissatisfaction_count"] = 0
                return "我可能没理解准确，建议直接联系对应部门，或告诉我更具体的条件我再试一次。"
            # First dissatisfaction: re-run with current session
            if self._session["date"]:
                return self._run_query_with_session()

        # ===== 部分更新检测 =====
        action = self._detect_partial_update(msg)
        if action and self._session["date"]:
            confirm_parts = []
            if action == "time":
                old_label = self._session["time_label"]
                new_label = {"上午": "下午", "下午": "晚上", "晚上": "上午"}[old_label]
                self._session["time_label"] = new_label
                self._session["last_modified_condition"] = "time"
                confirm_parts.append(f"时间段→{new_label}（原{old_label}）")
            elif action == "capacity_up":
                old = self._session["people_count"]
                new = max(old + 2, old * 2) if old > 0 else 4
                self._session["people_count"] = new
                self._session["last_modified_condition"] = "capacity"
                confirm_parts.append(f"人数→{new}人（原{old}人）")
            elif action == "capacity_down":
                old = self._session["people_count"]
                new = max(1, old // 2) if old > 1 else 1
                self._session["people_count"] = new
                self._session["last_modified_condition"] = "capacity"
                confirm_parts.append(f"人数→{new}人（原{old}人）")
            elif action.startswith("type_"):
                new_type = action[5:]
                old_types = "、".join(self._session["venue_types"])
                self._session["venue_types"] = [new_type]
                self._session["last_modified_condition"] = "venue_type"
                confirm_parts.append(f"场馆类型→{new_type}（原{old_types}）")

            confirm_parts.append("其余条件不变")
            confirm_line = "已更新：" + "；".join(confirm_parts)

            # Check consecutive failure on same condition
            last_mod = self._session["last_modified_condition"]
            result = self._run_query_with_session()
            if "暂无" in result or "未找到" in result or "无空闲" in result or "无任何记录" in result:
                self._session["consecutive_fail_same_cond"] += 1
                if self._session["consecutive_fail_same_cond"] >= 2:
                    self._session["consecutive_fail_same_cond"] = 0
                    cond_name = {"time": "时间段", "capacity": "人数", "venue_type": "场馆类型"}.get(last_mod, "该条件")
                    return f"{confirm_line}\n\n{result}\n\n是否放宽{cond_name}？当前条件下知识库中无可用时段。"
            else:
                self._session["consecutive_fail_same_cond"] = 0

            return f"{confirm_line}\n\n{result}"

        # ===== 完整查询 =====
        self._session["dissatisfaction_count"] = 0
        self._session["consecutive_fail_same_cond"] = 0
        self._session["last_modified_condition"] = ""

        # 解析日期（多层次：口语词 → 星期 → 正则）
        target_date = None
        date_indicators = ["明天", "后天", "今天", "明儿", "今儿", "大后天"]
        today = date.today()
        delta_map = {"今天": 0, "今儿": 0, "明天": 1, "明儿": 1, "后天": 2, "大后天": 3}
        for di in date_indicators:
            if di in msg:
                target_date = today + timedelta(days=delta_map[di])
                break
        if target_date is None:
            target_date = resolve_weekday(msg)
        if target_date is None:
            date_patterns = [
                re.compile(r'\d{4}[-/.]\d{1,2}[-/.]\d{1,2}'),
                re.compile(r'\d{1,2}[-/.]\d{1,2}'),
                re.compile(r'\d{4}年\d{1,2}月\d{1,2}日'),
                re.compile(r'\d{1,2}月\d{1,2}日'),
            ]
            for pattern in date_patterns:
                m = pattern.search(msg)
                if m:
                    parsed = parse_date(m.group())
                    if parsed:
                        target_date = parsed
                        break

        # ===== 缺信息逐项追问（一次只问一项） =====
        if target_date is None:
            # 检查是否有类型
            venue_types = match_venue_type(msg)
            has_type = bool(venue_types) and venue_types != ["教室", "研讨室", "体育场馆"]
            self._session["consecutive_parse_fail"] += 1
            if self._session["consecutive_parse_fail"] >= 2:
                self._session["consecutive_parse_fail"] = 0
                return (
                    "我没太理解你的查询。你可以试试这样说：\n"
                    "- 明天下午 8人 研讨室\n"
                    "- 10月23日 有投影的教室\n"
                    "- 周五 体育馆\n\n"
                    "也可以直接联系场馆管理中心人工查询。"
                )
            if not has_type:
                return "你想找教室、研讨室还是体育场馆？"
            available_dates_sorted = sorted(self.available_dates)
            return (
                f"你想查哪一天？可以说'明天''周五'或具体日期。\n"
                f"当前可查询日期：{available_dates_sorted[0]} 至 {available_dates_sorted[-1]}"
            )

        self._session["consecutive_parse_fail"] = 0

        date_str = target_date.strftime("%Y-%m-%d")
        if date_str not in self.available_dates:
            available_dates_sorted = sorted(self.available_dates)
            return (
                f"该日期的场馆数据尚未同步。\n"
                f"可查询日期范围：{available_dates_sorted[0]} 至 {available_dates_sorted[-1]}"
            )

        # 保存到会话
        self._session["date"] = target_date
        self._session["date_str"] = date_str
        self._session["time_label"] = self._label_from_msg(msg)
        self._session["venue_types"] = match_venue_type(msg)
        people_count = parse_people_count(msg)
        self._session["people_count"] = people_count if people_count is not None else parse_user_needs(msg)["people_count"]
        self._session["special_needs"] = self._parse_special_needs(msg)
        self._session["last_full_query"] = msg

        return self._run_query_with_session()

    def _run_query_with_session(self) -> str:
        s = self._session
        target_date = s["date"]
        date_str = s["date_str"]
        preferred_types = s["venue_types"]
        people_count = s["people_count"]
        time_prefs = self._period_from_time_label(s["time_label"])
        type_names = "、".join(preferred_types)

        all_type_slots = find_available_slots(target_date, preferred_types, self.venue_data)
        unsync_slots = get_unsynchronized_slots(target_date, preferred_types, self.venue_data)

        # ===== 检查该类型是否在知识库中完全不存在（规则5） =====
        all_types_in_data: set[str] = {row["类型"] for row in self.venue_data}
        unknown_types = [t for t in preferred_types if t not in all_types_in_data]
        if unknown_types and not all_type_slots and not unsync_slots:
            return f"该类型场馆在{date_str}无任何记录，无法判断空闲情况，建议换类型或联系场馆管理中心核实。"

        # ===== 全部未同步 =====
        if not all_type_slots and unsync_slots:
            period_label = s["time_label"] or "下午"
            people_str = f"{people_count}人" if people_count > 0 else "不限人数"
            header = f"🏫 **查询结果** · {date_str} {period_label} · {type_names} · {people_str}"

            unsync_items = []
            for v in unsync_slots:
                if v["is_full_day"]:
                    unsync_items.append({
                        "venue": v["场馆名称"],
                        "range": v["日期"],
                    })
                else:
                    unsync_items.append({
                        "venue": v["场馆名称"],
                        "range": f"{v['日期']} {v['时段']}",
                    })
            unsync_items = unsync_items[:5]
            unsync_note = (
                "> ⏳ 未同步 = 知识库中无该时段记录，无法判断是否空闲，"
                "建议联系场馆管理中心核实。"
            )

            if len(unsync_items) >= 3:
                table_rows = "\n".join(
                    f"| {u['venue']} | {u['range']} | ⏳ 未同步 |"
                    for u in unsync_items
                )
                unsync_block = (
                    "| 场馆 | 日期/时段 | 状态 |\n"
                    "|:---|:---|:---:|\n"
                    f"{table_rows}\n\n{unsync_note}"
                )
            else:
                bullets = "\n".join(
                    f"- **{u['venue']}** · {u['range']} · ⏳ 未同步"
                    for u in unsync_items
                )
                unsync_block = f"{bullets}\n\n{unsync_note}"

            return (
                f"{header}\n\n"
                f"## ✅ 推荐时段\n\n无\n\n"
                f"## ⚠️ 数据未同步\n\n{unsync_block}\n\n"
                f"## 🚨 冲突预警\n\n无\n\n"
                f"## 👉 下一步\n\n"
                f"换一个已同步的日期查询；或联系场馆管理中心核实该日期数据。"
            )

        # ===== 全部无记录 =====
        if not all_type_slots and not unsync_slots:
            period_label = s["time_label"] or "下午"
            people_str = f"{people_count}人" if people_count > 0 else "不限人数"
            header = f"🏫 **查询结果** · {date_str} {period_label} · {type_names} · {people_str}"
            return (
                f"{header}\n\n"
                f"## ✅ 推荐时段\n\n无\n\n"
                f"## ⚠️ 数据未同步\n\n无\n\n"
                f"## 🚨 冲突预警\n\n无\n\n"
                f"## 👉 下一步\n\n"
                f"当前条件下无空闲时段。可换时间段、换场馆类型或联系场馆管理中心。"
            )

        # Sort by: 空闲时长 desc（优先长时段）
        all_type_slots.sort(key=lambda r: (
            -(int(r["结束时间"][:2]) * 60 + int(r["结束时间"][3:]) -
              int(r["开始时间"][:2]) * 60 - int(r["开始时间"][3:])),
            r["场馆名称"],
            r["开始时间"],
        ))

        scored_slots = []
        for slot in all_type_slots:
            score = 0
            match_tags = []
            excluded_tags = []

            # 基础匹配
            venue_type = slot["类型"]
            match_tags.append(venue_type)
            match_tags.append("空闲")

            cap = int(slot.get("可容纳人数", 0))
            if people_count > 0:
                if cap >= people_count:
                    match_tags.append("容量足")
                    score += 2
                else:
                    excluded_tags.append(f"🚫 容量{cap}<{people_count}人（见【第9条】）")
                    score -= 5
            else:
                match_tags.append(f"容量{cap}人")

            # ===== 第9条：使用人数下限 =====
            if people_count > 0:
                if venue_type == "研讨室" and people_count < 2:
                    excluded_tags.append("🚫 研讨室使用人数不少于2人（见【第9条】）")
                    score -= 10
                elif venue_type == "教室":
                    min30 = max(1, int(cap * 0.3))
                    if people_count < min30:
                        excluded_tags.append(f"⚠️ 人数低于教室容量30%（需≥{min30}人）（见【第9条】）")
                        score -= 3

            # ===== 设备匹配 =====
            special_needs = s["special_needs"]
            if special_needs:
                equip_str = slot.get("设备", "")
                missing = [n for n in special_needs if n not in equip_str]
                if missing:
                    excluded_tags.append(f"🚫 缺设备{'、'.join(missing)}")
                    score -= 4
                else:
                    match_tags.append("设备匹配")
                    score += 1

            time_matched = slot_matches_time_pref(slot, time_prefs)
            if time_matched:
                match_tags.append(f"{s['time_label']}")
                score += 1
            elif time_prefs.get("prefer_morning") or time_prefs.get("prefer_afternoon") or time_prefs.get("prefer_evening"):
                excluded_tags.append("⚠️ 时段偏好不匹配")
                score -= 3

            now = datetime.now()
            start_dt = datetime.combine(target_date, datetime.strptime(slot["开始时间"], "%H:%M").time())
            remaining_hours = (start_dt - now).total_seconds() / 3600
            min_hours = rule_min_advance_hours(venue_type)

            if remaining_hours < min_hours:
                excluded_tags.append(f"⚠️ 距开始不足{min_hours}h（见【第2条】）")
                score -= 2
                slot["_advance_warning"] = min_hours

            # ===== 第2条：最早提前上限 =====
            max_days = 7 if venue_type in ("研讨室", "教室") else 3
            if remaining_hours > max_days * 24:
                excluded_tags.append(f"⚠️ 超出最早提前{max_days}天（见【第2条】）")
                score -= 2
                slot["_early_warning"] = max_days

            if rule_needs_approval(venue_type, slot["开始时间"], slot["结束时间"], target_date):
                excluded_tags.append("⚠️ 高峰期需审批（见【第7条】）")
                score -= 1
                slot["_needs_approval"] = True

            max_dur = rule_max_duration_hours(venue_type)
            h1, m1 = map(int, slot["开始时间"].split(":"))
            h2, m2 = map(int, slot["结束时间"].split(":"))
            dur_hours = (h2 - h1) + (m2 - m1) / 60
            dur_minutes = (h2 - h1) * 60 + (m2 - m1)
            if dur_hours > max_dur:
                excluded_tags.append(f"⚠️ 时长{dur_hours:.0f}h超上限{max_dur}h（见【第3条】）")
                score -= 2
                slot["_duration_warning"] = max_dur

            data_source = f"第{slot['_csv_row']}行"

            slot["_score"] = score
            slot["_dur_minutes"] = dur_minutes
            slot["_match_tags"] = match_tags
            slot["_excluded_tags"] = excluded_tags
            slot["_data_source"] = data_source
            scored_slots.append(slot)

        scored_slots.sort(key=lambda r: (-r["_score"], -r["_dur_minutes"]))
        top_slots = [s for s in scored_slots if s["_score"] >= 0][:3]
        if not top_slots:
            top_slots = scored_slots[:3]

        period_label = s["time_label"] or "下午"
        people_str = f"{people_count}人" if people_count > 0 else "不限人数"
        header = f"🏫 **查询结果** · {date_str} {period_label} · {type_names} · {people_str}"

        # ===== ✅ 推荐时段 =====
        if top_slots and any(s["_score"] >= 0 for s in top_slots):
            rec_lines = []
            for idx, slot in enumerate(top_slots, start=1):
                if slot["_score"] < 0:
                    continue
                venue_name = slot["场馆名称"]
                start_t = slot["开始时间"]
                end_t = slot["结束时间"]
                cap = slot.get("可容纳人数", "?")
                pos = slot.get("位置", "—")
                match_str = " / ".join(slot["_match_tags"])
                rec_lines.append(
                    f"**{idx}. {venue_name}** `{start_t}-{end_t}`\n"
                    f"> 💡 **匹配度**：{match_str}\n"
                    f"> 📍 **位置**：{pos} ｜ 👥 **容量**：{cap}人\n"
                    f"> 📄 **数据源**：{slot['_data_source']}"
                )
            rec_block = "\n\n".join(rec_lines) if rec_lines else (
                "当前条件下没有匹配的空闲时段。可以试试：放宽时间段、减少人数要求，或换个场馆类型。"
            )
        else:
            rec_block = "当前条件下没有匹配的空闲时段。可以试试：放宽时间段、减少人数要求，或换个场馆类型。"

        # ===== ⚠️ 数据未同步 =====
        unsync_note = (
            "> ⏳ 未同步 = 知识库中无该时段记录，无法判断是否空闲，"
            "建议联系场馆管理中心核实。"
        )
        if unsync_slots:
            unsync_items = []
            for v in unsync_slots:
                if v["is_full_day"]:
                    unsync_items.append({
                        "venue": v["场馆名称"],
                        "range": v["日期"],
                    })
                else:
                    unsync_items.append({
                        "venue": v["场馆名称"],
                        "range": f"{v['日期']} {v['时段']}",
                    })
            unsync_items = unsync_items[:5]

            if len(unsync_items) >= 3:
                table_rows = "\n".join(
                    f"| {u['venue']} | {u['range']} | ⏳ 未同步 |"
                    for u in unsync_items
                )
                unsync_block = (
                    "| 场馆 | 日期/时段 | 状态 |\n"
                    "|:---|:---|:---:|\n"
                    f"{table_rows}\n\n{unsync_note}"
                )
            else:
                bullets = "\n".join(
                    f"- **{u['venue']}** · {u['range']} · ⏳ 未同步"
                    for u in unsync_items
                )
                unsync_block = f"{bullets}\n\n{unsync_note}"
        else:
            unsync_block = "无"

        # ===== 🚨 冲突预警 =====
        seen_warn = set()
        warn_lines = []
        for slot in scored_slots:
            for tag in slot["_excluded_tags"]:
                key = (slot["场馆名称"], slot["开始时间"], tag)
                if key not in seen_warn:
                    seen_warn.add(key)
                    warn_lines.append(
                        f"- {slot['场馆名称']} `{slot['开始时间']}-{slot['结束时间']}` {tag}"
                    )
        warn_block = "\n".join(warn_lines[:5]) if warn_lines else "无"

        next_step = (
            "前往预约系统提交申请；涉及审批或费用请联系场馆管理中心。"
            "推荐时段为两小时整段，具体时间以预约系统为准。"
        )

        return (
            f"{header}\n\n"
            f"## ✅ 推荐时段\n\n{rec_block}\n\n"
            f"## ⚠️ 数据未同步\n\n{unsync_block}\n\n"
            f"## 🚨 冲突预警\n\n{warn_block}\n\n"
            f"## 👉 下一步\n\n{next_step}"
        )

    def _handle_demo(self, demo_cmd: str) -> str:
        cmd = demo_cmd.strip()

        if "帮我直接订" in cmd or "帮我订" in cmd:
            return "我无法代替你完成预约操作，但可以帮你确认时段并整理好信息，复制到预约系统即可。"

        if any(kw in cmd for kw in ["食堂", "好吃", "什么菜", "什么饭"]):
            return "我只负责场馆空闲查询和预约预警，其他问题建议咨询对应部门。"

        if cmd == "换个时间":
            if not self._session["date"]:
                return "暂无历史查询记录，请先执行完整的场馆查询。"
            old_label = self._session["time_label"]
            new_label = {"上午": "下午", "下午": "晚上", "晚上": "上午"}[old_label]
            self._session["time_label"] = new_label
            result = self._run_query_with_session()
            return f"已更新：时间段→{new_label}（原{old_label}）；其余条件不变。\n\n{result}"

        # Normal demo query: full pipeline via query without the prefix
        self._demo_state = {"original_cmd": cmd, "time_label": self._label_from_msg(cmd)}
        result = self.query(cmd)
        return result


# ============================================================
# Gradio 界面
# ============================================================

agent = VenueAgent()

available_dates_sorted = sorted(agent.available_dates)
date_range_info = ""
if available_dates_sorted:
    date_range_info = f"📅 可查询日期范围：{available_dates_sorted[0]} ～ {available_dates_sorted[-1]}"


def chat_fn(message: str, history: list[dict]) -> tuple:
    response = agent.query(message)
    history.append({"role": "user", "content": message})
    history.append({"role": "assistant", "content": response})
    return "", history


def undo_last(history: list[dict]) -> list[dict]:
    if len(history) >= 2:
        return history[:-2]
    return history


with gr.Blocks(title="校园场馆通") as demo:

    gr.Markdown(
        """
        # 🏫 校园场馆通
        ### 空闲时段查询与预约辅助智能体
        """
    )

    gr.Markdown(
        f"""
        告诉我你想预约的**日期**和**场馆类型**，我帮你查找空闲时段 👇
        {date_range_info}
        """
    )

    chatbot = gr.Chatbot(
        value=[
            {"role": "assistant",
             "content": "你好！我是校园场馆通，有什么可以帮你的？\n\n直接告诉我想查的**日期+场馆类型**即可：\n- 明天下午 8人 研讨室\n- 明天上午 有投影的教室\n- 10月23日体育馆\n\n查完后还能说「换个时间」「大一点的」快速调整 👇"}
        ],
        height=450,
        render_markdown=True,
    )

    with gr.Row():
        msg_input = gr.Textbox(
            placeholder="输入你的查询，如：明天下午的研讨室...",
            scale=8,
            show_label=False,
            container=False,
        )
        send_btn = gr.Button("发送", variant="primary", scale=1)
        back_btn = gr.Button("↩ 返回", variant="secondary", scale=1, size="sm")

    gr.Examples(
        examples=[
            "明天下午的研讨室",
            "明天上午 有投影的教室",
            "明天 8人 研讨室",
            "10月23日体育馆",
            "10月24日上午的教室",
            "后天 5人 研讨室",
            "【演示】明天下午3点到5点 8人 研讨室",
        ],
        inputs=msg_input,
        label="💡 尝试这些查询",
    )

    with gr.Accordion("📋 查看规则与数据", open=False):
        with gr.Row():
            rules_btn = gr.Button("📜 预约规则")
            data_btn = gr.Button("📊 场馆数据")
            data_btn2 = gr.Button("📊 场馆数据（前20行）")
        info_display = gr.Markdown("点击上方按钮查看内容")

    rules_btn.click(fn=lambda: agent.rules_text, inputs=[], outputs=[info_display])
    data_btn.click(
        fn=lambda: "```csv\n" + open(r"D:\AI 智能体创新应用大赛作品\场馆空闲数据.csv", encoding="utf-8-sig").read() + "\n```",
        inputs=[], outputs=[info_display],
    )
    data_btn2.click(
        fn=lambda: "```csv\n" + "".join(open(r"D:\AI 智能体创新应用大赛作品\场馆空闲数据.csv", encoding="utf-8-sig").readlines()[:21]) + "\n```",
        inputs=[], outputs=[info_display],
    )

    send_btn.click(
        fn=chat_fn,
        inputs=[msg_input, chatbot],
        outputs=[msg_input, chatbot],
    )

    msg_input.submit(
        fn=chat_fn,
        inputs=[msg_input, chatbot],
        outputs=[msg_input, chatbot],
    )

    back_btn.click(
        fn=undo_last,
        inputs=[chatbot],
        outputs=[chatbot],
    )


if __name__ == "__main__":
    demo.launch(
        server_name="0.0.0.0",
        server_port=7860,
        share=False,
        inbrowser=True,
        theme=gr.themes.Soft(
            primary_hue="blue",
            secondary_hue="sky",
            neutral_hue="slate",
        ),
        css="""
        .gradio-container { max-width: 800px !important; margin: 0 auto !important; }
        footer { display: none !important; }
        """,
    )