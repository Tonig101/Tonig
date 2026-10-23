/**
 * data.js — 全局配置、分类词典、平替词典、演示种子数据
 *
 * 浏览器：通过 <script src="data.js"> 加载，挂载到 window.AJ.data
 * Node  ：require('./data.js') 直接返回 DATA 对象（便于单元测试）
 */
(function (global) {
  'use strict';

  /** localStorage 统一 key */
  var STORAGE_KEY = 'ai_jizhang_v1';

  /** 数据版本号，结构变更时用于迁移 */
  var DATA_VERSION = 1;

  /** 固定分类（"其他" 为兜底分类） */
  var CATEGORIES = [
    { key: '餐饮', color: '#07C160' },
    { key: '社交', color: '#FF8A3D' },
    { key: '购物', color: '#7C6CF0' },
    { key: '学习', color: '#3D9CFF' },
    { key: '交通', color: '#2AC6C0' },
    { key: '娱乐', color: '#EF5350' },
    { key: '居住', color: '#B0803C' },
    { key: '医疗', color: '#E0629A' },
    { key: '其他', color: '#9AA3AD' }
  ];

  /**
   * 分类关键词词典。
   * 打分规则见 nlp.js classify()：最长命中词长度 * 10 + 命中词个数。
   */
  var CATEGORY_KEYWORDS = {
    '餐饮': [
      '食堂', '外卖', '美团', '饿了么', '黄焖鸡', '麻辣烫', '火锅', '烧烤', '米线', '拉面',
      '面条', '饭团', '便当', '奶茶', '咖啡', '星巴克', '瑞幸', '库迪', '蜜雪', '喜茶',
      '霸王茶姬', '奈雪', '茶百道', '古茗', '零食', '水果', '泡面', '饮料', '早餐', '午餐',
      '晚餐', '早饭', '午饭', '晚饭', '夜宵', '宵夜', '吃饭', '米饭', '包子', '馒头', '饺子', '馄饨',
      '粥', '饼', '汉堡', '披萨', '炸鸡', '麻辣香锅', '酸菜鱼', '螺蛳粉', '自助', '可乐',
      '矿泉水', '雪糕', '冰淇淋', '蛋糕', '面包', '食堂饭卡', '饭卡', '肉', '菜', '汤', '面'
    ],
    '社交': [
      '聚餐', 'AA制', 'AA', '请客', '舍友', '室友', '同学', '朋友', '生日', '聚会', '剧本杀', 'KTV',
      '唱歌', '送礼', '份子', '随礼', '红包', '社团', '联谊', '约会', '礼物', '团建', '串门',
      '请吃饭', '聚会', '酒', '啤酒'
    ],
    '购物': [
      '衣服', '鞋', '裤子', '裙子', '卫衣', '外套', '化妆', '护肤', '洗面奶', '洗发水',
      '沐浴露', '纸巾', '日用', '淘宝', '拼多多', '京东', '快递', '耳机', '口红', '面膜',
      '牙膏', '牙刷', '毛巾', '袜子', '充电宝', '数据线', '水杯', '台灯', '床单', '被套',
      '超市', '商场', '优衣库', '香水', '首饰', '手表', '包'
    ],
    '学习': [
      '教材', '打印', '复印', '文具', '本子', '网课', '报名', '四六级', '考研', '资料',
      '考试', '课程', '学费', '辅导', '讲座', '实验', '笔记本', '参考书', '书', '笔'
    ],
    '交通': [
      '地铁', '公交', '打车', '滴滴', '高铁', '火车', '单车', '共享单车', '充电', '车费',
      '油费', '车票', '机票', '大巴', '出租车', '网约车', '交通卡', '地铁卡'
    ],
    '娱乐': [
      '游戏', '皮肤', '充值', '盲盒', '会员', 'VIP', '点卡', '点券', '抽卡', '手办',
      '演唱会', '桌游', '网吧', '电影', '剧本', '台球', '密室', '电竞', '追星', '周边',
      '爱奇艺', '腾讯视频', '网易云', '音乐', 'steam', 'Steam'
    ],
    '居住': [
      '住宿', '房租', '水电', '电费', '水费', '网费', '空调', '洗衣', '宿舍', '租房',
      '物业', '宽带'
    ],
    '医疗': [
      '医院', '挂号', '体检', '感冒', '口罩', '诊所', '看病', '退烧', '消炎', '眼药水',
      '疫苗', '药', '牙'
    ]
  };

  /** 情绪型（冲动）消费关键词 */
  var EMOTION_KEYWORDS = [
    '盲盒', '皮肤', '抽卡', '手办', '演唱会', '会员', '游戏', '夜宵', '宵夜', '奶茶',
    '咖啡', '星巴克', '打车', '限量', '联名', '冲动', '电影', 'KTV', '剧本杀', '密室',
    '网咖', '网吧', '周边', '追星', '充值', '鲜花', '口红', '冰淇淋', '雪糕'
  ];

  /** "想要"（非刚需）关键词：服装鞋包 / 数码 / 美妆 */
  var WANT_KEYWORDS = [
    '衣服', '鞋', '裤子', '裙子', '卫衣', '外套', '口红', '化妆', '护肤', '面膜',
    '耳机', '手办', '周边', '香水', '首饰', '手表', '盲盒', '皮肤', '背包', '书包',
    '双肩包', '手提包', '单肩包', '包包'
  ];

  /** 收入关键词（同时需要上下文，见 nlp.js detectIncome） */
  var INCOME_KEYWORDS = [
    '生活费', '到账', '兼职', '工资', '奖学金', '助学金', '家里打', '退款', '报销',
    '进账', '收入', '赚了'
  ];

  /** 收入分类名（与支出 9 分类并列，仅用于 type === 'income' 的账单） */
  var INCOME_CATEGORY = '收入';

  /** 收入来源枚举（录入表单 / 解析推断共用） */
  var INCOME_SOURCES = ['生活费', '兼职', '奖学金', '助学金', '红包', '退款', '其他'];

  /**
   * 收入来源推断关键词。
   * nlp.js 解析「收到生活费2000」「兼职赚了300」时按此表推断 source。
   */
  var INCOME_SOURCE_KEYWORDS = [
    { source: '兼职', keywords: ['兼职', '工资', '日结', '跑腿', '家教', '实习', '勤工'] },
    { source: '奖学金', keywords: ['奖学金', '国奖', '励志奖'] },
    { source: '助学金', keywords: ['助学金', '补助', '补贴', '贫困生'] },
    { source: '红包', keywords: ['红包', '压岁钱', '转账给我'] },
    { source: '退款', keywords: ['退款', '退回', '退货', '报销'] },
    { source: '生活费', keywords: ['生活费', '家里打', '打钱', '给我转'] },
    // 兜底：只出现「到账」时按生活费理解（放在最后，避免抢走「兼职到账」）
    { source: '生活费', keywords: ['到账'] }
  ];

  /**
   * 导入账单（支付宝 / 微信 / 银行）14 类 → 应用内分类映射。
   * 值为应用内分类名；`收入` 是特殊值（导入层会转成 type: 'income'）。
   * 未命中时由 analysis.js 回退到 nlp.classify()。
   */
  var BILL_CATEGORY_MAP = {
    '餐饮': '餐饮',
    '交通': '交通',
    '购物': '购物',
    '日用': '购物',
    '居住': '居住',
    '通讯': '居住',
    '医疗': '医疗',
    '教育': '学习',
    '娱乐': '娱乐',
    '人情往来': '社交',
    '收入': '收入',
    '其他': '其他',
    '转账': '其他',
    '还款': '其他'
  };

  /**
   * 导入时不参与消费统计的分类（给室友转账 / 还花呗不是消费）。
   * analysis.js 会把这些行标记 excluded: true，不计入支出与占比。
   */
  var BILL_EXCLUDED_CATEGORIES = ['转账', '还款', '信用还款', '信用卡还款', '转账红包', '投资理财', '借贷'];

  /** 日期词 → 相对今天的天数偏移 */
  var DATE_WORDS = [
    { word: '大前天', offset: -3 },
    { word: '前天', offset: -2 },
    { word: '昨晚', offset: -1 },
    { word: '昨早', offset: -1 },
    { word: '昨天', offset: -1 },
    { word: '今日', offset: 0 },
    { word: '今晚', offset: 0 },
    { word: '今早', offset: 0 },
    { word: '今天', offset: 0 },
    { word: '今儿', offset: 0 },
    { word: '刚才', offset: 0 }
  ];

  /** 餐段词 → 餐段名称 */
  var MEAL_WORDS = [
    { word: '早饭', meal: '早餐' },
    { word: '早餐', meal: '早餐' },
    { word: '早上', meal: '早餐' },
    { word: '早晨', meal: '早餐' },
    { word: '上午', meal: '早餐' },
    { word: '今早', meal: '早餐' },
    { word: '午饭', meal: '午餐' },
    { word: '午餐', meal: '午餐' },
    { word: '中饭', meal: '午餐' },
    { word: '中午', meal: '午餐' },
    { word: '下午', meal: '午餐' },
    { word: '晚饭', meal: '晚餐' },
    { word: '晚餐', meal: '晚餐' },
    { word: '晚上', meal: '晚餐' },
    { word: '今晚', meal: '晚餐' },
    { word: '傍晚', meal: '晚餐' },
    { word: '夜宵', meal: '夜宵' },
    { word: '宵夜', meal: '夜宵' }
  ];

  /**
   * 备注清洗停用词表。
   * 注意：刻意不包含 "和"，避免把 "和舍友AA聚餐" 洗成 "舍友AA聚餐"。
   */
  var STOP_WORDS = [
    '大前天', '今天', '昨天', '前天', '今日', '今晚', '今早', '昨晚', '昨早', '今儿', '刚才',
    '上午', '早晨', '早上', '中午', '下午', '傍晚', '晚上', '夜宵', '宵夜',
    '一共', '总共', '合计', '大概', '大约', '左右', '差不多', '大概其',
    '花了', '花费', '付了', '付款', '支付', '买了', '买', '入了', '消费了', '消费',
    '用了', '充了', '充值', '吃', '吃了', '喝', '喝了', '给了', '交了', '到账',
    '等了', '住了', '抽了',
    '人民币', '块钱', '块', '元', '毛', '角', '钱',
    '一杯', '一份', '一次', '一张', '一个', '一瓶', '一件', '一斤', '一袋', '一盒', '一碗', '一串',
    '杯', '份', '次', '张', '个', '瓶', '件', '斤', '袋', '盒', '碗', '串', '根', '双', '只', '顿',
    '的', '了', '我', '在', '是', '又', '还', '就', '才', '刚', '约', '了'
  ];

  /** 段首可安全剔除的连接词（不包含 "和"） */
  var LEADING_CONNECTORS = ['还有', '然后', '另外', '加上', '以及', '顺便', '再', '并且'];

  /**
   * 校园平替词典（14 条）。
   * save = 品牌参考价 brandPrice - altPrice（统一按单价计算，不跟随整笔实付金额）
   * times = 文案里"本周少 X 次"的次数，用于计算本周可省金额（save × times），
   *         必须与 timesText 的措辞严格一致。
   */
  var ALTERNATIVES = [
    {
      id: 'starbucks', keywords: ['星巴克', 'starbucks', '馥芮白'],
      brand: '星巴克', brandPrice: 32, altName: '三食堂现磨咖啡', altPrice: 10,
      unit: '杯', times: 2, timesText: '本周少喝两杯'
    },
    {
      id: 'luckin', keywords: ['瑞幸', '库迪', 'luckin', '幸运咖'],
      brand: '瑞幸/库迪', brandPrice: 19, altName: '食堂美式咖啡', altPrice: 6,
      unit: '杯', times: 2, timesText: '本周少喝两杯'
    },
    {
      id: 'chayi', keywords: ['喜茶', '奈雪', '霸王茶姬', '茶百道', '古茗', '沪上阿姨'],
      brand: '喜茶/奈雪', brandPrice: 22, altName: '食堂奶茶', altPrice: 6,
      unit: '杯', times: 2, timesText: '本周少喝两杯'
    },
    {
      id: 'milktea', keywords: ['奶茶'],
      brand: '奶茶', brandPrice: 15, altName: '自泡茶包', altPrice: 2,
      unit: '杯', times: 3, timesText: '本周少喝三杯'
    },
    {
      id: 'waimai', keywords: ['外卖', '美团', '饿了么'],
      brand: '外卖', brandPrice: 28, altName: '食堂两荤一素', altPrice: 12,
      unit: '顿', times: 3, timesText: '本周少点三次'
    },
    {
      id: 'taxi', keywords: ['打车', '滴滴', '出租车', '网约车'],
      brand: '打车', brandPrice: 23, altName: '校车/共享单车', altPrice: 1.5,
      unit: '次', times: 2, timesText: '本周少打两次'
    },
    {
      id: 'skin', keywords: ['皮肤', '抽卡', '充值', '点券', '点卡'],
      brand: '游戏充值', brandPrice: 99, altName: '等打折/二手账号', altPrice: 49,
      unit: '次', times: 1, timesText: '等一个折扣季'
    },
    {
      id: 'blindbox', keywords: ['盲盒', '手办', '谷子'],
      brand: '盲盒', brandPrice: 59, altName: '闲鱼二手', altPrice: 20,
      unit: '个', times: 1, timesText: '二手同款'
    },
    {
      id: 'movie', keywords: ['电影', '影院', '观影'],
      brand: '商业影院', brandPrice: 45, altName: '校园影院', altPrice: 8,
      unit: '张', times: 1, timesText: '校园影院一场'
    },
    {
      id: 'gym', keywords: ['健身房', '健身卡', '私教'],
      brand: '校外健身房', brandPrice: 199, altName: '学校体育馆', altPrice: 0,
      unit: '月', times: 1, timesText: '凭学生证免费'
    },
    {
      id: 'haircut', keywords: ['理发', '剪头', 'tony', 'Tony'],
      brand: '校外理发店', brandPrice: 68, altName: '学校理发店', altPrice: 15,
      unit: '次', times: 1, timesText: '校内一次'
    },
    {
      id: 'print', keywords: ['打印', '复印'],
      brand: '校外打印店', brandPrice: 1, altName: '图书馆自助打印', altPrice: 0.1,
      unit: '张', times: 1, timesText: '本周少打一次'
    },
    {
      id: 'snack', keywords: ['零食', '超市', '便利店'],
      brand: '超市零食', brandPrice: 25, altName: '食堂水果', altPrice: 5,
      unit: '份', times: 1, timesText: '食堂水果更便宜'
    },
    {
      id: 'coffee', keywords: ['咖啡'],
      brand: '校外咖啡', brandPrice: 28, altName: '食堂现磨咖啡', altPrice: 10,
      unit: '杯', times: 2, timesText: '本周少喝两杯'
    }
  ];

  /** 分类预算默认占比（用于 budgets.csv 的"预算金额"列） */
  var CATEGORY_BUDGET_RATIO = {
    '餐饮': 0.40,
    '社交': 0.12,
    '购物': 0.15,
    '学习': 0.08,
    '交通': 0.06,
    '娱乐': 0.10,
    '居住': 0.05,
    '医疗': 0.02,
    '其他': 0.02
  };

  /** 默认预算设置 */
  var DEFAULT_BUDGET = {
    total: 2000,
    payday: 1,
    cooldownThreshold: 50
  };

  /** 预置理财目标 */
  var DEFAULT_GOALS = [
    { id: 'goal_ipad', name: 'iPad', target: 3000, saved: 800, deadline: '2026-12-31' }
  ];

  /**
   * 演示种子账单（14 笔支出）。
   * offset 表示"距今几天"，由 app.js 在首次启动时换算成真实日期。
   */
  var SEED_BILLS = [
    { offset: 0, amount: 220, category: '餐饮', note: '食堂饭卡充值', motivation: '刚需', want: false },
    { offset: 0, amount: 18, category: '餐饮', note: '黄焖鸡米饭', motivation: '刚需', want: false },
    { offset: 1, amount: 26, category: '餐饮', note: '外卖麻辣烫', motivation: '刚需', want: false },
    { offset: 2, amount: 32, category: '餐饮', note: '星巴克拿铁', motivation: '情绪', want: false },
    { offset: 2, amount: 6, category: '餐饮', note: '蜜雪冰城柠檬水', motivation: '情绪', want: false },
    { offset: 3, amount: 128, category: '餐饮', note: '周末火锅', motivation: '刚需', want: false },
    { offset: 4, amount: 68, category: '社交', note: '和舍友AA聚餐', motivation: '刚需', want: false },
    { offset: 5, amount: 100, category: '社交', note: '社团生日份子', motivation: '刚需', want: false },
    { offset: 6, amount: 100, category: '交通', note: '地铁卡充值', motivation: '刚需', want: false },
    { offset: 7, amount: 23, category: '交通', note: '打车回学校', motivation: '情绪', want: false },
    { offset: 8, amount: 36.5, category: '学习', note: '打印资料和文具', motivation: '刚需', want: false },
    { offset: 9, amount: 99, category: '娱乐', note: '游戏皮肤充值', motivation: '情绪', want: false },
    { offset: 10, amount: 259, category: '购物', note: '淘宝卫衣', motivation: '刚需', want: true },
    { offset: 11, amount: 219, category: '购物', note: '蓝牙耳机', motivation: '情绪', want: true }
  ];

  /** 演示种子收入（1 笔，生活费） */
  var SEED_INCOME = {
    offset: 11,
    amount: 2000,
    category: '收入',
    source: '生活费',
    note: '生活费到账',
    motivation: '刚需',
    want: false,
    type: 'income'
  };

  /** 根据分类名取颜色 */
  function getCategoryColor(key) {
    var i;
    for (i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].key === key) {
        return CATEGORIES[i].color;
      }
    }
    return '#9AA3AD';
  }

  /** 分类 key 列表 */
  var CATEGORY_KEYS = CATEGORIES.map(function (c) { return c.key; });

  var DATA = {
    STORAGE_KEY: STORAGE_KEY,
    DATA_VERSION: DATA_VERSION,
    CATEGORIES: CATEGORIES,
    CATEGORY_KEYS: CATEGORY_KEYS,
    CATEGORY_KEYWORDS: CATEGORY_KEYWORDS,
    CATEGORY_BUDGET_RATIO: CATEGORY_BUDGET_RATIO,
    EMOTION_KEYWORDS: EMOTION_KEYWORDS,
    WANT_KEYWORDS: WANT_KEYWORDS,
    INCOME_KEYWORDS: INCOME_KEYWORDS,
    INCOME_CATEGORY: INCOME_CATEGORY,
    INCOME_SOURCES: INCOME_SOURCES,
    INCOME_SOURCE_KEYWORDS: INCOME_SOURCE_KEYWORDS,
    BILL_CATEGORY_MAP: BILL_CATEGORY_MAP,
    BILL_EXCLUDED_CATEGORIES: BILL_EXCLUDED_CATEGORIES,
    DATE_WORDS: DATE_WORDS,
    MEAL_WORDS: MEAL_WORDS,
    STOP_WORDS: STOP_WORDS,
    LEADING_CONNECTORS: LEADING_CONNECTORS,
    ALTERNATIVES: ALTERNATIVES,
    DEFAULT_BUDGET: DEFAULT_BUDGET,
    DEFAULT_GOALS: DEFAULT_GOALS,
    SEED_BILLS: SEED_BILLS,
    SEED_INCOME: SEED_INCOME,
    getCategoryColor: getCategoryColor
  };

  if (typeof window !== 'undefined') {
    window.AJ = window.AJ || {};
    window.AJ.data = DATA;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DATA;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
