/**
 * Tavily 搜索代理（Cloudflare Worker）
 * --------------------------------------------------------------
 * 作用：前端（GitHub Pages）无法直接调用 Tavily（Tavily 不开放 CORS，且 Key 不能暴露在前端）。
 *       本 Worker 作为代理：浏览器 -> 本 Worker -> Tavily；Key 只存在 Worker 端环境变量，前端不发 Key。
 * 免费：Cloudflare Workers 免费档每日 10 万次请求，无需信用卡。
 *
 * 部署步骤（无需 CLI，纯控制台）：
 *   1. 打开 https://dash.cloudflare.com → 左侧 "Workers 和 Pages" → "创建" → 选 "Worker" → 命名（如 bobo-search）。
 *   2. 在代码编辑器里清空默认代码，粘贴本文件全部内容。
 *   3. 点 "设置" → "变量" → 添加「环境变量」：
 *        - 名称：TAVILY_API_KEY   值：你的 Tavily Key（tvly-...）   【建议点"加密"设为密钥】
 *   4. 点 "部署"。部署后地址形如 https://bobo-search.<你的子域>.workers.dev
 *   5. 把该地址发给我，我写进前端的 SEARCH_PROXY_URL 常量并重新构建发布。
 *
 * 说明：Worker 已开启 CORS（Access-Control-Allow-Origin: *），允许 GitHub Pages 跨域调用；
 *       并正确处理浏览器对 POST+JSON 的 OPTIONS 预检请求。
 */

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // 处理 CORS 预检（浏览器对带 JSON 的 POST 会先发 OPTIONS）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400, headers: cors });
    }

    const query = (body && body.query) || '';
    if (!query) {
      return new Response('Missing query', { status: 400, headers: cors });
    }

    // 转发到 Tavily，Key 取自 Worker 环境变量（不出现在前端）
    const upstream = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (env.TAVILY_API_KEY || ''),
      },
      body: JSON.stringify({
        query,
        max_results: body.max_results || 6,
        search_depth: 'advanced',
        include_answer: false,
        include_raw_content: false,
      }),
    });

    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
