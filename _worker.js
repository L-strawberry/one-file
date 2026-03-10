// 默认管理员密码
const DEFAULT_PASSWORD = 'admin888';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ua = request.headers.get('user-agent') || '';

    // 1. 管理后台 API 与 页面
    if (url.pathname === '/admin') {
      return renderAdminPage(env, request);
    }

    // API 路由
    if (url.pathname.startsWith('/api/')) {
      if (!checkAuth(request, env)) return unauthorized();
    // Gist 更新接口
    if (url.pathname === '/api/gist-update' && request.method === 'POST') {
      try {
        const { url: gistUrl, content } = await request.json();
        const token = env.GITHUB_TOKEN; // 从环境变量获取
        
        if (!token) return new Response('Server missing GITHUB_TOKEN', { status: 500 });
    
        // 解析 Gist ID 和文件名
        const urlObj = new URL(gistUrl);
        const pathParts = urlObj.pathname.split('/');
        const gistId = pathParts[2];
        const fileName = pathParts.filter(p => p).pop();
    
        const ghRes = await fetch(`https://api.github.com/gists/${gistId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Cloudflare-Worker-Gist-Manager',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            files: { [fileName]: { content: content } }
          })
        });
    
        if (ghRes.ok) {
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        } else {
          const err = await ghRes.text();
          return new Response('GitHub Error: ' + err, { status: ghRes.status });
        }
      } catch (e) {
        return new Response('Update Failed: ' + e.message, { status: 500 });
      }
    }

      // 获取配置与统计
      if (url.pathname === '/api/config' && request.method === 'GET') {
        const configs = await env.CONFIG_KV.get('configs', { type: 'json' }) || [];
        const stats = await env.CONFIG_KV.get('stats', { type: 'json' }) || {};
        return new Response(JSON.stringify({ configs, stats }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      }

      // 更新配置
      if (url.pathname === '/api/config' && request.method === 'POST') {
        try {
          const newConfigs = await request.json();
          await env.CONFIG_KV.put('configs', JSON.stringify(newConfigs));
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
        }
      }

      // 清空统计
      if (url.pathname === '/api/stats/clear' && request.method === 'POST') {
        await env.CONFIG_KV.put('stats', JSON.stringify({}));
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      // 预览代理
      if (url.pathname === '/api/preview' && request.method === 'GET') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) return new Response('Missing URL', { status: 400 });
        
        try {
          let res;
          for(let i=0; i<2; i++) {
            res = await fetch(targetUrl, { 
              headers: { 'User-Agent': 'GistProxy-Preview/1.1' },
              signal: AbortSignal.timeout(6000) 
            });
            if(res.ok) break;
          }
          const text = await res.text();
          return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        } catch (e) {
            const isTimeout = e.name === 'AbortError' || e.message.includes('timeout');
            return new Response(isTimeout ? '请求超时 (6s)，请重试' : 'Fetch Error: ' + e.message, { status: 500 });
        }
      }
    }

    // 核心匹配逻辑
    const configs = await env.CONFIG_KV.get('configs', { type: 'json' }) || [];
    const lowerUA = ua.toLowerCase();
    let matchedItem = null;

    for (const item of configs) {
      // 如果规则被显式设置为 false，则跳过匹配
      if (item.enabled === false) continue; 
  
      if (!item.ua || !item.url) continue;
      const keywords = item.ua.split(',').map(k => k.trim().toLowerCase()).filter(k => k !== "");
      if (keywords.some(k => lowerUA.includes(k))) {
        matchedItem = item;
        break;
      }
    }

    if (matchedItem) {
      ctx.waitUntil((async () => {
        const stats = await env.CONFIG_KV.get('stats', { type: 'json' }) || {};
        const key = matchedItem.url;
        if (!stats[key]) stats[key] = { count: 0, lastAccess: null };
        stats[key].count += 1;
        stats[key].lastAccess = new Date().toISOString();
        await env.CONFIG_KV.put('stats', JSON.stringify(stats));
      })());

      try {
        const gistResponse = await fetch(matchedItem.url, {
          headers: { 'User-Agent': ua || 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000)
        });
        if (!gistResponse.ok) return new Response(`Gist Error ${gistResponse.status}`, { status: 502 });

        const body = await gistResponse.arrayBuffer();
        const responseHeaders = new Headers(gistResponse.headers);
        
        // 覆盖下载文件名：优先取参数 name，次之取配置项 name，最后默认 config
        let fileName = url.searchParams.get('name') || matchedItem.name || 'config';
        if (!/\.(yaml|yml|conf|ini|txt|json)$/i.test(fileName)) fileName += '.yaml';
        
        const encodedFileName = encodeURIComponent(fileName);
        responseHeaders.set('Content-Disposition', `attachment; filename="${fileName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=utf-8''${encodedFileName}`);


        responseHeaders.set('Vary', 'User-Agent');
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');

        return new Response(body, { status: 200, headers: responseHeaders });
      } catch (e) {
        return new Response('Proxy Server Error: ' + e.message, { status: 500 });
      }
    }

    return new Response('No matched rule for UA: ' + ua, { status: 400 });
  }
};

function checkAuth(request, env) {
  const password = env.ADMIN_PASSWORD || DEFAULT_PASSWORD;
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-admin-token');
  return token === password;
}

function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

function renderAdminPage(env, request) {
  const url = new URL(request.url);
  const bgUrl = env.BACKGROUND_URL || '';
  const baseUrl = `${url.protocol}//${url.host}/`;

  const hostParts = url.host.split('.');
  const tld = hostParts.pop(); // 获取顶级后缀如 xyz, com
  const maskedHost = `***.***.${tld}`; 
  const maskedUrl = `${url.protocol}//${maskedHost}/`;
  
  return new Response(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>One File | 管理后台</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><defs><linearGradient id=%22g%22 x1=%220%25%22 y1=%220%25%22 x2=%22100%25%22 y2=%22100%25%22><stop offset=%220%25%22 style=%22stop-color:%236366f1%22/><stop offset=%22100%22 style=%22stop-color:%233730a3%22/></linearGradient></defs><rect width=%22100%22 height=%22100%22 rx=%2224%22 fill=%22url(%23g)%22/><circle cx=%2235%22 cy=%2235%22 r=%228%22 fill=%22%23fff%22 opacity=%220.9%22/><circle cx=%2265%22 cy=%2250%22 r=%228%22 fill=%22%23fff%22/><circle cx=%2235%22 cy=%2265%22 r=%228%22 fill=%22%23fff%22 opacity=%220.9%22/><path d=%22M35 35 L65 50 L35 65%22 stroke=%22white%22 stroke-width=%224%22 stroke-linecap=%22round%22 opacity=%220.5%22 fill=%22none%22/></svg>">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class'
        }
    </script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
       
    <script>
        (function() {
            const theme = localStorage.getItem('theme') || 'system';
            const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
            document.documentElement.classList.toggle('dark', isDark);
        })();
    </script>
    <link href="https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css" rel="stylesheet">
    <style>
    
        /* Gist URL 单元格容器 */
        .url-cell-container {
            position: relative;
            height: 38px; /* 保持与输入框高度一致 */
            display: flex;
            align-items: center;
        }
        
        /* 掩码层：平时显示，悬停消失 */
        .url-mask-display {
            position: absolute;
            inset: 0;
            padding: 6px 8px;
            font-size: 13px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            color: #94a3b8; /* slate-400 */
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            pointer-events: none;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
        }
        
        /* 模糊效果 */
        .url-blur {
            filter: blur(4.5px);
            opacity: 0.7;
            background: rgba(241, 245, 249, 0.5);
            border-radius: 4px;
            padding: 0 4px;
        }
        .dark .url-blur {
            background: rgba(30, 41, 59, 0.5);
        }
        
        /* 悬停逻辑：掩码隐藏，输入框显示 */
        .group\/url:hover .url-mask-display {
            opacity: 0;
            filter: blur(10px);
            transform: translateY(-5px);
        }
        
        .url-real-input {
            opacity: 0;
            transition: all 0.3s ease;
        }
        
        .group\/url:hover .url-real-input {
            opacity: 1;
        }

        /* 垃圾桶晃动动画 */
        @keyframes bin-shake {
            0%, 100% { transform: rotate(0deg); }
            25% { transform: rotate(12deg); }
            50% { transform: rotate(-12deg); }
            75% { transform: rotate(6deg); }
        }
        
        /* 悬停触发动画 */
        th.group:hover .ri-delete-bin-7-line {
            display: inline-block;
            animation: bin-shake 0.5s ease-in-out infinite;
        }
        
        /* 统计单元格清空时的闪烁特效 */
        .stats-clearing {
            animation: pulse-red 0.5s ease-out;
        }
        
        @keyframes pulse-red {
            0% { transform: scale(1); opacity: 1; }
            50% { transform: scale(0.9); opacity: 0.5; color: #ef4444; }
            100% { transform: scale(1); opacity: 1; }
        }

        /* 拖拽时的占位符样式 */
        .sortable-ghost {
            opacity: 0.4;
            background: rgba(99, 102, 241, 0.1) !important;
            border: 2px dashed #6366f1 !important;
            border-radius: 16px !important; /*数值越大越圆角 */
        }
        
        /* 选中的行样式 */
        .sortable-chosen {
            background: rgba(255, 255, 255, 0.9);
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
        }
        
        .drag-handle { cursor: grab; }
        .drag-handle:active { cursor: grabbing; }

        /* 液态流体光效动画 */
        @keyframes liquid-glow {
            0%, 100% {
                transform: translate(0, 0) scale(1) rotate(0deg);
                border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%;
            }
            33% {
                transform: translate(10px, -10px) scale(1.1) rotate(5deg);
                border-radius: 40% 60% 70% 30% / 40% 40% 60% 50%;
            }
            66% {
                transform: translate(-15px, 5px) scale(0.9) rotate(-5deg);
                border-radius: 70% 30% 50% 50% / 30% 60% 40% 70%;
            }
        }

        .animate-liquid-glow {
            animation: liquid-glow 8s ease-in-out infinite;
            filter: blur(40px);
            opacity: 0.6;
        }

        /* 增强模态框淡入效果 */
        #qrModal.open .fade-in {
            animation: liquid-pop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        @keyframes liquid-pop {
            0% { opacity: 0; transform: scale(0.8) translateY(20px); }
            100% { opacity: 1; transform: scale(1) translateY(0); }
        }

        /* 隐藏二维码默认生成的白边，使其更融合 */
        #qrcode img {
            border-radius: 1.5rem;
            mix-blend-mode: multiply;
        }
        .dark #qrcode img {
            filter: invert(0.9) hue-rotate(180deg); /* 适配暗黑模式 */
            mix-blend-mode: lighten;
        }
        
        .fade-in { animation: fadeIn 0.3s ease-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .toast { visibility: hidden; position: fixed; left: 50%; bottom: 2rem; transform: translateX(-50%); background: #1e293b; color: white; padding: 10px 20px; border-radius: 12px; font-size: 13px; z-index: 999; opacity: 0; transition: all 0.3s; }
        .toast.show { visibility: visible; opacity: 1; bottom: 3rem; }
        
        body {
            background-image: ${bgUrl ? "url('" + bgUrl + "')" : 'none'};
            background-size: cover; background-position: center; background-attachment: fixed;
            transition: background-color 0.3s;
        }
        .bg-overlay {
            position: fixed; inset: 0; z-index: -1;
            background: ${bgUrl ? 'rgba(248, 250, 252, 0.85)' : 'transparent'};
        }
        .dark .bg-overlay { background: ${bgUrl ? 'rgba(2, 6, 23, 0.9)' : 'transparent'}; }

        .config-input { border: 1px solid transparent; outline: none; width: 100%; transition: all 0.2s; padding: 6px 8px; border-radius: 8px; background: transparent; }
        .config-input:focus { background: rgba(241, 245, 249, 0.5); border-color: rgba(226, 232, 240, 0.5); }
        .dark .config-input:focus { background: rgba(30, 41, 59, 0.5); border-color: rgba(51, 65, 85, 0.5); }

        .modal { display: none; position: fixed; inset: 0; z-index: 100; align-items: center; justify-content: center; background: rgba(0,0,0,0.4); backdrop-filter: blur(4px); }
        .modal.open { display: flex; }

        tr.dragging { opacity: 0.5; background: rgba(99, 102, 241, 0.1); }
        .drag-handle { cursor: grab; padding: 10px; }
        
        @keyframes pulse-save {
            0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
            70% { transform: scale(1.05); box-shadow: 0 0 0 15px rgba(16, 185, 129, 0); }
            100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }
        .pulse-save-btn { animation: pulse-save 2s infinite; }

        .accordion-content { max-height: 0; overflow: hidden; transition: max-height 0.3s ease-out; }
        .accordion-item.active .accordion-content { max-height: 1000px; transition: max-height 0.5s ease-in; }
        .accordion-item.active .chevron { transform: rotate(180deg); }

        .scrollable-table-container {
            max-height: 235px; /* 规则列表高度，完全展开不滚动可设置为max-height: none */
            overflow-y: auto;
            scrollbar-width: thin;
        }

        .scrollable-table-container::-webkit-scrollbar { width: 6px; }
        .scrollable-table-container::-webkit-scrollbar-thumb { background: rgba(99, 102, 241, 0.2); border-radius: 10px; }
        
        thead th {
            position: sticky; top: 0; z-index: 10;
            background: rgba(255, 255, 255, 0.95);
        }
        .dark thead th { background: rgba(15, 23, 42, 0.95); }
        
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .animate-spin-custom { animation: spin 1s linear infinite; }
    </style>
</head>
<body class="bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 font-sans">
    <div class="bg-overlay"></div>
    <div id="toast" class="toast shadow-xl"></div>

    <!-- 登录页 -->
    <div id="loginPage" class="min-h-screen flex items-center justify-center px-6 relative z-10">
        <div class="w-full max-sm bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200/50 shadow-2xl text-center fade-in">
            <div class="mb-6 flex justify-center">
                <div class="w-16 h-16 bg-gradient-to-br from-indigo-500 to-indigo-800 rounded-2xl shadow-lg flex items-center justify-center transform rotate-12 group hover:rotate-0 transition-transform duration-300">
                   <i class="ri-shield-keyhole-line text-white text-3xl transform -rotate-12 group-hover:rotate-0 transition-transform"></i>
                </div>
            </div>
            <h2 class="text-xl font-black mb-2 tracking-tight">管理认证</h2>
            <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-8">Secure Access Portal</p>
            
            <input type="password" id="adminToken" onkeyup="if(event.keyCode==13) login()" placeholder="输入密钥" class="w-full bg-slate-100/50 dark:bg-slate-800/50 border-none outline-none px-5 py-4 rounded-2xl mb-4 text-center placeholder:text-slate-400 focus:ring-2 ring-indigo-500/20 transition-all">
            <button onclick="login()" class="w-full bg-indigo-800 hover:bg-indigo-700 text-white py-4 rounded-2xl font-bold shadow-xl shadow-indigo-500/20 active:scale-95 transition-all flex items-center justify-center gap-2">
                <span>进入后台</span>
                <i class="ri-arrow-right-line"></i>
            </button>
        </div>
    </div>

    <!-- 主界面 -->
    <div id="mainPage" class="hidden min-h-screen pb-32 relative z-10">
        <nav class="sticky top-0 z-30 bg-white/60 dark:bg-slate-950/60 backdrop-blur-md border-b border-slate-200/50 h-16 flex items-center px-6 justify-between">
            <div class="flex items-center">
                <div onclick="location.reload()" 
                    class="flex items-center gap-2 px-4 py-1.5 rounded-full cursor-pointer 
                            bg-white/50 dark:bg-white/5 
                            backdrop-blur-xl saturate-150
                            border border-white/40 dark:border-white/10
                            shadow-[0_4px_12px_rgba(0,0,0,0.05)]
                            hover:bg-white/40 dark:hover:bg-white/10 
                            transition-all duration-300 group">
        
                    <i class="ri-instance-fill text-indigo-800 dark:text-indigo-400 text-lg group-hover:scale-110 transition-transform"></i>
        
                    <span class="font-black text-sm tracking-tight text-slate-700 dark:text-slate-200">
                      One File
                    </span>
                </div>
            </div>

            <div class="flex items-center gap-4">
                <div class="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
                    <button onclick="setTheme('system')" id="btn-system" class="theme-btn w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 transition-all"><i class="ri-mac-line text-sm"></i></button>
                    <button onclick="setTheme('light')" id="btn-light" class="theme-btn w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 transition-all"><i class="ri-sun-line text-sm"></i></button>                    
                    <button onclick="setTheme('dark')" id="btn-dark" class="theme-btn w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 transition-all"><i class="ri-moon-line text-sm"></i></button>
                </div>

                <div class="h-6 w-[1px] bg-slate-200 dark:bg-slate-700 mx-1"></div>
                <button onclick="openBackupModal()" class="w-10 h-10 flex items-center justify-center rounded-xl text-slate-400 hover:text-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all" title="备份与恢复">
                    <i class="ri-database-2-line text-lg"></i>
                </button>
                <input type="file" id="importFile" class="hidden" accept=".bin" onchange="importEncryptedData(event)">
            </div>
        </nav>

        <main class="max-w-6xl mx-auto px-6 mt-8 space-y-6">
        
            <!-- 统计与链接区域 -->
            <div class="grid md:grid-cols-3 gap-6">
                <div class="md:col-span-2 bg-white/70 dark:bg-slate-900/70 backdrop-blur p-6 rounded-[2rem] border border-slate-200/50 shadow-sm flex flex-col justify-center">
                    <h2 class="text-[11px] font-black uppercase tracking-[0.2em] text-indigo-800 dark:text-indigo-400 mb-3 flex items-center gap-2">
                        <i class="ri-pulse-line"></i> UA 命中测试
                    </h2>
                    <div class="flex gap-2">
                        <input type="text" id="testUA" placeholder="输入 User-Agent 进行测试..." class="flex-1 bg-slate-100/50 dark:bg-slate-800/50 border-none rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 ring-indigo-500/20 text-slate-600 dark:text-slate-300">
                        <button onclick="testMatch()" class="bg-zinc-950 text-white px-6 py-2 rounded-xl text-sm font-bold active:scale-95 transition-all shadow-lg shadow-zinc-900/50">测试</button>
                    </div>
                    <div id="testResult" class="mt-3 text-xs font-medium hidden"></div>
                </div>
            
                <div class="bg-white/70 dark:bg-slate-900/70 p-6 rounded-[2rem] border border-slate-200/50 shadow-sm flex flex-col justify-center">
                    <div class="flex items-center justify-between mb-3 px-1">
                        <span class="text-[11px] font-black uppercase tracking-[0.2em] text-indigo-800 dark:text-indigo-400">
                            <i class="ri-link-m text-indigo-800 dark:text-indigo-400"></i> 通用订阅链接
                        </span>
                        <button onclick="showQRCode('${baseUrl}')" class="w-6 h-6 flex items-center justify-center rounded-lg text-slate-400 hover:text-indigo-800 hover:bg-white dark:hover:bg-slate-700 transition-all" title="生成二维码">
                            <i class="ri-qr-code-line text-sm"></i>
                        </button>
                    </div>
            
                    <div class="space-y-3">
                        <div class="group flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/30 p-2 rounded-xl border border-transparent hover:border-indigo-500/20 transition-all">
                            <div class="flex flex-col min-w-0">
                                <span class="text-[9px] text-slate-400 uppercase font-bold">基础订阅链接</span>
                                <code class="text-xs font-black tracking-tight text-emerald-400 dark:text-emerald-400 truncate">${maskedUrl}</code>
                            </div>
                            <button onclick="copyText('${baseUrl}')" class="w-8 h-8 flex items-center justify-center rounded-lg text-purple-400 hover:text-indigo-800 hover:bg-white dark:hover:bg-slate-700 shadow-sm transition-all">
                                <i class="ri-file-copy-2-line"></i>
                            </button>
                        </div>
                        <div class="group flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/30 p-2 rounded-xl border border-transparent hover:border-indigo-500/20 transition-all">
                            <div class="flex flex-col min-w-0">
                                <span class="text-[9px] text-slate-400 uppercase font-bold">链接携带参数</span>
                                <code class="text-[11px] font-medium tracking-tighter text-emerald-400 truncate">${maskedUrl}?name=config</code>
                            </div>
                            <button onclick="copyText('${baseUrl}?name=config')" class="w-8 h-8 flex items-center justify-center rounded-lg text-purple-400 hover:text-indigo-800 hover:bg-white dark:hover:bg-slate-700 shadow-sm transition-all">
                                <i class="ri-file-copy-2-line text-sm"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 规则列表 -->
            <div class="bg-white/70 dark:bg-slate-900/70 backdrop-blur rounded-[2.5rem] border border-slate-200/50 shadow-sm overflow-hidden">
                <div class="px-8 py-5 border-b border-slate-100/50 dark:border-slate-800 flex items-center justify-between">
                    <h2 class="font-black text-sm flex items-center gap-2"><i class="ri-list-settings-line text-indigo-800"></i>规则列表</h2>
                    <button onclick="addRow()" class="bg-indigo-800 text-white px-5 py-2.5 rounded-xl text-xs font-bold shadow-lg hover:bg-indigo-700 transition-all">新增规则</button>
                </div>
                
                <div class="scrollable-table-container">
                    <table class="w-full text-left min-w-[1000px] border-collapse">
                        <thead class="bg-white/95 dark:bg-slate-900/95 sticky top-0 z-10">
                            <tr class="text-[10px] text-slate-400 font-black uppercase border-b border-slate-50 dark:border-slate-800/50">
                                <th class="px-4 py-4 w-10 text-center">°•°</th>
                                <th class="px-4 py-4 w-40">备注/文件名</th>
                                <th class="px-4 py-4 w-48">UA关键词</th>
                                <th class="px-4 py-4">Gist URL</th>
                                <th class="px-4 py-4 w-32 cursor-pointer hover:text-red-500 transition-colors group" onclick="requestClearStats()">
                                    <div class="flex items-center justify-start gap-1">
                                        <span class="whitespace-nowrap">访问统计</span>
                                        <i class="ri-delete-bin-7-line opacity-0 group-hover:opacity-100 transition-all text-red-500 text-xs"></i>
                                    </div>
                                </th>
                                <th class="px-4 py-4 w-28 text-center text-indigo-800/80">操作</th>
                            </tr>
                        </thead>
                        <tbody id="configList" class="divide-y divide-slate-50 dark:divide-slate-800/50"></tbody>
                    </table>
                </div>
            </div>

            <!-- 说明与技巧 -->
            <div class="mt-12">
                <div class="accordion-item bg-white/40 dark:bg-slate-900/90 backdrop-blur-sm border border-slate-200/50 dark:border-slate-800/50 rounded-3xl overflow-hidden transition-all duration-300">
                    <button onclick="toggleAccordion()" class="w-full px-8 py-6 flex items-center justify-between group">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 flex items-center justify-center">
                                <i class="ri-question-line"></i>
                            </div>
                            <span class="font-black text-sm tracking-tight">使用说明与进阶技巧</span>
                        </div>
                        <i class="ri-arrow-down-s-line chevron transition-transform duration-300 text-slate-400 group-hover:text-indigo-800"></i>
                    </button>
                    <div id="accordionContent" class="accordion-content">
                        <div class="px-8 pb-8 pt-2 grid md:grid-cols-3 gap-8 text-[11px] md:text-[13px] text-slate-500 dark:text-slate-400 leading-relaxed">                     
                            
                            <div class="space-y-3">
                                <h4 class="font-black text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                                    <i class="ri-drag-drop-line text-indigo-500"></i> 规则匹配与排序
                                </h4>
                                <div class="flex gap-2">
                                    <span class="shrink-0">•</span>
                                    <p>系统采用<span class="text-indigo-600 dark:text-indigo-400 font-bold">自上而下</span>原则。点击行首 <i class="ri-draggable text-slate-300"></i> 图标可自由拖拽排序。若 UA 包含多个关键词（如 <code>clash,mihomo</code>），匹配其一即可。</p>
                                </div>
                                <div class="flex gap-2">
                                    <span class="shrink-0">•</span>
                                    <p>利用顶部的 <span class="font-bold text-slate-700 dark:text-slate-300">UA 命中测试</span>，输入客户端 User-Agent 即可实时预览命中哪条规则，验证优先级是否准确。</p>
                                </div>
                            </div>
            
                            <div class="space-y-3">
                                <h4 class="font-black text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                                    <i class="ri-flashlight-line text-emerald-500"></i> 列表快捷操作
                                </h4>
                                <div class="flex gap-2">
                                    <span class="shrink-0">•</span>
                                    <p>点击表头 <span class="text-red-500 font-bold">“访问统计”</span> 区域，可一键<span class="font-bold">清空全局访问记录</span>，让统计数据从头开始计数。</p>
                                </div>
                                <div class="flex gap-2">
                                    <span class="shrink-0">•</span>
                                    <p>点击预览图标 <i class="ri-eye-line text-purple-500"></i> 可穿透代理直接查看 Gist 原文，方便快速校验远端配置内容。</p>
                                </div>
                            </div>
            
                            <div class="space-y-3">
                                <h4 class="font-black text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                                    <i class="ri-safe-2-line text-amber-500"></i> 备份与外部链接
                                </h4>
                                <div class="flex gap-2">
                                    <span class="shrink-0">•</span>
                                    <p>导出备份使用 <span class="font-bold text-slate-700 dark:text-slate-300">AES-GCM 256位</span> 强加密。请务必牢记密码；<span class="text-red-500 font-bold">密码不存储于服务器</span>，丢失将无法找回数据。</p>
                                </div>
                                <div class="flex gap-2">
                                    <span class="shrink-0">•</span>
                                    <p>通过 <code class="text-slate-800 dark:text-slate-200">?name=文件名</code> 参数可自定义下载的文件名。点击上方 <span class="text-pink-500 font-bold">One File</span> 图标可快速刷新当前页。</p>
                                </div>
                            </div>           
                        </div>
                     </div>
                 </div>
            </div>
        </main>

        <!-- 动态保存栏 -->
        <footer id="saveFooter" class="fixed bottom-0 inset-x-0 p-6 z-40 transform translate-y-full opacity-0 transition-all duration-500 ease-in-out pointer-events-none">
            <div class="max-w-6xl mx-auto flex items-center justify-between bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl p-4 rounded-3xl border border-slate-200/50 shadow-2xl pointer-events-auto">
                <div class="flex items-center gap-3 px-2">
                    <div id="saveIndicator" class="w-2 h-2 rounded-full bg-amber-500"></div>
                    <span id="saveStatus" class="text-[10px] font-black uppercase tracking-widest text-slate-400">待保存更改</span>
                </div>
                <div class="flex gap-2">
                   <button onclick="saveConfigs()" id="saveBtn" class="bg-indigo-800 hover:bg-indigo-700 text-white px-10 py-3 rounded-2xl text-xs font-black shadow-xl shadow-indigo-500/20 active:scale-95 transition-all flex items-center gap-2">
                        <i class="ri-save-3-line"></i>
                        <span>保存配置</span>
                   </button>
                </div>
            </div>
        </footer>
    </div>

    <!-- 预览弹窗 -->
    <div id="previewModal" class="modal px-6">
        <div class="w-full max-w-5xl bg-white/70 dark:bg-slate-950/70 backdrop-blur-xl saturate-150 border border-white/20 dark:border-white/10 rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col h-[90vh]">
            <div class="p-6 border-b border-slate-100/50 dark:border-slate-800/50 flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-purple-100 dark:bg-purple-900/30 text-purple-600 flex items-center justify-center">
                        <i class="ri-edit-box-line text-xl"></i>
                    </div>
                    <div class="flex flex-col min-w-0">
                        <span id="previewTitle" class="font-black text-sm truncate leading-tight">配置预览编辑</span>
                        <span id="previewSubtitle" class="text-[10px] text-slate-400 font-bold truncate">备注名</span>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="copyPreviewContent()" class="w-8 h-8 flex items-center justify-center rounded-full text-purple-600 hover:bg-purple-50 transition-all" title="复制全部">
                        <i id="copyPreviewIcon" class="ri-file-copy-2-line"></i> </button>
                </div>
            </div>
    
            <div class="px-6 py-3 bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100/50 dark:border-slate-800/50 flex flex-wrap gap-3 items-center">
                <div class="flex items-center bg-white dark:bg-slate-800 rounded-lg px-3 py-1 border border-slate-200/50 dark:border-slate-700/50 flex-1 min-w-[250px] transition-all focus-within:ring-2 focus-within:ring-indigo-500/50">
                    <i class="ri-search-line text-slate-400 mr-2 text-xs"></i>
                    <input type="text" id="findInput" placeholder="查找内容..." class="bg-transparent border-none outline-none text-xs flex-1 py-1 dark:text-white">
                    
                    <span id="findStatus" class="text-[10px] text-slate-400 font-mono px-2 border-l border-slate-200 dark:border-slate-700 ml-2">0/0</span>
                    
                    <div class="flex items-center ml-1 border-l border-slate-200 dark:border-slate-700 pl-1">
                        <button type="button" 
                                onmousedown="event.preventDefault()" 
                                onclick="navigateMatch(-1)" 
                                class="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-400 transition-colors">
                            <i class="ri-arrow-up-s-line"></i>
                        </button>
                        <button type="button" 
                                onmousedown="event.preventDefault()" 
                                onclick="navigateMatch(1)" 
                                class="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-400 transition-colors">
                            <i class="ri-arrow-down-s-line"></i>
                        </button>
                    </div>
                </div>
            </div>
            
            <div class="flex-1 overflow-hidden px-6 bg-transparent flex flex-col pt-4">
                <textarea id="previewContent" 
                          class="w-full h-full p-4 text-sm font-mono bg-white/50 dark:bg-slate-800/50 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all resize-none dark:text-slate-300"
                          spellcheck="false"></textarea>
            </div>
            
            <div class="px-6 py-4 mt-2 flex items-center justify-between bg-slate-50/30 dark:bg-slate-900/30 border-t border-slate-100/50 dark:border-slate-800/50">
                <div class="flex items-center gap-2">
                    <div class="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></div>
                    <span id="editStatus" class="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest">就绪</span>
                </div>
            
                <div class="flex items-center gap-3">
                    <button onclick="closePreview()" class="px-5 py-2 rounded-xl text-xs font-bold text-slate-500 hover:bg-slate-200/50 dark:hover:bg-slate-800/50 transition-all">
                        取消
                    </button>
                    <button onclick="updateGistContent()" id="syncGistBtn" 
                            class="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-xl text-xs font-bold shadow-lg shadow-indigo-500/20 active:scale-95 transition-all flex items-center gap-2">
                        <i class="ri-cloud-line"></i>
                        <span>保存同步</span>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- 确认对话框组件 -->
    <div id="confirmModal" class="modal px-6" onclick="if(event.target==this) closeConfirm(false)">
        <div class="w-full max-w-sm bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl overflow-hidden p-8 text-center fade-in">
            <div class="mb-6 flex justify-center">
                <div class="w-16 h-16 bg-red-50 dark:bg-red-950/30 rounded-full flex items-center justify-center text-red-500">
                    <i class="ri-alert-line text-3xl"></i>
                </div>
            </div>
            <h3 id="confirmTitle" class="text-lg font-black mb-2 tracking-tight">操作确认</h3>
            <p id="confirmText" class="text-sm text-slate-400 mb-8 px-2">此操作无法撤销，请确认是否继续？</p>
            <div class="flex gap-3">
                <button onclick="closeConfirm(false)" class="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-500 py-3 rounded-2xl font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition-all">取消</button>
                <button id="confirmActionBtn" class="flex-1 bg-red-500 text-white py-3 rounded-2xl font-bold shadow-lg shadow-red-500/20 active:scale-95 transition-all">确认</button>
            </div>
        </div>
    </div>
    
    <!-- 密码输入框组件 -->
    <div id="inputModal" class="modal px-6" onclick="if(event.target==this) closeInput(null)">
        <div class="w-full max-w-sm bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-[2rem] shadow-2xl overflow-hidden p-8 text-center fade-in border border-white/20">
            <div class="mb-6 flex justify-center">
                <div class="w-16 h-16 bg-indigo-50 dark:bg-indigo-950/30 rounded-2xl flex items-center justify-center text-indigo-600">
                <i class="ri-lock-password-line text-3xl"></i>
                </div>
            </div>
            <h3 id="inputTitle" class="text-lg font-black mb-2 tracking-tight">加密认证</h3>
            <p id="inputText" class="text-sm text-slate-400 mb-6 px-2">请输入备份文件的解密密码</p>
            <input type="password" id="modalInput" class="w-full bg-slate-100/50 dark:bg-slate-800/50 border-none outline-none px-5 py-4 rounded-2xl mb-6 text-center placeholder:text-slate-400 focus:ring-2 ring-indigo-500/20 transition-all" placeholder="输入密码...">
            <div class="flex gap-3">
                <button onclick="closeInput(null)" class="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-500 py-3 rounded-2xl font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition-all">取消</button>
                <button id="inputConfirmBtn" class="flex-1 bg-indigo-800 text-white py-3 rounded-2xl font-bold shadow-lg shadow-indigo-500/20 active:scale-95 transition-all">确认</button>
        </div>
    </div>
</div>

    <script>
        let configs = [];
        let stats = {};
        let originalConfigsJson = ''; 
        let isModified = false;
        let confirmResolve = null;
        let inputResolve = null;
        let sortableInstance = null;
        let currentPreviewUrl = '';
        let matches = [];
        let currentMatchIndex = -1;
        
        async function login() {
            const token = document.getElementById('adminToken').value;
            const res = await fetch('/api/config', { headers: { 'x-admin-token': token } });
            if (res.ok) {
                sessionStorage.setItem('gist_proxy_token', token);
                document.getElementById('loginPage').classList.add('hidden');
                document.getElementById('mainPage').classList.remove('hidden');
                loadConfigs();
            } else {
                showToast('认证失败');
            }
        }

        async function loadConfigs() {
            const res = await fetch('/api/config', { 
                headers: { 'x-admin-token': sessionStorage.getItem('gist_proxy_token') } 
            });
            if (res.ok) {
                const d = await res.json();
                configs = d.configs || [];
                stats = d.stats || {};
                originalConfigsJson = JSON.stringify(configs); 
                renderTable();
            }
        }

        function initSortable() {
            const el = document.getElementById('configList');
            if (typeof Sortable === 'undefined') {
                console.error('Sortable library not loaded');
                return;
            }
            if (sortableInstance) sortableInstance.destroy();
            sortableInstance = Sortable.create(el, {
                handle: '.drag-handle',
                animation: 150,
                ghostClass: 'sortable-ghost',
                chosenClass: 'sortable-chosen',
                forceFallback: true,
                fallbackTolerance: 3,
                onEnd: (evt) => {
                    const movedItem = configs.splice(evt.oldIndex, 1)[0];
                    configs.splice(evt.newIndex, 0, movedItem);
                    markModified();
                }
            });
        }
        
        function maskGistUrl(url) {
            if (!url) return '未配置 URL';
            try {
                const urlObj = new URL(url);
                // 如果是 GitHub Gist 常见的 raw 格式
                if (urlObj.hostname === 'gist.githubusercontent.com') {
                    const parts = urlObj.pathname.split('/'); 
                    // 路径格式通常为 /username/gistid/raw/...
                    if (parts.length >= 2) {
                        const username = parts[1];
                        const maskedPath = urlObj.pathname.replace(username, '******');
                        return urlObj.origin + maskedPath;
                    }
                }
                // 非 Gist 链接，做通用掩码处理：保留首尾，中间模糊
                return url.replace(/(.{12}).+(.{8})/, '$1****$2');
            } catch (e) {
                return url; // 解析失败则返回原样
            }
        }
        
        async function toggleRule(index) {
            // 1. 切换本地状态
            configs[index].enabled = (configs[index].enabled === false) ? true : false;
            
            // 2. 立即渲染界面，给用户视觉反馈
            renderTable();
                       
            // 3. 立即发起请求保存到 KV
            try {
                const res = await fetch('/api/config', { 
                    method: 'POST', 
                    headers: { 
                        'x-admin-token': sessionStorage.getItem('gist_proxy_token'), 
                        'Content-Type': 'application/json' 
                    }, 
                    body: JSON.stringify(configs) 
                });
                
                if (res.ok) {
                    originalConfigsJson = JSON.stringify(configs); // 更新原始记录，隐藏保存栏
                    markModified(); 
                    showToast('✅ 启停状态已同步至 KV 数据库');
                } else {
                    showToast('❌ 同步失败，未能写入 KV，请稍后重试');
                }
            } catch (e) {
                showToast('⚠️ 网络异常，同步未完成');
            }
        }

        function renderTable() {
            const container = document.getElementById('configList');
            if (!container) return;
            
            container.innerHTML = configs.map((item, index) => {
                const stat = stats[item.url] || { count: 0, lastAccess: null };
                const timeStr = stat.lastAccess ? new Date(stat.lastAccess).toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'numeric', minute:'numeric'}) : '-';
                
                // 渲染 URL 掩码预览 - 使用单引号避免嵌套冲突
                const renderUrlPreview = (url) => {
                    if (!url) return '<span class="text-slate-300 italic">未配置 URL</span>';
                    try {
                        const urlObj = new URL(url);
                        if (urlObj.hostname === 'gist.githubusercontent.com') {
                            const parts = urlObj.pathname.split('/');
                            const username = parts[1] || '****';
                            const rest = parts.slice(2).join('/');
                            return 'https://.../<span class="blur-[4px] bg-slate-100 dark:bg-slate-800 px-1 rounded mx-0.5 select-none">' + username + '</span>/' + rest.substring(0, 8) + '...';
                        }
                        return url.length > 25 ? url.replace(/(.{10}).+(.{10})/, '$1...$2') : url;
                    } catch(e) {
                        return url;
                    }
                };

                return \`
                    <tr id="rule-row-\${index}" class="group hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all duration-500 border-b border-slate-50 dark:border-slate-800/50 \${item.enabled === false ? 'opacity-50 grayscale-[0.5]' : ''}">
                        <td class="px-4 py-4 text-center text-slate-300 dark:text-slate-700 cursor-grab active:cursor-grabbing" style="touch-action: none;">
                            <i class="ri-draggable drag-handle text-lg"></i>
                        </td>                    
                        <td class="px-4 py-2">
                            <input type="text" value="\${item.name || ''}" placeholder="备注" onchange="updateItem(\${index}, 'name', this.value)" class="config-input text-[13px] font-bold">
                        </td>
                        <td class="px-4 py-2">
                            <input type="text" value="\${item.ua || ''}" placeholder="clash,mihomo" onchange="updateItem(\${index}, 'ua', this.value)" class="config-input text-[13px] font-mono">
                        </td>
                        
                        <td class="px-4 py-2 group/url relative min-w-[240px]">
                            <div class="relative h-9 flex items-center">
                                <div class="absolute inset-0 flex items-center px-3 pointer-events-none transition-all duration-300 group-hover/url:opacity-0 group-hover/url:-translate-y-1">
                                    <span class="text-[12px] font-mono text-slate-400 truncate">
                                        \${renderUrlPreview(item.url)}
                                    </span>
                                </div>
                                
                                <input type="text" 
                                       value="\${item.url || ''}" 
                                       placeholder="https://gist..." 
                                       onchange="updateItem(\${index}, 'url', this.value)" 
                                       class="config-input text-[13px] font-mono text-indigo-800/70 dark:text-indigo-300 opacity-0 group-hover/url:opacity-100 transition-all duration-300 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm">
                            </div>
                        </td>

                        <td class="px-4 py-2">
                            <div class="flex flex-col text-[10px]">
                                <span class="font-black text-slate-900 dark:text-slate-100">\${stat.count} 次访问</span>
                                <span class="text-slate-400">\${timeStr}</span>
                            </div>
                        </td>
                        <td class="px-4 py-2">
                            <div class="flex items-center justify-center gap-1">
                                <button onclick="toggleRule(\${index})" 
                                        title="\${item.enabled === false ? '启用规则' : '禁用规则'}" 
                                        class="w-8 h-8 flex items-center justify-center rounded-lg \${item.enabled === false ? 'text-slate-400' : 'text-emerald-500'} hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
                                    <i class="\${item.enabled === false ? 'ri-toggle-line' : 'ri-toggle-fill'} text-xl"></i></button>                                                 
                                <button onclick="previewUrl(\${index})" title="文件预览" class="w-8 h-8 flex items-center justify-center rounded-lg text-purple-500 hover:bg-purple-50 transition-all"><i class="ri-eye-line text-lg"></i></button>
                                <button onclick="deleteRow(\${index})" title="删除" class="w-8 h-8 flex items-center justify-center rounded-lg text-red-400 hover:bg-red-50 transition-all"><i class="ri-delete-bin-line"></i></button>
                            </div>
                        </td>
                    </tr>\`;
            }).join('');
            
            setTimeout(initSortable, 0);
        }

        function updateItem(index, key, val) {
            configs[index][key] = val;
            markModified();
        }

        function addRow() {
            configs.unshift({ name: '', ua: '', url: '' });
            renderTable();
            markModified();
        }

        async function deleteRow(index) {
            const name = configs[index].name || '该规则';
            const ok = await customConfirm('确认删除', \`确定要删除 "\${name}" 吗？此操作仅在点击保存后生效。\`);
            if (ok) {
                configs.splice(index, 1);
                renderTable();
                markModified();
            }
        }

        function markModified() {
            const footer = document.getElementById('saveFooter');
            if (JSON.stringify(configs) === originalConfigsJson) {
                footer.classList.add('translate-y-full', 'opacity-0');
            } else {
                footer.classList.remove('translate-y-full', 'opacity-0');
            }
        }

        async function saveConfigs() {
            const res = await fetch('/api/config', { 
                method: 'POST', 
                headers: { 
                    'x-admin-token': sessionStorage.getItem('gist_proxy_token'), 
                    'Content-Type': 'application/json' 
                }, 
                body: JSON.stringify(configs) 
            });
            if(res.ok) {
                originalConfigsJson = JSON.stringify(configs);
                markModified(); 
                showToast('✅ 配置已同步至 KV 数据库');
            }
        }        
     
        // 初始化查找功能
        function initSearch() {
            const input = document.getElementById('findInput');
            const textarea = document.getElementById('previewContent');
        
            input.addEventListener('input', () => {
                const searchTerm = input.value;
                const text = textarea.value;
                matches = [];
                currentMatchIndex = -1;
        
                if (searchTerm && searchTerm.length > 0) {
                    const pattern = '[.*+?^' + '$' + '{' + '}()|[\\]\\\\]';
                    const safeSearch = searchTerm.replace(new RegExp(pattern, 'g'), '\\\\$&');
                    
                    try {
                        const regex = new RegExp(safeSearch, 'gi');
                        let match;
                        while ((match = regex.exec(text)) !== null) {
                            matches.push({
                                start: match.index,
                                end: match.index + searchTerm.length
                            });
                        }
                    } catch (e) {
                        console.error("Regex error:", e);
                    }
                }
                
                updateFindUI();
                if (matches.length > 0) {
                    currentMatchIndex = 0;
                    highlightAndScroll();
                    updateFindUI();
                }
            });
        }
        
        // 更新计数显示
        function updateFindUI() {
            const status = document.getElementById('findStatus');
            if (matches.length === 0) {
                status.innerText = '0/0';
                return;
            }
            // 使用字符串拼接避免 Cloudflare 变量解析错误
            status.innerText = (currentMatchIndex + 1) + ' / ' + matches.length;
        }
        
        // 上下切换逻辑
        function navigateMatch(direction) {
            if (matches.length === 0) return;
        
            currentMatchIndex += direction;
            
            // 循环导航：最后跳到最前，最前跳到最后
            if (currentMatchIndex >= matches.length) currentMatchIndex = 0;
            if (currentMatchIndex < 0) currentMatchIndex = matches.length - 1;
        
            highlightAndScroll();
            updateFindUI();
        }
        
        // 核心：高亮、焦点与自动滚动
        function highlightAndScroll() {
            const textarea = document.getElementById('previewContent');
            const match = matches[currentMatchIndex];
        
            if (match) {
                textarea.focus();
                // 高亮选中该段文字
                textarea.setSelectionRange(match.start, match.end);
        
                // 计算行号进行滚动定位
                const textBefore = textarea.value.substring(0, match.start);
                const lineNumbers = textBefore.split('\\n').length;
                
                // 粗略计算滚动高度 (每行约 18px)
                const lineHeight = 18;
                textarea.scrollTop = (lineNumbers - 5) * lineHeight;
            }
        }
        function showToast(msg) {
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.classList.add('show');
            setTimeout(() => t.classList.remove('show'), 3000);
        }

        // 自定义确认对话框
        function customConfirm(title, text, isDanger = true) {
            return new Promise((resolve) => {
                confirmResolve = resolve;
                document.getElementById('confirmTitle').innerText = title;
                document.getElementById('confirmText').innerText = text;
                const btn = document.getElementById('confirmActionBtn');
                btn.className = isDanger 
                    ? 'flex-1 bg-red-500 text-white py-3 rounded-2xl font-bold shadow-lg shadow-red-500/20 active:scale-95 transition-all'
                    : 'flex-1 bg-indigo-800 text-white py-3 rounded-2xl font-bold shadow-lg shadow-indigo-500/20 active:scale-95 transition-all';
                btn.onclick = () => closeConfirm(true);
                document.getElementById('confirmModal').classList.add('open');
            });
        }

        function closeConfirm(result) {
            document.getElementById('confirmModal').classList.remove('open');
            if (confirmResolve) confirmResolve(result);
        }
        
        // 自定义输入对话框
        function customInput(title, text) {
            return new Promise((resolve) => {
                inputResolve = resolve;
                document.getElementById('inputTitle').innerText = title;
                document.getElementById('inputText').innerText = text;
                const inputField = document.getElementById('modalInput');
                inputField.value = '';
                document.getElementById('inputModal').classList.add('open');
                inputField.focus();

                document.getElementById('inputConfirmBtn').onclick = () => {
                    const val = inputField.value;
                    if(!val) return showToast('请输入密码');
                    closeInput(val);
                };
                inputField.onkeyup = (e) => { if(e.keyCode === 13) document.getElementById('inputConfirmBtn').click(); };
            });
        }

        function closeInput(result) {
            document.getElementById('inputModal').classList.remove('open');
            if (inputResolve) inputResolve(result);
        }
        
        async function previewUrl(index) {
            const item = configs[index];
            if(!item.url) return;
            currentPreviewUrl = item.url;
            
            // 重置搜索状态
            matches = [];
            currentMatchIndex = -1;
            document.getElementById('findInput').onkeyup = function(e) {
                if (e.key === 'Enter') {
                    // 执行查找跳转逻辑
                    const keyword = this.value;
                    navigateToContent(keyword); 
                    // 手机端收起键盘（可选）
                    this.blur(); 
                }
            };
            document.getElementById('findStatus').innerText = '0/0';
        
            document.getElementById('previewTitle').innerText = '配置预览编辑';
            document.getElementById('previewSubtitle').innerText = item.name || '未命名备注';
            document.getElementById('previewContent').value = '正在拉取远程配置...';
            document.getElementById('editStatus').innerText = '正在获取内容...';
            document.getElementById('previewModal').classList.add('open');
            
            try {
                const res = await fetch('/api/preview?url=' + encodeURIComponent(item.url), {
                    headers: { 'x-admin-token': sessionStorage.getItem('gist_proxy_token') }
                });
                const text = await res.text();
                document.getElementById('previewContent').value = text;
                document.getElementById('editStatus').innerText = '可编辑状态';
                
                // 关键调用：在内容加载完成后初始化搜索功能
                initSearch(); 
                
            } catch (e) {
                document.getElementById('previewContent').value = '获取失败: ' + e.message;
            }
        }
        
        // 同步至 GitHub Gist (需要你在 Worker 环境变量中配置 GITHUB_TOKEN)
        async function updateGistContent() {
            const content = document.getElementById('previewContent').value;
            if (!currentPreviewUrl) return;
        
            const ok = await customConfirm('同步确认', '确定要将修改推送到远程 Gist 吗？此操作不可撤销。', false);
            if (!ok) return;
        
            document.getElementById('syncGistBtn').disabled = true;
            showToast('正在向 GitHub 发送请求...');
        
            try {
                const res = await fetch('/api/gist-update', {
                    method: 'POST',
                    headers: { 
                        'x-admin-token': sessionStorage.getItem('gist_proxy_token'),
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url: currentPreviewUrl, content: content })
                });
        
                if (res.ok) {
                    showToast('✅ Gist 更新成功！');
                    setTimeout(closePreview, 1000);
                } else {
                    // 这里原来报错的地方：改用单引号拼接
                    const err = await res.text();
                    showToast('❌ 更新失败: ' + err); 
                }
            } catch (e) {
                showToast('❌ 网络错误');
            } finally {
                document.getElementById('syncGistBtn').disabled = false;
            }
        }

        function closePreview() { document.getElementById('previewModal').classList.remove('open'); }

        function copyPreviewContent() {
            const previewElem = document.getElementById('previewContent');
            const icon = document.getElementById('copyPreviewIcon');
            
            if (!previewElem) return;
            const content = previewElem.value; // 使用 .value 获取 textarea 内容
        
            // 使用现代剪贴板 API (如果环境支持) 配合退化方案
            const copyToClipboard = (text) => {
                if (navigator.clipboard && window.isSecureContext) {
                    return navigator.clipboard.writeText(text);
                } else {
                    const temp = document.createElement('textarea');
                    temp.value = text;
                    document.body.appendChild(temp);
                    temp.select();
                    const success = document.execCommand('copy');
                    document.body.removeChild(temp);
                    return success ? Promise.resolve() : Promise.reject();
                }
            };
        
            copyToClipboard(content).then(() => {
                showToast('已复制预览内容');
                if (icon) {
                    icon.className = 'ri-checkbox-circle-line';
                    setTimeout(() => {
                        icon.className = 'ri-file-copy-2-line';
                    }, 2000);
                }
            }).catch(() => {
                showToast('复制失败，请手动选择复制');
            });
        }

        // 清空统计 (带动画反馈)
        async function requestClearStats() {
            const ok = await customConfirm('清空统计', '确定要清空所有访问统计吗？');
            if(!ok) return;
        
            // 1. 给数字添加闪烁动画
            const cells = document.querySelectorAll('#configList td:nth-child(6)');
            cells.forEach(c => c.classList.add('stats-clearing'));
        
            const res = await fetch('/api/stats/clear', {
                method: 'POST',
                headers: { 'x-admin-token': sessionStorage.getItem('gist_proxy_token') }
            });
        
            if(res.ok) { 
                setTimeout(() => {
                    stats = {}; 
                    renderTable(); 
                    showToast('统计已重置');
                }, 300); // 动画播放一半时刷新数据
            } else {
                cells.forEach(c => c.classList.remove('stats-clearing'));
                showToast('重置失败');
            }
        }

        function setTheme(t) { 
            localStorage.setItem('theme', t); 
            updateThemeUI(); 
        }

        function updateThemeUI() {
            const theme = localStorage.getItem('theme') || 'system';
            const systemIsDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            
            // 如果是 system 则看系统，否则看手动设置
            const isDark = theme === 'dark' || (theme === 'system' && systemIsDark);
            
            // 1. 切换全局深色模式类
            document.documentElement.classList.toggle('dark', isDark);
        
            // 2. 更新三个按钮的高亮状态
            const buttons = document.querySelectorAll('.theme-btn');
            buttons.forEach(btn => {
                // 先重置所有按钮为未选中状态
                btn.classList.remove('bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-indigo-600', 'dark:text-indigo-400');
                btn.classList.add('text-slate-400');
                
                // 匹配当前存储的主题模式（system/light/dark）
                if (btn.id === 'btn-' + theme) {
                    btn.classList.add('bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-indigo-600', 'dark:text-indigo-400');
                    btn.classList.remove('text-slate-400');
                }
            });
        }
        // 页面加载时立即执行一次，确保初始状态正确
        updateThemeUI();
        
        // 监听系统主题变化
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
            // 只有当用户选择的是 "跟随系统" (system) 时，才触发自动切换
            if (localStorage.getItem('theme') === 'system' || !localStorage.getItem('theme')) {
                updateThemeUI();
            }
        });

        function copyText(text) {
            const temp = document.createElement('textarea');
            temp.value = text;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            document.body.removeChild(temp);
            showToast('已复制订阅链接');
        }

        function testMatch() {
            const ua = document.getElementById('testUA').value;
            const resEl = document.getElementById('testResult');
            if(!ua) { resEl.classList.add('hidden'); return; }
            
            const lowerUA = ua.toLowerCase();
            // 寻找匹配项及其索引
            let matchedIndex = -1;
            let found = configs.find((item, index) => {
                if(!item.ua) return false;
                const isMatch = item.ua.split(',').map(k => k.trim().toLowerCase()).filter(k => k).some(k => lowerUA.includes(k));
                if(isMatch) {
                    matchedIndex = index;
                    return true;
                }
                return false;
            });
        
            resEl.classList.remove('hidden');
            
            if (found) {
                resEl.innerHTML = \`<span class="text-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 px-2 py-1 rounded-md">👾 命中: \${found.name || '未命名'}</span>\`;
                
                // 执行滚动与高亮
                const targetRow = document.getElementById(\`rule-row-\${matchedIndex}\`);
                if (targetRow) {
                    // 滚动到该行
                    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    
                    // 触发视觉高亮特效
                    targetRow.classList.add('bg-indigo-100', 'dark:bg-indigo-900/40', 'ring-2', 'ring-indigo-500/50');
                    
                    // 2秒后移除高亮
                    setTimeout(() => {
                        targetRow.classList.remove('bg-indigo-100', 'dark:bg-indigo-900/40', 'ring-2', 'ring-indigo-500/50');
                    }, 2000);
                }
            } else {
                resEl.innerHTML = '<span class="text-red-500 bg-red-50 dark:bg-red-500/10 px-2 py-1 rounded-md">☠️ 未命中</span>';
            }
        }

        function openBackupModal() { document.getElementById('backupModal').classList.add('open'); }
        function closeBackupModal() { document.getElementById('backupModal').classList.remove('open'); }

        async function handleExportClick() {
            closeBackupModal();
            await exportEncryptedData();
        }

        function handleImportClick() {
            closeBackupModal();
            document.getElementById('importFile').click();
        }

        function toggleAccordion() { 
            document.querySelector('.accordion-item').classList.toggle('active');
        }

        async function exportEncryptedData() {
            const password = await customInput("导出备份", "请设置备份文件的解密密码 (重要)");
            if (!password) return;
            try {
                const data = JSON.stringify({ configs, stats });
                const encoder = new TextEncoder();
                const salt = crypto.getRandomValues(new Uint8Array(16));
                const iv = crypto.getRandomValues(new Uint8Array(12));
                const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
                const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
                const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, encoder.encode(data));
                const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
                combined.set(salt); combined.set(iv, 16); combined.set(new Uint8Array(encrypted), 28);
                const blob = new Blob([combined], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = \`OneFile_Backup_\${new Date().toISOString().slice(0,10)}.bin\`;
                a.click();
                showToast('已导出加密备份');
            } catch (err) { showToast('加密失败: ' + err.message); }
        }

        function importEncryptedData(event) {
            const file = event.target.files[0];
            if(!file) return;
            (async () => {
                const password = await customInput("导入备份", "请输入该备份文件的解密密码");
                if (!password) { event.target.value = ''; return; }
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const combined = new Uint8Array(e.target.result);
                        const salt = combined.slice(0, 16);
                        const iv = combined.slice(16, 28);
                        const encrypted = combined.slice(28);
                        const encoder = new TextEncoder();
                        const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
                        const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
                        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, encrypted);
                        const data = JSON.parse(new TextDecoder().decode(decrypted));
                        configs = data.configs; stats = data.stats || {};
                        renderTable(); markModified();
                        showToast('导入成功，请保存'); 
                    } catch (err) { showToast('解密失败：密码错误或文件损坏'); }
                    event.target.value = ''; 
                };
                reader.readAsArrayBuffer(file);
            })();
        }

        window.onload = () => {
            // 1. 初始化界面主题
            updateThemeUI();
            
            // 2. 检查登录状态并加载数据
            if(sessionStorage.getItem('gist_proxy_token')) loadConfigs();

            // 3. 监听系统主题变化
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
                // 只有当用户选择“系统”模式时，才响应系统的自动切换
                if (localStorage.getItem('theme') === 'system' || !localStorage.getItem('theme')) {
                    updateThemeUI();
                }
            });
        };
        
        function showQRCode(url) {
            const container = document.getElementById('qrcode');
            if (!container) return;

            // 1. 清空旧内容
            container.innerHTML = "";

            // 2. 检查是否有有效 URL
            if (!url) {
                alert("二维码链接无效");
                return;
            }

            try {
                // 3. 生成二维码
                new QRCode(container, {
                    text: url,
                    width: 180,
                    height: 180,
                    colorDark: "#1e293b",
                    colorLight: "#ffffff",
                    // 建议改为 L，这样在长链接下二维码会更清晰，更容易扫码
                    correctLevel: QRCode.CorrectLevel.L 
                });

                // 4. 显示弹窗
                document.getElementById('qrModal').classList.add('open');
            } catch (e) {
                console.error("二维码生成失败:", e);
            }
        }

        function closeQRModal() { 
            document.getElementById('qrModal').classList.remove('open'); 
        }
    </script>

    
    <div id="backupModal" class="modal px-6" onclick="if(event.target==this) closeBackupModal()">
        <div class="w-full max-w-sm bg-white/70 dark:bg-slate-900/70 backdrop-blur-2xl saturate-150 rounded-[2.5rem] p-8 shadow-2xl border border-white/20 fade-in">
            <div class="flex justify-between items-center mb-6">
                <h3 class="text-lg font-black tracking-tight">备份与恢复</h3>
                <button onclick="closeBackupModal()" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                    <i class="ri-close-line text-xl"></i>
                </button>
            </div>
        
            <div class="grid gap-4">
                <button onclick="handleExportClick()" class="group flex items-center gap-4 p-4 rounded-2xl bg-white/50 dark:bg-slate-800/50 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 border border-white/40 dark:border-white/10 transition-all text-left">
                    <div class="w-12 h-12 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <i class="ri-download-cloud-2-line text-2xl"></i>
                    </div>
                    <div>
                        <div class="font-bold text-sm">导出备份</div>
                        <div class="text-[10px] text-slate-400 font-bold uppercase">Export .bin File</div>
                    </div>
                </button>

                <button onclick="handleImportClick()" class="group flex items-center gap-4 p-4 rounded-2xl bg-white/50 dark:bg-slate-800/50 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 border border-white/40 dark:border-white/10 transition-all text-left">
                    <div class="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <i class="ri-upload-cloud-2-line text-2xl"></i>
                    </div>
                    <div>
                        <div class="font-bold text-sm">导入备份</div>
                        <div class="text-[10px] text-slate-400 font-bold uppercase">Import .bin File</div>
                    </div>
                </button>
            </div>
        </div>
    </div> 
    
    <div id="qrModal" class="modal px-6" onclick="if(event.target==this) closeQRModal()">
        <div class="relative w-full max-w-[320px] fade-in group">
        
            <div class="absolute -inset-4 bg-gradient-to-tr from-indigo-500/30 to-purple-500/30 blur-3xl rounded-full animate-liquid-glow"></div>
        
            <div class="relative bg-white/60 dark:bg-slate-950/60 backdrop-blur-3xl saturate-200 rounded-[3.5rem] p-8 shadow-[0_20px_50px_rgba(0,0,0,0.1)] border border-white/40 dark:border-white/10 text-center overflow-hidden">
            
                <div class="absolute top-0 left-1/2 -translate-x-1/2 w-20 h-1.5 bg-gradient-to-r from-transparent via-indigo-500/20 to-transparent rounded-full"></div>

                <div class="flex justify-between items-center mb-8">
                    <span class="text-[11px] font-black uppercase tracking-[0.2em] text-indigo-600/60 dark:text-indigo-400/60">Subscription QR</span>
                    <button onclick="closeQRModal()" class="w-10 h-10 flex items-center justify-center rounded-2xl hover:bg-white/50 dark:hover:bg-slate-800/50 transition-all active:scale-90">
                        <i class="ri-close-line text-xl text-slate-400"></i>
                    </button>
                </div>

                <div class="relative inline-block p-6 bg-white dark:bg-slate-800 rounded-[2.5rem] shadow-[inner_0_4px_12px_rgba(0,0,0,0.05)] border border-slate-100/50 dark:border-slate-700/50 mb-6 group-hover:scale-[1.02] transition-transform duration-500">
                    <div id="qrcode" class="flex justify-center transition-all"></div>
                    <div class="absolute -top-1 -left-1 w-6 h-6 border-t-2 border-l-2 border-indigo-500/30 rounded-tl-[1.2rem]"></div>
                    <div class="absolute -bottom-1 -right-1 w-6 h-6 border-b-2 border-r-2 border-indigo-500/30 rounded-br-[1.2rem]"></div>
                </div>

                <div class="space-y-1">
                    <p class="text-[13px] font-bold text-slate-700 dark:text-slate-200">扫码即刻导入</p>
                    <p class="text-[10px] font-medium text-pink-500 tracking-tight break-all px-4">快速同步配置到客户端</p>
                </div>
            </div>
        </div>
    </div>
      
</body>
</html>
  `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
