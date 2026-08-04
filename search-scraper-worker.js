/**
 * 免费搜索引擎抓取代理（Cloudflare Worker）
 * --------------------------------------------------------------
 * 用途：纯前端无法直连搜索引擎（无 CORS + 反爬），本 Worker 在服务端抓取并解析结果页，
 *       返回结构化 JSON 给前端。全程【无需任何 API Key、零费用】。
 *
 * 默认引擎：Bing 中国（cn.bing.com）—— 国内可达、中英文覆盖都强、结果页无验证码、外链直出。
 * 也可用 360 搜索 / 搜狗（见下方 ENGINE 切换与对应解析函数）。百度最反爬（跳验证码），不推荐。
 *
 * 返回格式（与前端 _searchViaProxy 对齐）：
 *   { "results": [ { "title": "...", "url": "...", "content": "..." }, ... ] }
 *
 * 部署步骤（纯控制台，无需 CLI）：
 *   1. Cloudflare 控制台 → "Workers 和 Pages" → "创建" → 选 "Worker" → 命名（如 bobo-search）。
 *   2. 清空默认代码，粘贴本文件全部内容。
 *   3. 点 "部署"。得到地址 https://bobo-search.<子域>.workers.dev
 *   4. 把该地址发我，我写进前端 SEARCH_PROXY_URL 常量并重新发布即可。
 *
 * 注意：
 *   - 抓取搜索引擎通常违反其服务条款，个人低频次使用一般被默许；请勿高并发滥用。
 *   - 搜索引擎改版会导致解析失效，届时只需更新下方解析函数（已尽量容错）。
 *   - Cloudflare 机房 IP 偶尔可能被搜索引擎限流/弹验证码；如发生，可换 360/搜狗或加 Cookie。
 */

// 切换引擎：'bing' | 'so360' | 'sogou'
const ENGINE = 'bing';

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: cors });

    let body;
    try { body = await request.json(); } catch { return new Response('Bad Request', { status: 400, headers: cors }); }
    const query = (body && body.query) || '';
    if (!query) return new Response('Missing query', { status: 400, headers: cors });
    const max = Math.min(parseInt(body.max_results, 10) || 6, 10);

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
    let searchUrl, html;
    try {
      if (ENGINE === 'so360') {
        searchUrl = 'https://www.so.com/s?q=' + encodeURIComponent(query);
      } else if (ENGINE === 'sogou') {
        searchUrl = 'https://www.sogou.com/web?query=' + encodeURIComponent(query);
      } else {
        searchUrl = 'https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&mkt=zh-CN';
      }
      const r = await fetch(searchUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
      if (!r.ok) throw new Error('上游 HTTP ' + r.status);
      html = await r.text();
    } catch (e) {
      return new Response(JSON.stringify({ error: '抓取失败：' + e.message }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    let results = [];
    if (ENGINE === 'so360') results = parseSo360(html);
    else if (ENGINE === 'sogou') results = parseSogou(html);
    else results = parseBing(html);

    results = results.slice(0, max);
    return new Response(JSON.stringify({ results }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};

// ---------- 解析工具 ----------
function clean(s) {
  if (!s) return '';
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10))) // 数字实体
    .replace(/&[a-zA-Z]+;/g, ' ')                                       // 命名实体
    .replace(/<[^>]+>/g, ' ')                                           // 去标签
    .replace(/https?:\/\/\S+/g, '')                                      // 去残留 URL（面包屑）
    .replace(/\s+/g, ' ')
    .trim();
}

// Bing：结果块 <li class="b_algo">，标题为块内第一个外部 <a>，摘要为块内第一个 <p>
function parseBing(html) {
  const blocks = html.split('<li class="b_algo"').slice(1);
  const out = [];
  for (const b of blocks) {
    const links = [...b.matchAll(/<a\b[^>]*?\shref="(https?:\/\/[^"]+)"/g)]
      .map(m => m[1])
      .filter(u => !/r\.bing\.com|bing\.com\/ck\/a|bing\.com\/rp/i.test(u));
    if (!links.length) continue;
    const url = links[0];
    const tm = b.match(new RegExp('<a[^>]*href="' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>([\\s\\S]*?)</a>'));
    let title = tm ? clean(tm[1]) : '';
    if (title.includes('›')) title = title.split('›').pop().trim(); // 去掉面包屑
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const content = p ? clean(p[1]) : '';
    if (title && url) out.push({ title: title.slice(0, 100), url, content: content.slice(0, 300) });
  }
  return out;
}

// 360：结果块 <li class="res-list">，标题在 <h3><a href="...">，摘要在 <p class="res-desc">
function parseSo360(html) {
  const blocks = html.split('<li class="res-list"').slice(1);
  const out = [];
  for (const b of blocks) {
    const h = b.match(/<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!h) continue;
    let url = h[1];
    if (url.startsWith('/')) url = 'https://www.so.com' + url;
    const p = b.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/);
    const content = p ? clean(p[1]) : '';
    const title = clean(h[2]);
    if (title && url.startsWith('http')) out.push({ title: title.slice(0, 100), url, content: content.slice(0, 300) });
  }
  return out;
}

// 搜狗：结果块 <div class="rb"> 或 <div class="vrwrap">，标题在 <h3><a href="...">
function parseSogou(html) {
  const blocks = html.split(/<div class="(?:rb|vrwrap)"/).slice(1);
  const out = [];
  for (const b of blocks) {
    const h = b.match(/<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!h) continue;
    let url = h[1];
    if (url.startsWith('/')) url = 'https://www.sogou.com' + url;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const content = p ? clean(p[1]) : '';
    const title = clean(h[2]);
    if (title && url.startsWith('http')) out.push({ title: title.slice(0, 100), url, content: content.slice(0, 300) });
  }
  return out;
}
