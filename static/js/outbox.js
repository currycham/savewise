// 数据流向账：每次往服务器发和支出有关的数据（AI 用的汇总、复盘邮件、加密同步），在本机记一条，
// 用户可以在「隐私」页逐条翻看发出去的原文。只存在这台设备，不上传。
import * as store from "./store.js";

const MAX = 100;

export async function logUpload(kind, payload, note = "") {
  try {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 1);
    const list = (await store.get("outbox")) || [];
    list.push({ at: Date.now(), kind, note, size: text.length, content: text.slice(0, 60000) });
    await store.set("outbox", list.slice(-MAX));
  } catch { /* 记账失败不影响发送 */ }
}

export const readOutbox = async () => (await store.get("outbox")) || [];
export const clearOutbox = () => store.set("outbox", []);
