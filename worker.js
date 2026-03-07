// ============================================================
//  Cloudflare Worker — AI Chat Hub
//
//  环境变量（wrangler secret put）：
//    ADMIN_PASSWORD  — 登录密码（必须）
//
//  KV 绑定（wrangler.toml）：
//    [[kv_namespaces]]
//    binding = "AI_JOBS"   ← 对话历史云端持久化
//
//  Routes:
//    GET  /               → HTML 页面
//    POST /api/login      → 密码登录，返回 token
//    POST /               → 流式聊天        [需鉴权]
//    POST /api/vision     → 图片理解        [需鉴权]
//    POST /api/translate  → 翻译            [需鉴权]
//    GET  /api/history    → 读取云端历史    [需鉴权]
//    POST /api/history    → 保存云端历史    [需鉴权]
//    GET  /api/models     → 模型列表（KV 缓存）[需鉴权]
// ============================================================

// ── Token 签名（无状态，每日轮换） ──────────────────────────
async function signToken(password) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const data = new TextEncoder().encode(password + ":" + day);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyToken(token, password) {
  if (!token || !password) return false;
  const expected = await signToken(password);
  return token === expected;
}

function getToken(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

// ── Auth middleware ────────────────────────────────────────
async function requireAuth(request, env) {
  const token = getToken(request);
  const ok = await verifyToken(token, env.ADMIN_PASSWORD);
  if (!ok) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

// ── Route handler ─────────────────────────────────────────
export default {
  // ctx 参数让 ctx.waitUntil() 可在客户端断开后继续在 CF 后台执行
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;

    if (method === "GET" && url.pathname === "/") {
      return new Response(getHTML(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    if (method === "POST" && url.pathname === "/api/login") {
      return handleLogin(request, env);
    }

    // 以下路由全部需要鉴权
    const authErr = await requireAuth(request, env);
    if (authErr) return authErr;

    if (method === "POST" && url.pathname === "/")               return handleChatSubmit(request, env);
    if (method === "POST" && url.pathname === "/api/vision")    return handleVision(request, env);
    if (method === "POST" && url.pathname === "/api/translate") return handleTranslate(request, env);
    if (method === "GET"  && url.pathname === "/api/models")    return handleModels(request, env);
    if (method === "GET"  && url.pathname === "/api/history")   return handleHistoryGet(request, env);
    if (method === "POST" && url.pathname === "/api/history")   return handleHistoryPost(request, env);

    return new Response("Not Found", { status: 404 });
  },
};

// ── /api/login ─────────────────────────────────────────────
async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const { password } = body;
  if (!env.ADMIN_PASSWORD) {
    return Response.json({ error: "服务端未配置 ADMIN_PASSWORD" }, { status: 500 });
  }
  if (password !== env.ADMIN_PASSWORD) {
    return Response.json({ error: "密码错误" }, { status: 401 });
  }
  const token = await signToken(env.ADMIN_PASSWORD);
  return Response.json({ token });
}

// ── POST / → 直接 SSE 流式响应（最可靠方案）────────────────
// 放弃 KV 轮询：ctx.waitUntil 有 30s 墙钟限制，AI 推理超时后 KV 永远停在 running
// SSE 直接流式返回，前端实时显示 token，无需轮询
async function handleChatSubmit(request, env, ctx) {
  const body = await request.json();
  const { messages, model, system, max_tokens } = body;
  if (!messages || !messages.length) {
    return Response.json({ error: "messages 不能为空" }, { status: 400 });
  }

  const mdl    = model || "@cf/zai-org/glm-4.7-flash";
  const maxTok = Math.min(32768, Math.max(256, Number(max_tokens) || 8192));
  const params = { messages, stream: true, max_tokens: maxTok };
  if (system) params.system = system;

  try {
    const stream = await env.AI.run(mdl, params);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    // 部分模型不支持 system，去掉重试
    if (system) {
      try {
        delete params.system;
        const s2 = await env.AI.run(mdl, params);
        return new Response(s2, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      } catch (e2) {
        return Response.json({ error: e2.message }, { status: 500 });
      }
    }
    return Response.json({ error: e.message }, { status: 500 });
  }
}


// ── /api/vision ───────────────────────────────────────────
async function handleVision(request, env) {
  const { prompt, images } = await request.json();
  const imageList = Array.isArray(images) ? images : [];
  if (!imageList.length) {
    return Response.json({ response: "未收到图片数据" });
  }
  const userPrompt = prompt || "Describe this image in detail.";
  const results = await Promise.all(imageList.map(async (b64, idx) => {
    const imageArray = base64ToUint8Array(b64);
    const res = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
      image: [...imageArray],
      prompt: imageList.length > 1 ? `[图片 ${idx + 1}] ${userPrompt}` : userPrompt,
      max_tokens: 1024,
    });
    return (res.description || res.response || "").trim();
  }));
  const combined = imageList.length > 1
    ? results.map((r, i) => `**图片 ${i + 1}**\n${r}`).join("\n\n")
    : results[0];
  return Response.json({ response: combined });
}

// ── /api/translate ────────────────────────────────────────
async function handleTranslate(request, env) {
  const { text, source_lang, target_lang } = await request.json();
  const result = await env.AI.run("@cf/meta/m2m100-1.2b", {
    text,
    source_lang: source_lang || "en",
    target_lang: target_lang || "zh",
  });
  return Response.json({ translated_text: result.translated_text });
}

// ── /api/models (动态拉取 CF 官方模型文档·全类型) ──────────
const CF_AUTHOR_MAP = {
  'openai':'openai','meta':'meta','meta-llama':'meta-llama',
  'zai-org':'zai-org','ibm':'ibm','aisingapore':'aisingapore',
  'qwen':'qwen','google':'google','mistralai':'mistral',
  'deepseek':'deepseek-ai','nousresearch':'nousresearch',
  'microsoft':'microsoft','defog':'defog','tinyllama':'tinyllama',
  'openchat':'openchat','tiiuae':'tiiuae','nexusflow':'nexusflow',
  'thebloke':'thebloke','fblgit':'fblgit',
  'black forest labs':'black-forest-labs','leonardo':'leonardo',
  'deepgram':'deepgram','myshell-ai':'myshell-ai','pfnet':'pfnet',
  'pipecat-ai':'pipecat-ai','baai':'baai','huggingface':'huggingface',
  'ai4bharat':'ai4bharat','bytedance':'bytedance','lykon':'lykon',
  'runwayml':'runwayml','stability.ai':'stability-ai',
  'facebook':'facebook','llava-hf':'llava-hf','unum':'unum',
};

// 任务类型 → task key 映射
const TASK_MAP = {
  'Text Generation':             'text-gen',
  'Text-to-Image':               'text-to-image',
  'Text-to-Speech':              'tts',
  'Automatic Speech Recognition':'asr',
  'Text Embeddings':             'embedding',
  'Text Classification':         'classification',
  'Translation':                 'translation',
  'Image-to-Text':               'image-to-text',
  'Object Detection':            'object-detect',
  'Image Classification':        'image-classify',
  'Summarization':               'summarization',
  'Voice Activity Detection':    'vad',
};

// 任务类型 → 分组前缀
const TASK_GROUP = {
  'text-gen':       '💬 对话生成',
  'text-to-image':  '🖼️ 文生图',
  'tts':            '🔊 文字转语音',
  'asr':            '🎤 语音识别',
  'embedding':      '🔢 文本嵌入',
  'classification': '🔤 文本分类',
  'translation':    '🌐 翻译',
  'image-to-text':  '📸 图像理解',
  'object-detect':  '🔍 目标检测',
  'image-classify': '🔍 图像分类',
  'summarization':  '📝 摘要',
  'vad':            '🎙️ 语音活动检测',
};

async function handleModels(request, env) {
  // 先查 KV 缓存（30 分钟）
  if (env.AI_JOBS) {
    try {
      const cached = await env.AI_JOBS.get("models_cache");
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        if (Date.now() - ts < 30 * 60 * 1000) {
          return Response.json(data);
        }
      }
    } catch {}
  }
  try {
    const res = await fetch('https://developers.cloudflare.com/workers-ai/models/index.md', {
      headers: {'User-Agent':'CF-AI-Chat/1.0'},
      cf: {cacheTtl:1800, cacheEverything:true}
    });
    if (!res.ok) return Response.json({error:`fetch failed: ${res.status}`, ok:false});
    const md    = await res.text();
    const lines = md.split('\n');
    const models= [];
    const seen  = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 匹配所有 "任务类型 • Author" 格式（用 • U+2022 精确匹配）
      const m = line.match(/\[([^\u2022\]]+) \u2022 ([^\]]+)\]\(https:\/\/developers\.cloudflare\.com\/workers-ai\/models\/([^)]+)\)/);
      if (!m) continue;
      const taskRaw = m[1].trim();
      const author  = m[2].trim().toLowerCase();
      const slug    = m[3].trim();
      if (seen.has(slug)) continue;
      seen.add(slug);

      // 取后续 10 行
      const block = lines.slice(i, Math.min(i+10, lines.length)).join('\n');
      if (block.includes('* Deprecated')) continue;  // 跳过已弃用

      // 能力标签
      const caps = [];
      if (block.includes('* Batch'))            caps.push('batch');
      if (block.includes('* Function calling')) caps.push('fn');
      if (block.includes('* LoRA'))             caps.push('lora');
      if (block.includes('* Partner'))          caps.push('partner');
      if (block.includes('* Real-time'))        caps.push('realtime');

      // 描述
      let desc = '';
      for (let k = i+1; k < Math.min(i+5, lines.length); k++) {
        const dm = lines[k].match(/^\[([^\]]{15,})\]\(https:\/\/developers\.cloudflare/);
        if (dm) { desc = dm[1].slice(0,88); break; }
      }

      const taskKey = TASK_MAP[taskRaw] || 'other';
      const ns      = CF_AUTHOR_MAP[author] || author.replace(/\s+/g,'-');
      const modelId = '@cf/' + ns + '/' + slug;
      const group   = TASK_GROUP[taskKey] || '🤖 其他';

      // 智能标签（文本生成类才推断更多）
      const tags = [...new Set([...caps,
        ...(taskKey==='text-gen' ? [
          ...(slug.includes('vision')||slug.includes('llava') ? ['vision']:[]),
          ...(slug.includes('coder')||slug.includes('sql')    ? ['code'] :[]),
          ...(slug.includes('-r1') ||slug.includes('qwq')||slug.includes('-math') ? ['reason']:[]),
          ...(slug.match(/1b-|3b-|-micro|-fast|phi-2/)        ? ['fast'] :[]),
          ...(slug.match(/[0-9]+b/)&&parseInt(slug.match(/(\d+)b/)?.[1]||99)<=8 ? ['lite']:[]),
          ...(['meta','zai-org','qwen','google','mistralai','aisingapore'].includes(author)?['multi']:[]),
        ] : []),
      ])].slice(0,5);

      // 显示名：slug → 可读化
      const name = slug.replace(/-instruct$/,'').split('-')
        .map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ')
        .replace(/Fp8/g,'FP8').replace(/Fp16/g,'FP16')
        .replace(/Int8/g,'INT8').replace(/Awq/g,'AWQ')
        .replace(/Bf16/g,'BF16').replace(/Sql/g,'SQL')
        .replace(/Gpt Oss/g,'GPT-OSS').replace(/Glm/g,'GLM')
        .replace(/Qwq/g,'QwQ').trim();

      models.push({ id:modelId, name, slug, desc, group, task:taskKey, tags });
    }

    const result = { ok:true, models, count:models.length,
      byTask: Object.fromEntries(
        Object.entries(TASK_GROUP).map(([k,v])=>[k, models.filter(m=>m.task===k).length])
      )
    };
    // 写入 KV 缓存
    if (env.AI_JOBS) {
      env.AI_JOBS.put("models_cache", JSON.stringify({ data: result, ts: Date.now() }),
        { expirationTtl: 3600 }).catch(() => {});
    }
    return Response.json(result);
  } catch(e) {
    return Response.json({ error:e.message, ok:false });
  }
}

// ── /api/history GET/POST：KV 云端对话历史 ──────────────────
// KV binding: AI_JOBS（binding = "AI_JOBS" in wrangler.toml）
// Key: "history"，存储完整 chatHistory JSON 数组

async function handleHistoryGet(request, env) {
  if (!env.AI_JOBS) return Response.json({ history: [], kv: false });
  try {
    const raw = await env.AI_JOBS.get("history");
    const history = raw ? JSON.parse(raw) : [];
    return Response.json({ history, kv: true });
  } catch (e) {
    return Response.json({ history: [], error: e.message });
  }
}

async function handleHistoryPost(request, env) {
  if (!env.AI_JOBS) return Response.json({ ok: false, kv: false });
  try {
    const { history } = await request.json();
    if (!Array.isArray(history)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    await env.AI_JOBS.put("history", JSON.stringify(history), { expirationTtl: 60 * 60 * 24 * 30 }); // 30 天
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: e.message });
  }
}

// ── helpers ───────────────────────────────────────────────
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

// ============================================================
//  FRONTEND HTML
// ============================================================
function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CF · AI Chat</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Sora:wght@300;400;500;600&display=swap" rel="stylesheet" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:#0d0f14; --surface:#13161e; --surface2:#1c2030; --border:#252a3a;
      --accent:#e8a045; --accent2:#5b8af0; --danger:#e05a5a; --success:#4caf8a;
      --text:#dde2f0; --muted:#6b7491; --code-bg:#0a0c11;
      --radius:10px; --mono:'DM Mono',monospace; --sans:'Sora',sans-serif;
    }
    html{height:100%;height:-webkit-fill-available;}
    body{font-family:var(--sans);background:var(--bg);color:var(--text);
         display:flex;flex-direction:column;
         height:100vh;height:100dvh;          /* dvh 适配移动端动态地址栏 */
         overflow:hidden;
         padding-bottom:env(safe-area-inset-bottom); /* iOS 安全区 */}

    /* LOGIN */
    #login-page{position:fixed;inset:0;z-index:100;background:var(--bg);
                display:flex;align-items:center;justify-content:center;}
    .login-card{width:360px;background:var(--surface);border:1px solid var(--border);
                border-radius:16px;padding:40px 36px;display:flex;flex-direction:column;
                gap:22px;box-shadow:0 24px 64px rgba(0,0,0,.5);}
    .login-logo{font-family:var(--mono);font-size:22px;color:var(--accent);
                letter-spacing:.1em;text-align:center;}
    .login-logo span{color:var(--muted);}
    .login-logo small{display:block;font-size:11px;color:var(--muted);margin-top:6px;letter-spacing:.05em;}
    .login-field{display:flex;flex-direction:column;gap:8px;}
    .login-field label{font-size:11px;font-family:var(--mono);color:var(--muted);}
    .login-field input{background:var(--surface2);border:1px solid var(--border);
                       border-radius:8px;color:var(--text);font-family:var(--mono);
                       font-size:14px;padding:12px 14px;outline:none;
                       transition:border-color .2s;letter-spacing:.05em;}
    .login-field input:focus{border-color:var(--accent);}
    .login-btn{width:100%;padding:13px;background:var(--accent);border:none;
               border-radius:8px;color:#0d0f14;font-family:var(--mono);
               font-size:14px;font-weight:500;cursor:pointer;
               letter-spacing:.06em;transition:opacity .2s;}
    .login-btn:hover{opacity:.88;} .login-btn:disabled{opacity:.45;cursor:default;}
    .login-err{font-size:12px;color:var(--danger);font-family:var(--mono);
               text-align:center;min-height:16px;}


    /* APP */
    #app{display:flex;flex-direction:column;height:100%;min-height:0;}
    header{display:flex;align-items:center;gap:14px;padding:12px 20px;
           border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0;}
    .logo{font-family:var(--mono);font-size:15px;font-weight:500;
          color:var(--accent);letter-spacing:.08em;}
    .logo span{color:var(--muted);}
    .mode-tabs{display:flex;gap:6px;margin-left:auto;}
    .mode-tab{font-family:var(--mono);font-size:12px;padding:5px 14px;
              border-radius:999px;border:1px solid var(--border);background:transparent;
              color:var(--muted);cursor:pointer;transition:all .2s;
              display:flex;align-items:center;gap:6px;}
    .mode-tab:hover{border-color:var(--accent);color:var(--accent);}
    .mode-tab.active{background:var(--accent);border-color:var(--accent);
                     color:#0d0f14;font-weight:500;}
    .mode-tab svg{width:13px;height:13px;}
    .logout-btn{font-family:var(--mono);font-size:11px;padding:5px 12px;
                border-radius:999px;border:1px solid var(--border);background:transparent;
                color:var(--muted);cursor:pointer;transition:all .2s;margin-left:8px;}
    .logout-btn:hover{border-color:var(--danger);color:var(--danger);}

    .model-bar{padding:7px 20px;border-bottom:1px solid var(--border);
               background:var(--surface);display:flex;align-items:center;
               gap:10px;flex-shrink:0;position:relative;}
    .model-bar label{font-size:11px;color:var(--muted);font-family:var(--mono);white-space:nowrap;}
    .model-bar-hint{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;}
    .refresh-models-btn{display:flex;align-items:center;gap:4px;font-family:var(--mono);font-size:11px;
                        padding:3px 8px;border-radius:6px;border:1px solid var(--border);
                        background:transparent;color:var(--muted);cursor:pointer;
                        transition:all .2s;white-space:nowrap;flex-shrink:0;}
    .refresh-models-btn:hover{border-color:var(--accent2);color:var(--accent2);}
    .refresh-models-btn.loading{opacity:.6;pointer-events:none;}
    .refresh-models-btn.loading svg{animation:spin .8s linear infinite;}
    /* 自定义模型选择器 */
    .model-picker{position:relative;flex:1;max-width:480px;}
    .model-trigger{display:flex;align-items:center;gap:8px;width:100%;
                   background:var(--surface2);border:1px solid var(--border);border-radius:6px;
                   color:var(--text);font-family:var(--mono);font-size:12px;
                   padding:5px 10px;cursor:pointer;outline:none;transition:border-color .2s;text-align:left;}
    .model-trigger:hover,.model-trigger.open{border-color:var(--accent);}
    .model-trigger-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .model-trigger-tags{display:flex;gap:4px;flex-shrink:0;}
    .model-trigger-arrow{width:14px;height:14px;flex-shrink:0;transition:transform .2s;}
    .model-trigger.open .model-trigger-arrow{transform:rotate(180deg);}
    .model-dropdown{display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;
                    background:var(--surface);border:1px solid var(--border);border-radius:8px;
                    box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:200;overflow:hidden;
                    min-width:320px;}
    .model-dropdown.open{display:block;}
    .model-search-wrap{padding:8px 10px;border-bottom:1px solid var(--border);}
    .model-search{width:100%;background:var(--surface2);border:1px solid var(--border);
                  border-radius:6px;color:var(--text);font-family:var(--mono);font-size:12px;
                  padding:6px 10px;outline:none;transition:border-color .2s;}
    .model-search:focus{border-color:var(--accent);}
    .model-list{max-height:320px;overflow-y:auto;padding:6px 0;
                scrollbar-width:thin;scrollbar-color:var(--border) transparent;}
    .model-group-label{padding:6px 12px 3px;font-family:var(--mono);font-size:10px;
                       color:var(--muted);letter-spacing:.06em;text-transform:uppercase;}
    .model-item{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;
                transition:background .15s;border-left:2px solid transparent;}
    .model-item:hover{background:var(--surface2);}
    .model-item.selected{background:rgba(232,160,69,.08);border-left-color:var(--accent);}
    .model-item-name{flex:1;font-family:var(--mono);font-size:12px;color:var(--text);
                     overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .model-item-desc{font-size:10px;color:var(--muted);font-family:var(--sans);
                     white-space:nowrap;flex-shrink:0;max-width:140px;overflow:hidden;
                     text-overflow:ellipsis;}
    .model-tags{display:flex;gap:3px;flex-shrink:0;}
    .tag{font-size:10px;padding:1px 5px;border-radius:4px;font-family:var(--mono);
         border:1px solid;white-space:nowrap;}
    .tag-fast  {color:#4caf8a;border-color:#4caf8a33;background:#4caf8a11;}
    .tag-reason{color:#5b8af0;border-color:#5b8af033;background:#5b8af011;}
    .tag-code  {color:#e8a045;border-color:#e8a04533;background:#e8a04511;}
    .tag-vision{color:#c678dd;border-color:#c678dd33;background:#c678dd11;}
    .tag-sql   {color:#56b6c2;border-color:#56b6c233;background:#56b6c211;}
    .tag-lite  {color:#6b7491;border-color:#6b749133;background:#6b749111;}
    .tag-multi {color:#e06c75;border-color:#e06c7533;background:#e06c7511;}
    .tag-fn    {color:#e5c07b;border-color:#e5c07b33;background:#e5c07b11;}
    .tag-batch {color:#56b6c2;border-color:#56b6c233;background:#56b6c211;}
    .tag-lora    {color:#c678dd;border-color:#c678dd33;background:#c678dd11;}
    .tag-partner {color:#98c379;border-color:#98c37933;background:#98c37911;}
    .thinking-dots{display:inline-flex;gap:4px;align-items:center;padding:4px 0;}
    .thinking-dots span{width:6px;height:6px;border-radius:50%;background:var(--accent2);
      animation:dot-blink 1.2s ease-in-out infinite;}
    .thinking-dots span:nth-child(2){animation-delay:.2s;}
    .thinking-dots span:nth-child(3){animation-delay:.4s;}
    @keyframes dot-blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
    .job-status{color:var(--muted);font-size:12px;display:inline-flex;align-items:center;}
    .spin-icon{animation:spin .9s linear infinite;}
    .tag-realtime{color:#61afef;border-color:#61afef33;background:#61afef11;}
    .model-item-nonchat{opacity:.75;}
    .model-item-nonchat:hover{opacity:1;}
    .task-hint{font-size:10px;color:var(--muted);font-weight:normal;}

    @keyframes spin{to{transform:rotate(360deg);}}

    #messages{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:20px 0;display:flex;
              flex-direction:column;gap:2px;
              scrollbar-width:thin;scrollbar-color:var(--border) transparent;}
    .msg-wrap{display:flex;padding:0 20px;animation:fadeUp .22s ease both;min-width:0;}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    .msg-wrap.user{justify-content:flex-end;}
    .bubble{max-width:72%;padding:11px 15px;border-radius:var(--radius);
            font-size:14px;line-height:1.7;word-break:break-word;
            overflow-wrap:break-word;min-width:0;box-sizing:border-box;}
    .bubble.user{background:var(--accent);color:#0d0f14;border-bottom-right-radius:3px;
                 min-width:0;box-sizing:border-box;}
    /* 用户纯文本：保留换行，强制折行，不溢出 */
    .bubble.user .user-text{
      white-space:pre-wrap;
      overflow-wrap:break-word;
      word-break:break-word;
      max-width:100%;
    }
    /* 折叠信息栏 */
    .collapse-meta{display:flex;align-items:center;gap:8px;margin-top:6px;
                   padding-top:6px;border-top:1px solid rgba(0,0,0,.15);}
    .collapse-len{font-size:11px;opacity:.6;font-family:var(--mono);}
    .collapse-btn{background:rgba(0,0,0,.12);border:none;color:inherit;
                  border-radius:4px;padding:2px 8px;font-size:11px;
                  cursor:pointer;font-family:var(--mono);}
    .collapse-btn:hover{background:rgba(0,0,0,.22);}
    .bubble.user .user-actions{opacity:0;transition:opacity .15s;}
    .bubble.user:hover .user-actions{opacity:1;}
    .bubble.user .bubble-action-btn{color:#0d0f1488;border-color:#0d0f1422;}
    .bubble.user .bubble-action-btn:hover{color:#0d0f14;background:#0d0f1411;}
    .bubble.user .bubble-action-btn.copied{color:#0d0f14;}
    .bubble.assistant{background:var(--surface2);border:1px solid var(--border);
                      color:var(--text);border-bottom-left-radius:3px;}
    .bubble pre{background:var(--code-bg);border:1px solid var(--border);border-radius:6px;
                padding:11px;margin:10px 0;overflow-x:auto;font-family:var(--mono);
                font-size:12px;line-height:1.6;}
    .bubble code{font-family:var(--mono);font-size:12px;background:var(--code-bg);
                 padding:1px 5px;border-radius:4px;}
    .bubble pre code{background:none;padding:0;}
    .bubble img.preview{max-width:220px;border-radius:6px;margin-bottom:8px;display:block;}
    .cursor-blink{display:inline-block;width:2px;height:14px;background:var(--accent);
                  margin-left:2px;vertical-align:middle;animation:blink .7s step-end infinite;}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
    @keyframes spin{to{transform:rotate(360deg)}}

    #translate-panel{display:none;flex:1;min-height:0;padding:20px;gap:14px;
                     flex-direction:column;overflow:hidden;}
    .trans-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;}
    .trans-select{font-family:var(--mono);font-size:12px;background:var(--surface2);
                  color:var(--text);border:1px solid var(--border);border-radius:6px;
                  padding:6px 10px;outline:none;}
    .trans-select:focus{border-color:var(--accent2);}
    .trans-swap{background:none;border:1px solid var(--border);color:var(--muted);
                border-radius:6px;padding:6px 10px;cursor:pointer;font-size:15px;transition:all .2s;}
    .trans-swap:hover{border-color:var(--accent2);color:var(--accent2);}
    .trans-areas{display:flex;gap:14px;flex:1;min-height:0;}
    .trans-box{flex:1;display:flex;flex-direction:column;gap:7px;}
    .trans-box label{font-size:11px;color:var(--muted);font-family:var(--mono);}
    .trans-box textarea{flex:1;background:var(--surface2);border:1px solid var(--border);
                        border-radius:var(--radius);color:var(--text);font-family:var(--sans);
                        font-size:14px;padding:13px;resize:none;outline:none;line-height:1.7;
                        transition:border-color .2s;}
    .trans-box textarea:focus{border-color:var(--accent2);}
    #trans-result{background:var(--surface);}
    .trans-btn{align-self:flex-start;background:var(--accent2);color:#fff;border:none;
               border-radius:8px;padding:7px 22px;font-family:var(--mono);font-size:13px;
               cursor:pointer;transition:opacity .2s;}
    .trans-btn:hover{opacity:.85;} .trans-btn:disabled{opacity:.4;cursor:default;}

    #input-area{padding:12px 20px 16px;border-top:1px solid var(--border);
                background:var(--surface);flex-shrink:0;min-width:0;overflow:hidden;}
    .upload-preview{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;}
    .upload-chip{display:flex;align-items:center;gap:6px;background:var(--surface2);
                 border:1px solid var(--border);border-radius:6px;padding:3px 9px;
                 font-family:var(--mono);font-size:11px;color:var(--muted);}
    .upload-chip button{background:none;border:none;color:var(--danger);
                        cursor:pointer;font-size:13px;line-height:1;padding:0;}
    .upload-chip img{width:26px;height:26px;object-fit:cover;border-radius:3px;}
    .input-row{display:flex;align-items:flex-end;gap:10px;}
    .input-row textarea{flex:1;background:var(--surface2);border:1px solid var(--border);
                        border-radius:var(--radius);color:var(--text);font-family:var(--sans);
                        font-size:14px;padding:11px 13px;resize:none;outline:none;
                        line-height:1.6;max-height:160px;transition:border-color .2s;}
    .input-row textarea:focus{border-color:var(--accent);}
    .input-row textarea::placeholder{color:var(--muted);}
    .toolbar{display:flex;flex-direction:column;gap:6px;}
    .icon-btn{width:38px;height:38px;display:flex;align-items:center;justify-content:center;
              border-radius:8px;border:1px solid var(--border);background:var(--surface2);
              color:var(--muted);cursor:pointer;transition:all .2s;}
    .icon-btn:hover{border-color:var(--accent);color:var(--accent);}
    .icon-btn.send{background:var(--accent);border-color:var(--accent);color:#0d0f14;}
    .icon-btn.send:hover{opacity:.85;} .icon-btn.send:disabled{opacity:.4;cursor:default;}
    .icon-btn svg{width:17px;height:17px;}
    #file-input{display:none;}
    .empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;
                 height:100%;gap:12px;color:var(--muted);text-align:center;}
    .empty-state .big{font-size:40px;}
    .empty-state h2{font-size:17px;font-weight:500;color:var(--text);}
    .empty-state p{font-size:13px;line-height:1.7;max-width:360px;}
    .suggestions{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;margin-top:8px;}
    .suggestion{font-family:var(--mono);font-size:12px;padding:5px 13px;
                border:1px solid var(--border);border-radius:999px;
                cursor:pointer;transition:all .2s;color:var(--muted);}
    .suggestion:hover{border-color:var(--accent);color:var(--accent);}
    a{color:var(--accent2);text-decoration:none;}
    /* 翻译历史 */
    .trans-history{display:flex;flex-direction:column;gap:6px;max-height:130px;overflow-y:auto;
                   padding-top:8px;border-top:1px solid var(--border);margin-top:4px;
                   scrollbar-width:thin;scrollbar-color:var(--border) transparent;}
    .trans-history-item{display:flex;gap:8px;align-items:flex-start;padding:6px 8px;
                         background:var(--surface2);border-radius:6px;font-size:12px;
                         font-family:var(--mono);cursor:pointer;transition:border .2s;
                         border:1px solid transparent;}
    .trans-history-item:hover{border-color:var(--accent2);}
    .trans-history-item .src{color:var(--muted);flex:1;overflow:hidden;
                              white-space:nowrap;text-overflow:ellipsis;}
    .trans-history-item .arr{color:var(--border);flex-shrink:0;}
    .trans-history-item .tgt{color:var(--text);flex:1;overflow:hidden;
                              white-space:nowrap;text-overflow:ellipsis;}
    /* System prompt 区域 */
    .sys-prompt-wrap{padding:6px 20px;border-bottom:1px solid var(--border);
                     background:var(--bg);flex-shrink:0;display:flex;align-items:center;gap:8px;}
    .sys-prompt-wrap label{font-size:11px;color:var(--muted);font-family:var(--mono);white-space:nowrap;}
    .sys-prompt-wrap input{flex:1;background:var(--surface2);border:1px solid var(--border);
                            border-radius:6px;color:var(--text);font-family:var(--mono);
                            font-size:12px;padding:4px 10px;outline:none;transition:border-color .2s;}
    .sys-prompt-wrap input:focus{border-color:var(--accent);}
    .sys-prompt-wrap input::placeholder{color:var(--muted);}
    .max-tokens-sel{flex-shrink:0;background:var(--surface2);border:1px solid var(--border);border-radius:5px;color:var(--muted);font-family:var(--mono);font-size:11px;padding:2px 6px;cursor:pointer;outline:none;height:26px;}
    .max-tokens-sel:hover,.max-tokens-sel:focus{border-color:var(--accent2);color:var(--accent2);}
    /* marked.js 输出样式 */
    .bubble table{border-collapse:collapse;width:100%;margin:.5em 0;font-size:13px;}
    .bubble th,.bubble td{border:1px solid var(--border);padding:5px 10px;text-align:left;}
    .bubble th{background:var(--surface);color:var(--accent);}
    .bubble ul,.bubble ol{margin:.3em 0 .3em 1.3em;}
    .bubble li{margin:.15em 0;}
    .bubble blockquote{border-left:3px solid var(--accent2);padding-left:10px;
                        color:var(--muted);margin:.4em 0;}

    /* header 图标按钮 */
    .icon-hdr-btn{width:32px;height:32px;display:flex;align-items:center;justify-content:center;
                  border-radius:8px;border:1px solid var(--border);background:transparent;
                  color:var(--muted);cursor:pointer;transition:all .2s;}
    .icon-hdr-btn:hover{border-color:var(--accent);color:var(--accent);}
    .icon-hdr-btn svg{width:15px;height:15px;}

    /* 气泡操作栏 */
    .bubble-actions{display:flex;gap:4px;margin-top:8px;opacity:0;transition:opacity .2s;}
    .msg-wrap:hover .bubble-actions{opacity:1;}
    .bubble-action-btn{font-family:var(--mono);font-size:11px;padding:3px 8px;
                       border-radius:5px;border:1px solid var(--border);background:transparent;
                       color:var(--muted);cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:4px;}
    .bubble-action-btn:hover{border-color:var(--accent2);color:var(--accent2);background:rgba(91,138,240,.08);}
    .bubble-action-btn.copied{border-color:var(--success);color:var(--success);}
    .bubble-action-btn svg{width:11px;height:11px;}

    /* 代码块复制按钮 */
    .code-wrap{position:relative;}
    .code-copy-btn{position:absolute;top:6px;right:6px;font-family:var(--mono);font-size:11px;
                   padding:2px 8px;border-radius:4px;border:1px solid var(--border);
                   background:var(--surface);color:var(--muted);cursor:pointer;
                   opacity:0;transition:all .2s;z-index:1;}
    .code-wrap:hover .code-copy-btn{opacity:1;}
    .code-copy-btn.copied{border-color:var(--success);color:var(--success);}

    /* 会话侧边栏 */
    .session-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:300;}
    .session-overlay.open{display:block;}
    .session-panel{position:fixed;left:0;top:0;bottom:0;width:280px;
                   background:var(--surface);border-right:1px solid var(--border);
                   display:flex;flex-direction:column;z-index:301;
                   transform:translateX(-100%);transition:transform .25s ease;}
    .session-panel.open{transform:translateX(0);}
    .session-panel-header{display:flex;align-items:center;justify-content:space-between;
                           padding:14px 16px;border-bottom:1px solid var(--border);
                           font-family:var(--mono);font-size:13px;color:var(--text);flex-shrink:0;}
    .session-close{background:none;border:none;color:var(--muted);cursor:pointer;
                   font-size:16px;line-height:1;padding:0;transition:color .2s;}
    .session-close:hover{color:var(--danger);}
    .session-new-btn{margin:10px 12px;padding:8px 14px;background:var(--accent);border:none;
                     border-radius:8px;color:#0d0f14;font-family:var(--mono);font-size:12px;
                     font-weight:500;cursor:pointer;transition:opacity .2s;flex-shrink:0;}
    .session-new-btn:hover{opacity:.85;}
    .session-list{flex:1;overflow-y:auto;padding:4px 8px;
                  scrollbar-width:thin;scrollbar-color:var(--border) transparent;}
    .session-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:8px;
                  cursor:pointer;transition:background .15s;border:1px solid transparent;}
    .session-item:hover{background:var(--surface2);}
    .session-item.active{background:rgba(232,160,69,.1);border-color:rgba(232,160,69,.3);}
    .session-item-info{flex:1;min-width:0;}
    .session-item-name{font-family:var(--mono);font-size:12px;color:var(--text);
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .session-item-meta{font-size:10px;color:var(--muted);margin-top:2px;font-family:var(--mono);}
    .session-item-del{background:none;border:none;color:var(--muted);cursor:pointer;
                      font-size:14px;padding:2px 4px;border-radius:4px;
                      opacity:0;transition:all .15s;flex-shrink:0;}
    .session-item:hover .session-item-del{opacity:1;}
    .session-item-del:hover{color:var(--danger);background:rgba(224,90,90,.1);}

    /* ── 响应式：移动端适配 ── */
    @media (max-width: 600px) {
      /* 登录卡片撑满屏幕 */
      .login-card{width:calc(100vw - 32px);padding:28px 20px;border-radius:12px;}

      /* header 压缩 */
      header{padding:8px 12px;gap:8px;flex-wrap:nowrap;}
      .logo{font-size:13px;}
      .mode-tab{padding:4px 8px;font-size:11px;gap:4px;}
      .mode-tab svg{display:none;}          /* 移动端隐藏图标，只显示文字 */
      .logout-btn{padding:4px 8px;font-size:10px;margin-left:0;}

      /* sys-prompt 折叠为小图标行 */
      .sys-prompt-wrap{padding:4px 12px;flex-wrap:nowrap;}
      .sys-prompt-wrap label{display:none;}   /* 移动端隐藏 label 省空间 */
      .sys-prompt-wrap input{font-size:12px;padding:3px 8px;}
      .max-tokens-sel{font-size:11px;padding:1px 4px;height:24px;}

      /* model-bar 移动端 */
      .model-bar{padding:5px 12px;flex-wrap:wrap;}
      .model-picker{max-width:100%;}
      .model-bar-hint{display:none;}
      .model-dropdown{min-width:0;right:0;}
      .model-item-desc{display:none;}

      /* 消息气泡更宽 */
      .bubble{max-width:88%;}
      .msg-wrap{padding:0 10px;}

      /* 输入区紧凑 + iOS 安全区 */
      #input-area{padding:8px 12px calc(10px + env(safe-area-inset-bottom));}
      .input-row textarea{font-size:16px;}  /* iOS 防止缩放（>=16px 不缩放）*/

      /* 翻译面板改为纵向堆叠 */
      .trans-areas{flex-direction:column;}
      .trans-box textarea{min-height:120px;}
      #translate-panel{padding:12px;}
      .trans-row{gap:6px;}
    }

    @media (max-width: 380px) {
      .mode-tab{padding:4px 6px;font-size:10px;}
      .bubble{max-width:94%;}
    }

    /* 桌面端限制最大宽度，居中显示 */
    @media (min-width: 1200px) {
      #messages{padding:20px calc((100% - 900px) / 2);}
      #input-area{padding:12px calc((100% - 900px) / 2) 16px;}
    }
  </style>
</head>
<body>

<!-- LOGIN PAGE -->
<div id="login-page">
  <div class="login-card">
    <div class="login-logo">CF<span>·</span>AI<small>WORKERS AI CHAT</small></div>
    <div class="login-field">
      <label>管理员密码</label>
      <input type="password" id="pwd-input" placeholder="输入密码…" autocomplete="current-password" />
    </div>
    <div class="login-err" id="login-err"></div>
    <button class="login-btn" id="login-btn">登 录</button>
  </div>
</div>

<!-- MAIN APP -->
<div id="app" style="display:none">

<header>
  <div class="logo">CF<span>·</span>AI</div>
  <div class="mode-tabs">
    <button class="mode-tab active" data-mode="chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      对话
    </button>
    <button class="mode-tab" data-mode="translate">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>
      翻译
    </button>
  </div>
  <button class="icon-hdr-btn" id="new-chat-btn" title="新建对话">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  </button>
  <button class="icon-hdr-btn" id="sessions-btn" title="会话列表">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
  </button>
  <button class="logout-btn" id="logout-btn">退出</button>
</header>

<!-- 会话侧边栏 -->
<div class="session-overlay" id="session-overlay"></div>
<div class="session-panel" id="session-panel">
  <div class="session-panel-header">
    <span>会话列表</span>
    <button class="session-close" id="session-close">✕</button>
  </div>
  <button class="session-new-btn" id="session-new-btn">＋ 新建对话</button>
  <div class="session-list" id="session-list"></div>
</div>

<div class="sys-prompt-wrap" id="sys-prompt-bar">
  <label>System Prompt</label>
  <input type="text" id="sys-prompt-input" placeholder="You are a helpful AI assistant…（留空使用默认）" />
  <select id="max-tokens-select" class="max-tokens-sel" title="最大输出 Token 数（影响回复长度）">
    <option value="1024">1K</option>
    <option value="2048">2K</option>
    <option value="4096">4K</option>
    <option value="8192" selected>8K</option>
    <option value="16384">16K</option>
    <option value="32768">32K</option>
  </select>
</div>
<div class="model-bar" id="model-bar">
  <label>模型</label>
  <div class="model-picker" id="model-picker">
    <button class="model-trigger" id="model-trigger" type="button">
      <span class="model-trigger-name" id="model-trigger-name">GLM 4.7 Flash</span>
      <span class="model-trigger-tags" id="model-trigger-tags"></span>
      <svg class="model-trigger-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="model-dropdown" id="model-dropdown">
      <div class="model-search-wrap">
        <input type="text" class="model-search" id="model-search" placeholder="搜索模型…" autocomplete="off" />
      </div>
      <div class="model-list" id="model-list"></div>
    </div>
  </div>
  <!-- 隐藏 input 保存当前选中值，兼容原有 .value 读取逻辑 -->
  <input type="hidden" id="model-select" value="@cf/zai-org/glm-4.7-flash" />
  <button class="refresh-models-btn" id="refresh-models-btn" title="从 CF 文档拉取最新模型列表">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg>
    <span id="refresh-models-txt">刷新模型</span>
  </button>
  <span class="model-bar-hint">Ctrl+Enter 发送</span>
</div>

<div id="messages">
  <div class="empty-state" id="empty-state">
    <div class="big">⚡</div>
    <h2>Cloudflare AI Chat</h2>
    <p>支持多模型流式对话、代码分析、图片理解、多语言翻译</p>
    <div class="suggestions">
      <div class="suggestion" data-msg="帮我写一个快速排序算法，用 Python">🐍 Python 排序</div>
      <div class="suggestion" data-msg="解释一下什么是 Transformer 架构">🤖 Transformer</div>
      <div class="suggestion" data-msg="帮我 review 以下代码，找出潜在 bug：\nfunction add(a,b){ return a-b }">🔍 Code Review</div>
      <div class="suggestion" data-msg="用 Markdown 整理一份 REST API 设计规范">📋 API 规范</div>
    </div>
  </div>
</div>

<div id="translate-panel">
  <div class="trans-row">
    <label style="font-family:var(--mono);font-size:11px;color:var(--muted)">源语言</label>
    <select class="trans-select" id="src-lang">
      <option value="zh">中文</option><option value="en" selected>English</option>
      <option value="ja">日本語</option><option value="ko">한국어</option>
      <option value="fr">Français</option><option value="de">Deutsch</option>
      <option value="es">Español</option><option value="ar">العربية</option>
      <option value="ru">Русский</option><option value="pt">Português</option>
    </select>
    <button class="trans-swap" id="trans-swap-btn">⇄</button>
    <label style="font-family:var(--mono);font-size:11px;color:var(--muted)">目标语言</label>
    <select class="trans-select" id="tgt-lang">
      <option value="zh" selected>中文</option><option value="en">English</option>
      <option value="ja">日本語</option><option value="ko">한국어</option>
      <option value="fr">Français</option><option value="de">Deutsch</option>
      <option value="es">Español</option><option value="ar">العربية</option>
      <option value="ru">Русский</option><option value="pt">Português</option>
    </select>
    <button class="trans-btn" id="trans-btn">翻译</button>
  </div>
  <div class="trans-areas">
    <div class="trans-box">
      <label>原文</label>
      <textarea id="trans-source" placeholder="输入要翻译的文本…"></textarea>
    </div>
    <div class="trans-box">
      <label>译文</label>
      <textarea id="trans-result" readonly placeholder="翻译结果将显示在这里…"></textarea>
    </div>
    <div class="trans-history" id="trans-history"></div>
</div>
</div>

<div id="input-area">
  <div class="upload-preview" id="upload-preview"></div>
  <div class="input-row">
    <textarea id="user-input" rows="1" placeholder="输入消息…（Shift+Enter 换行）"></textarea>
    <div class="toolbar">
      <label class="icon-btn" id="upload-btn" title="上传文件/图片">
        <input type="file" id="file-input" accept="image/*,video/*,.txt,.md,.js,.mjs,.ts,.tsx,.jsx,.py,.ipynb,.java,.c,.cpp,.h,.cs,.go,.rs,.rb,.php,.swift,.kt,.dart,.sh,.bash,.zsh,.ps1,.bat,.html,.css,.scss,.less,.json,.json5,.yaml,.yml,.toml,.xml,.csv,.tsv,.sql,.graphql,.proto,.env,.conf,.ini,.log,.pdf,.docx,.xlsx,.pptx,.md,.rst,.tex" />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      </label>
      <!-- 发送时变为停止按钮（AbortController 中断 SSE） -->
      <button class="icon-btn send" id="send-btn" title="发送 (Ctrl+Enter)">
        <svg id="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        <svg id="stop-icon" viewBox="0 0 24 24" fill="currentColor" style="display:none;width:14px;height:14px"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
      </button>
    </div>
  </div>
  <!-- 输入框底部工具栏 -->
  <div id="input-footer" style="display:flex;justify-content:flex-end;align-items:center;padding:2px 2px 0;min-height:16px;">
    <span id="char-count" style="display:none;font-size:11px;font-family:var(--mono);transition:color .2s;"></span>
  </div>
</div>
</div>

<script>
// ══ AUTH ══════════════════════════════════════════════════
let authToken = localStorage.getItem('cf_token') || '';

async function doLogin() {
  const btn  = document.getElementById('login-btn');
  const pwd  = document.getElementById('pwd-input').value;
  const err  = document.getElementById('login-err');
  if (!pwd) { err.textContent = '请输入密码'; return; }
  btn.disabled = true; btn.textContent = '验证中…'; err.textContent = '';
  try {
    const res  = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error || '登录失败'; return; }
    authToken = data.token;
    localStorage.setItem('cf_token', authToken);
    showApp();
  } catch (e) {
    err.textContent = '网络错误: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
}

async function showApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  // 从 KV 云端加载历史（如果本地为空时）
  try {
    if (!chatHistory.length) {
      const r = await fetch('/api/history', { headers: authHeaders() });
      if (r.ok) {
        const { history, kv } = await r.json();
        if (kv && Array.isArray(history) && history.length > 0) {
          chatHistory.splice(0, chatHistory.length, ...history);
          try { localStorage.setItem('cf_history', JSON.stringify(chatHistory)); } catch {}
          restoreHistory();
        }
      }
    }
  } catch {}
}

function doLogout() {
  // 只清 token，不清历史记录
  localStorage.removeItem('cf_token'); authToken = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('pwd-input').value = '';
  document.getElementById('login-err').textContent = '';
}

document.getElementById('pwd-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

// 有 token 立即乐观显示 app，后台静默验证，仅 401 才强制退回登录
if (authToken) {
  showApp();
  fetch('/api/history', { headers: { 'Authorization': 'Bearer ' + authToken } })
    .then(r => { if (r.status === 401) doLogout(); })
    .catch(() => {});
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken };
}



// ══ MODE ═══════════════════════════════════════════════════
let mode = 'chat', uploadedFiles = [], streaming = false;
let _abortCtrl = null;   // 当前 SSE 请求的 AbortController

// showToast：轻提示
function showToast(msg, dur) {
  let t = document.getElementById('__toast__');
  if (!t) {
    t = document.createElement('div'); t.id = '__toast__';
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
      'background:rgba(0,0,0,.82);color:#fff;padding:7px 18px;border-radius:20px;' +
      'font-size:13px;z-index:9999;pointer-events:none;transition:opacity .3s;white-space:nowrap;';
    document.body.appendChild(t);
  }
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.opacity = '0'; }, dur || 2500);
}

// setSendBtn：切换 发送 ↔ 停止 按钮状态
function setSendBtn(isStopping) {
  const btn = document.getElementById('send-btn');
  const si  = document.getElementById('send-icon');
  const st  = document.getElementById('stop-icon');
  if (!btn) return;
  if (isStopping) {
    btn.title = '停止生成'; btn.disabled = false;
    btn.style.cssText = 'background:var(--danger);border-color:var(--danger);';
    if (si) si.style.display = 'none'; if (st) st.style.display = '';
  } else {
    btn.title = '发送 (Ctrl+Enter)'; btn.style.cssText = '';
    if (si) si.style.display = ''; if (st) st.style.display = 'none';
  }
}

// 从 localStorage 恢复对话历史（跨会话持久化）
let chatHistory = (() => {
  try { return JSON.parse(localStorage.getItem('cf_history') || '[]'); } catch { return []; }
})();
function saveHistory() {
  try { localStorage.setItem('cf_history', JSON.stringify(chatHistory.slice(-60))); } catch {}
  saveCurrentSession();
  // 同时写 KV 云端（异步，不阻塞 UI）
  if (authToken) {
    fetch('/api/history', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: chatHistory.slice(-60) })
    }).catch(() => {});
  }
}
function clearHistory() {
  chatHistory = []; localStorage.removeItem('cf_history');
  document.getElementById('messages').innerHTML =
    '<div class="empty-state" id="empty-state"><div class="big">⚡</div>' +
    '<h2>Cloudflare AI Chat</h2><p>支持多模型流式对话、代码分析、图片理解、多语言翻译</p>' +
    '<div class="suggestions">' +
    '<div class="suggestion" data-msg="帮我写一个快速排序算法，用 Python">🐍 Python 排序</div>' +
    '<div class="suggestion" data-msg="解释一下什么是 Transformer 架构">🤖 Transformer</div>' +
    '<div class="suggestion" data-msg="帮我 review 以下代码，找出潜在 bug：\\nfunction add(a,b){ return a-b }">🔍 Code Review</div>' +
    '<div class="suggestion" data-msg="用 Markdown 整理一份 REST API 设计规范">📋 API 规范</div>' +
    '</div></div>';
  // 重新绑定 suggestion 事件
  document.querySelectorAll('.suggestion').forEach(el => {
    el.addEventListener('click', () => quickSend(el.dataset.msg));
  });
}

function setMode(m) {
  mode = m;
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  const isT = m === 'translate';
  ['messages','input-area','model-bar','sys-prompt-bar'].forEach(id =>
    document.getElementById(id).style.display = isT ? 'none' : '');
  document.getElementById('translate-panel').style.display = isT ? 'flex' : 'none';
  document.getElementById('user-input').placeholder = '输入消息…（Ctrl+Enter 发送）';
}

// ══ TEXTAREA ═══════════════════════════════════════════════
const ta = document.getElementById('user-input');
// 大文本粘贴防卡死：仅在内容 <=2000 字时做自动高度（否则固定最大高度）
// 防抖：16ms 节流，避免每个字符都触发 scrollHeight 重排
let _taTimer = null;
function resizeTA() {
  if (ta.value.length > 2000) {
    ta.style.height = '160px';
    return;
  }
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
}
ta.addEventListener('input', () => {
  clearTimeout(_taTimer);
  // 超长文本（输入法粘贴后）用更长的防抖避免卡死
  const delay = ta.value.length > 5000 ? 200 : 16;
  _taTimer = setTimeout(resizeTA, delay);
  updateCharCount(ta.value.length);
});
// 输入法完成（compositionend）：捕获输入法粘贴事件
ta.addEventListener('compositionend', () => {
  clearTimeout(_taTimer);
  _taTimer = setTimeout(resizeTA, 200);
  updateCharCount(ta.value.length);
  // 超过 10 万字给出警告
  if (ta.value.length > 100000) {
    showToast('⚠️ 内容已超过 10 万字，建议通过上传文件功能传入大文本', 4000);
  }
});
ta.addEventListener('paste', (e) => {
  // 粘贴时先检查剪贴板大小，超过 50K 字符给出警告
  const pasted = e.clipboardData?.getData('text') || '';
  if (pasted.length > 50000) {
    e.preventDefault();
    const truncated = pasted.slice(0, 50000);
    const start = ta.selectionStart, end = ta.selectionEnd;
    const val = ta.value;
    ta.value = val.slice(0, start) + truncated + val.slice(end);
    ta.selectionStart = ta.selectionEnd = start + truncated.length;
    updateCharCount(ta.value.length);
    resizeTA();
    showToast('⚠️ 内容超过 5 万字，已截断至 50,000 字符');
    return;
  }
  setTimeout(() => { resizeTA(); updateCharCount(ta.value.length); }, 0);
});
ta.addEventListener('keydown', e => { if (e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();sendMessage();} });

// 字数统计显示
function updateCharCount(len) {
  let el = document.getElementById('char-count');
  if (!el) return;
  if (len > 500) {
    el.textContent = len.toLocaleString() + ' 字';
    el.style.display = 'inline';
    el.style.color = len > 20000 ? 'var(--danger)' : len > 5000 ? 'var(--accent)' : 'var(--muted)';
  } else {
    el.style.display = 'none';
  }
}

// ══ FILE UPLOAD ════════════════════════════════════════════
document.getElementById('file-input').addEventListener('change', async e => {
  for (const file of e.target.files) {
    const isImage = file.type.startsWith('image/');
    const base64  = await toB64(file);
    uploadedFiles.push({ name: file.name, isImage, base64,
      dataUrl: isImage ? \`data:\${file.type};base64,\${base64}\` : null,
      text: isImage ? null : await toText(file) });
  }
  renderPrev(); e.target.value = '';
});
const toB64  = f => new Promise(r => { const fr=new FileReader(); fr.onload=()=>r(fr.result.split(',')[1]); fr.readAsDataURL(f); });
const toText = f => new Promise(r => { const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.onerror=()=>r(''); fr.readAsText(f); });
function renderPrev() {
  document.getElementById('upload-preview').innerHTML = uploadedFiles.map((f,i) =>
    \`<div class="upload-chip">\${f.isImage?\`<img src="\${f.dataUrl}"/>\`:'📄'} \${f.name}
     <button data-idx="\${i}">×</button></div>\`).join('');
}
function removeFile(i) { uploadedFiles.splice(i,1); renderPrev(); }

// ══ SEND ═══════════════════════════════════════════════════
// quickSend：快捷短语直接发送
function quickSend(t) { document.getElementById('user-input').value=t; sendMessage(); }

async function runChat(text, files) {
  if (streaming) return;
  let content = text;
  files.filter(f => !f.isImage && f.text).forEach(f => {
    content += '\\n\\n[\\u6587\\u4ef6:' + f.name + ']\\n\`\`\`\\n' + f.text + '\\n\`\`\`';
  });
  appendBubble('user', text, files.filter(f => f.isImage).map(f => f.dataUrl));
  chatHistory.push({ role: 'user', content });
  saveHistory();
  await streamChat(0);
}

async function sendMessage() {
  if (streaming) return;
  const input = document.getElementById('user-input');
  const text  = input.value.trim();
  const files = [...uploadedFiles];
  if (!text && !files.length) return;
  input.value=''; input.style.height='auto'; updateCharCount(0);
  uploadedFiles=[]; renderPrev();
  document.getElementById('empty-state').style.display='none';
  await runChat(text, files);
}

// ══ CHAT（SSE 流式模式）══════════════════════════════════════
async function streamChat(retryCount) {
  retryCount = retryCount || 0;
  streaming  = true;
  _abortCtrl = new AbortController();
  setSendBtn(true);  // 切换为停止按钮

  const model     = document.getElementById('model-select').value;
  const sysPrompt = document.getElementById('sys-prompt-input').value.trim();
  const maxTok    = parseInt(document.getElementById('max-tokens-select')?.value || '8192');

  const { el: wrapEl, textEl } = appendBubble('assistant', '', []);
  const cursor = document.createElement('span');
  cursor.className = 'cursor-blink';

  // 显示等待动画
  textEl.innerHTML = '<span class="thinking-dots"><span></span><span></span><span></span></span>';

  try {
    const res = await fetch('/', {
      method: 'POST',
      headers: authHeaders(),
      signal: _abortCtrl?.signal,
      body: JSON.stringify({
        messages:   chatHistory,
        model:      model,
        system:     sysPrompt || undefined,
        max_tokens: maxTok
      })
    });
    if (res.status === 401) { doLogout(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);

    // ── 直接读 SSE 流式响应 ────────────────────────────────
    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      // 非 SSE（通常是错误 JSON）
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'HTTP ' + res.status);
    }

    textEl.innerHTML = ''; textEl.appendChild(cursor);
    const reader2 = res.body.getReader(), dec2 = new TextDecoder();
    let full2 = '', buf2 = '';
    // 真正 token 级别流式：每次 read() 收到 chunk 立刻处理
    outer: while (true) {
      const { done, value } = await reader2.read();
      if (done) break;
      buf2 += dec2.decode(value, { stream: true });
      // 逐行处理（SSE 每行以真实换行符结束）
      let nlIdx;
      while ((nlIdx = buf2.indexOf('\\n')) !== -1) {
        const line = buf2.slice(0, nlIdx).trimEnd();
        buf2 = buf2.slice(nlIdx + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '[DONE]') break outer;
        try {
          const j = JSON.parse(d);
          const tok = j.choices?.[0]?.delta?.content ?? j.response ?? '';
          if (tok) {
            full2 += tok;
            cursor.remove();
            // 流式阶段用 textContent（极快，无 Markdown 解析开销）
            textEl.textContent = full2;
            textEl.appendChild(cursor);
            scrollBot();
          }
        } catch {}
      }
    }
    reader2.cancel().catch(() => {});
    // 完成后做一次完整 Markdown 渲染
    cursor.remove();
    textEl.innerHTML = renderMD(full2); addCodeCopyBtns(textEl);
    if (full2) {
      chatHistory.push({ role: 'assistant', content: full2 });
      saveHistory();  // saveHistory 同时写 KV
    }
    scrollBot(); streaming = false; _abortCtrl = null; setSendBtn(false);

  } catch (e) {
    // AbortError / BodyStreamBuffer：用户主动停止，静默处理
    const isAbort = e.name === 'AbortError' || /aborted|abort/i.test(e.message);
    if (isAbort) {
      cursor.remove();
      // 保存已生成内容
      const partial = textEl.innerText.trim();
      if (partial) { textEl.innerHTML = renderMD(partial); addCodeCopyBtns(textEl); }
      else { wrapEl.remove(); }
      streaming = false; _abortCtrl = null; setSendBtn(false);
      scrollBot();
      return;
    }
    const isNet = /fetch|network|Failed to fetch/i.test(e.message);
    if (isNet && retryCount < 3) {
      wrapEl.remove();
      streaming = false; _abortCtrl = null; setSendBtn(false);
      await new Promise(r => setTimeout(r, (retryCount + 1) * 1000));
      await streamChat(retryCount + 1);
      return;
    }
    textEl.innerHTML =
      '<div style="color:var(--danger);font-size:13px">' +
        (isNet ? '\ud83d\udcf6 \u7f51\u7edc\u4e2d\u65ad' : '\u8bf7\u6c42\u5931\u8d25') +
        ': ' + e.message + '</div>' +
      '<button id="retry-btn-' + retryCount + '" style="margin-top:8px;padding:4px 14px;' +
        'border-radius:6px;border:1px solid var(--border);background:transparent;' +
        'color:var(--accent2);cursor:pointer;font-size:12px">\u21ba \u70b9\u51fb\u91cd\u8bd5</button>';
    document.getElementById('retry-btn-' + retryCount)?.addEventListener('click', () => {
      wrapEl.remove(); streaming = false; document.getElementById('send-btn').disabled = false;
      streamChat(0);
    });
    streaming = false; _abortCtrl = null; setSendBtn(false);
  }
  scrollBot();
}


// ══ TRANSLATE ══════════════════════════════════════════════
let transHistory = (() => {
  try { return JSON.parse(localStorage.getItem('cf_trans') || '[]'); } catch { return []; }
})();
function renderTransHistory() {
  const el = document.getElementById('trans-history');
  if (!transHistory.length) { el.innerHTML = ''; return; }
  el.innerHTML = transHistory.slice().reverse().map((h, i) =>
    \`<div class="trans-history-item" data-idx="\${transHistory.length-1-i}">
       <span class="src">\${esc2(h.src)}</span>
       <span class="arr">→</span>
       <span class="tgt">\${esc2(h.tgt)}</span>
     </div>\`).join('');
  el.querySelectorAll('.trans-history-item').forEach(item => {
    item.addEventListener('click', () => {
      const h = transHistory[Number(item.dataset.idx)];
      document.getElementById('trans-source').value = h.src;
      document.getElementById('trans-result').value = h.tgt;
      document.getElementById('src-lang').value = h.sl;
      document.getElementById('tgt-lang').value = h.tl;
    });
  });
}
function esc2(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
renderTransHistory();

async function doTranslate() {
  const btn=document.getElementById('trans-btn');
  const src=document.getElementById('trans-source').value.trim();
  if (!src) return;
  btn.disabled=true; btn.textContent='翻译中…';
  document.getElementById('trans-result').value='';
  const sl=document.getElementById('src-lang').value;
  const tl=document.getElementById('tgt-lang').value;
  try {
    const res=await fetch('/api/translate',{method:'POST',headers:authHeaders(),
      body:JSON.stringify({text:src, source_lang:sl, target_lang:tl})});
    if (res.status===401){doLogout();return;}
    const data=await res.json();
    const result=data.translated_text||'翻译失败';
    document.getElementById('trans-result').value=result;
    // 保存历史
    transHistory.push({src, tgt:result, sl, tl});
    if (transHistory.length > 30) transHistory.shift();
    try { localStorage.setItem('cf_trans', JSON.stringify(transHistory)); } catch {}
    renderTransHistory();
  } catch(e){document.getElementById('trans-result').value='请求失败: '+e.message;}
  btn.disabled=false; btn.textContent='翻译';
}
function swapLangs(){
  const s=document.getElementById('src-lang'),t=document.getElementById('tgt-lang');
  [s.value,t.value]=[t.value,s.value];
  const sv=document.getElementById('trans-source').value,tv=document.getElementById('trans-result').value;
  document.getElementById('trans-source').value=tv;
  document.getElementById('trans-result').value=sv;
}

// ══ HELPERS ════════════════════════════════════════════════
function addCodeCopyBtns(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.parentElement.classList.contains('code-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = '复制';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      navigator.clipboard.writeText(code ? code.innerText : pre.innerText).then(() => {
        btn.textContent = '已复制'; btn.classList.add('copied');
        setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 1500);
      }).catch(() => {});
    });
    wrap.appendChild(btn);
  });
}

// COLLAPSE_THRESHOLD: 用户气泡超过此字符数则折叠显示
const COLLAPSE_THRESHOLD = 600;

function appendBubble(role, text, imgs) {
  const msgs = document.getElementById('messages');
  const wrap = document.createElement('div'); wrap.className = \`msg-wrap \${role}\`;
  const bub  = document.createElement('div'); bub.className  = \`bubble \${role}\`;
  (imgs || []).forEach(u => { const i = document.createElement('img'); i.src = u; i.className = 'preview'; bub.appendChild(i); });
  const el = document.createElement('div');

  if (role === 'user' && text) {
    // 用户消息：纯文本显示（不走 renderMD，避免万字文本生成巨型 HTML）
    el.className = 'user-text';
    const needCollapse = text.length > COLLAPSE_THRESHOLD;
    const displayText  = needCollapse ? text.slice(0, COLLAPSE_THRESHOLD) : text;
    el.textContent = displayText;
    if (needCollapse) {
      const ellipsis = document.createElement('span');
      ellipsis.textContent = ' …';
      el.appendChild(ellipsis);
      const meta = document.createElement('div');
      meta.className = 'collapse-meta';
      const lenSpan = document.createElement('span');
      lenSpan.className = 'collapse-len';
      lenSpan.textContent = text.length.toLocaleString() + ' 字';
      const colBtn = document.createElement('button');
      colBtn.className = 'collapse-btn';
      colBtn.textContent = '展开全文';
      meta.appendChild(lenSpan);
      meta.appendChild(colBtn);
      let expanded = false;
      colBtn.addEventListener('click', () => {
        expanded = !expanded;
        if (expanded) {
          el.textContent = text;
          colBtn.textContent = '收起';
          lenSpan.textContent = text.length.toLocaleString() + ' 字';
        } else {
          el.textContent = displayText;
          el.appendChild(ellipsis);
          colBtn.textContent = '展开全文';
        }
      });
      bub.appendChild(el);
      bub.appendChild(meta);
    } else {
      bub.appendChild(el);
    }
  } else {
    // 助手消息：走 Markdown 渲染
    if (text) { el.innerHTML = renderMD(text); addCodeCopyBtns(el); }
    bub.appendChild(el);
  }
  // 添加操作按钮（user / assistant 各自不同）
  const copyIcon = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>\`;

  if (role === 'user') {
    // user 气泡：仅复制按钮，悬停才显示
    const actions = document.createElement('div');
    actions.className = 'bubble-actions user-actions';
    actions.innerHTML = \`<button class="bubble-action-btn" title="复制消息">\${copyIcon} 复制</button>\`;
    actions.querySelector('button').addEventListener('click', function() {
      const raw = text || el.innerText;
      navigator.clipboard.writeText(raw).then(() => {
        this.innerHTML = copyIcon + ' 已复制'; this.classList.add('copied');
        setTimeout(() => { this.innerHTML = copyIcon + ' 复制'; this.classList.remove('copied'); }, 1500);
      }).catch(() => {});
    });
    bub.appendChild(actions);
  }

  if (role === 'assistant') {
    const actions = document.createElement('div');
    actions.className = 'bubble-actions';
    actions.innerHTML =
      \`<button class="bubble-action-btn" data-action="copy" title="复制全文">
         \${copyIcon} 复制
       </button>
       <button class="bubble-action-btn" data-action="retry" title="重新生成">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg> 重新生成
       </button>\`;
    actions.querySelector('[data-action="copy"]').addEventListener('click', function() {
      navigator.clipboard.writeText(el.innerText).then(() => {
        this.innerHTML = this.innerHTML.replace('复制', '已复制'); this.classList.add('copied');
        setTimeout(() => { this.innerHTML = this.innerHTML.replace('已复制', '复制'); this.classList.remove('copied'); }, 1500);
      }).catch(() => {});
    });
    actions.querySelector('[data-action="retry"]').addEventListener('click', () => {
      regenLast(wrap);
    });
    bub.appendChild(actions);
  }
  wrap.appendChild(bub); msgs.appendChild(wrap); scrollBot();
  return { el: wrap, textEl: el };
}
function scrollBot(){const e=document.getElementById('messages');e.scrollTop=e.scrollHeight;}

function renderMD(t){
  if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true, gfm: true });
    return marked.parse(t);
  }
  // fallback
  return '<pre>' + t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
// ══ SESSION MANAGEMENT ════════════════════════════════════
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function getSessions() {
  try { return JSON.parse(localStorage.getItem('cf_sessions') || '[]'); } catch { return []; }
}
function saveSessions(ss) {
  try { localStorage.setItem('cf_sessions', JSON.stringify(ss)); } catch {}
}
function getActiveId() { return localStorage.getItem('cf_active_sid') || ''; }
function setActiveId(id) { localStorage.setItem('cf_active_sid', id); }

function createSession(name) {
  const ss = getSessions();
  const id = genId();
  const modelName = (MODEL_LIST.find(m => m.id === selectedModel) || {name: selectedModel}).name;
  ss.unshift({ id, name: name || '新对话', model: selectedModel, modelName, msgs: [], updatedAt: Date.now() });
  saveSessions(ss);
  return id;
}

function loadSession(id) {
  const ss = getSessions();
  const s  = ss.find(x => x.id === id);
  if (!s) return;
  setActiveId(id);
  chatHistory = s.msgs ? JSON.parse(JSON.stringify(s.msgs)) : [];
  saveHistory();
  // 重新渲染消息
  const msgsEl = document.getElementById('messages');
  msgsEl.innerHTML = '<div class="empty-state" id="empty-state" style="' + (chatHistory.length ? 'display:none' : '') + '"><div class="big">⚡</div><h2>Cloudflare AI Chat</h2><p>支持多模型流式对话、代码分析、图片理解、多语言翻译</p><div class="suggestions"><div class="suggestion" data-msg="帮我写一个快速排序算法，用 Python">🐍 Python 排序</div><div class="suggestion" data-msg="解释一下什么是 Transformer 架构">🤖 Transformer</div><div class="suggestion" data-msg="帮我 review 以下代码，找出潜在 bug：\\nfunction add(a,b){ return a-b }">🔍 Code Review</div><div class="suggestion" data-msg="用 Markdown 整理一份 REST API 设计规范">📋 API 规范</div></div></div>';
  document.querySelectorAll('.suggestion').forEach(el => { el.addEventListener('click', () => quickSend(el.dataset.msg)); });
  chatHistory.forEach(m => { if (m.role === 'user' || m.role === 'assistant') appendBubble(m.role, m.content, []); });
  renderSessionList();
}

function saveCurrentSession() {
  let id = getActiveId();
  const ss = getSessions();
  if (!id || !ss.find(x => x.id === id)) {
    // 自动创建
    const firstMsg = chatHistory.find(m => m.role === 'user');
    const name = firstMsg ? firstMsg.content.slice(0, 28).replace(/\\n/g, ' ') : '新对话';
    id = createSession(name);
    setActiveId(id);
  }
  const idx = ss.findIndex(x => x.id === id);
  if (idx !== -1) {
    ss[idx].msgs      = JSON.parse(JSON.stringify(chatHistory));
    ss[idx].updatedAt = Date.now();
    if (ss[idx].name === '新对话') {
      const firstMsg = chatHistory.find(m => m.role === 'user');
      if (firstMsg) ss[idx].name = firstMsg.content.slice(0, 28).replace(/\\n/g, ' ');
    }
    saveSessions(ss);
  }
  renderSessionList();
}

function renderSessionList() {
  const el = document.getElementById('session-list');
  if (!el) return;
  const ss  = getSessions();
  const aid = getActiveId();
  if (!ss.length) { el.innerHTML = '<div style="padding:16px;font-family:var(--mono);font-size:11px;color:var(--muted);text-align:center">暂无会话记录</div>'; return; }
  el.innerHTML = ss.map(s => {
    const d = new Date(s.updatedAt);
    const dateStr = d.getMonth()+1 + '/' + d.getDate() + ' ' + d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
    return '<div class="session-item' + (s.id === aid ? ' active' : '') + '" data-sid="' + s.id + '">' +
      '<div class="session-item-info"><div class="session-item-name">' + esc2(s.name) + '</div>' +
      '<div class="session-item-meta">' + esc2(s.modelName || '') + ' · ' + dateStr + '</div></div>' +
      '<button class="session-item-del" data-del="' + s.id + '" title="删除">✕</button>' +
      '</div>';
  }).join('');
  el.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.dataset.del) return;
      loadSession(item.dataset.sid);
      closeSessions();
    });
  });
  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const ss2 = getSessions().filter(x => x.id !== btn.dataset.del);
      saveSessions(ss2);
      if (getActiveId() === btn.dataset.del) { localStorage.removeItem('cf_active_sid'); chatHistory = []; saveHistory(); }
      renderSessionList();
    });
  });
}

function openSessions()  { document.getElementById('session-panel').classList.add('open'); document.getElementById('session-overlay').classList.add('open'); renderSessionList(); }
function closeSessions() { document.getElementById('session-panel').classList.remove('open'); document.getElementById('session-overlay').classList.remove('open'); }
function newChat() {
  saveCurrentSession();
  const id = createSession('新对话');
  chatHistory = []; saveHistory(); setActiveId(id);
  const msgsEl = document.getElementById('messages');
  msgsEl.innerHTML = '<div class="empty-state" id="empty-state"><div class="big">⚡</div><h2>Cloudflare AI Chat</h2><p>支持多模型流式对话、代码分析、图片理解、多语言翻译</p><div class="suggestions"><div class="suggestion" data-msg="帮我写一个快速排序算法，用 Python">🐍 Python 排序</div><div class="suggestion" data-msg="解释一下什么是 Transformer 架构">🤖 Transformer</div><div class="suggestion" data-msg="帮我 review 以下代码，找出潜在 bug：\\nfunction add(a,b){ return a-b }">🔍 Code Review</div><div class="suggestion" data-msg="用 Markdown 整理一份 REST API 设计规范">📋 API 规范</div></div></div>';
  document.querySelectorAll('.suggestion').forEach(el => { el.addEventListener('click', () => quickSend(el.dataset.msg)); });
}

// ══ 动态刷新模型列表 ══════════════════════════════════════════
async function refreshModels() {
  const btn = document.getElementById('refresh-models-btn');
  const txt = document.getElementById('refresh-models-txt');
  if (!btn) return;
  btn.classList.add('loading');
  txt.textContent = '获取中…';
  try {
    const res  = await fetch('/api/models', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok || !data.models?.length) {
      txt.textContent = '失败 ✗';
      setTimeout(() => { btn.classList.remove('loading'); txt.textContent = '刷新模型'; }, 2000);
      return;
    }
    // 用拉取的数据覆盖全局 MODEL_LIST
    MODEL_LIST.length = 0;
    data.models.forEach(m => MODEL_LIST.push(m));

    // 保存到 localStorage 供下次使用
    try { localStorage.setItem('cf_model_list', JSON.stringify(MODEL_LIST)); } catch {}

    // 当前选中模型若不在新列表中，自动切换到第一个文本生成模型
    const curId = document.getElementById('model-select').value;
    if (!MODEL_LIST.find(m => m.id === curId) && MODEL_LIST.length > 0) {
      const firstChat = MODEL_LIST.find(m => m.task === 'text-gen') || MODEL_LIST[0];
      setModel(firstChat.id);
    }
    // 重新渲染下拉列表
    renderList('');
    // 显示各类型数量
    const byTask = data.byTask || {};
    const summary = Object.entries(byTask).filter(([,v])=>v>0)
      .map(([k,v])=>v+' '+k).join(', ');
    txt.textContent = '已更新 ✓ ' + data.count + ' 个模型';
    if (summary) console.log('[Models]', summary);
    setTimeout(() => { btn.classList.remove('loading'); txt.textContent = '刷新模型'; }, 2500);
  } catch(e) {
    txt.textContent = '网络错误 ✗';
    setTimeout(() => { btn.classList.remove('loading'); txt.textContent = '刷新模型'; }, 2000);
  }
}

// 启动时尝试从 localStorage 恢复缓存的模型列表
(function restoreCachedModels() {
  try {
    const cached = localStorage.getItem('cf_model_list');
    if (cached) {
      const arr = JSON.parse(cached);
      if (Array.isArray(arr) && arr.length > 0) {
        MODEL_LIST.length = 0;
        arr.forEach(m => MODEL_LIST.push(m));
      }
    }
  } catch {}
})();

// ══ MODEL PICKER ══════════════════════════════════════════
// ── 每个模型的 max_tokens 上限（基于 CF 文档 context window）──────
// 原则：max_tokens = min(context_window * 0.5, 16384) 取合理最大输出
const MODEL_MAX_TOKENS = {
  // Context: 24K → output max 12K
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast":         12288,
  "@cf/meta/llama-4-scout-17b-16e-instruct":           12288,
  // Context: 128K → output max 16K
  "@cf/zai-org/glm-4.7-flash":                         16384,
  "@cf/mistral/mistral-small-3.1-24b-instruct":        16384,
  "@cf/google/gemma-3-12b-it":                         16384,
  "@cf/qwen/qwq-32b":                                  16384,
  "@cf/qwen/qwen3-30b-a3b-fp8":                        16384,
  // Context: 32K → output max 16K
  "@cf/mistral/mistral-7b-instruct-v0.2":              16384,
  "@cf/mistral/mistral-7b-instruct-v0.2-lora":         16384,
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b":      16384,
  // Context: 8K → output max 4K
  "@cf/openai/gpt-oss-120b":                            8192,
  "@cf/openai/gpt-oss-20b":                             8192,
  "@cf/qwen/qwen2.5-coder-32b-instruct":                8192,
  "@cf/ibm/granite-4.0-h-micro":                        8192,
  "@cf/meta/llama-3.1-70b-instruct":                    8192,
  "@cf/meta/llama-3.1-8b-instruct":                     8192,
  "@cf/meta/llama-3.1-8b-instruct-fast":                8192,
  "@cf/meta/llama-3.1-8b-instruct-fp8":                 8192,
  "@cf/meta/llama-3.1-8b-instruct-awq":                 8192,
  "@cf/meta/llama-3.2-11b-vision-instruct":             8192,
  "@cf/meta/llama-3.2-3b-instruct":                     8192,
  "@cf/meta/llama-3.2-1b-instruct":                     4096,
  "@cf/meta/llama-3-8b-instruct":                       8192,
  "@cf/meta-llama/meta-llama-3-8b-instruct":            8192,
  "@cf/meta/llama-3-8b-instruct-awq":                   8192,
  "@cf/meta/llama-guard-3-8b":                          4096,
  "@cf/google/gemma-7b-it":                             8192,
  "@cf/google/gemma-7b-it-lora":                        8192,
  "@cf/google/gemma-2b-it-lora":                        4096,
  "@cf/nousresearch/hermes-2-pro-mistral-7b":           8192,
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it":           8192,
  "@cf/mistral/mistral-7b-instruct-v0.1":               4096,
  "@cf/meta/llama-2-7b-chat-fp16":                      4096,
  "@cf/meta/llama-2-7b-chat-int8":                      4096,
  "@cf/meta-llama/llama-2-7b-chat-hf-lora":             4096,
  "@cf/defog/sqlcoder-7b-2":                            4096,
  "@cf/microsoft/phi-2":                                4096,
};
// getMaxTokens：根据 CF 文档 context window，返回每个模型允许的最大输出 token 数
function getMaxTokens(modelId) {
  return MODEL_MAX_TOKENS[modelId] || 8192;
}

const MODEL_LIST = [
  // ══ 💬 Text Generation ════════════════════════════════════
  // ── 📌 置顶推荐 ──
  { group:'💬 对话生成 / 📌 置顶推荐', id:'@cf/openai/gpt-oss-120b',
    name:'GPT-OSS 120B',                  desc:'OpenAI 开放权重·生产级高推理',                 task:'text-gen', tags:['reason','code','fn'] },
  { group:'💬 对话生成 / 📌 置顶推荐', id:'@cf/openai/gpt-oss-20b',
    name:'GPT-OSS 20B',                   desc:'OpenAI 开放权重·低延迟·边缘部署',              task:'text-gen', tags:['fast','reason','fn'] },
  { group:'💬 对话生成 / 📌 置顶推荐', id:'@cf/meta/llama-4-scout-17b-16e-instruct',
    name:'Llama 4 Scout 17B 16E',         desc:'Meta 最新 MoE 多模态·图文理解',                task:'text-gen', tags:['vision','multi','fn','batch'] },
  { group:'💬 对话生成 / 📌 置顶推荐', id:'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    name:'Llama 3.3 70B FP8 Fast',        desc:'最快 70B·FP8 量化·函数调用',                  task:'text-gen', tags:['fast','code','fn','batch'] },
  { group:'💬 对话生成 / 📌 置顶推荐', id:'@cf/meta/llama-3.1-8b-instruct-fast',
    name:'Llama 3.1 8B Fast',             desc:'快速版·多语言对话',                            task:'text-gen', tags:['fast','multi'] },
  { group:'💬 对话生成 / 📌 置顶推荐', id:'@cf/zai-org/glm-4.7-flash',
    name:'GLM-4.7 Flash',                 desc:'智谱·131K 上下文·100+ 语言·工具调用',         task:'text-gen', tags:['fast','multi','fn'] },
  // ── 🆕 新模型 ──
  { group:'💬 对话生成 / 🆕 新模型',   id:'@cf/ibm/granite-4.0-h-micro',
    name:'Granite 4.0 H Micro',           desc:'IBM·RAG/多智能体/边缘部署',                   task:'text-gen', tags:['fast','code','fn'] },
  { group:'💬 对话生成 / 🆕 新模型',   id:'@cf/aisingapore/gemma-sea-lion-v4-27b-it',
    name:'SEA-LION v4 27B IT',            desc:'东南亚语言优化·多语言 LLM',                   task:'text-gen', tags:['multi'] },
  { group:'💬 对话生成 / 🆕 新模型',   id:'@cf/qwen/qwen3-30b-a3b-fp8',
    name:'Qwen3 30B A3B FP8',             desc:'阿里旗舰 MoE·推理+指令+多语言',               task:'text-gen', tags:['reason','code','multi','fn','batch'] },
  { group:'💬 对话生成 / 🆕 新模型',   id:'@cf/google/gemma-3-12b-it',
    name:'Gemma 3 12B IT',                desc:'Google·多模态·128K·140+ 语言',                task:'text-gen', tags:['vision','multi','lora'] },
  { group:'💬 对话生成 / 🆕 新模型',   id:'@cf/mistral/mistral-small-3.1-24b-instruct',
    name:'Mistral Small 3.1 24B',         desc:'视觉+128K 上下文·函数调用',                   task:'text-gen', tags:['vision','multi','fn'] },
  { group:'💬 对话生成 / 🆕 新模型',   id:'@cf/qwen/qwq-32b',
    name:'QwQ-32B',                       desc:'Qwen 推理专精·媲美 DeepSeek-R1',              task:'text-gen', tags:['reason','code','lora'] },
  { group:'💬 对话生成 / 🆕 新模型',   id:'@cf/qwen/qwen2.5-coder-32b-instruct',
    name:'Qwen2.5 Coder 32B',             desc:'代码专精·支持 92 种编程语言',                 task:'text-gen', tags:['code','lora'] },
  // ── 🦙 Meta Llama ──
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-3.1-70b-instruct',
    name:'Llama 3.1 70B Instruct',        desc:'高质量多语言·代码+对话',                      task:'text-gen', tags:['code','multi'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-3.1-8b-instruct',
    name:'Llama 3.1 8B Instruct',         desc:'多语言对话·检索摘要',                         task:'text-gen', tags:['multi'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-3.1-8b-instruct-fp8',
    name:'Llama 3.1 8B FP8',              desc:'FP8 精度量化版',                              task:'text-gen', tags:['fast','lite'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-3.1-8b-instruct-awq',
    name:'Llama 3.1 8B AWQ',              desc:'INT4 量化·更省资源',                          task:'text-gen', tags:['lite'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-3.2-11b-vision-instruct',
    name:'Llama 3.2 11B Vision',          desc:'视觉识别·图像推理·图文理解',                 task:'text-gen', tags:['vision','lora'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-3.2-3b-instruct',
    name:'Llama 3.2 3B Instruct',         desc:'超轻量·多语言对话',                           task:'text-gen', tags:['lite','multi'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-3.2-1b-instruct',
    name:'Llama 3.2 1B Instruct',         desc:'最小参数·极速响应',                           task:'text-gen', tags:['fast','lite'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-guard-3-8b',
    name:'Llama Guard 3 8B',              desc:'内容安全分类·输入/输出检测',                  task:'text-gen', tags:['code','lora'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-3-8b-instruct',
    name:'Llama 3 8B Instruct',           desc:'上代经典·行业基准',                           task:'text-gen', tags:['lite'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta-llama/meta-llama-3-8b-instruct',
    name:'Llama 3 8B (meta-llama)',       desc:'meta-llama 命名空间版',                       task:'text-gen', tags:['lite'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-3-8b-instruct-awq',
    name:'Llama 3 8B AWQ',                desc:'INT4 量化·节省显存',                          task:'text-gen', tags:['lite'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-2-7b-chat-fp16',
    name:'Llama 2 7B FP16',               desc:'FP16 高精度',                                 task:'text-gen', tags:['lite'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta/llama-2-7b-chat-int8',
    name:'Llama 2 7B INT8',               desc:'INT8 量化版',                                 task:'text-gen', tags:['lite'] },
  { group:'💬 对话生成 / 🦙 Meta Llama', id:'@cf/meta-llama/llama-2-7b-chat-hf-lora',
    name:'Llama 2 7B HF LoRA',            desc:'LoRA 适配器推理专用',                         task:'text-gen', tags:['lite','lora'] },
  // ── 🔥 Mistral ──
  { group:'💬 对话生成 / 🔥 Mistral',  id:'@cf/mistral/mistral-7b-instruct-v0.2',
    name:'Mistral 7B v0.2',               desc:'32K 上下文·指令微调·LoRA 支持',              task:'text-gen', tags:['fast','lite','lora'] },
  { group:'💬 对话生成 / 🔥 Mistral',  id:'@cf/mistral/mistral-7b-instruct-v0.2-lora',
    name:'Mistral 7B v0.2 LoRA',          desc:'LoRA 适配器版',                               task:'text-gen', tags:['lite','lora'] },
  { group:'💬 对话生成 / 🔥 Mistral',  id:'@cf/mistral/mistral-7b-instruct-v0.1',
    name:'Mistral 7B v0.1',               desc:'经典版本·LoRA 支持',                          task:'text-gen', tags:['lite','lora'] },
  // ── 💎 Google Gemma ──
  { group:'💬 对话生成 / 💎 Google Gemma', id:'@cf/google/gemma-7b-it',
    name:'Gemma 7B IT',                   desc:'轻量开源·LoRA 支持',                          task:'text-gen', tags:['lite','lora'] },
  { group:'💬 对话生成 / 💎 Google Gemma', id:'@cf/google/gemma-7b-it-lora',
    name:'Gemma 7B IT LoRA',              desc:'LoRA 适配器专用版',                           task:'text-gen', tags:['lite','lora'] },
  { group:'💬 对话生成 / 💎 Google Gemma', id:'@cf/google/gemma-2b-it-lora',
    name:'Gemma 2B IT LoRA',              desc:'超轻量 LoRA 版',                              task:'text-gen', tags:['lite','lora'] },
  // ── 🧠 推理/专用 ──
  { group:'💬 对话生成 / 🧠 推理/专用', id:'@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    name:'DeepSeek R1 Qwen 32B',          desc:'蒸馏自 R1·超越 o1-mini',                      task:'text-gen', tags:['reason','code'] },
  { group:'💬 对话生成 / 🧠 推理/专用', id:'@cf/nousresearch/hermes-2-pro-mistral-7b',
    name:'Hermes 2 Pro Mistral 7B',       desc:'函数调用 + 结构化 JSON 输出',                 task:'text-gen', tags:['fn','code'] },
  { group:'💬 对话生成 / 🧠 推理/专用', id:'@cf/defog/sqlcoder-7b-2',
    name:'SQLCoder 7B v2',                desc:'自然语言→SQL·数据库查询',                     task:'text-gen', tags:['sql','code'] },
  { group:'💬 对话生成 / 🧠 推理/专用', id:'@cf/microsoft/phi-2',
    name:'Phi-2 2.7B',                    desc:'微软小参数·推理超同量级',                     task:'text-gen', tags:['lite','reason'] },

  // ══ 🖼️ Text-to-Image ══════════════════════════════════════
  { group:'🖼️ 文生图', id:'@cf/black-forest-labs/flux-2-klein-9b',
    name:'FLUX.2 Klein 9B',               desc:'超快蒸馏模型·生成+编辑·高质量',               task:'text-to-image', tags:['partner'] },
  { group:'🖼️ 文生图', id:'@cf/black-forest-labs/flux-2-klein-4b',
    name:'FLUX.2 Klein 4B',               desc:'超快蒸馏·实时预览·低延迟',                   task:'text-to-image', tags:['partner'] },
  { group:'🖼️ 文生图', id:'@cf/black-forest-labs/flux-2-dev',
    name:'FLUX.2 Dev',                    desc:'高真实感·多参考图支持',                       task:'text-to-image', tags:['partner'] },
  { group:'🖼️ 文生图', id:'@cf/black-forest-labs/flux-1-schnell',
    name:'FLUX.1 Schnell',                desc:'12B 整流流变换器·文本生图',                   task:'text-to-image', tags:[] },
  { group:'🖼️ 文生图', id:'@cf/leonardo/lucid-origin',
    name:'Lucid Origin',                  desc:'Leonardo·高提示响应·多风格',                  task:'text-to-image', tags:['partner'] },
  { group:'🖼️ 文生图', id:'@cf/leonardo/phoenix-1.0',
    name:'Phoenix 1.0',                   desc:'Leonardo·精准提示·文字渲染',                  task:'text-to-image', tags:['partner'] },
  { group:'🖼️ 文生图', id:'@cf/bytedance/stable-diffusion-xl-lightning',
    name:'SDXL Lightning',                desc:'字节跳动·闪电加速·1024px 高质量',             task:'text-to-image', tags:[] },
  { group:'🖼️ 文生图', id:'@cf/lykon/dreamshaper-8-lcm',
    name:'DreamShaper 8 LCM',             desc:'写实风格微调·SD 基础',                        task:'text-to-image', tags:[] },
  { group:'🖼️ 文生图', id:'@cf/runwayml/stable-diffusion-v1-5-img2img',
    name:'SD v1.5 Img2Img',               desc:'图生图·输入图像+文本提示',                    task:'text-to-image', tags:[] },
  { group:'🖼️ 文生图', id:'@cf/runwayml/stable-diffusion-v1-5-inpainting',
    name:'SD v1.5 Inpainting',            desc:'局部修复·Mask 区域重绘',                      task:'text-to-image', tags:[] },
  { group:'🖼️ 文生图', id:'@cf/stability-ai/stable-diffusion-xl-base-1.0',
    name:'SDXL Base 1.0',                 desc:'Stability AI·文本生成高质量图像',             task:'text-to-image', tags:[] },

  // ══ 🔊 Text-to-Speech ════════════════════════════════════
  { group:'🔊 文字转语音', id:'@cf/deepgram/aura-2-en',
    name:'Aura-2 EN',                     desc:'Deepgram·上下文感知 TTS·英文',                task:'tts', tags:['batch','partner','realtime'] },
  { group:'🔊 文字转语音', id:'@cf/deepgram/aura-2-es',
    name:'Aura-2 ES',                     desc:'Deepgram·上下文感知 TTS·西班牙语',            task:'tts', tags:['batch','partner','realtime'] },
  { group:'🔊 文字转语音', id:'@cf/deepgram/aura-1',
    name:'Aura-1',                        desc:'Deepgram·上下文感知 TTS·多语言',              task:'tts', tags:['batch','partner','realtime'] },
  { group:'🔊 文字转语音', id:'@cf/myshell-ai/melotts',
    name:'MeloTTS',                       desc:'高质量多语言 TTS·MyShell.ai',                 task:'tts', tags:[] },

  // ══ 🎤 Automatic Speech Recognition ══════════════════════
  { group:'🎤 语音识别', id:'@cf/deepgram/nova-3',
    name:'Nova-3',                        desc:'Deepgram·实时流式 STT',                       task:'asr', tags:['batch','partner','realtime'] },
  { group:'🎤 语音识别', id:'@cf/deepgram/flux',
    name:'Deepgram Flux',                 desc:'对话专用语音识别·实时',                       task:'asr', tags:['partner','realtime'] },
  { group:'🎤 语音识别', id:'@cf/openai/whisper-large-v3-turbo',
    name:'Whisper Large v3 Turbo',        desc:'预训练 ASR·批量转写',                         task:'asr', tags:['batch'] },
  { group:'🎤 语音识别', id:'@cf/openai/whisper',
    name:'Whisper',                       desc:'通用 ASR·多语言转录+翻译',                    task:'asr', tags:[] },
  { group:'🎤 语音识别', id:'@cf/openai/whisper-tiny-en',
    name:'Whisper Tiny EN',               desc:'最小英文 ASR·极低资源',                       task:'asr', tags:[] },

  // ══ 🔢 Text Embeddings ════════════════════════════════════
  { group:'🔢 文本嵌入', id:'@cf/baai/bge-large-en-v1.5',
    name:'BGE Large EN v1.5',             desc:'BAAI·1024 维向量·大型嵌入',                   task:'embedding', tags:['batch'] },
  { group:'🔢 文本嵌入', id:'@cf/baai/bge-base-en-v1.5',
    name:'BGE Base EN v1.5',              desc:'BAAI·768 维向量·基础嵌入',                    task:'embedding', tags:['batch'] },
  { group:'🔢 文本嵌入', id:'@cf/baai/bge-small-en-v1.5',
    name:'BGE Small EN v1.5',             desc:'BAAI·384 维向量·小型嵌入',                    task:'embedding', tags:['batch'] },
  { group:'🔢 文本嵌入', id:'@cf/baai/bge-m3',
    name:'BGE-M3',                        desc:'多功能·多语言·多粒度嵌入',                   task:'embedding', tags:[] },
  { group:'🔢 文本嵌入', id:'@cf/google/embeddinggemma-300m',
    name:'EmbeddingGemma 300M',           desc:'Google·300M·100+ 语言检索嵌入',              task:'embedding', tags:[] },
  { group:'🔢 文本嵌入', id:'@cf/qwen/qwen3-embedding-0.6b',
    name:'Qwen3 Embedding 0.6B',          desc:'Qwen3 最新嵌入模型·文本检索排序',            task:'embedding', tags:[] },
  { group:'🔢 文本嵌入', id:'@cf/pfnet/plamo-embedding-1b',
    name:'PLaMo Embedding 1B',            desc:'日语专用文本嵌入·PFNet',                      task:'embedding', tags:[] },

  // ══ 🔤 Text Classification ════════════════════════════════
  { group:'🔤 文本分类', id:'@cf/baai/bge-reranker-base',
    name:'BGE Reranker Base',             desc:'问题+文档直接输出相关性分数',                 task:'classification', tags:[] },
  { group:'🔤 文本分类', id:'@cf/huggingface/distilbert-sst-2-int8',
    name:'DistilBERT SST-2 INT8',         desc:'情感分类·正面/负面',                          task:'classification', tags:[] },

  // ══ 🌐 Translation ════════════════════════════════════════
  { group:'🌐 翻译', id:'@cf/meta/m2m100-1.2b',
    name:'M2M100 1.2B',                   desc:'Meta·多对多多语言翻译',                       task:'translation', tags:['batch'] },
  { group:'🌐 翻译', id:'@cf/ai4bharat/indictrans2-en-indic-1B',
    name:'IndicTrans2 EN→Indic 1B',       desc:'英语→22 种印度语言翻译',                      task:'translation', tags:[] },

  // ══ 📸 Image-to-Text ══════════════════════════════════════
  { group:'📸 图像理解', id:'@cf/llava-hf/llava-1.5-7b-hf',
    name:'LLaVA 1.5 7B HF',              desc:'多模态聊天·图像描述·VQA',                     task:'image-to-text', tags:[] },
  { group:'📸 图像理解', id:'@cf/unum/uform-gen2-qwen-500m',
    name:'UForm-Gen2 Qwen 500M',          desc:'图像描述+视觉问答·超轻量',                    task:'image-to-text', tags:[] },

  // ══ 🔍 Object Detection / Image Classification ═══════════
  { group:'🔍 图像检测/分类', id:'@cf/facebook/detr-resnet-50',
    name:'DETR ResNet-50',                desc:'Facebook·COCO 端到端目标检测',                task:'object-detect', tags:[] },
  { group:'🔍 图像检测/分类', id:'@cf/microsoft/resnet-50',
    name:'ResNet-50',                     desc:'微软·ImageNet 1M+ 图像分类',                  task:'image-classify', tags:[] },

  // ══ 📝 Summarization ══════════════════════════════════════
  { group:'📝 摘要', id:'@cf/facebook/bart-large-cnn',
    name:'BART Large CNN',                desc:'Facebook·文本摘要·seq2seq',                   task:'summarization', tags:[] },

  // ══ 🎙️ Voice Activity Detection ══════════════════════════
  { group:'🎙️ 语音活动检测', id:'@cf/pipecat-ai/smart-turn-v2',
    name:'Smart Turn v2',                 desc:'开源原生音频轮次检测·V2',                     task:'vad', tags:['batch','realtime'] },
];

const TAG_META = {
  fast:   { label:'⚡ 快速',  cls:'tag-fast'   },
  reason: { label:'🧠 推理',  cls:'tag-reason' },
  code:   { label:'💻 代码',  cls:'tag-code'   },
  vision: { label:'👁 多模态', cls:'tag-vision' },
  sql:    { label:'🗃 SQL',   cls:'tag-sql'    },
  lite:   { label:'🪶 轻量',  cls:'tag-lite'   },
  multi:  { label:'🌐 多语',  cls:'tag-multi'  },
  fn:     { label:'🔧 工具调用', cls:'tag-fn'  },
  batch:  { label:'📦 批量',  cls:'tag-batch'  },
  lora:   { label:'🔀 LoRA',  cls:'tag-lora'   },
};

let selectedModel = localStorage.getItem('cf_model') || '@cf/zai-org/glm-4.7-flash';

function renderTags(tags) {
  return (tags || []).map(t => {
    const m = TAG_META[t];
    return m ? \`<span class="tag \${m.cls}">\${m.label}</span>\` : '';
  }).join('');
}

function initModelPicker() {
  const trigger     = document.getElementById('model-trigger');
  const triggerName = document.getElementById('model-trigger-name');
  const triggerTags = document.getElementById('model-trigger-tags');
  const dropdown    = document.getElementById('model-dropdown');
  const listEl      = document.getElementById('model-list');
  const searchEl    = document.getElementById('model-search');
  const hiddenInput = document.getElementById('model-select');

  function setModel(id) {
    const m = MODEL_LIST.find(x => x.id === id) || MODEL_LIST[0];
    hiddenInput.value    = m.id;
    selectedModel        = m.id;
    // 任务类型徽标
    const BADGES = {'text-gen':'💬','text-to-image':'🖼️','tts':'🔊','asr':'🎤',
      'embedding':'🔢','classification':'🔤','translation':'🌐',
      'image-to-text':'📸','object-detect':'🔍','image-classify':'🔍',
      'summarization':'📝','vad':'🎙️'};
    const badge = BADGES[m.task] || '🤖';
    triggerName.textContent = badge + ' ' + m.name;
    triggerTags.innerHTML   = renderTags(m.tags);
    localStorage.setItem('cf_model', m.id);
    listEl.querySelectorAll('.model-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.id === m.id);
    });
    // 非对话类模型：input placeholder 提示
    const inp = document.getElementById('user-input');
    if (inp) {
      inp.placeholder = (m.task && m.task !== 'text-gen')
        ? '⚠️ 当前选择的是 ' + badge + ' ' + m.name + '（非对话模型）'
        : '输入消息…（Ctrl+Enter 发送）';
    }
    // 自动将 max-tokens-select 设为该模型允许的最大值
    const maxSel = document.getElementById('max-tokens-select');
    if (maxSel) {
      const limit = getMaxTokens(m.id);
      let best = maxSel.options[0];
      for (let i = 0; i < maxSel.options.length; i++) {
        if (parseInt(maxSel.options[i].value) <= limit) best = maxSel.options[i];
      }
      maxSel.value = best.value;
    }
  }

  function renderList(filter) {
    const q = (filter || '').toLowerCase();
    const groups = {};
    MODEL_LIST.forEach(m => {
      const taskLabel = m.task || '';
      if (q && !m.name.toLowerCase().includes(q) && !m.desc.toLowerCase().includes(q) &&
          !m.group.toLowerCase().includes(q) && !taskLabel.includes(q)) return;
      if (!groups[m.group]) groups[m.group] = [];
      groups[m.group].push(m);
    });
    listEl.innerHTML = Object.entries(groups).map(([g, items]) =>
      \`<div class="model-group-label">\${g}</div>\` +
      items.map(m =>
        \`<div class="model-item\${m.id === selectedModel ? ' selected' : ''}" data-id="\${m.id}">
           <div style="flex:1;min-width:0">
             <div class="model-item-name">\${m.name}</div>
             <div class="model-item-desc">\${m.desc}</div>
           </div>
           <div class="model-tags">\${renderTags(m.tags)}</div>
         </div>\`
      ).join('')
    ).join('');
    listEl.querySelectorAll('.model-item').forEach(el => {
      el.addEventListener('click', () => { setModel(el.dataset.id); closeDropdown(); });
    });
  }

  function openDropdown() {
    dropdown.classList.add('open');
    trigger.classList.add('open');
    searchEl.value = '';
    renderList('');
    searchEl.focus();
    setTimeout(() => {
      const sel = listEl.querySelector('.selected');
      if (sel) sel.scrollIntoView({ block:'nearest' });
    }, 50);
  }

  function closeDropdown() {
    dropdown.classList.remove('open');
    trigger.classList.remove('open');
  }

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.classList.contains('open') ? closeDropdown() : openDropdown();
  });
  searchEl.addEventListener('input', () => renderList(searchEl.value));
  document.addEventListener('click', e => {
    if (!document.getElementById('model-picker').contains(e.target)) closeDropdown();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDropdown(); });

  // 初始化选中值
  setModel(selectedModel);
}

// ══ 恢复历史消息气泡 ══════════════════════════════════════
function restoreHistory() {
  if (!chatHistory.length) return;
  document.getElementById('empty-state').style.display = 'none';
  chatHistory.forEach(m => {
    if (m.role === 'user' || m.role === 'assistant') {
      appendBubble(m.role, m.content, []);
    }
  });
}

// ══ EVENT BINDINGS ════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initModelPicker();
  // 初始化会话：恢复上次的会话
  const aid = getActiveId();
  const ss  = getSessions();
  if (aid && ss.find(x => x.id === aid)) {
    loadSession(aid);
  } else {
    restoreHistory();
  }
  // 新建对话按钮
  document.getElementById('new-chat-btn').addEventListener('click', newChat);
  document.getElementById('refresh-models-btn').addEventListener('click', refreshModels);
  // 会话列表按钮
  document.getElementById('sessions-btn').addEventListener('click', openSessions);
  document.getElementById('session-close').addEventListener('click', closeSessions);
  document.getElementById('session-overlay').addEventListener('click', closeSessions);
  document.getElementById('session-new-btn').addEventListener('click', () => { newChat(); closeSessions(); });
  // 登录
  document.getElementById('login-btn').addEventListener('click', doLogin);

  // 模式切换（利用已有 data-mode 属性）
  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // 退出
  document.getElementById('logout-btn').addEventListener('click', doLogout);

  // 快捷提示（利用 data-msg 属性）
  document.querySelectorAll('.suggestion').forEach(el => {
    el.addEventListener('click', () => quickSend(el.dataset.msg));
  });

  // 翻译面板
  document.getElementById('trans-swap-btn').addEventListener('click', swapLangs);
  document.getElementById('trans-btn').addEventListener('click', doTranslate);

  // 发送按钮
  document.getElementById('send-btn').addEventListener('click', () => {
    if (streaming && _abortCtrl) {
      // 停止生成：中止当前 SSE 请求
      _abortCtrl.abort();
      streaming = false; _abortCtrl = null; setSendBtn(false);
      // 保存已生成的部分内容（取最后一个 assistant bubble 的文本）
      const msgs = document.getElementById('messages');
      const lastBub = msgs.querySelector('.msg-wrap.assistant:last-child .bubble > div');
      if (lastBub) {
        const partial = lastBub.innerText.trim();
        if (partial && partial !== 'AI 思考中…') {
          chatHistory.push({ role: 'assistant', content: partial });
          saveHistory();
        }
      }
      showToast('✋ 已停止生成');
    } else {
      sendMessage();
    }
  });

  // upload-preview 事件委托（动态生成的删除按钮）
  document.getElementById('upload-preview').addEventListener('click', e => {
    const btn = e.target.closest('button[data-idx]');
    if (btn) removeFile(Number(btn.dataset.idx));
  });

  // 双击 logo 清空对话历史
  document.querySelector('.logo').addEventListener('dblclick', () => {
    if (confirm('清空所有对话历史？')) clearHistory();
  });
});
</script>
</body>
</html>`;
}
