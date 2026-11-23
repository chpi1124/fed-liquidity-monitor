// provider 共享层：只放「与具体官方源无关」的能力（带重试的取数、日期解析、ZIP/XLSX 容器读取、
// 官方历史接口的分窗与分页节奏）。下划线前缀的文件不是 provider，注册表会跳过它们。
// 各 provider 只声明「去哪个官方端点、怎么解析」，接入新官方源 = 新增一个 provider 文件（不改主程序）。
import zlib from "node:zlib";

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const usage = { calls: 0, bytes: 0 };
// 每轮更新前后各取一次差值 ⇒ fetch_run 里的 http_calls/bytes 是实测，不是估算
export function drainUsage() {
  const u = { ...usage };
  usage.calls = 0;
  usage.bytes = 0;
  return u;
}

export async function request(url, as, hdr) {
  let lastErr;
  const extra = typeof hdr === "string" ? { referer: hdr } : hdr || {};
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(60000),
        headers: {
          "user-agent": UA,
          accept: as === "json" ? "application/json" : as === "html" ? "text/html" : as === "buffer" ? "*/*" : "text/csv",
          ...extra,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (as === "buffer") {
        const buf = Buffer.from(await res.arrayBuffer());
        usage.calls++;
        usage.bytes += buf.length;
        return buf;
      }
      const body = await (as === "json" ? res.json() : res.text());
      usage.calls++;
      usage.bytes += typeof body === "string" ? body.length : JSON.stringify(body).length;
      return body;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw new Error(`${url} -> ${lastErr.message}`);
}

// MM/DD/YYYY -> YYYY-MM-DD
export function usDate(s) {
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

export function dayRange(start, end, stepMs) {
  const out = [];
  const endT = Date.parse(`${end}T00:00:00Z`);
  let cur = Date.parse(`${start}T00:00:00Z`);
  while (cur <= endT) {
    const winEnd = Math.min(cur + stepMs, endT);
    out.push([new Date(cur).toISOString().slice(0, 10), new Date(winEnd).toISOString().slice(0, 10)]);
    cur = winEnd + 86400000;
  }
  return out;
}

export function yearRange(start, end) {
  const out = [];
  const y0 = Number(start.slice(0, 4));
  const y1 = Number(end.slice(0, 4));
  for (let y = y0; y <= y1; y++) out.push(y);
  return out;
}

// 零依赖 ZIP 容器读取（XLSX 即 ZIP）
export function unzipEntries(b) {
  const eocd = b.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  if (eocd < 0) throw new Error("zip: central directory not found");
  const total = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < total; i++) {
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28);
    const elen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const lho = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + nlen).toString("utf8");
    const start = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    const raw = b.slice(start, start + csize);
    out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

export function xlsxSheet(buf, sheetName) {
  const f = unzipEntries(buf);
  const wb = (f["xl/workbook.xml"] || Buffer.from("")).toString("utf8");
  const rels = (f["xl/_rels/workbook.xml.rels"] || Buffer.from("")).toString("utf8");
  let target = null;
  for (const s of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = s[0];
    const name = (tag.match(/name="([^"]+)"/) || [])[1];
    const id = (tag.match(/r:id="rId(\d+)"/) || [])[1];
    if (name !== sheetName || !id) continue;
    for (const r of rels.matchAll(/<Relationship[^>]*>/g)) {
      const rt = r[0];
      if ((rt.match(/Id="rId(\d+)"/) || [])[1] !== id) continue;
      target = (rt.match(/Target="([^"]+)"/) || [])[1];
    }
  }
  if (!target) throw new Error(`xlsx: sheet "${sheetName}" not found`);
  const p = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const xml = (f[p] || Buffer.from("")).toString("utf8");
  const strings = [...(f["xl/sharedStrings.xml"] || Buffer.from("")).toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")
  );
  const rows = [...xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].map((m) => [Number(m[1]), m[2]]);
  const decode = (cellXml) => {
    const v = (cellXml.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    if (v == null) return null;
    return /t="s"/.test(cellXml) ? strings[Number(v)] ?? "" : v;
  };
  const cell = (rowXml, col) => {
    for (const m of rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (m[1] !== col) continue;
      return decode(`${m[2]}>${m[3] || ""}`);
    }
    return null;
  };
  return { rows, cell };
}

// PDF 文本抽取（零依赖：只解 FlateDecode 流里的 Tj/TJ 文本算子）
export function pdfText(buf) {
  const s = buf.toString("latin1");
  let textAll = "";
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const raw = Buffer.from(m[1].replace(/\r?\n$/, ""), "latin1");
    let out;
    try {
      out = zlib.inflateSync(raw);
    } catch {
      try {
        out = zlib.inflateRawSync(raw);
      } catch {
        continue;
      }
    }
    const txt = out.toString("latin1");
    const pieces = [...txt.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj|\[([^\]]*)\]\s*TJ/g)].map((mm) =>
      mm[1] != null ? mm[1] : [...mm[2].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((x) => x[1]).join("")
    );
    if (pieces.length) textAll += pieces.join(" ") + "\n";
  }
  return textAll.replace(/\s+/g, " ");
}
