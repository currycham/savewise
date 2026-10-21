// 账号与加密云同步。
// 密码只在浏览器里用：派生出两把钥匙——登录口令（发给服务器）和数据密钥（AES-GCM，只留在浏览器里）。
// 上传前把数据压缩、加密，服务器只存密文；没有密码谁也解不开，包括我们自己。
const enc = new TextEncoder();
const ITER = 200_000;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function deriveKeys(email, password) {
  email = email.trim().toLowerCase();
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits", "deriveKey"]);
  const params = (purpose) => ({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(`savewise-${purpose}|${email}`), iterations: ITER });
  const auth = hex(await crypto.subtle.deriveBits(params("auth"), base, 256));
  const key = await crypto.subtle.deriveKey(params("data"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { auth, key };
}

function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function seal(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const zipped = await pipe(enc.encode(JSON.stringify(obj)), new CompressionStream("gzip"));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, zipped));
  return { iv: toB64(iv), data: toB64(data) };
}

export async function unseal({ iv, data }, key) {
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(data));
  } catch {
    throw new Error("云端数据解不开（可能是在别处改过密码），请重新登录");
  }
  return JSON.parse(new TextDecoder().decode(await pipe(new Uint8Array(plain), new DecompressionStream("gzip"))));
}

export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof data.detail === "string" ? data.detail : res.status === 413 ? "数据太大了" : `请求失败（${res.status}）`;
    throw new ApiError(msg, res.status);
  }
  return data;
}

// 两份数据合并（第一次在有数据的设备上登录、或两台设备同时改过时）。冲突时 a（本机）优先。
// 流水按交易 ID 去重；复盘标记、分类覆盖等按键合并；冷静期按 ID 合并。
export function mergeBundles(a, b) {
  if (!b) return a;
  if (!a) return b;
  const datasets = [...(b.datasets || [])];
  const tx = { ...(b.tx || {}) };
  const seen = new Set(Object.values(tx).flat().map((t) => t.id));
  for (const d of a.datasets || []) {
    if (datasets.some((x) => x.id === d.id)) continue;
    const fresh = (a.tx?.[d.id] || []).filter((t) => !seen.has(t.id));
    if (!fresh.length) continue;
    fresh.forEach((t) => seen.add(t.id));
    const dates = fresh.map((t) => t.date).sort();
    datasets.push({ ...d, count: fresh.length, from: dates[0], to: dates[dates.length - 1] });
    tx[d.id] = fresh;
  }
  const out = { ...b, ...a, datasets, tx };
  for (const k of ["kinds", "statuses", "reviews", "cuts", "catOverrides", "goalChecks"]) out[k] = { ...(b[k] || {}), ...(a[k] || {}) };
  const byId = (xs, ys, key) => { const m = new Map(); for (const x of [...(ys || []), ...(xs || [])]) m.set(key(x), x); return [...m.values()]; };
  out.cooling = byId(a.cooling, b.cooling, (c) => c.id);
  out.recaps = byId(a.recaps, b.recaps, (r) => r.period);
  out.reports = byId(a.reports, b.reports, (r) => `${r.month}|${r.at}`).sort((x, y) => x.at - y.at);
  out.chatLog = a.chatLog?.length ? a.chatLog : b.chatLog || [];
  // 计划：手动改过的优先（auto=false），两边都改过就用本机的
  out.plan = a.plan && !a.plan.auto ? a.plan : b.plan && !b.plan.auto ? b.plan : a.plan || b.plan || null;
  return out;
}
