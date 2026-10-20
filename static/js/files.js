// 读用户选的文件：Excel / CSV 直接解析；微信、支付宝发到邮箱的是加密 zip，在浏览器里用密码解开再解析。
// 两个库都放在本站 /static/vendor 里，不走外部 CDN，用到时才加载。
import { parseFile } from "./parse.js";

const loaded = {};
function loadScript(src) {
  loaded[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`加载 ${src} 失败`));
    document.head.append(s);
  });
  return loaded[src];
}

async function xlsx() { await loadScript("/static/vendor/xlsx.full.min.js"); return window.XLSX; }
async function zipLib() {
  await loadScript("/static/vendor/zip.min.js");
  window.zip.configure({ useWebWorkers: false });
  return window.zip;
}

const DATA_FILE = /\.(csv|xlsx|xls|xlsm|txt)$/i;

// 解压 zip，返回 [{name, bytes}]；askPassword(name, wrong) 返回密码或 null（取消）
async function unzip(file, askPassword) {
  const zip = await zipLib();
  const reader = new zip.ZipReader(new zip.BlobReader(file));
  const entries = (await reader.getEntries()).filter((e) => !e.directory && DATA_FILE.test(e.filename) && !/__MACOSX/.test(e.filename));
  const out = [];
  let password;
  for (const e of entries) {
    for (let wrong = false; ;) {
      try {
        if (e.encrypted && password === undefined) {
          password = await askPassword(file.name, wrong);
          if (password === null) throw new Error("已取消");
        }
        const bytes = await e.getData(new zip.Uint8ArrayWriter(), e.encrypted ? { password } : {});
        out.push({ name: e.filename.split("/").pop(), bytes });
        break;
      } catch (err) {
        if (err.message === "已取消") { await reader.close(); throw err; }
        if (e.encrypted && /password|密码|Invalid/i.test(String(err.message || err))) { password = undefined; wrong = true; continue; }
        throw err;
      }
    }
  }
  await reader.close();
  return out;
}

// 返回 [{fileName, source, sheetName, txs, skipped, error}]
export async function readFiles(files, { askPassword }) {
  const results = [];
  for (const f of files) {
    try {
      const parts = /\.zip$/i.test(f.name) ? await unzip(f, askPassword) : [f];
      if (!parts.length) results.push({ fileName: f.name, txs: [], error: "压缩包里没有找到 CSV 或 Excel 文件" });
      for (const p of parts) {
        const needXlsx = /\.(xlsx|xls|xlsm)$/i.test(p.name);
        const sheets = await parseFile(p, needXlsx ? await xlsx() : null);
        if (!sheets.length) results.push({ fileName: p.name, txs: [], error: "没有认出交易记录" });
        for (const s of sheets) results.push({ fileName: p.name, ...s });
      }
    } catch (err) {
      results.push({ fileName: f.name, txs: [], error: err.message || String(err) });
    }
  }
  return results;
}
