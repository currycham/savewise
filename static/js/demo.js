// 演示数据：一个虚构的上海双职工家庭（有房贷、一辆车、一个上小学的女儿、一只猫），2021-01 ~ 2026-10 的流水，
// 最近一年支出约 32 万。数字是编的：参照上海统计局公布的居民人均消费支出（2024 年上半年人均约 2.6 万），
// 按中等偏上的三口之家放大；分类用随手记的默认分类（早午晚餐、腐败聚会、按揭还款……）加几个家庭自己加的。
// 结构和真实导入的随手记数据一样，只为让没导入数据的人也能看到完整的效果。
import { pad, rng, ymd } from "./util.js";

const START = new Date(2021, 0, 1);
const END = new Date(2026, 9, 19);
const CAT = "2022-05";        // 养猫
const SCHOOL = "2024-09";     // 上小学
const LOCKDOWN = ["2022-04-01", "2022-05-31"];

// 每年生活水平的膨胀系数
const LIFESTYLE = { 2021: 0.85, 2022: 0.88, 2023: 0.95, 2024: 1.0, 2025: 1.06, 2026: 1.1 };

export function demoTransactions() {
  const r = rng(20211101);
  const between = (a, b) => a + (b - a) * r();
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const time = (h1, h2) => { const m = Math.floor(between(h1 * 60, h2 * 60)); return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; };
  const txs = [];
  const add = (date, amount, cat1, cat2, merchant, extra = {}) => txs.push({
    date, time: extra.time ?? time(9, 21), amount: Math.round(amount * 100) / 100, type: extra.type || "expense",
    cat1, cat2, merchant, note: extra.note || "", account: extra.account || pick(["交行信用卡", "微信", "支付宝"]),
    member: "", source: "demo",
  });

  for (let d = new Date(START); d <= END; d.setDate(d.getDate() + 1)) {
    const date = ymd(d);
    const ym = date.slice(0, 7);
    const y = d.getFullYear();
    const g = LIFESTYLE[y];
    const day = d.getDate();
    const md = date.slice(5);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const locked = date >= LOCKDOWN[0] && date <= LOCKDOWN[1];
    // 外卖这两年越点越多：孩子上学后工作日晚饭常常来不及做
    const takeout = ym >= "2026-01" ? 1.4 : ym >= "2025-01" ? 1.1 : 1;

    // ---------- 高频小额 ----------
    if (!weekend && !locked && r() < 0.6) add(date, between(26, 48) * g, "食品酒水", "早午晚餐", pick(["公司食堂", "全家", "老盛昌", "沙县小吃", "Wagas"]), { time: time(11.5, 13) });
    if (!locked && r() < 0.32 * g * takeout) add(date, between(30, 85) * g, "食品酒水", "外卖", pick(["美团外卖", "美团外卖", "饿了么"]), { time: r() < 0.4 ? time(11.3, 12.6) : time(18, 20.5) });
    if (!locked && r() < 0.5 * g) add(date, between(14, 34), "食品酒水", "饮料咖啡", pick(["瑞幸咖啡", "Manner", "星巴克", "茶百道", "霸王茶姬"]), { time: time(8.5, 16) });
    if (r() < (locked ? 0.7 : 0.42)) add(date, between(55, 210) * (locked ? 1.6 : 1) * g, "食品酒水", "买菜", locked ? pick(["小区团购", "叮咚买菜"]) : pick(["盒马", "叮咚买菜", "山姆会员店", "菜市场"]));
    if (r() < 0.22) add(date, between(18, 90), "食品酒水", "水果零食", pick(["百果园", "盒马", "来伊份"]));
    if (!locked && r() < (weekend ? 0.32 : 0.06)) add(date, between(180, 560) * g, "休闲娱乐", "腐败聚会", pick(["外婆家", "新荣记", "小杨生煎", "望湘园", "烧肉店"]), { time: time(11.5, 20.5) });
    if (!locked && r() < 0.18 * g) add(date, between(18, 70), "行车交通", "打车租车", pick(["滴滴出行", "高德打车"]));
    if (!weekend && !locked && r() < 0.55) add(date, between(4, 8), "行车交通", "公共交通", "上海地铁", { time: time(8, 9.5) });
    if (!locked && r() < (weekend ? 0.45 : 0.12)) add(date, between(8, 30), "行车交通", "私家车费用", pick(["停车", "停车", "ETC"]), { note: "停车/通行" });
    if (r() < 0.25 * g) add(date, between(19, 150), "居家物业", "日常用品", pick(["淘宝", "京东", "拼多多", "山姆会员店"]), { time: time(10, 23) });
    if (r() < 0.045 * g) add(date, between(150, 1200), "衣服饰品", "衣服裤子", pick(["优衣库", "天猫", "ZARA", "迪卡侬"]));
    if (r() < 0.02 * g) add(date, between(300, 1500), "衣服饰品", "鞋帽包包", pick(["耐克", "天猫", "Skechers"]));
    if (r() < 0.035 * g) add(date, between(100, 600), "衣服饰品", "化妆饰品", pick(["丝芙兰", "天猫", "屈臣氏"]));
    if (ym >= SCHOOL && r() < 0.08) add(date, between(25, 180), "子女教育", "文具绘本", pick(["当当", "京东", "晨光文具"]));
    if (r() < 0.03) add(date, between(40, 600), "医疗保健", "看病拿药", pick(["社区医院", "叮当快药", "儿童医院"]));
    if (!locked && r() < 0.05 * g) add(date, between(80, 480), "休闲娱乐", "休闲玩乐", pick(["猫眼", "上海博物馆", "迪士尼小镇", "万达影城", "亲子乐园"]));
    if (ym >= CAT && r() < 0.012) add(date, between(200, 1500), "休闲娱乐", "宠物宝贝", "宠物医院", { note: pick(["疫苗", "体检", "肠胃不舒服"]) });

    // ---------- 每月固定 ----------
    if (day === 15) add(date, ym >= "2024-07" ? 8900 : 9800, "金融保险", "按揭还款", "银行按揭", { account: "工资卡", note: ym === "2024-07" ? "提前还款后月供降低" : "" });
    if (day === 6) {
      add(date, between(280, 680) * (md < "03" || md >= "07" ? 1.2 : 1), "居家物业", "水电煤气", "国家电网/燃气", { account: "支付宝" });
      add(date, 410, "居家物业", "物业管理", "物业公司", { account: "支付宝" });
      add(date, 176, "交流通讯", "手机费", "中国移动", { account: "支付宝" });
      add(date, 99, "交流通讯", "上网费", "中国电信", { account: "支付宝" });
    }
    if ((day === 3 || day === 18) && !locked) add(date, between(320, 420) * g, "行车交通", "私家车费用", pick(["中石化", "中石油"]), { note: "加油" });
    if (day === 11 && ym >= CAT) add(date, between(180, 460), "休闲娱乐", "宠物宝贝", pick(["京东", "天猫", "淘宝"]), { note: "猫粮猫砂" });
    // 兴趣班：钢琴每月 4 节，后来又加了游泳、编程
    if (day === 1 && ym >= "2023-03") add(date, ym >= "2025-03" ? 1200 : 1000, "子女教育", "兴趣班", "钢琴老师", { account: "微信", note: "钢琴课 4 节" });
    if (ym >= "2024-04" && ["01-05", "04-05", "07-05", "10-05"].includes(md)) add(date, 2400, "子女教育", "兴趣班", "游泳馆", { note: "游泳季卡" });
    if (ym >= "2025-09" && (md === "09-08" || md === "02-26")) add(date, 6800, "子女教育", "兴趣班", "编程机构", { note: "少儿编程一学期" });
    if (ym >= SCHOOL && (md === "09-01" || md === "02-17")) add(date, 2600, "子女教育", "学杂费", "学校", { account: "工资卡", note: "学期杂费、午餐费" });

    // ---------- 订阅 ----------
    const sub = (cond, amount, name, note = "") => { if (cond) add(date, amount, "交流通讯", "会员订阅", name, { note, time: time(0, 7), account: pick(["支付宝", "微信"]) }); };
    sub(day === 9, 30, "腾讯视频");
    sub(day === 21 && ym >= "2023-02", 15, "网易云音乐");
    sub(day === 4, ym >= "2024-06" ? 68 : 21, "iCloud+", ym >= "2024-06" ? "2TB" : "200GB");
    sub(day === 13 && ym >= "2025-04", 25, "芒果TV");
    sub(day === 26 && ym >= "2025-06", 145, "ChatGPT", "Plus 订阅");
    sub(md === "03-02", 148, "B站大会员", "年度会员");
    sub(md === "06-10" && y >= 2022, 233, "知乎盐选", "年度会员");
    sub(md === "10-08" && y >= 2024, 199, "夸克网盘", "年费");
    if (md === "03-20" && y >= 2024) add(date, 4280, "休闲娱乐", "运动健身", "威尔仕健身", { note: "年卡", time: "19:40" });

    // ---------- 一年一次 / 偶发 ----------
    if (md === "04-15") add(date, y >= 2022 ? 18600 : 12600, "金融保险", "保险费", "家庭保险", { account: "工资卡", note: "重疾险、医疗险" });
    if (md === "09-12") add(date, y >= 2024 ? 4900 : 4500, "金融保险", "保险费", "车险", { account: "工资卡", note: "交强险+商业险" });
    if (md === "05-18" && y >= 2023) add(date, { 2023: 1600, 2024: 1900, 2025: 2300, 2026: 2600 }[y], "医疗保健", "体检", "体检中心", { note: "两人年度体检" });
    if (md === "06-20" || md === "12-20") add(date, between(800, 1300), "行车交通", "私家车费用", "4S 店", { note: "保养" });
    if (md === "01-25") add(date, 8000, "人情往来", "孝敬家长", "爸妈", { account: "微信", note: "过年" });
    if (md === "09-17") add(date, 2000, "人情往来", "孝敬家长", "爸妈", { account: "微信", note: "中秋" });
    if (r() < 0.02 * g) add(date, pick([200, 500, 500, 800, 1000]), "人情往来", "送礼请客", "微信红包", { account: "微信", note: pick(["同事结婚", "朋友孩子满月", "红包", "随礼"]) });
    if (r() < 0.012 * g) add(date, between(300, 1500), "人情往来", "送礼请客", pick(["京东", "天猫", "餐厅"]));
    if (r() < 0.006 * g) add(date, between(1500, 7000), "学习进修", "数码装备", pick(["Apple Store", "京东", "小米之家"]), { time: time(19, 23) });
    if (r() < 0.004 * g) add(date, between(1000, 5000), "居家物业", "家具家电", pick(["宜家", "京东", "苏宁"]));
  }

  // 旅行：每年几次，越来越多、越来越贵
  const trips = {
    2021: [["05-01", 0.6], ["10-02", 0.7]],
    2022: [["01-22", 0.6], ["10-01", 0.5]],
    2023: [["04-29", 0.8], ["07-22", 1], ["10-02", 0.8]],
    2024: [["02-10", 0.9], ["07-13", 1.1], ["10-01", 0.9]],
    2025: [["01-28", 1.1], ["05-01", 0.9], ["07-19", 1.3], ["10-03", 1]],
    2026: [["02-14", 1.2], ["05-01", 1], ["07-18", 1.4]],
  };
  const r2 = rng(11);
  for (const [y, list] of Object.entries(trips)) {
    for (const [md, k] of list) {
      const date = `${y}-${md}`;
      const city = ["厦门", "青岛", "成都", "大阪", "普吉岛", "西安"][Math.floor(r2() * 6)];
      add(date, (2600 + r2() * 2000) * k, "休闲娱乐", "旅游度假", "携程", { note: `${city} 机票` });
      add(date, (3000 + r2() * 2500) * k, "休闲娱乐", "旅游度假", "携程", { note: `${city} 酒店` });
      add(date, (1500 + r2() * 1500) * k, "休闲娱乐", "旅游度假", "当地消费", { note: `${city} 吃喝门票` });
    }
  }

  // 几笔大件
  const big = [
    ["2023-11-11", 3299, "居家物业", "家具家电", "京东", "扫地机器人"],
    ["2024-08-25", 2680, "子女教育", "兴趣班", "夏令营", "暑期营"],
    ["2025-05-03", 2680, "休闲娱乐", "运动健身", "迪卡侬", "公路自行车"],
    ["2025-10-26", 2399, "衣服饰品", "衣服裤子", "天猫", "羽绒服"],
    ["2026-03-08", 4999, "学习进修", "培训进修", "某职场课程", "PMP 备考课"],
    ["2026-04-18", 4599, "学习进修", "数码装备", "京东", "投影仪"],
    ["2026-07-06", 6800, "子女教育", "兴趣班", "夏令营", "暑期营"],
  ];
  for (const [date, amount, cat1, cat2, merchant, note] of big) add(date, amount, cat1, cat2, merchant, { note });

  // 收入与转账：让结余率和“转账不算支出”有东西可看
  for (let d = new Date(START); d <= END; d.setMonth(d.getMonth() + 1)) {
    const y = d.getFullYear();
    const ym = ymd(d).slice(0, 7);
    const grow = 1 + (y - 2021) * 0.04;
    add(`${ym}-10`, 21000 * grow, "职业收入", "工资", "公司A", { type: "income", account: "工资卡", time: "10:00" });
    add(`${ym}-12`, 15500 * grow, "职业收入", "工资", "公司B", { type: "income", account: "工资卡", time: "10:00" });
    if (ym.endsWith("-02")) add(`${ym}-25`, 50000 * grow, "职业收入", "年终奖", "公司A", { type: "income", account: "工资卡" });
    add(`${ym}-08`, 6000 + (y - 2021) * 600, "", "", "交行信用卡", { type: "transfer", note: "信用卡还款", account: "工资卡" });
  }

  return txs.map((t, i) => ({ ...t, id: `demo-${i}` }));
}
