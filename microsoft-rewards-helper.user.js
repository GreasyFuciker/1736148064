// ==UserScript==
// @name         Microsoft Rewards 自动助手
// @namespace    https://github.com/GreasyFuciker/1736148064
// @version      2.0.0
// @description  Bing Rewards 助手：读取每日任务与搜索进度、抓取相关搜索词、以可配置的人类节奏执行搜索，并在页面跳转之间完整保持状态
// @author       SOYS（v1）/ 重构优化（v2）
// @match        https://www.bing.com/*
// @match        https://cn.bing.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // 双保险：@noframes 之外再挡一次 iframe（奖励侧栏本身就是 iframe）
    if (window !== window.top) return;

    // ==========================================================================
    // 0. 常量
    // ==========================================================================

    const VERSION = '2.0.0';
    const CONFIG_KEY = 'bing_rewards_config_v2';
    const SESSION_KEY = 'bing_rewards_session_v2';

    /** 会话在无活动多久之后视为过期（毫秒）。需要大于最长的休息时间。 */
    const SESSION_TTL = 45 * 60 * 1000;

    /** 阶段名，同时作为持久化的断点标记。 */
    const Phase = {
        IDLE: 'idle',
        SCROLL: 'scrolling',
        SETTLE: 'waiting',
        CHECK: 'checking',
        REST: 'resting',
        INTERVAL: 'interval'
    };

    const PHASE_LABEL = {
        [Phase.SCROLL]: '滚动中',
        [Phase.SETTLE]: '停留中',
        [Phase.CHECK]: '检查中',
        [Phase.REST]: '休息中',
        [Phase.INTERVAL]: '等待中'
    };

    /** 只有命中这些 URL 的响应才会被解析，避免对全站所有请求做无谓的克隆与正则。 */
    const REWARDS_URL_RE = /(rewards|bingflyout|flyoutcontroller|getuserinfo|dailysetpromotions)/i;

    /** 兜底搜索词，仅在页面上一个相关搜索都抓不到时使用。 */
    const FALLBACK_TERMS = [
        'iPhone', 'Tesla', 'NVIDIA', 'Microsoft', 'weather', 'news today',
        'best movies', 'recipe', 'travel', 'technology', 'sports scores',
        'stock market', 'music playlist', 'fitness tips', 'book reviews'
    ];

    /** 中断信号：停止搜索时用它把正在 await 的阶段安静地打断。 */
    const ABORT = Symbol('aborted');

    // ==========================================================================
    // 1. 配置与会话持久化
    // ==========================================================================

    const config = {
        restTime: 5 * 60,          // 连续无进度时的休息时长（秒）
        scrollTime: 10,            // 每次搜索后的滚动时长（秒）
        waitTime: 8,               // 滚动结束后的停留时长（秒），让 Bing 记账
        searchInterval: [12, 25],  // 两次搜索之间的随机间隔（秒）
        maxNoProgressCount: 3,     // 连续多少次无进度才休息
        pointsPerSearch: 3,        // 单次搜索的积分，仅用于估算“还需搜几次”
        maxSearchesPerDay: 60,     // 安全上限：读不到进度时也不会无限循环
        autoClickDailyTasks: true  // 自动点击未完成的每日奖励卡片
    };

    /** 运行期状态。progress 与 usedTerms 会跨页面跳转持久化。 */
    const state = {
        running: false,
        phase: Phase.IDLE,
        phaseUntil: 0,             // 当前阶段的结束时间戳，跳转后据此续算
        progress: { current: 0, total: 0, completed: false, noProgressCount: 0, known: false },
        usedTerms: new Set(),      // 本日已搜过的词，跨跳转保留
        clickedOffers: new Set(),  // 本日已点过的奖励卡片链接
        searchCount: 0,            // 本日已发起的搜索次数（安全上限用）
        day: today(),
        mainTerms: [],
        iframeTerms: [],
        dailyTasks: [],
        collapsed: true
    };

    /** 每次调用 stop() 递增，正在 await 的阶段发现 token 变了就自我了断。 */
    let runToken = 0;

    /** 本轮是否已经结算过“进度有没有涨”，见 applyProgress。 */
    let cycleScored = false;

    function today() {
        const d = new Date();
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    }

    function readJSON(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function writeJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            log('写入本地存储失败:', e.message);
            return false;
        }
    }

    function loadConfig() {
        const saved = readJSON(CONFIG_KEY);
        if (!saved) return;
        const num = (v, min, max) => (typeof v === 'number' && v >= min && v <= max);
        if (num(saved.restTime, 60, 3600)) config.restTime = saved.restTime;
        if (num(saved.scrollTime, 3, 60)) config.scrollTime = saved.scrollTime;
        if (num(saved.waitTime, 0, 60)) config.waitTime = saved.waitTime;
        if (num(saved.maxNoProgressCount, 1, 10)) config.maxNoProgressCount = saved.maxNoProgressCount;
        if (num(saved.pointsPerSearch, 1, 10)) config.pointsPerSearch = saved.pointsPerSearch;
        if (num(saved.maxSearchesPerDay, 5, 200)) config.maxSearchesPerDay = saved.maxSearchesPerDay;
        if (Array.isArray(saved.searchInterval) && saved.searchInterval.length === 2 &&
            num(saved.searchInterval[0], 1, 600) && num(saved.searchInterval[1], 1, 600) &&
            saved.searchInterval[0] <= saved.searchInterval[1]) {
            config.searchInterval = saved.searchInterval.slice();
        }
        if (typeof saved.autoClickDailyTasks === 'boolean') config.autoClickDailyTasks = saved.autoClickDailyTasks;
    }

    function saveConfig() {
        writeJSON(CONFIG_KEY, config);
    }

    /**
     * 保存会话。v1 用防抖延迟 2 秒写入，而搜索会立刻触发页面跳转，
     * 于是最关键的一次写入经常被跳转吃掉；这里改成同步写入。
     */
    function saveSession() {
        if (!state.running) return;
        writeJSON(SESSION_KEY, {
            running: true,
            phase: state.phase,
            phaseUntil: state.phaseUntil,
            progress: state.progress,
            usedTerms: [...state.usedTerms],
            clickedOffers: [...state.clickedOffers],
            searchCount: state.searchCount,
            day: state.day,
            updatedAt: Date.now()
        });
    }

    function loadSession() {
        const saved = readJSON(SESSION_KEY);
        if (!saved || !saved.running) return null;
        if (Date.now() - (saved.updatedAt || 0) > SESSION_TTL) {
            log('会话已过期，丢弃');
            clearSession();
            return null;
        }
        if (saved.day !== today()) {
            log('跨天，重置会话');
            clearSession();
            return null;
        }
        return saved;
    }

    function clearSession() {
        try {
            localStorage.removeItem(SESSION_KEY);
        } catch (e) { /* 忽略 */ }
    }

    function log(...args) {
        console.log('[RewardsHelper]', ...args);
    }

    // ==========================================================================
    // 2. 网络拦截
    // ==========================================================================
    // 奖励侧栏是跨域 iframe 时读不到 DOM，只能从 API 响应里捞数据。
    // v1 对站内每个请求都做 clone().text()，且用 /(\d+)\/(\d+)/ 匹配任意响应，
    // 日期 "10/25"、版本号之类都会被误判成进度。这里按 URL 收窄，并且只认结构化字段。

    const intercepted = { progress: null, dailyTasks: [] };

    function installInterceptors() {
        const originalFetch = window.fetch;
        if (typeof originalFetch === 'function') {
            window.fetch = function (...args) {
                const promise = originalFetch.apply(this, args);
                const url = requestUrl(args[0]);
                if (url && REWARDS_URL_RE.test(url)) {
                    promise.then(res => {
                        res.clone().text().then(text => parseRewardsResponse(url, text)).catch(() => {});
                    }).catch(() => {});
                }
                return promise;
            };
        }

        const xhrOpen = XMLHttpRequest.prototype.open;
        const xhrSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this.__rewardsUrl = typeof url === 'string' ? url : '';
            return xhrOpen.call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.send = function (body) {
            if (REWARDS_URL_RE.test(this.__rewardsUrl || '') && !this.__rewardsHooked) {
                this.__rewardsHooked = true;
                this.addEventListener('load', () => {
                    try {
                        if (this.responseType === '' || this.responseType === 'text') {
                            parseRewardsResponse(this.__rewardsUrl, this.responseText);
                        }
                    } catch (e) { /* 忽略 */ }
                });
            }
            return xhrSend.call(this, body);
        };

        log('网络拦截器已激活（仅匹配 Rewards 相关请求）');
    }

    function requestUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;   // Request 对象
        if (input && typeof input.href === 'string') return input.href; // URL 对象
        return '';
    }

    function parseRewardsResponse(url, text) {
        if (!text || text.length < 32) return;

        // 只接受带有明确字段名的进度，不再对任意 "a/b" 做猜测
        const m = text.match(/"pointProgress"\s*:\s*(\d+)[\s\S]{0,120}?"pointProgressMax"\s*:\s*(\d+)/) ||
                  text.match(/"current"\s*:\s*(\d+)\s*,\s*"total"\s*:\s*(\d+)/);
        if (m) {
            const current = parseInt(m[1], 10);
            const total = parseInt(m[2], 10);
            if (total > 0 && current <= total) {
                intercepted.progress = { current, total };
                log('从 API 捕获进度:', current, '/', total);
                applyProgress(current, total, 'API');
            }
        }

        if (/"offers?"/i.test(text) && /complete/i.test(text)) {
            const tasks = [];
            const re = /"title"\s*:\s*"([^"]{2,80})"[\s\S]{0,400}?"complete"\s*:\s*(true|false)/gi;
            let hit;
            while ((hit = re.exec(text)) !== null && tasks.length < 6) {
                tasks.push({ name: hit[1], status: hit[2] === 'true' ? '已完成' : '未完成' });
            }
            if (tasks.length) {
                intercepted.dailyTasks = tasks;
                state.dailyTasks = tasks;
                renderDailyTasks(tasks);
            }
        }
    }

    // ==========================================================================
    // 3. 主题与 UI
    // ==========================================================================

    const dom = {};

    function $(id) {
        if (!dom[id] || !dom[id].isConnected) dom[id] = document.getElementById(id);
        return dom[id];
    }

    function setText(id, text) {
        const node = $(id);
        if (node) node.textContent = text;
    }

    /** 极简 DOM 构造器，替换 v1 里逐行 createElement/appendChild 的重复代码。 */
    function el(tag, opts = {}) {
        const node = document.createElement(tag);
        if (opts.id) node.id = opts.id;
        if (opts.text != null) node.textContent = opts.text;
        if (opts.css) node.style.cssText = opts.css;
        for (const [k, v] of Object.entries(opts.attrs || {})) node.setAttribute(k, v);
        for (const [k, v] of Object.entries(opts.props || {})) node[k] = v;
        for (const [k, v] of Object.entries(opts.on || {})) node.addEventListener(k, v);
        for (const child of opts.children || []) if (child) node.appendChild(child);
        if (opts.parent) opts.parent.appendChild(node);
        return node;
    }

    function isDarkMode() {
        const html = document.documentElement;
        if (html.classList.contains('b_dark')) return true;
        if (document.body && document.body.classList.contains('b_dark')) return true;
        if (html.getAttribute('data-darkmode') === 'true') return true;
        if (document.body) return false;
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function getTheme() {
        const dark = isDarkMode();
        return {
            bg: dark ? '#2d2d2d' : '#fff',
            border: dark ? '#444' : '#ddd',
            text: dark ? '#e0e0e0' : '#333',
            textSecondary: dark ? '#aaa' : '#666',
            inputBg: dark ? '#3a3a3a' : '#fff',
            inputBorder: dark ? '#555' : '#ccc',
            accent: '#0078d4',
            accentDark: '#005a9e',
            danger: '#d83b01',
            dangerDark: '#a4262c',
            ok: '#4CAF50'
        };
    }

    const CONFIG_FIELDS = [
        { id: 'cfg-rest', label: '休息时间(分)', min: 1, max: 60, get: () => config.restTime / 60, set: v => { config.restTime = v * 60; }, unit: '分钟' },
        { id: 'cfg-scroll', label: '滚动时间(秒)', min: 3, max: 60, get: () => config.scrollTime, set: v => { config.scrollTime = v; }, unit: '秒' },
        { id: 'cfg-settle', label: '停留时间(秒)', min: 0, max: 60, get: () => config.waitTime, set: v => { config.waitTime = v; }, unit: '秒' },
        { id: 'cfg-tolerance', label: '容错次数', min: 1, max: 10, get: () => config.maxNoProgressCount, set: v => { config.maxNoProgressCount = v; }, unit: '次' },
        { id: 'cfg-imin', label: '间隔下限(秒)', min: 1, max: 600, get: () => config.searchInterval[0], set: v => { config.searchInterval[0] = Math.min(v, config.searchInterval[1]); }, unit: '秒' },
        { id: 'cfg-imax', label: '间隔上限(秒)', min: 1, max: 600, get: () => config.searchInterval[1], set: v => { config.searchInterval[1] = Math.max(v, config.searchInterval[0]); }, unit: '秒' },
        { id: 'cfg-cap', label: '每日上限(次)', min: 5, max: 200, get: () => config.maxSearchesPerDay, set: v => { config.maxSearchesPerDay = v; }, unit: '次' }
    ];

    function createUI() {
        const t = getTheme();

        const container = el('div', {
            id: 'rewards-helper-container',
            css: `position:fixed;bottom:20px;right:20px;background:${t.bg};color:${t.text};
                  border:1px solid ${t.border};border-radius:10px;padding:0;z-index:2147483000;
                  box-shadow:0 4px 20px rgba(0,0,0,.25);width:280px;font-size:12px;line-height:1.4;overflow:hidden;`
        });

        // --- 标题栏 ---
        const header = el('div', {
            id: 'rewards-helper-header',
            css: `background:linear-gradient(135deg,${t.accent},${t.accentDark});color:#fff;padding:10px 12px;
                  display:flex;justify-content:space-between;align-items:center;cursor:move;`,
            parent: container,
            children: [
                el('div', {
                    css: 'display:flex;align-items:center;gap:8px;',
                    children: [
                        el('span', { text: '🔍', css: 'font-size:16px;' }),
                        el('div', {
                            children: [
                                el('div', { text: 'Rewards 自动助手', css: 'font-weight:bold;font-size:13px;' }),
                                el('div', { text: `v${VERSION}`, css: 'font-size:10px;opacity:.8;' })
                            ]
                        })
                    ]
                }),
                el('div', {
                    css: 'display:flex;align-items:center;gap:6px;',
                    children: [
                        el('span', {
                            id: 'minimize-btn', text: '+',
                            css: 'cursor:pointer;font-size:16px;opacity:.8;width:20px;text-align:center;',
                            on: { click: toggleCollapse }
                        }),
                        el('span', {
                            text: '×',
                            css: 'cursor:pointer;font-size:18px;opacity:.8;width:20px;text-align:center;',
                            on: { click: () => { container.style.display = 'none'; } }
                        })
                    ]
                })
            ]
        });

        const content = el('div', { id: 'rewards-helper-content', css: 'padding:12px;', parent: container });

        // --- 进度 ---
        el('div', {
            css: 'margin-bottom:10px;',
            parent: content,
            children: [
                el('div', {
                    css: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;',
                    children: [
                        el('div', { id: 'rewards-progress', text: '进度: 加载中...', css: 'font-weight:bold;font-size:12px;' }),
                        el('div', { id: 'countdown', css: `font-size:11px;color:${t.accent};font-weight:bold;` })
                    ]
                }),
                el('div', {
                    css: `width:100%;height:6px;background:${t.inputBorder};border-radius:3px;overflow:hidden;`,
                    children: [
                        el('div', {
                            id: 'rewards-progress-bar',
                            css: `width:0%;height:100%;background:linear-gradient(90deg,${t.accent},#00bcf2);border-radius:3px;transition:width .3s ease;`
                        })
                    ]
                })
            ]
        });

        // --- 状态 ---
        el('div', {
            id: 'search-status', text: '就绪',
            css: `font-size:11px;color:${t.textSecondary};margin-bottom:8px;padding:6px 8px;
                  background:${t.inputBg};border-radius:4px;border-left:3px solid ${t.accent};
                  word-break:break-word;`,
            parent: content
        });

        // --- 每日任务 ---
        el('div', {
            id: 'daily-tasks-section',
            css: 'margin-bottom:8px;',
            parent: content,
            children: [
                el('div', { id: 'daily-tasks-summary', text: '每日任务：加载中...', css: 'font-weight:bold;font-size:11px;margin-bottom:4px;' }),
                el('div', { id: 'daily-tasks-list', css: 'font-size:11px;padding-left:4px;' })
            ]
        });

        // --- 搜索词 ---
        el('div', {
            id: 'rewards-search-terms-container',
            css: `margin-bottom:8px;max-height:100px;overflow-y:auto;font-size:11px;padding:6px 8px;
                  background:${t.inputBg};border-radius:4px;`,
            parent: content,
            children: [
                el('div', { text: '搜索词列表', css: `font-weight:bold;margin-bottom:4px;font-size:11px;color:${t.textSecondary};` }),
                el('div', { text: '主页面:', css: `font-weight:bold;font-size:10px;color:${t.textSecondary};margin-top:4px;` }),
                el('div', { id: 'main-search-terms', css: 'padding-left:8px;margin-bottom:4px;' }),
                el('div', { text: '侧栏推荐:', css: `font-weight:bold;font-size:10px;color:${t.textSecondary};` }),
                el('div', { id: 'iframe-search-terms', css: 'padding-left:8px;' })
            ]
        });

        // --- 配置 ---
        const configForm = el('div', {
            css: 'grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;font-size:11px;display:none;'
        });

        for (const field of CONFIG_FIELDS) {
            el('div', {
                css: 'display:flex;flex-direction:column;gap:2px;',
                parent: configForm,
                children: [
                    el('label', { text: field.label, attrs: { for: field.id }, css: `font-size:10px;color:${t.textSecondary};` }),
                    el('input', {
                        id: field.id,
                        attrs: { type: 'number', min: String(field.min), max: String(field.max) },
                        props: { value: String(field.get()) },
                        css: `width:100%;box-sizing:border-box;background:${t.inputBg};color:${t.text};
                              border:1px solid ${t.inputBorder};border-radius:4px;padding:4px 6px;font-size:11px;`,
                        on: {
                            change: (e) => {
                                const raw = parseInt(e.target.value, 10);
                                const val = Math.min(field.max, Math.max(field.min, isNaN(raw) ? field.min : raw));
                                field.set(val);
                                saveConfig();
                                syncConfigInputs();
                                setStatus(`${field.label.replace(/\(.*\)/, '')}已更新: ${field.get()}${field.unit}`);
                            }
                        }
                    })
                ]
            });
        }

        el('div', {
            css: 'grid-column:1/-1;display:flex;align-items:center;gap:6px;margin-top:2px;',
            parent: configForm,
            children: [
                el('input', {
                    id: 'auto-click-daily',
                    attrs: { type: 'checkbox' },
                    props: { checked: config.autoClickDailyTasks },
                    css: 'cursor:pointer;width:14px;height:14px;',
                    on: {
                        change: (e) => {
                            config.autoClickDailyTasks = e.target.checked;
                            saveConfig();
                            setStatus('自动点击奖励卡片: ' + (e.target.checked ? '开启' : '关闭'));
                        }
                    }
                }),
                el('label', { text: '自动点击奖励卡片', attrs: { for: 'auto-click-daily' }, css: 'cursor:pointer;font-size:11px;' })
            ]
        });

        const configArrow = el('span', { text: '▸', css: 'transition:transform .2s;font-size:10px;' });
        const configToggle = el('div', {
            text: '⚙️ 配置参数',
            css: 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-weight:bold;font-size:11px;padding:4px 0;',
            children: [configArrow],
            on: {
                click: () => {
                    const open = configForm.style.display === 'none';
                    configForm.style.display = open ? 'grid' : 'none';
                    configArrow.style.transform = open ? 'rotate(90deg)' : '';
                }
            }
        });

        el('div', {
            id: 'rewards-config-section',
            css: `border-top:1px solid ${t.border};padding-top:8px;`,
            parent: content,
            children: [configToggle, configForm]
        });

        // --- 按钮 ---
        el('div', {
            css: 'padding:0 12px 12px;',
            parent: container,
            children: [
                el('button', {
                    id: 'start-search-btn',
                    text: '▶ 开始搜索',
                    css: `width:100%;padding:8px 0;cursor:pointer;background:linear-gradient(135deg,${t.accent},${t.accentDark});
                          color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:bold;transition:opacity .2s;`,
                    on: {
                        click: () => { state.running ? stop('搜索已停止') : start(); },
                        mouseenter: (e) => { e.target.style.opacity = '.9'; },
                        mouseleave: (e) => { e.target.style.opacity = '1'; }
                    }
                })
            ]
        });

        document.body.appendChild(container);
        makeDraggable(container, header);
    }

    function syncConfigInputs() {
        for (const field of CONFIG_FIELDS) {
            const input = $(field.id);
            if (input) input.value = String(field.get());
        }
    }

    function makeDraggable(container, header) {
        let offsetX = 0;
        let offsetY = 0;

        const onMouseMove = (e) => {
            container.style.top = clamp(e.clientY - offsetY, 0, window.innerHeight - 40) + 'px';
            container.style.left = clamp(e.clientX - offsetX, 0, window.innerWidth - 60) + 'px';
        };

        const onMouseUp = () => {
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
        };

        header.addEventListener('mousedown', (e) => {
            if (window.getComputedStyle(e.target).cursor === 'pointer') return; // 点的是按钮
            const rect = container.getBoundingClientRect();
            container.style.left = rect.left + 'px';
            container.style.top = rect.top + 'px';
            container.style.right = '';
            container.style.bottom = '';
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp, { once: true });
        });
    }

    function clamp(v, min, max) {
        return Math.min(max, Math.max(min, v));
    }

    function setStatus(message) {
        setText('search-status', message);
        log(message);
    }

    function toggleCollapse() {
        state.collapsed = !state.collapsed;
        applyCollapse();
    }

    function applyCollapse() {
        const hidden = state.collapsed ? 'none' : 'block';
        for (const id of ['rewards-search-terms-container', 'rewards-config-section', 'daily-tasks-section']) {
            const node = $(id);
            if (node) node.style.display = hidden;
        }
        setText('minimize-btn', state.collapsed ? '+' : '−');
    }

    function renderProgress() {
        const p = state.progress;
        if (!p.known) {
            setText('rewards-progress', '进度: 未知');
            return;
        }
        const suffix = p.completed ? ' (已完成)' : '';
        setText('rewards-progress', `进度: ${p.current}/${p.total}${suffix}`);
        const bar = $('rewards-progress-bar');
        if (bar && p.total > 0) {
            bar.style.width = clamp((p.current / p.total) * 100, 0, 100) + '%';
            if (p.completed) bar.style.background = `linear-gradient(90deg,${getTheme().ok},#8BC34A)`;
        }
    }

    function updateCountdown(seconds, phase) {
        const node = $('countdown');
        if (!node) return;
        if (seconds > 0) {
            node.textContent = `${PHASE_LABEL[phase] || '倒计时'}: ${seconds}秒`;
            node.style.display = 'block';
        } else {
            node.textContent = '';
            node.style.display = 'none';
        }
    }

    function renderTermList(id, terms) {
        const box = $(id);
        if (!box) return;
        box.replaceChildren(...terms.map(term => el('div', { text: term })));
    }

    function renderDailyTasks(tasks) {
        const list = $('daily-tasks-list');
        const summary = $('daily-tasks-summary');
        const icon = (s) => (s === '已完成' ? '✅' : s === '未完成' ? '❌' : '❔');

        if (summary) summary.textContent = `每日任务：${tasks.length ? tasks.map(t => icon(t.status)).join('') : '✅✅✅'}`;
        if (!list) return;

        if (!tasks.length) {
            list.replaceChildren(el('div', { text: '每日任务已全部完成', css: `color:${getTheme().ok};` }));
            return;
        }
        list.replaceChildren(...tasks.map(task => el('div', {
            text: `${task.name}: ${task.status}`,
            css: `color:${task.status === '未完成' ? getTheme().danger : getTheme().ok};`
        })));
    }

    function applyTheme() {
        const t = getTheme();
        const container = $('rewards-helper-container');
        if (!container) return;

        container.style.backgroundColor = t.bg;
        container.style.color = t.text;
        container.style.borderColor = t.border;

        const header = $('rewards-helper-header');
        if (header) header.style.background = `linear-gradient(135deg,${t.accent},${t.accentDark})`;

        const status = $('search-status');
        if (status) {
            status.style.backgroundColor = t.inputBg;
            status.style.borderLeftColor = t.accent;
        }

        const cfg = $('rewards-config-section');
        if (cfg) cfg.style.borderTopColor = t.border;

        for (const input of container.querySelectorAll('input[type="number"]')) {
            input.style.background = t.inputBg;
            input.style.color = t.text;
            input.style.borderColor = t.inputBorder;
        }

        const terms = $('rewards-search-terms-container');
        if (terms) terms.style.backgroundColor = t.inputBg;

        const btn = $('start-search-btn');
        if (btn && !state.running) btn.style.background = `linear-gradient(135deg,${t.accent},${t.accentDark})`;
    }

    function setButtonRunning(running) {
        const btn = $('start-search-btn');
        if (!btn) return;
        const t = getTheme();
        btn.textContent = running ? '⏹ 停止搜索' : '▶ 开始搜索';
        btn.style.background = running
            ? `linear-gradient(135deg,${t.danger},${t.dangerDark})`
            : `linear-gradient(135deg,${t.accent},${t.accentDark})`;
    }

    function showCompletionNotification() {
        const t = getTheme();
        const notification = el('div', {
            css: `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:${t.accent};color:#fff;
                  padding:20px;border-radius:5px;box-shadow:0 4px 8px rgba(0,0,0,.2);z-index:2147483001;
                  text-align:center;font-size:16px;`,
            children: [
                el('div', { text: '任务完成！', css: 'font-weight:bold;margin-bottom:10px;font-size:18px;' }),
                el('div', { text: `今日搜索奖励已拿满（${state.progress.current}/${state.progress.total}）` })
            ]
        });
        el('button', {
            text: '关闭',
            css: 'margin-top:15px;padding:5px 15px;background:#fff;color:#0078d4;border:none;border-radius:3px;cursor:pointer;',
            parent: notification,
            on: { click: () => notification.remove() }
        });
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 10000);
    }

    // ==========================================================================
    // 4. 数据抓取
    // ==========================================================================

    /** v1 直接取第一个 iframe，Bing 页面里第一个往往是广告/埋点框。这里按 src 与内容特征定位。 */
    function getRewardsIframe() {
        const frames = [...document.querySelectorAll('iframe')];
        const bySrc = frames.find(f => /rewards|flyout/i.test(f.src || ''));
        if (bySrc) return bySrc;
        return frames.find(f => {
            try {
                return !!(f.contentDocument && f.contentDocument.querySelector('#bingRewards, .promo_cont, .daily_search_row'));
            } catch (e) {
                return false;
            }
        }) || null;
    }

    /** 打开积分侧栏。v1 的兜底分支在 forEach 里 return true，既没生效也会点开所有链接。 */
    function openRewardsSidebar() {
        const selectors = [
            '#id_rh', '.points-container', '.pointsContainer',
            '[data-testid="rewards-points"]', '.ms-rewards-link',
            '[aria-label*="积分"]', '[aria-label*="Rewards"]'
        ];
        for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (node && node.offsetParent !== null) {
                node.click();
                log('已点击积分入口:', selector);
                return true;
            }
        }
        const link = [...document.querySelectorAll('a[href*="rewards"]')]
            .find(a => !/account|profile|redeem/i.test(a.href));
        if (link) {
            link.click();
            log('兜底点击了 rewards 链接');
            return true;
        }
        log('未找到积分入口');
        return false;
    }

    /** 统一的进度写入口，负责判断“是否有增长”“是否完成”，并刷新 UI。 */
    function applyProgress(current, total, source) {
        const p = state.progress;
        if (!(total > 0) || current < 0 || current > total) return;

        // 一轮循环里可能多次读到进度（DOM + API 拦截），只允许结算一次，
        // 否则读取失败重试会把 noProgressCount 一次性推过阈值，误触发休息。
        if (p.known && state.running && !cycleScored) {
            cycleScored = true;
            if (current > p.current) {
                p.noProgressCount = 0;
                log(`进度增加: ${p.current} → ${current}（来源:${source}）`);
            } else {
                p.noProgressCount++;
                log(`进度未增加(${current})，连续 ${p.noProgressCount} 次`);
            }
        }

        p.current = current;
        p.total = total;
        p.known = true;
        p.completed = current >= total;
        renderProgress();
        saveSession();
    }

    /**
     * 读取侧栏 iframe。返回 true 表示至少拿到了一类数据。
     * 跨域时退回到网络拦截捕获的数据。
     */
    function readSidebar() {
        const iframe = getRewardsIframe();
        if (!iframe) {
            log('未找到奖励 iframe');
            return useInterceptedData();
        }

        let doc;
        try {
            doc = iframe.contentDocument || iframe.contentWindow.document;
        } catch (e) {
            log('iframe 跨域，改用 API 拦截数据:', e.message);
            return useInterceptedData();
        }
        if (!doc || doc.readyState === 'loading') return useInterceptedData();

        let ok = false;
        ok = readDailyTasks(doc) || ok;
        ok = readProgress(doc) || ok;
        ok = readSidebarTerms(iframe, doc) || ok;
        return ok || useInterceptedData();
    }

    function useInterceptedData() {
        let ok = false;
        if (intercepted.progress) {
            applyProgress(intercepted.progress.current, intercepted.progress.total, 'API');
            ok = true;
        }
        if (intercepted.dailyTasks.length) {
            renderDailyTasks(intercepted.dailyTasks);
            ok = true;
        }
        return ok;
    }

    function readProgress(doc) {
        // 1) 常规进度行
        const row = doc.querySelector('.daily_search_row span:last-child');
        const m = row && row.textContent.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) {
            applyProgress(parseInt(m[1], 10), parseInt(m[2], 10), 'DOM');
            return true;
        }

        // 2) 文案兜底
        const body = doc.body ? doc.body.textContent : '';
        if (!body) return false;

        const patterns = [
            { cur: /你已获得\s*(\d+)\s*积分/, max: /最多\s*(\d+)\s*(?:奖励)?积分/ },
            { cur: /You earned\s*(\d+)\s*points?/i, max: /(?:earn|get)\s+up\s+to\s*(\d+)\s*(?:Rewards\s+)?points?/i }
        ];
        for (const { cur, max } of patterns) {
            const c = body.match(cur);
            const t = body.match(max);
            if (c && t) {
                applyProgress(parseInt(c[1], 10), parseInt(t[1], 10), '文案');
                return true;
            }
            if (c && !t) {
                // 只有“你已获得 N 积分”而没有“最多”，说明当天已拿满
                const n = parseInt(c[1], 10);
                applyProgress(n, n, '文案-完成');
                return true;
            }
        }
        return false;
    }

    function readDailyTasks(doc) {
        const tasks = [];
        const clickTargets = [];

        // 旧版三卡片布局
        const oldContainer = doc.querySelector('#bingRewards .flyout_control_threeOffers');
        if (oldContainer) {
            for (const offer of oldContainer.querySelectorAll('div[aria-label*="Offer"]')) {
                const label = offer.getAttribute('aria-label') || '';
                const lower = label.toLowerCase();
                const status = lower.includes('not completed') ? '未完成'
                    : /offer (is )?completed/.test(lower) ? '已完成' : '未知';
                tasks.push({ name: label.split(' - ')[0] || `任务${tasks.length + 1}`, status });
                const link = offer.querySelector('a[href]');
                if (status === '未完成' && link) clickTargets.push(link);
            }
        }

        // 新版 promo_card 布局
        const cards = [...doc.querySelectorAll('.promo_cont .promo_card, .fp_row.promo_card')]
            .filter(card => {
                const title = card.querySelector('.promo-title');
                if (!title) return false;
                const text = title.textContent.trim().toLowerCase();
                return !['推荐', 'refer', '邀请', 'share', 'earn 7500'].some(p => text.includes(p));
            });

        for (const card of cards) {
            if (tasks.length >= 6) break;
            const titleEl = card.querySelector('.promo-title, p[class*="promo-title"]');
            const name = titleEl ? titleEl.textContent.trim() : `任务${tasks.length + 1}`;
            const done = card.classList.contains('complete') ||
                (titleEl && titleEl.classList.contains('complete')) ||
                !!card.querySelector('.complete');
            tasks.push({ name, status: done ? '已完成' : '未完成' });
            // v1 在这里取 .promo_cont 里的第一个 a，导致所有卡片都点到同一个链接
            const link = card.closest('a[href]') || card.querySelector('a[href]');
            if (!done && link) clickTargets.push(link);
        }

        if (!oldContainer && !cards.length) return false;

        state.dailyTasks = tasks;
        renderDailyTasks(tasks);

        if (config.autoClickDailyTasks && clickTargets.length) clickOffers(clickTargets);
        return true;
    }

    /** 每个链接每天只点一次，并限制单次数量，避免疯狂开新标签页。 */
    function clickOffers(links) {
        let clicked = 0;
        for (const link of links) {
            if (clicked >= 3) break;
            const href = link.href || link.getAttribute('href') || '';
            if (!href || state.clickedOffers.has(href)) continue;
            state.clickedOffers.add(href);
            link.click();
            clicked++;
            log('点击奖励卡片:', href);
        }
        if (clicked) {
            saveSession();
            setStatus(`已点击 ${clicked} 个未完成的奖励卡片`);
        }
    }

    function readSidebarTerms(iframe, doc) {
        let terms = [];

        // 1) 直接读 iframe 里的 viewModel
        try {
            const vm = iframe.contentWindow && iframe.contentWindow.flyoutViewModel;
            const ss = vm && ((vm.flyoutResult && vm.flyoutResult.suggestedSearches) || vm.suggestedSearches);
            if (ss && Array.isArray(ss.suggestedItems)) {
                terms = ss.suggestedItems.map(i => i.query).filter(Boolean);
            }
        } catch (e) { /* 跨域，忽略 */ }

        // 2) 从 script 标签里把 viewModel JSON 抠出来
        if (!terms.length) {
            for (const script of doc.querySelectorAll('script')) {
                const text = script.textContent || '';
                const idx = text.indexOf('window.flyoutViewModel');
                if (idx === -1) continue;
                const json = extractBalancedJSON(text, text.indexOf('{', idx));
                if (!json) break;
                try {
                    const vm = JSON.parse(json);
                    const ss = (vm.flyoutResult && vm.flyoutResult.suggestedSearches) || vm.suggestedSearches;
                    if (ss && Array.isArray(ss.suggestedItems)) {
                        terms = ss.suggestedItems.map(i => i.query).filter(Boolean);
                    }
                } catch (e) {
                    log('viewModel JSON 解析失败:', e.message);
                }
                break;
            }
        }

        // 3) DOM 兜底
        if (!terms.length) {
            const wrapper = doc.querySelector('.ss_items_wrapper');
            if (wrapper) {
                terms = [...wrapper.querySelectorAll('span')]
                    .map(s => s.textContent.trim())
                    .filter(Boolean);
            }
        }

        if (!terms.length) return false;
        state.iframeTerms = [...new Set(terms)];
        renderTermList('iframe-search-terms', state.iframeTerms);
        log('侧栏搜索词:', state.iframeTerms.length, '个');
        return true;
    }

    /** 从 start 位置的 '{' 起做括号配对（跳过字符串与转义），取出完整 JSON。 */
    function extractBalancedJSON(text, start) {
        if (start < 0) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
        }
        return null;
    }

    function readMainPageTerms() {
        const current = (new URLSearchParams(location.search).get('q') || '').trim();
        const accept = (text) => text.length > 2 && text.length < 60 && text !== current;
        const selectors = ['.b_vList.b_divsec a[href*="/search?q="]', '.rslist a[href*="/search?q="]', '.richrsrailsuggestion_text'];

        let terms = [];
        for (const selector of selectors) {
            terms = [...document.querySelectorAll(selector)]
                .map(node => node.textContent.trim())
                .filter(accept);
            if (terms.length) break;
        }

        if (!terms.length) return false;
        state.mainTerms = [...new Set(terms)];
        renderTermList('main-search-terms', state.mainTerms);
        log('主页面搜索词:', state.mainTerms.length, '个');
        return true;
    }

    // ==========================================================================
    // 5. 搜索词选择
    // ==========================================================================

    function usingFallback() {
        return !state.iframeTerms.length &&
            state.mainTerms.length > 0 &&
            state.mainTerms.every(t => FALLBACK_TERMS.includes(t));
    }

    function ensureFallbackTerms() {
        if (state.mainTerms.length || state.iframeTerms.length) return false;
        state.mainTerms = [...FALLBACK_TERMS];
        renderTermList('main-search-terms', state.mainTerms);
        setStatus('页面无相关搜索词，改用兜底词库');
        return true;
    }

    function randomSuffix() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        const len = 2 + Math.floor(Math.random() * 3);
        let out = '';
        for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
        return out;
    }

    function pickTerm() {
        const pool = [
            { terms: state.mainTerms.filter(t => !state.usedTerms.has(t)), source: usingFallback() ? '兜底' : '主页面' },
            { terms: state.iframeTerms.filter(t => !state.usedTerms.has(t)), source: '侧栏' }
        ];

        let candidate = pool.find(p => p.terms.length);

        // 全部用过：兜底词库可以加随机后缀复用，页面词则清空重来
        if (!candidate) {
            if (!state.mainTerms.length && !state.iframeTerms.length) return null;
            log('搜索词已全部用过，重置');
            state.usedTerms.clear();
            candidate = state.mainTerms.length
                ? { terms: state.mainTerms, source: usingFallback() ? '兜底' : '主页面' }
                : { terms: state.iframeTerms, source: '侧栏' };
        }

        const base = candidate.terms[Math.floor(Math.random() * candidate.terms.length)];
        state.usedTerms.add(base);
        // 兜底词库很小，加随机后缀让每次查询串不同，避免被判为重复搜索
        return { term: usingFallback() ? `${base} ${randomSuffix()}` : base, source: candidate.source };
    }

    // ==========================================================================
    // 6. 阶段调度
    // ==========================================================================
    // v1 的致命问题：performSearch 提交表单后页面立刻跳转，
    // 挂在后面的 setTimeout(滚动 → 查进度 → 等待) 随着旧页面一起被销毁，从未执行；
    // 新页面恢复时又调用 startSearchProcess() 清空了已用词集合，于是反复搜同样的词。
    // v2 把「搜索」定为一次跳转的终点，其余阶段全部放在新页面加载后执行，
    // 并把阶段与截止时间写进 localStorage，跳转/刷新都能续算。

    let tickerId = null;
    let scrollerId = null;

    function clearTimers() {
        if (tickerId) { clearInterval(tickerId); tickerId = null; }
        if (scrollerId) { clearInterval(scrollerId); scrollerId = null; }
    }

    /** 等到 deadline，期间刷新倒计时；停止搜索会以 ABORT 拒绝。 */
    function waitUntil(deadline, phase) {
        state.phase = phase;
        state.phaseUntil = deadline;
        saveSession();

        return new Promise((resolve, reject) => {
            const token = runToken;
            if (tickerId) { clearInterval(tickerId); tickerId = null; }

            const tick = () => {
                if (token !== runToken || !state.running) {
                    clearInterval(tickerId);
                    tickerId = null;
                    reject(ABORT);
                    return;
                }
                const left = Math.ceil((deadline - Date.now()) / 1000);
                updateCountdown(left, phase);
                if (left <= 0) {
                    clearInterval(tickerId);
                    tickerId = null;
                    updateCountdown(0);
                    resolve();
                }
            };
            tick();
            // 250ms 一跳：倒计时顺滑，且用时间戳算差值，不会像 setInterval(1000) 那样累积漂移
            tickerId = setInterval(tick, 250);
        });
    }

    function waitSeconds(seconds, phase) {
        return waitUntil(Date.now() + seconds * 1000, phase);
    }

    /** 内部短等待：不写会话、不刷倒计时，仅用于轮询。停止搜索时以 ABORT 拒绝。 */
    function sleep(ms) {
        return new Promise((resolve, reject) => {
            const token = runToken;
            setTimeout(() => {
                (token === runToken && state.running) ? resolve() : reject(ABORT);
            }, ms);
        });
    }

    /** 恢复被跳转打断的阶段：剩余时间大于 0 就接着等，否则立即跳过。 */
    function resumePhase(saved) {
        const remain = (saved.phaseUntil || 0) - Date.now();
        if (remain > 1000 && PHASE_LABEL[saved.phase]) {
            setStatus(`恢复上次的${PHASE_LABEL[saved.phase]}（剩余 ${Math.ceil(remain / 1000)} 秒）`);
            return waitUntil(saved.phaseUntil, saved.phase);
        }
        return Promise.resolve();
    }

    function scrollPhase() {
        setStatus('模拟浏览：滚动页面...');
        clearInterval(scrollerId);
        scrollerId = setInterval(() => {
            const amount = 100 + Math.floor(Math.random() * 300);
            window.scrollBy({ top: Math.random() > 0.3 ? amount : -amount, behavior: 'smooth' });
        }, 1000);

        return waitSeconds(config.scrollTime, Phase.SCROLL).finally(() => {
            clearInterval(scrollerId);
            scrollerId = null;
        });
    }

    async function checkPhase() {
        setStatus('检查搜索进度...');
        state.phase = Phase.CHECK;
        saveSession();

        openRewardsSidebar();
        // 侧栏 iframe 是异步加载的，轮询等它就绪，最多 6 秒。
        // 这里刻意用 sleep 而不是 waitSeconds：轮询不该反复写 localStorage，也不该刷倒计时。
        for (let i = 0; i < 12; i++) {
            await sleep(500);
            if (readSidebar()) return true;
        }
        log('本轮未能读到侧栏数据');
        return false;
    }

    function randomInterval() {
        const [min, max] = config.searchInterval;
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    function estimateRemaining() {
        const p = state.progress;
        if (!p.known || p.completed) return 0;
        // 进度行给的通常是积分而非次数，按每次搜索的积分折算，仅用于展示
        return Math.max(1, Math.ceil((p.total - p.current) / config.pointsPerSearch));
    }

    /** 发起搜索：直接跳转比填表单提交更可靠（不依赖 Bing 表单里的隐藏字段与事件）。 */
    function doSearch() {
        const picked = pickTerm();
        if (!picked) {
            stop('没有可用的搜索词，已停止');
            return false;
        }

        state.searchCount++;
        state.phase = Phase.IDLE;
        state.phaseUntil = 0;
        saveSession(); // 跳转前同步写入，绝不能丢

        const url = new URL('/search', location.origin);
        url.searchParams.set('q', picked.term);
        url.searchParams.set('form', 'QBRE');
        setStatus(`搜索: ${picked.term}（${picked.source}）· 第 ${state.searchCount} 次 · 预计还需 ${estimateRemaining()} 次`);
        location.assign(url.toString());
        return true;
    }

    /** 一次完整循环，运行在「上一次搜索跳转后的新页面」上，最后以一次跳转结束。 */
    async function runCycle(savedPhase) {
        cycleScored = false;
        try {
            if (savedPhase) await resumePhase(savedPhase);

            if (isResultsPage()) {
                await scrollPhase();
                if (config.waitTime > 0) {
                    setStatus('停留片刻，等待 Bing 记账...');
                    await waitSeconds(config.waitTime, Phase.SETTLE);
                }
                await checkPhase();
            } else {
                // 不在结果页（比如首页）就别装浏览了，直接查一次进度
                await checkPhase();
            }

            if (state.progress.completed) {
                showCompletionNotification();
                stop('今日搜索奖励已拿满 🎉');
                return;
            }

            if (state.searchCount >= config.maxSearchesPerDay) {
                stop(`已达每日上限 ${config.maxSearchesPerDay} 次，停止`);
                return;
            }

            if (state.progress.noProgressCount >= config.maxNoProgressCount) {
                state.progress.noProgressCount = 0;
                setStatus(`连续 ${config.maxNoProgressCount} 次无进度，休息 ${Math.round(config.restTime / 60)} 分钟`);
                await waitSeconds(config.restTime, Phase.REST);
            }

            readMainPageTerms();
            ensureFallbackTerms();

            const gap = randomInterval();
            setStatus(`等待 ${gap} 秒后进行下一次搜索`);
            await waitSeconds(gap, Phase.INTERVAL);

            doSearch();
        } catch (e) {
            if (e === ABORT) {
                log('循环已中断');
                return;
            }
            log('循环出错:', e && e.message);
            setStatus('出错了：' + (e && e.message ? e.message : String(e)));
            stop('因错误停止');
        }
    }

    function isResultsPage() {
        return location.pathname.startsWith('/search') && !!new URLSearchParams(location.search).get('q');
    }

    async function start() {
        // 启动时的这次读取发生在任何搜索之前，不能算作“搜索了却没涨分”，
        // 否则连点几次开始就会被误判成需要休息。
        cycleScored = true;
        state.running = true;
        state.day = today();
        state.phase = Phase.IDLE;
        state.progress.noProgressCount = 0;
        setButtonRunning(true);
        setStatus('启动中，正在读取奖励数据...');
        saveSession();

        readMainPageTerms();
        try {
            await checkPhase();
        } catch (e) {
            if (e === ABORT) return;
            log('启动时读取数据失败:', e && e.message);   // 读不到也继续，下一轮还会再读
        }
        if (!state.running) return;

        if (state.progress.completed) {
            showCompletionNotification();
            stop('今日搜索奖励已拿满 🎉');
            return;
        }

        ensureFallbackTerms();
        if (!state.mainTerms.length && !state.iframeTerms.length) {
            stop('没有可用的搜索词，无法开始');
            return;
        }

        doSearch();
    }

    function stop(message) {
        runToken++;          // 让正在 await 的阶段自行退出
        clearTimers();
        state.running = false;
        state.phase = Phase.IDLE;
        state.phaseUntil = 0;
        state.progress.noProgressCount = 0;
        updateCountdown(0);
        clearSession();
        setButtonRunning(false);
        setStatus(message || '搜索已停止');
    }

    // ==========================================================================
    // 7. 初始化
    // ==========================================================================

    function debounce(fn, ms) {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    function watchTheme() {
        const onChange = debounce(applyTheme, 200);
        const observer = new MutationObserver(onChange);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-darkmode'] });
        if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onChange);
    }

    function restore(saved) {
        state.progress = Object.assign(state.progress, saved.progress || {});
        state.usedTerms = new Set(saved.usedTerms || []);   // v1 在这里被清空，导致重复搜索
        state.clickedOffers = new Set(saved.clickedOffers || []);
        state.searchCount = saved.searchCount || 0;
        state.day = saved.day || today();
        state.running = true;
        setButtonRunning(true);
        renderProgress();
        setStatus('检测到上次任务，正在继续...');
    }

    function init() {
        loadConfig();
        createUI();
        applyCollapse();
        renderProgress();
        installInterceptors();
        watchTheme();

        window.addEventListener('beforeunload', () => {
            clearTimers();
            saveSession();
        });

        const saved = loadSession();
        if (saved) {
            restore(saved);
            runCycle(saved);
        } else {
            // 空闲状态也读一次数据，方便用户先看清今天还差多少
            setTimeout(() => {
                readMainPageTerms();
                openRewardsSidebar();
                setTimeout(() => {
                    if (!readSidebar()) setStatus('未读到奖励数据，可点开积分面板后重试');
                    else setStatus('就绪');
                }, 2500);
            }, 1200);
        }

        log(`已加载 v${VERSION}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
