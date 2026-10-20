// 演示数据：一个上海三口之家 6 年的流水（2020-11 ~ 2026-10），最近一年支出约 70 万。
// 数字是编的，只为让没导入数据的人也能看到完整的效果；结构和真实导入的数据一样。
import { pad, rng, ymd } from "./util.js";

const START = new Date(2020, 10, 1);
const END = new Date(2026, 9, 19);
const BABY = "2022-06";

// 每年生活水平的膨胀系数
const LIFESTYLE = { 2020: 0.7, 2021: 0.72, 2022: 0.82, 2023: 0.9, 2024: 0.95, 2025: 1.0, 2026: 1.03 };

export function demoTransactions() {
  const r = rng(20261020);
  const between = (a, b) => a + (b - a) * r();
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const time = (h1, h2) => { const m = Math.floor(between(h1 * 60, h2 * 60)); return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; };
  const txs = [];
  const add = (date, amount, cat1, cat2, merchant, extra = {}) => txs.push({
    date, time: extra.time ?? time(9, 21), amount: Math.round(amount * 100) / 100, type: extra.type || "expense",
    cat1, cat2, merchant, note: extra.note || "", account: extra.account || pick(["招行信用卡", "微信", "支付宝"]),
    member: "", source: "demo",
  });

  for (let d = new Date(START); d <= END; d.setDate(d.getDate() + 1)) {
    const date = ymd(d);
    const ym = date.slice(0, 7);
    const y = d.getFullYear();
    const g = LIFESTYLE[y];
    const day = d.getDate();
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const hasBaby = ym >= BABY;
    // 外卖最近两年明显变多：带娃之后懒得做饭
    const takeoutBoost = ym >= "2025-01" ? 1.35 : ym >= BABY ? 1.15 : 1;

    // ---------- 高频小额 ----------
    if (r() < 0.55 * g * takeoutBoost) {
      add(date, between(32, 95) * g, "食品酒水", "外卖", pick(["美团外卖", "美团外卖", "饿了么"]),
        { time: r() < 0.5 ? time(11.3, 12.6) : time(18, 20.5) });
    }
    if (r() < 0.6 * g) add(date, between(12, 38), "食品酒水", "咖啡奶茶", pick(["瑞幸咖啡", "星巴克", "喜茶", "霸王茶姬", "Manner"]), { time: time(8.5, 16) });
    if (r() < (weekend ? 0.45 : 0.1)) add(date, between(180, 650) * g, "食品酒水", "餐厅聚餐", pick(["海底捞", "西贝", "外婆家", "本帮菜馆", "日料店"]), { time: time(11.5, 20.5) });
    if (r() < 0.35) add(date, between(80, 320) * g, "食品酒水", "买菜", pick(["盒马", "叮咚买菜", "山姆会员店"]));
    if (r() < 0.2) add(date, between(25, 120), "食品酒水", "水果零食", pick(["百果园", "零食很忙", "盒马"]));
    if (r() < 0.38 * g) {
      const late = r() < 0.15;
      add(date, between(18, 75) * (late ? 1.6 : 1), "行车交通", "打车", "滴滴出行", { time: late ? time(22, 25) : time(8, 20) });
    }
    if (!weekend && r() < 0.5) add(date, between(3, 7), "行车交通", "地铁公交", "上海地铁", { time: time(8, 9.5) });
    if (r() < 0.3 * g) add(date, between(19, 189), "购物消费", "日用百货", pick(["淘宝", "京东", "拼多多", "京东"]), { time: time(10, 24) });
    if (r() < 0.06 * g) add(date, between(200, 1500), "购物消费", "衣服鞋包", pick(["优衣库", "天猫", "COS", "lululemon"]));
    if (hasBaby && r() < 0.13) add(date, between(40, 380), "宝宝", "玩具绘本", pick(["京东", "淘宝", "孩子王", "当当"]), { time: time(10, 23.5) });
    if (hasBaby && r() < 0.08) add(date, between(90, 600), "宝宝", "衣物用品", pick(["孩子王", "天猫", "Babycare"]));
    if (r() < 0.03) add(date, between(80, 900), "医疗保健", "看病买药", pick(["社区医院", "叮当快药", "妇幼医院"]));
    if (r() < 0.015 * g) add(date, between(150, 900), "休闲娱乐", "电影演出", pick(["猫眼", "大麦", "万达影城"]));

    // ---------- 每月固定 ----------
    if (day === 5) {
      add(date, ym >= "2023-01" ? 17000 : ym >= "2022-01" ? 15500 : 14000, "居家物业", "房租", "房东", { account: "工资卡", type: "expense" });
      add(date, between(550, 950), "居家物业", "物业水电", "国家电网/物业", { account: "支付宝" });
      add(date, 128, "通讯会员", "手机话费", "中国移动", { account: "支付宝" });
    }
    if (day === 10 && ym >= BABY) add(date, 3000, "居家物业", "家政阿姨", "王阿姨", { account: "微信" });
    if (day === 8 || day === 22) {
      // 保健品：带娃之后一路升级到每月 5000 左右
      const base = ym >= "2024-01" ? 2500 : ym >= "2023-01" ? 2000 : ym >= BABY ? 1500 : 750;
      add(date, between(0.92, 1.08) * base, "医疗保健", "保健品", pick(["天猫国际", "京东国际", "Swisse官方旗舰店"]), { time: time(20, 23.5) });
    }
    if ((day === 3 || day === 18) && ym >= BABY) add(date, between(900, 1100), "宝宝", "奶粉尿裤", "京东", { time: time(20, 23) });

    // ---------- 订阅 ----------
    const sub = (cond, amount, name, note = "") => { if (cond) add(date, amount, "通讯会员", "会员订阅", name, { note, time: time(0, 7), account: pick(["支付宝", "微信"]) }); };
    sub(day === 12, 30, "爱奇艺");
    sub(day === 16, 30, "腾讯视频");
    sub(day === 20 && ym >= "2021-03", 15, "QQ音乐");
    sub(day === 2, ym >= "2022-08" ? 68 : 21, "iCloud+", ym >= "2022-08" ? "2TB" : "200GB");
    sub(day === 9 && ym >= "2023-03", 99, "小步早教App", "月度会员");
    sub(day === 27 && ym >= "2024-05", 38, "Apple", "App 订阅");
    sub(day === 14 && ym >= "2025-02", 25, "优酷");
    const md = date.slice(5);
    sub(md === "03-15", 198, "Keep", "年度会员");
    sub(md === "08-03", 298, "百度网盘", "超级会员 年费");
    sub(md === "01-20", 365, "得到", "年度会员");
    sub(md === "11-06" && y >= 2023, 258, "喜马拉雅", "年卡");
    if (md === "09-01" && y >= 2023) add(date, 4800, "休闲娱乐", "运动健身", "乐刻健身", { note: "年卡", time: "21:40" });

    // ---------- 一年一次 / 偶发 ----------
    if (md === "04-10") add(date, y >= 2022 ? 28000 : 12000, "保险", "保险费", "平安人寿", { account: "工资卡" });
    if (md === "01-28" || (md === "02-05" && y % 2)) add(date, 10000, "人情往来", "孝敬父母", "爸妈", { account: "微信" });
    if (md === "09-15") add(date, 3000, "人情往来", "孝敬父母", "爸妈", { account: "微信", note: "中秋" });
    if (r() < 0.022 * g) add(date, pick([500, 800, 1000, 1000, 2000, 3000]), "人情往来", "礼金红包", "微信红包", { account: "微信", note: pick(["同事结婚", "朋友宝宝满月", "红包", "随礼"]) });
    if (r() < 0.012 * g) add(date, between(400, 1800), "人情往来", "请客送礼", pick(["京东", "天猫", "餐厅"]));
    if (r() < 0.008 * g) add(date, between(1500, 9000), "购物消费", "数码家电", pick(["Apple Store", "京东", "苏宁"]), { time: time(20, 24) });
    if (r() < 0.005 * g) add(date, between(1200, 6000), "购物消费", "家居家具", pick(["宜家", "无印良品", "天猫"]));
  }

  // 旅行：每年几次，越来越贵、越来越临时
  const trips = {
    2021: [["03-12", 0.6], ["10-02", 0.8]],
    2022: [["01-20", 0.7], ["10-01", 0.6]],
    2023: [["04-28", 0.9], ["07-20", 1], ["10-01", 0.9], ["12-22", 0.8]],
    2024: [["02-08", 1.1], ["05-01", 0.9], ["07-15", 1.2], ["10-01", 1]],
    2025: [["01-25", 1.2], ["05-01", 1], ["07-18", 1.4], ["10-01", 1.1], ["12-24", 1]],
    2026: [["02-14", 1.2], ["05-01", 1.1], ["07-20", 1.5]],
  };
  const r2 = rng(7);
  for (const [y, list] of Object.entries(trips)) {
    for (const [md, k] of list) {
      const date = `${y}-${md}`;
      const city = ["三亚", "大理", "京都", "成都", "新加坡", "清迈"][Math.floor(r2() * 6)];
      const lastMinute = r2() < 0.5;
      add(date, (5500 + r2() * 4000) * k * (lastMinute ? 1.3 : 1), "休闲娱乐", "旅游度假", "携程", { note: `${city} 机票${lastMinute ? "（临时订）" : ""}`, time: "22:10" });
      add(date, (6000 + r2() * 5000) * k, "休闲娱乐", "旅游度假", "携程", { note: `${city} 酒店`, time: "22:16" });
      add(date, (2500 + r2() * 2500) * k, "休闲娱乐", "旅游度假", "当地消费", { note: `${city} 吃喝门票` });
    }
  }

  // 情绪 / 冲动消费：深夜、带娃焦虑期、双 11
  const impulse = [
    ["2022-07-14", 8800, "医疗保健", "产后修复", "某产后修复中心", "产后焦虑，一冲动办了卡", "23:40"],
    ["2022-09-03", 6999, "学习进修", "课程书籍", "某成长营", "睡不着刷到的，焦虑", "00:20"],
    ["2023-01-08", 12800, "宝宝", "早教课程", "某早教中心", "怕孩子落后", "21:30"],
    ["2023-05-20", 3600, "购物消费", "衣服鞋包", "天猫", "奖励自己", "23:55"],
    ["2024-03-02", 9800, "宝宝", "早教课程", "某早教中心", "续课", "20:10"],
    ["2024-11-11", 3999, "购物消费", "数码家电", "天猫", "双11 戴森", "00:05"],
    ["2025-04-12", 15800, "宝宝", "早教课程", "某早教中心", "隔壁孩子都在上", "21:50"],
    ["2025-11-11", 3999, "购物消费", "数码家电", "天猫", "双11 吹风机，其实旧的还能用", "00:12"],
    ["2025-11-11", 2680, "购物消费", "衣服鞋包", "天猫", "双11 凑满减", "00:31"],
    ["2026-01-09", 4999, "学习进修", "课程书籍", "某AI训练营", "焦虑，冲动买的", "23:20"],
    ["2026-03-15", 16800, "宝宝", "早教课程", "某早教中心", "又续了一年，其实只去了一半", "20:40"],
    ["2026-06-18", 3200, "宝宝", "衣物用品", "Babycare", "618 推车升级", "23:35"],
    ["2026-08-30", 2600, "医疗保健", "保健品", "天猫国际", "看直播下单的新品", "22:50"],
  ];
  for (const [date, amount, cat1, cat2, merchant, note, t] of impulse) add(date, amount, cat1, cat2, merchant, { note, time: t });

  // 收入与转账：让结余率和“转账不算支出”有东西可看
  for (let d = new Date(START); d <= END; d.setMonth(d.getMonth() + 1)) {
    const y = d.getFullYear();
    const ym = ymd(d).slice(0, 7);
    const grow = 1 + (y - 2020) * 0.05;
    add(`${ym}-10`, 46000 * grow, "职业收入", "工资", "公司A", { type: "income", account: "工资卡", time: "10:00" });
    add(`${ym}-15`, 38000 * grow, "职业收入", "工资", "公司B", { type: "income", account: "工资卡", time: "10:00" });
    if (ym.endsWith("-02")) add(`${ym}-20`, 120000 * grow, "职业收入", "年终奖", "公司A", { type: "income", account: "工资卡" });
    add(`${ym}-08`, 15000 + (y - 2020) * 2000, "", "", "招行信用卡", { type: "transfer", note: "信用卡还款", account: "工资卡" });
  }

  return txs.map((t, i) => ({ ...t, id: `demo-${i}` }));
}
