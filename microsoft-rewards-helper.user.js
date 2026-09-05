// ==UserScript==
// @name         Microsoft Rewards 自动助手
// @namespace    https://github.com/GreasyFuciker/1736148064
// @version      2.6.0
// @description  Bing Rewards 助手：按设定的检索次数执行搜索，每次搜索后在新标签页打开首条结果、滚动浏览再关掉，抓取相关搜索词与每日任务，并在页面跳转之间完整保持状态
// @author       SOYS（v1）/ 重构优化（v2）
// @match        https://www.bing.com/*
// @match        https://cn.bing.com/*
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /**
     * 页面真正的 window。
     * 声明了 @grant 之后脚本跑在沙箱里，`window` 是一层代理：改 window.fetch 只会改到
     * 代理上，页面里的 fetch 毫发无损；拿 `window` 直接和 `window.top` 比也会因为
     * 「代理 !== 真身」而恒不相等。凡是要碰页面本身的地方都用这个引用。
     */
    const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    /** 脚本管理器提供的开标签页 API。它由扩展开标签页，不受浏览器弹窗拦截器管。 */
    const openInTab = (typeof GM_openInTab === 'function') ? GM_openInTab : null;

    // 双保险：@noframes 之外再挡一次 iframe（奖励侧栏本身就是 iframe）
    if (pageWindow.top !== pageWindow) return;

    // ==========================================================================
    // 0. 常量
    // ==========================================================================

    const VERSION = '2.6.0';
    const CONFIG_KEY = 'bing_rewards_config_v2';
    const SESSION_KEY = 'bing_rewards_session_v2';

    /** 会话在无活动多久之后视为过期（毫秒）。需要大于最长的休息时间。 */
    const SESSION_TTL = 45 * 60 * 1000;

    /** 阶段名，同时作为持久化的断点标记。 */
    const Phase = {
        IDLE: 'idle',
        VISIT: 'visiting',
        SCROLL: 'scrolling',
        SETTLE: 'waiting',
        CHECK: 'checking',
        REST: 'resting',
        INTERVAL: 'interval'
    };

    const PHASE_LABEL = {
        [Phase.VISIT]: '浏览结果',
        [Phase.SCROLL]: '滚动中',
        [Phase.SETTLE]: '停留中',
        [Phase.CHECK]: '检查中',
        [Phase.REST]: '休息中',
        [Phase.INTERVAL]: '等待中'
    };

    /** 只有命中这些 URL 的响应才会被解析，避免对全站所有请求做无谓的克隆与正则。 */
    const REWARDS_URL_RE = /(rewards|bingflyout|flyoutcontroller|getuserinfo|dailysetpromotions)/i;

    /**
     * 脚本要在「被打开的首条结果」那一页里滚动并自行关闭，所以 @match 放开到了全站。
     * 但助手面板与整套搜索流程只在下面这两个域名上运行，其余站点最多进入访问模式，
     * 确认不是脚本开的页面就立刻返回，什么都不碰（见 init）。
     */
    const HELPER_HOSTS = ['www.bing.com', 'cn.bing.com'];
    const BING_HOST_RE = /(^|\.)bing\.com$/i;

    /** 访问模式的标记：打开结果页时写进 hash，值是「浏览到什么时候」的时间戳。 */
    const VISIT_HASH_KEY = 'brhVisit';
    /** hash 在 Bing 的 /ck/a 跳转里可能丢掉，这时结果页会用它跟主标签页要时间戳。 */
    const VISIT_MSG = 'bing-rewards-helper/visit';
    /** 时间戳超出这个范围就当过期忽略，免得一条存下来的旧链接把页面关掉。 */
    const VISIT_MAX_MS = 10 * 60 * 1000;
    /**
     * 结果页自己关不掉时，主标签页过了截止时间再等这么久就动手关。
     * 扩展开出来的标签页在 Chrome 里根本不许自己 window.close()（「脚本只能关闭自己
     * 打开的窗口」），所以主标签页才是真正负责收尾的那一方，这里不必等太久。
     * 过了这个点还没有任何页面认领访问票据，就说明那边压根没跑起脚本，不必再等。
     */
    const VISIT_GRACE = 2 * 1000;
    /** 结果页加载得慢、认领得晚时，最多再宽限这么久让它把浏览做完。 */
    const VISIT_LATE_ALLOWANCE = 6 * 1000;
    /** 结果页至少浏览这么久。加载太慢导致截止时间已过时，也不能开了就关。 */
    const VISIT_MIN_BROWSE = 3 * 1000;
    /**
     * 访问票据存在 GM 存储里（按脚本存，跨域也读得到），用来告诉被打开的那一页
     * 「你是脚本开的、浏览到什么时候」——hash 标记在跳转里丢掉时就靠它。
     */
    const VISIT_TICKET_KEY = 'visit_ticket';
    /** 票据写下多久之内可以被认领。超时就当过期，免得误伤用户自己开的标签页。 */
    const VISIT_CLAIM_WINDOW = 20 * 1000;

    /**
     * 起始话题池：彼此不相关，横跨天气/交通/美食/体育/硬件/教育/宠物/财经/
     * 影视/健身/旅行/汽车/编程/养生/家居/音乐/历史/摄影/户外/语言等领域。
     * 每个话题只作为一次随机游走的起点，走满若干步就换一个，
     * 避免一天的搜索全部落在同一个话题簇里。可在配置面板里自行编辑。
     */
    const SEED_TOPICS = [
        'weather forecast', 'flight status', 'pasta recipe', 'NBA standings',
        'GPU benchmark', 'IELTS test dates', 'cat vaccination schedule',
        'mortgage rates', 'movie recommendations', 'beginner workout plan',
        'Japan travel guide', 'electric car range', 'learn Python',
        'vitamin D benefits', 'stock market news', 'kitchen remodel ideas',
        'guitar chords for beginners', 'World War II timeline',
        'calculus practice problems', 'coffee roast levels',
        'phone photography tips', 'camping gear checklist',
        'keto meal plan', 'houseplant care'
    ];

    /**
     * v2.0 的中文默认话题。仅用于升级判断：存档里如果还是这份原样未改的列表，
     * 就跟着换成新的英文默认值；只要用户自己编辑过，就尊重用户的列表不动它。
     */
    const LEGACY_SEED_TOPICS = [
        '天气预报', '高铁时刻表', '家常菜做法', 'NBA 比分', '显卡天梯图',
        '雅思报名', '猫咪驱虫', '房贷利率', '电影推荐', '健身计划',
        '日本旅游', '新能源汽车', '编程入门', '中医养生', '股票行情',
        '装修风格', '吉他和弦', '二战历史', '考研数学', '咖啡豆推荐',
        '手机摄影', '露营装备', '减肥食谱', '英语口语'
    ];

    /** 近似判重时回看的最近词数量。 */
    const RECENT_WINDOW = 6;

    /** 中断信号：停止搜索时用它把正在 await 的阶段安静地打断。 */
    const ABORT = Symbol('aborted');

    /** 刷新循环检测：本标签页内「非脚本主动发起」的加载记录（sessionStorage）。 */
    const NAV_FLAG_KEY = 'bing_rewards_intentional_nav';
    const LOAD_LOG_KEY = 'bing_rewards_load_log';
    const LOOP_WINDOW = 30 * 1000;   // 观察窗口
    const LOOP_LIMIT = 3;            // 窗口内多少次意外加载算异常

    // ==========================================================================
    // 1. 配置与会话持久化
    // ==========================================================================

    const config = {
        restTime: 5 * 60,          // 休息一次的时长（秒）
        scrollTime: 10,            // 每次搜索后的滚动时长（秒）
        waitTime: 8,               // 滚动结束后的停留时长（秒），让 Bing 记账
        searchInterval: [12, 25],  // 两次搜索之间的随机间隔（秒）
        restEvery: 12,             // 每搜索多少次休息一次，0 表示不休息
        targetSearches: 40,        // 每天检索多少次。这是唯一的终止条件
        jitterPercent: 30,         // 各阶段时长的随机浮动幅度（±%），0 表示关闭
        walkLength: [5, 8],        // 每个话题连续走几步后换新话题
        seedTopics: [...SEED_TOPICS], // 起始话题池，可在面板里编辑
        serpScrollTime: 5,         // 打开首条结果之前，先在结果页上滚动多久（秒），0 表示不滚
        visitFirstResult: true,    // 搜索后在新标签页打开首条结果，滚动浏览再关掉
        autoClickDailyTasks: true  // 自动点击未完成的每日奖励卡片
    };

    /** 运行期状态。searchCount 与 usedTerms 会跨页面跳转持久化。 */
    const state = {
        running: false,
        phase: Phase.IDLE,
        phaseUntil: 0,             // 当前阶段的结束时间戳，跳转后据此续算
        usedTerms: new Set(),      // 本日已搜过的词，跨跳转保留
        recentTerms: [],           // 最近搜过的几个词，用于近似判重
        usedTopics: new Set(),     // 本日已用过的起始话题
        currentTopic: '',          // 当前话题
        walkSteps: 0,              // 当前话题已走的步数
        walkLimit: 0,              // 本话题这次要走的步数（随机 walkLength）
        clickedOffers: new Set(),  // 本日已点过的奖励卡片链接
        searchCount: 0,            // 本日已发起的搜索次数，唯一的终止依据
        day: today(),
        mainTerms: [],
        iframeTerms: [],
        dailyTasks: [],
        loopGuard: false,          // 检测到刷新循环后，禁止一切自动点击
        sidebarFailures: 0,        // 连续读不到侧栏的次数，超限后不再浪费时间轮询
        collapsed: true
    };

    /** 每次调用 stop() 递增，正在 await 的阶段发现 token 变了就自我了断。 */
    let runToken = 0;

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
        if (num(saved.serpScrollTime, 0, 60)) config.serpScrollTime = saved.serpScrollTime;
        if (num(saved.waitTime, 0, 60)) config.waitTime = saved.waitTime;
        if (num(saved.restEvery, 0, 100)) config.restEvery = saved.restEvery;
        if (num(saved.targetSearches, 1, 200)) config.targetSearches = saved.targetSearches;
        if (num(saved.jitterPercent, 0, 60)) config.jitterPercent = saved.jitterPercent;
        if (Array.isArray(saved.walkLength) && saved.walkLength.length === 2 &&
            num(saved.walkLength[0], 1, 50) && num(saved.walkLength[1], 1, 50) &&
            saved.walkLength[0] <= saved.walkLength[1]) {
            config.walkLength = saved.walkLength.slice();
        }
        const topics = sanitizeTopics(saved.seedTopics);
        const isLegacyDefault = topics.length === LEGACY_SEED_TOPICS.length &&
            topics.every((t, i) => t === LEGACY_SEED_TOPICS[i]);
        if (topics.length >= 2 && !isLegacyDefault) config.seedTopics = topics;
        if (Array.isArray(saved.searchInterval) && saved.searchInterval.length === 2 &&
            num(saved.searchInterval[0], 1, 600) && num(saved.searchInterval[1], 1, 600) &&
            saved.searchInterval[0] <= saved.searchInterval[1]) {
            config.searchInterval = saved.searchInterval.slice();
        }
        if (typeof saved.visitFirstResult === 'boolean') config.visitFirstResult = saved.visitFirstResult;
        if (typeof saved.autoClickDailyTasks === 'boolean') config.autoClickDailyTasks = saved.autoClickDailyTasks;
    }

    function saveConfig() {
        writeJSON(CONFIG_KEY, config);
    }

    /** 清洗用户输入的话题列表：去空白、去重、丢掉过长过短的行。 */
    function sanitizeTopics(input) {
        const lines = Array.isArray(input) ? input : String(input || '').split('\n');
        return [...new Set(lines.map(t => String(t).trim()).filter(t => t.length >= 2 && t.length <= 60))];
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
            usedTerms: [...state.usedTerms],
            recentTerms: state.recentTerms,
            usedTopics: [...state.usedTopics],
            currentTopic: state.currentTopic,
            walkSteps: state.walkSteps,
            walkLimit: state.walkLimit,
            clickedOffers: [...state.clickedOffers],
            searchCount: state.searchCount,
            sidebarFailures: state.sidebarFailures,
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

    /**
     * 判断本次页面加载是不是脚本自己发起的（doSearch 跳转前会打标记）。
     * 短时间内出现多次「非脚本发起」的加载，说明页面在被反复刷新——
     * 这时必须停手，否则会一直循环下去。
     */
    function detectReloadLoop() {
        let intentional = false;
        try {
            intentional = sessionStorage.getItem(NAV_FLAG_KEY) === '1';
            sessionStorage.removeItem(NAV_FLAG_KEY);
        } catch (e) { /* 忽略 */ }
        if (intentional) return false;

        let loads = [];
        try {
            loads = JSON.parse(sessionStorage.getItem(LOAD_LOG_KEY) || '[]');
        } catch (e) { /* 忽略 */ }

        const now = Date.now();
        loads = loads.filter(t => now - t < LOOP_WINDOW).concat(now);
        try {
            sessionStorage.setItem(LOAD_LOG_KEY, JSON.stringify(loads));
        } catch (e) { /* 忽略 */ }

        return loads.length > LOOP_LIMIT;
    }

    function clearLoopGuard() {
        state.loopGuard = false;
        try {
            sessionStorage.removeItem(LOAD_LOG_KEY);
        } catch (e) { /* 忽略 */ }
    }

    /**
     * 点击这个元素会不会把当前页面顶走？
     * Bing 首页的积分入口是普通导航链接，而结果页的同名元素是打开侧栏的按钮。
     * 分不清就点，会导致「点击 → 跳转 → 脚本重载 → 再点击」的无限刷新。
     */
    function navigatesAway(node) {
        const anchor = node.closest && node.closest('a[href]');
        if (!anchor) return false;
        if (anchor.target && anchor.target !== '_self') return false;  // 新标签页顶不走当前页
        const href = anchor.getAttribute('href') || '';
        return !!href && !href.startsWith('#') && !/^javascript:/i.test(href);
    }

    // ==========================================================================
    // 2. 网络拦截
    // ==========================================================================
    // 奖励侧栏是跨域 iframe 时读不到 DOM，只能从 API 响应里捞每日任务的完成状态。
    // v1 对站内每个请求都做 clone().text()，这里按 URL 收窄，只解析 Rewards 相关响应。

    const intercepted = { dailyTasks: [] };

    function installInterceptors() {
        try {
            hookPageRequests();
            log('网络拦截器已激活（仅匹配 Rewards 相关请求）');
        } catch (e) {
            // 拦截只影响每日任务的显示，装不上就算了，主流程照跑
            log('网络拦截器安装失败:', e && e.message);
        }
    }

    function hookPageRequests() {
        const originalFetch = pageWindow.fetch;
        if (typeof originalFetch === 'function') {
            pageWindow.fetch = function (...args) {
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

        const xhrProto = pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype;
        if (!xhrProto) return;
        const xhrOpen = xhrProto.open;
        const xhrSend = xhrProto.send;

        xhrProto.open = function (method, url, ...rest) {
            this.__rewardsUrl = typeof url === 'string' ? url : '';
            return xhrOpen.call(this, method, url, ...rest);
        };

        xhrProto.send = function (body) {
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
    }

    function requestUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;   // Request 对象
        if (input && typeof input.href === 'string') return input.href; // URL 对象
        return '';
    }

    function parseRewardsResponse(url, text) {
        if (!text || text.length < 32) return;

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
        { id: 'cfg-scroll', label: '浏览时长(秒)', min: 3, max: 60, get: () => config.scrollTime, set: v => { config.scrollTime = v; }, unit: '秒' },
        { id: 'cfg-serp', label: '结果页滚动(秒)', min: 0, max: 60, get: () => config.serpScrollTime, set: v => { config.serpScrollTime = v; }, unit: '秒' },
        { id: 'cfg-settle', label: '停留时间(秒)', min: 0, max: 60, get: () => config.waitTime, set: v => { config.waitTime = v; }, unit: '秒' },
        { id: 'cfg-rest-every', label: '休息间隔(次)', min: 0, max: 100, get: () => config.restEvery, set: v => { config.restEvery = v; }, unit: '次' },
        { id: 'cfg-imin', label: '间隔下限(秒)', min: 1, max: 600, get: () => config.searchInterval[0], set: v => { config.searchInterval[0] = Math.min(v, config.searchInterval[1]); }, unit: '秒' },
        { id: 'cfg-imax', label: '间隔上限(秒)', min: 1, max: 600, get: () => config.searchInterval[1], set: v => { config.searchInterval[1] = Math.max(v, config.searchInterval[0]); }, unit: '秒' },
        { id: 'cfg-target', label: '检索次数', min: 1, max: 200, get: () => config.targetSearches, set: v => { config.targetSearches = v; }, unit: '次' },
        { id: 'cfg-jitter', label: '随机幅度(%)', min: 0, max: 60, get: () => config.jitterPercent, set: v => { config.jitterPercent = v; }, unit: '%' },
        { id: 'cfg-wmin', label: '话题步数下限', min: 1, max: 50, get: () => config.walkLength[0], set: v => { config.walkLength[0] = Math.min(v, config.walkLength[1]); }, unit: '步' },
        { id: 'cfg-wmax', label: '话题步数上限', min: 1, max: 50, get: () => config.walkLength[1], set: v => { config.walkLength[1] = Math.max(v, config.walkLength[0]); }, unit: '步' }
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
                        el('div', { id: 'rewards-progress', text: '检索: 0/0 次', css: 'font-weight:bold;font-size:12px;' }),
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
            css: 'grid-column:1/-1;display:flex;flex-direction:column;gap:2px;margin-top:4px;',
            parent: configForm,
            children: [
                el('label', {
                    text: '起始话题（每行一个，至少 2 个）',
                    attrs: { for: 'cfg-topics' },
                    css: `font-size:10px;color:${t.textSecondary};`
                }),
                el('textarea', {
                    id: 'cfg-topics',
                    attrs: { rows: '5', spellcheck: 'false' },
                    props: { value: config.seedTopics.join('\n') },
                    css: `width:100%;box-sizing:border-box;background:${t.inputBg};color:${t.text};
                          border:1px solid ${t.inputBorder};border-radius:4px;padding:4px 6px;
                          font-size:11px;font-family:inherit;resize:vertical;`,
                    on: {
                        change: (e) => {
                            const topics = sanitizeTopics(e.target.value);
                            if (topics.length < 2) {
                                // 少于 2 个话题就没法「跳到不相关的话题」了，驳回并还原
                                e.target.value = config.seedTopics.join('\n');
                                setStatus('至少需要 2 个起始话题，已还原');
                                return;
                            }
                            config.seedTopics = topics;
                            state.usedTopics.clear();
                            saveConfig();
                            e.target.value = topics.join('\n');
                            setStatus(`起始话题已更新：${topics.length} 个`);
                        }
                    }
                })
            ]
        });

        el('div', {
            css: 'grid-column:1/-1;display:flex;align-items:center;gap:6px;margin-top:2px;',
            parent: configForm,
            children: [
                el('input', {
                    id: 'visit-first-result',
                    attrs: { type: 'checkbox' },
                    props: { checked: config.visitFirstResult },
                    css: 'cursor:pointer;width:14px;height:14px;',
                    on: {
                        change: (e) => {
                            config.visitFirstResult = e.target.checked;
                            saveConfig();
                            setStatus('新标签页浏览首条结果: ' + (e.target.checked ? '开启' : '关闭'));
                        }
                    }
                }),
                el('label', { text: '新标签页打开首条结果', attrs: { for: 'visit-first-result' }, css: 'cursor:pointer;font-size:11px;' })
            ]
        });

        el('div', {
            text: '由脚本管理器开标签页；退化到 window.open 时需允许本站弹窗',
            css: `grid-column:1/-1;font-size:10px;color:${t.textSecondary};padding-left:20px;`,
            parent: configForm
        });

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

    /**
     * 进度显示一律以「已检索次数 / 目标次数」为准——这是脚本唯一的终止条件，
     * 任何时候都拿得到，不会再出现「进度: 未知」。
     * 侧栏里的积分进度不再读取：那个数字经常读错，还会误判成「已拿满」提前收工。
     */
    function renderProgress() {
        const done = state.searchCount;
        const target = config.targetSearches;

        let text = `检索: ${done}/${target} 次`;
        if (done >= target) text += ' (已完成)';
        setText('rewards-progress', text);

        const bar = $('rewards-progress-bar');
        if (bar) {
            bar.style.width = clamp((done / Math.max(1, target)) * 100, 0, 100) + '%';
            bar.style.background = done >= target
                ? `linear-gradient(90deg,${getTheme().ok},#8BC34A)`
                : `linear-gradient(90deg,${getTheme().accent},#00bcf2)`;
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
                el('div', { text: `已检索 ${state.searchCount} 次` })
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
        if (state.loopGuard) {
            log('刷新循环保护生效中，不做任何点击');
            return false;
        }

        for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (!node || node.offsetParent === null) continue;
            if (navigatesAway(node)) {
                // 首页的积分入口就是这种，点了会跳转，跳过它
                log('跳过会导致跳转的积分入口:', selector);
                continue;
            }
            node.click();
            log('已点击积分入口:', selector);
            return true;
        }

        // 这里原本有一条「点击任意 rewards 链接」的兜底。那些链接全是导航链接，
        // 点下去必然跳转，正是首页无限刷新的根源，因此整条移除。
        log('未找到可安全点击的积分入口（可手动点开积分面板）');
        return false;
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
        ok = readSidebarTerms(iframe, doc) || ok;
        return ok || useInterceptedData();
    }

    function useInterceptedData() {
        if (!intercepted.dailyTasks.length) return false;
        renderDailyTasks(intercepted.dailyTasks);
        return true;
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

    /**
     * 结果页上的第一条自然结果。广告块和站内入口（图片/视频/相关搜索）都排掉，
     * 剩下的就是真人会点进去的那一条。找不到返回 null，由调用方退回原地滚动。
     */
    function findFirstResultLink() {
        // Bing 的结果页版式换得很勤，所以从最精确的选择器一路放宽到「结果区里的第一条外链」，
        // 而不是钉死在某一版 DOM 上。真正的过滤交给 isVisitableResult。
        const selectors = [
            '#b_results li.b_algo h2 a[href]',    // 经典版式：结果标题
            '#b_results li.b_algo a.tilk[href]',  // 带 .b_tpcn 包装的新版式
            '#b_results li.b_algo a[href]',       // 同一条结果里的任意外链
            '#b_results h2 a[href]',              // 版式又变了：任意结果块的标题
            '#b_results a[href]',                 // 兜底：结果区里的第一条外链
            '#b_content a[href]'                  // 连 #b_results 都找不到时
        ];
        for (const selector of selectors) {
            for (const node of document.querySelectorAll(selector)) {
                if (isVisitableResult(node)) return node;
            }
        }
        logNoResultLink();
        return null;
    }

    /** 一条都挑不出来时，把页面上到底有什么打到控制台，方便照着调选择器。 */
    function logNoResultLink() {
        const items = document.querySelectorAll('#b_results li');
        const links = document.querySelectorAll('#b_results a[href]');
        log('没挑出可打开的结果：#b_results 里有', items.length, '个条目、', links.length, '个链接；',
            '前 5 个 href:', [...links].slice(0, 5).map(a => a.href));
    }

    function isVisitableResult(node) {
        if (!node || !node.href || !node.getClientRects().length) return false;
        // 广告不点
        if (node.closest('.b_ad, .b_adTop, .b_adBottom, .b_adSlug, .ad_sc, .sb_add')) return false;
        let url;
        try {
            url = new URL(node.href, location.href);
        } catch (e) {
            return false;
        }
        if (!/^https?:$/.test(url.protocol)) return false;
        // 站内链接一律不算结果；/ck/a 例外，那是 Bing 自己的点击跳转，真人点的也是它
        return !BING_HOST_RE.test(url.hostname) || /^\/ck\//i.test(url.pathname);
    }

    /**
     * GM 存储是按脚本存的，跨域也读得到，正好用来在两个标签页之间传递访问票据。
     * 脚本管理器没提供这两个 API 时全部退化成空操作，只是少了一条兜底路径。
     */
    function gmGet(key, fallback) {
        try {
            return (typeof GM_getValue === 'function') ? GM_getValue(key, fallback) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function gmSet(key, value) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(key, value);
        } catch (e) { /* 忽略 */ }
    }

    function readVisitTicket() {
        const ticket = gmGet(VISIT_TICKET_KEY, null);
        return (ticket && typeof ticket === 'object' && ticket.deadline) ? ticket : null;
    }

    function writeVisitTicket(ticket) {
        gmSet(VISIT_TICKET_KEY, ticket);
    }

    function clearVisitTicket() {
        gmSet(VISIT_TICKET_KEY, null);
    }

    /** 认领票据（只能认领一次），返回浏览的截止时间；不该认领就返回 0。 */
    function claimVisitTicket() {
        const ticket = readVisitTicket();
        if (!ticket || ticket.claimedAt) return 0;
        const now = Date.now();
        if (now >= ticket.deadline || now - (ticket.createdAt || 0) > VISIT_CLAIM_WINDOW) return 0;
        // 只有「跟票据上写的是同一个站」或者「从 Bing 跳过来的」才可能是脚本开的那一页。
        // 这一层是为了绝不误伤用户自己开的标签页——认错了就等于把人家的页面关掉。
        if (hostOf(location.href) !== ticket.host && !BING_HOST_RE.test(referrerHost())) return 0;
        ticket.claimedAt = now;
        writeVisitTicket(ticket);
        return ticket.deadline;
    }

    /** 带 hash 标记进来的页面：把票据一并收走，免得别的标签页再认领。 */
    function markVisitClaimed() {
        const ticket = readVisitTicket();
        if (!ticket || ticket.claimedAt) return;
        ticket.claimedAt = Date.now();
        writeVisitTicket(ticket);
    }

    /** 浏览完了记一笔，主标签页看到就可以马上收尾，不用干等到宽限时间用完。 */
    function markVisitDone() {
        const ticket = readVisitTicket();
        if (!ticket) return;
        ticket.doneAt = Date.now();
        if (!ticket.claimedAt) ticket.claimedAt = ticket.doneAt;
        writeVisitTicket(ticket);
    }

    /**
     * Bing 结果链接常常是 /ck/a 这种点击跳转，跳转时会把 URL 里的 hash 吃掉。
     * 目标地址就编码在 u=a1<base64url> 里，能解就直接打开真实地址，
     * 既保住了标记，也少一次跳转。解不出来就原样返回。
     */
    function resolveResultUrl(href) {
        try {
            const url = new URL(href, location.href);
            if (!BING_HOST_RE.test(url.hostname) || !/^\/ck\//i.test(url.pathname)) return href;
            const raw = url.searchParams.get('u') || '';
            if (!/^a1./.test(raw)) return href;
            const base64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
            const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
            const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
            const target = new TextDecoder().decode(bytes);
            return /^https?:\/\//i.test(target) ? target : href;
        } catch (e) {
            return href;
        }
    }

    /** 把「浏览到什么时候」写进 hash，结果页据此知道自己是脚本打开的。 */
    function withVisitMarker(href, deadline) {
        try {
            const url = new URL(href, location.href);
            url.hash = url.hash
                ? `${url.hash}&${VISIT_HASH_KEY}=${deadline}`
                : `${VISIT_HASH_KEY}=${deadline}`;
            return url.toString();
        } catch (e) {
            return href;
        }
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

    /**
     * 近似判重：光靠字符串相等挡不住「咖啡」→「咖啡豆」→「咖啡豆推荐」这种
     * 换汤不换药的连续搜索。这里额外挡掉互相包含、以及用字高度重合的词。
     */
    function tooSimilar(a, b) {
        const x = a.toLowerCase().replace(/\s+/g, '');
        const y = b.toLowerCase().replace(/\s+/g, '');
        if (!x || !y) return false;
        if (x === y || x.includes(y) || y.includes(x)) return true;

        const setA = new Set(x);
        const setB = new Set(y);
        let shared = 0;
        for (const ch of setA) if (setB.has(ch)) shared++;
        return shared / Math.min(setA.size, setB.size) >= 0.8;
    }

    /** 记账：全天去重 + 维护最近词窗口。 */
    function markUsed(term) {
        state.usedTerms.add(term);
        state.recentTerms.push(term);
        while (state.recentTerms.length > RECENT_WINDOW) state.recentTerms.shift();
    }

    /** 当前页面上还能用的词，主页面优先、侧栏次之，已用过和近似的都排除。 */
    function availableTerms() {
        const usable = (list) => list.filter(t =>
            !state.usedTerms.has(t) && !state.recentTerms.some(r => tooSimilar(t, r)));
        const main = usable(state.mainTerms);
        if (main.length) return { terms: main, source: '主页面' };
        return { terms: usable(state.iframeTerms), source: '侧栏' };
    }

    /**
     * 换一个与当前话题无关的新起点，并重新掷出这一轮要走的步数。
     * 话题池用尽时洗牌重来；连话题带词全用过了返回 null，交回给页面词。
     */
    function nextTopic() {
        const unused = (skipTopics) => config.seedTopics.filter(t =>
            (skipTopics ? true : !state.usedTopics.has(t)) && !state.usedTerms.has(t));

        let pool = unused(false);
        if (!pool.length) {
            state.usedTopics.clear();          // 一天里话题走完就重新洗牌
            pool = unused(true);
        }
        if (!pool.length) return null;

        const topic = pool[Math.floor(Math.random() * pool.length)];
        const [min, max] = config.walkLength;
        state.usedTopics.add(topic);
        state.currentTopic = topic;
        state.walkSteps = 0;
        state.walkLimit = min + Math.floor(Math.random() * (max - min + 1));
        markUsed(topic);
        log(`切换话题:「${topic}」，本轮走 ${state.walkLimit} 步`);
        return topic;
    }

    /**
     * 选词。两种情况会跳到新话题而不是顺着当前结果页继续走：
     *   1. 当前话题已经走满了掷出的步数；
     *   2. 当前页面没有可用的新词（都用过或都太像）。
     * 否则从当前结果页的相关搜索里随机取一个，这样话题是连贯的，
     * 但每隔 5~8 步就会整体换到一个不相关的领域。
     */
    function pickTerm() {
        const available = availableTerms();
        const needNewTopic = state.walkSteps >= state.walkLimit || !available.terms.length;

        if (needNewTopic) {
            const topic = nextTopic();
            if (topic) return { term: topic, source: '新话题' };
            if (!available.terms.length) return null;   // 话题池也空了
        }

        const base = available.terms[Math.floor(Math.random() * available.terms.length)];
        markUsed(base);
        return { term: base, source: available.source };
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
    let stopScroller = null;
    let visitTab = null;      // 正在浏览的结果页标签（openVisitTab 返回的句柄）
    let visitBridge = null;   // 回答结果页「浏览到什么时候」的 message 监听器

    function clearTimers() {
        if (tickerId) { clearInterval(tickerId); tickerId = null; }
        if (stopScroller) { stopScroller(); stopScroller = null; }
    }

    /**
     * 等到 deadline，期间刷新倒计时；停止搜索会以 ABORT 拒绝。
     * until 是可选的提前结束条件（例如结果页标签自己关掉了，就没必要再等）。
     */
    function waitUntil(deadline, phase, until) {
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
                if (until && until()) {
                    clearInterval(tickerId);
                    tickerId = null;
                    updateCountdown(0);
                    resolve();
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
        // 访问模式的标签页跟着上一个页面一起没了，没什么可续的，直接往下走
        if (saved.phase === Phase.VISIT) return Promise.resolve();
        const remain = (saved.phaseUntil || 0) - Date.now();
        if (remain > 1000 && PHASE_LABEL[saved.phase]) {
            setStatus(`恢复上次的${PHASE_LABEL[saved.phase]}（剩余 ${Math.ceil(remain / 1000)} 秒）`);
            return waitUntil(saved.phaseUntil, saved.phase);
        }
        return Promise.resolve();
    }

    /**
     * 断续的人工滚动，返回一个停止函数。结果页和 Bing 页面共用这一份。
     *
     * 站外的落地页什么样都有：不少站点把滚动条放在自己的容器上，
     * document 本身根本不滚，这时 window.scrollBy 调了也白调。所以这里每滚一下
     * 都确认位置真的变了，连着两次没动就改滚页面里最大的那个可滚动容器。
     */
    function startScrolling() {
        let stepTimer = null;
        let checkTimer = null;
        // 文档本身就不能滚的（常见于自带滚动容器的站点），一上来就去找容器
        let target = documentScrollable() ? null : findScrollBox();
        let switched = target !== null;
        let stalled = 0;
        let lastPos = scrollPosOf(target);

        // 每次滚动的间隔也随机（600~1600ms）。固定 1000ms 的节拍太规律，
        // 真人的滚动是断续的：看一段、停一下、再滚。
        const step = () => {
            const amount = 100 + Math.floor(Math.random() * 300);
            const down = Math.random() > 0.3;
            scrollTargetBy(target, down ? amount : -amount);

            clearTimeout(checkTimer);
            checkTimer = setTimeout(() => {
                const now = scrollPosOf(target);
                // 只看向下滚：已经在顶端时向上滚本来就不会动，不算滚不动
                if (down && !atBottomOf(target) && Math.abs(now - lastPos) < 2) stalled++;
                else stalled = 0;
                lastPos = now;
                if (stalled >= 2 && !switched) {
                    switched = true;
                    stalled = 0;
                    target = findScrollBox();
                    lastPos = scrollPosOf(target);
                    log(target ? '窗口滚不动，改滚页面里的容器' : '这个页面没有可滚动的区域');
                }
            }, 400);

            stepTimer = setTimeout(step, 600 + Math.floor(Math.random() * 1000));
        };

        stepTimer = setTimeout(step, 300 + Math.floor(Math.random() * 700));
        return () => {
            clearTimeout(stepTimer);
            clearTimeout(checkTimer);
        };
    }

    function documentScrollable() {
        const doc = document.documentElement;
        return !!doc && (doc.scrollHeight - (pageWindow.innerHeight || 0)) > 50;
    }

    function scrollPosOf(target) {
        if (target) return target.scrollTop;
        return pageWindow.scrollY || (document.documentElement && document.documentElement.scrollTop) || 0;
    }

    function atBottomOf(target) {
        if (target) return target.scrollTop + target.clientHeight >= target.scrollHeight - 4;
        const doc = document.documentElement;
        return !doc || scrollPosOf(null) + (pageWindow.innerHeight || 0) >= doc.scrollHeight - 4;
    }

    function scrollTargetBy(target, delta) {
        try {
            if (target) target.scrollBy({ top: delta, behavior: 'smooth' });
            else pageWindow.scrollBy({ top: delta, behavior: 'smooth' });
        } catch (e) {
            // 个别页面重写过 scrollBy，退回最朴素的写法
            if (target) target.scrollTop += delta;
            else pageWindow.scrollTo(0, scrollPosOf(null) + delta);
        }
    }

    /** 页面里最大的那个能滚的容器。节点太多时只看前面一部分，别在这上面耗时间。 */
    function findScrollBox() {
        let best = null;
        let seen = 0;
        for (const node of document.querySelectorAll('div, main, section, article, ul')) {
            if (++seen > 600) break;
            if (node.clientHeight < 200 || node.scrollHeight - node.clientHeight < 200) continue;
            const overflow = getComputedStyle(node).overflowY;
            if (overflow !== 'auto' && overflow !== 'scroll') continue;
            if (!best || node.clientHeight > best.clientHeight) best = node;
        }
        return best;
    }

    /**
     * 搜索之后的浏览：新标签页打开首条结果，在那边滚动，到点关掉标签页回到本页。
     * 结果页会自己数着时间关掉自己，主标签页只是兜底——多等 VISIT_GRACE 后强制关，
     * 所以哪怕结果页根本没跑起脚本（CSP、PDF、跳转丢了 hash），流程也不会卡住。
     * 没有可打开的结果、或者弹窗被浏览器拦下来，就退回原来的做法：在结果页滚动。
     */
    async function visitPhase() {
        const seconds = humanize(config.scrollTime);
        const link = config.visitFirstResult ? findFirstResultLink() : null;
        if (!link) {
            return scrollPhase(seconds, config.visitFirstResult ? '没找到可打开的搜索结果' : '');
        }

        const href = resolveResultUrl(link.href);
        const label = (link.textContent || '').trim().slice(0, 24) || hostOf(href) || '首条结果';
        const deadline = Date.now() + seconds * 1000;

        // 票据先写、标签页后开：那一页可能比这行代码之后的任何东西都先加载完
        writeVisitTicket({
            host: hostOf(href), deadline, createdAt: Date.now(), claimedAt: 0, doneAt: 0
        });

        const handle = openVisitTab(withVisitMarker(href, deadline));
        if (!handle) {
            clearVisitTicket();
            return scrollPhase(seconds, '新标签页被拦截（请允许本站弹出窗口）');
        }

        visitTab = handle;
        if (handle.win) installVisitBridge(handle.win, deadline);
        setStatus(`新标签页浏览首条结果 ${seconds} 秒：${label}`);
        try {
            // 收尾条件，谁先到算谁：那一页自己关了 / 说它浏览完了 /
            // 过了宽限还没有任何页面认领票据（说明那边没跑起脚本，别再干等）。
            await waitUntil(deadline + VISIT_LATE_ALLOWANCE, Phase.VISIT, () => {
                if (handle.isClosed()) return true;
                const ticket = readVisitTicket();
                if (ticket && ticket.doneAt) return true;
                return Date.now() > deadline + VISIT_GRACE && !(ticket && ticket.claimedAt);
            });
            reportVisitOutcome();
        } finally {
            closeVisitTab();
        }
    }

    /** 那一页到底有没有滚起来？没有的话说清楚，别让人对着「打开了但没动」猜。 */
    function reportVisitOutcome() {
        const ticket = readVisitTicket();
        if (!ticket || ticket.claimedAt) return;
        log('结果页没有进入访问模式：可能是站点不允许用户脚本，或者跳转把标记弄丢了');
        setStatus('结果页没跑起脚本，本次只打开没滚动');
    }

    /**
     * 开一个标签页，返回统一的句柄 { isClosed(), close(), win }。
     *
     * 首选 GM_openInTab：标签页由脚本管理器（扩展）打开，绕得过浏览器的弹窗拦截器——
     * window.open 不是点击触发的，默认会被直接挡掉，这正是 v2.4.0 在实际浏览器里
     * 总是退回原地滚动的原因。代价是这样开出来的标签页拿不到 window 句柄，也不许
     * 自己 window.close()，所以一律由主标签页负责关。
     * 没有这个 API（或调用失败）时退回 window.open，那条路才需要用户放行弹窗。
     */
    function openVisitTab(url) {
        if (openInTab) {
            try {
                const tab = openInTab(url, { active: true, insert: true, setParent: true });
                if (tab) {
                    let closed = false;
                    try {
                        tab.onclose = () => { closed = true; };
                    } catch (e) { /* 老版本没有 onclose，靠 closed 属性和超时兜底 */ }
                    return {
                        win: null,
                        isClosed: () => closed || tab.closed === true,
                        close: () => { if (typeof tab.close === 'function') tab.close(); }
                    };
                }
            } catch (e) {
                log('GM_openInTab 失败，改用 window.open:', e && e.message);
            }
        } else {
            log('脚本管理器没提供 GM_openInTab，改用 window.open（可能被弹窗拦截器挡下）');
        }

        let win = null;
        try {
            win = pageWindow.open(url, '_blank');
        } catch (e) {
            log('window.open 失败:', e && e.message);
        }
        if (!win) return null;
        return {
            win,
            isClosed: () => win.closed,
            close: () => win.close()
        };
    }

    /** 关掉结果页标签并回到本页。它已经自己关了也没关系，再关一次是空操作。 */
    function closeVisitTab() {
        removeVisitBridge();
        const handle = visitTab;
        visitTab = null;
        if (!handle) return;
        clearVisitTicket();
        try {
            if (!handle.isClosed()) handle.close();
        } catch (e) { /* 忽略 */ }
        try {
            pageWindow.focus();
        } catch (e) { /* 忽略 */ }
    }

    /**
     * hash 有时会在 Bing 的 /ck/a 跳转里丢掉，结果页因此还会朝打开它的窗口喊一声，
     * 这里负责回答「浏览到什么时候」。只认自己 window.open 出来的那个窗口，
     * 别的窗口发来的消息一律不理。
     */
    function installVisitBridge(tab, deadline) {
        removeVisitBridge();
        visitBridge = (event) => {
            if (event.source !== tab) return;
            const data = event.data;
            if (!data || data.type !== VISIT_MSG || data.role !== 'hello') return;
            try {
                tab.postMessage({ type: VISIT_MSG, role: 'visit', deadline },
                                /^https?:\/\//.test(event.origin) ? event.origin : '*');
            } catch (e) { /* 忽略 */ }
        };
        pageWindow.addEventListener('message', visitBridge);
    }

    function removeVisitBridge() {
        if (!visitBridge) return;
        pageWindow.removeEventListener('message', visitBridge);
        visitBridge = null;
    }

    /**
     * 兜底：在当前结果页原地滚动（打不开新标签页时才会走到这里）。
     * reason 会一起显示在面板上——v2.4.0 把原因单独 setStatus 一次，紧接着就被这句
     * 盖掉了，结果用户只看到「在滚动」，看不出新标签页为什么没开。
     */
    function scrollPhase(seconds, reason) {
        setStatus(reason
            ? `${reason}，改为在结果页滚动 ${seconds} 秒`
            : `浏览结果页：滚动 ${seconds} 秒...`);
        if (stopScroller) stopScroller();
        stopScroller = startScrolling();

        return waitSeconds(seconds, Phase.SCROLL).finally(() => {
            if (stopScroller) {
                stopScroller();
                stopScroller = null;
            }
        });
    }

    function hostOf(href) {
        try {
            return new URL(href, location.href).hostname.replace(/^www\./, '');
        } catch (e) {
            return '';
        }
    }

    async function checkPhase() {
        // 侧栏只用来显示每日任务和补充搜索词，读不到完全不影响主流程，
        // 所以连续失败 3 次后就别再每轮白等 6 秒了。
        if (state.sidebarFailures >= 3) return false;

        setStatus('检查奖励面板...');
        state.phase = Phase.CHECK;
        saveSession();

        openRewardsSidebar();
        // 侧栏 iframe 是异步加载的，轮询等它就绪，最多 6 秒。
        // 这里刻意用 sleep 而不是 waitSeconds：轮询不该反复写 localStorage，也不该刷倒计时。
        for (let i = 0; i < 12; i++) {
            await sleep(500);
            if (readSidebar()) {
                state.sidebarFailures = 0;
                return true;
            }
        }

        state.sidebarFailures++;
        log('本轮未能读到侧栏数据（第 ' + state.sidebarFailures + ' 次）');
        if (state.sidebarFailures >= 3) {
            setStatus('读不到奖励面板，后续不再尝试；不影响按次数检索');
        }
        return false;
    }

    function randomInterval() {
        const [min, max] = config.searchInterval;
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    /**
     * 给一个固定时长加上 ±jitterPercent 的随机浮动。
     * 真人不会每次都停留恰好 8 秒、滚动恰好 10 秒——固定值本身就是特征。
     * jitterPercent 为 0 时原样返回；传入 0 时恒为 0（用于关闭「停留」阶段）。
     */
    function humanize(seconds) {
        if (!seconds || config.jitterPercent <= 0) return seconds;
        const swing = (Math.random() * 2 - 1) * (config.jitterPercent / 100);
        return Math.max(1, Math.round(seconds * (1 + swing)));
    }

    function remainingSearches() {
        return Math.max(0, config.targetSearches - state.searchCount);
    }

    /** 发起搜索：直接跳转比填表单提交更可靠（不依赖 Bing 表单里的隐藏字段与事件）。 */
    function doSearch() {
        const picked = pickTerm();
        if (!picked) {
            stop('没有可用的搜索词，已停止');
            return false;
        }

        state.searchCount++;
        state.walkSteps++;
        state.phase = Phase.IDLE;
        state.phaseUntil = 0;
        saveSession(); // 跳转前同步写入，绝不能丢

        try {
            sessionStorage.setItem(NAV_FLAG_KEY, '1');   // 标记：下一次加载是脚本自己发起的
        } catch (e) { /* 忽略 */ }

        const url = new URL('/search', location.origin);
        url.searchParams.set('q', picked.term);
        url.searchParams.set('form', 'QBRE');
        setStatus(`搜索: ${picked.term}（${picked.source}）· 话题「${state.currentTopic}」${state.walkSteps}/${state.walkLimit} 步 · 第 ${state.searchCount}/${config.targetSearches} 次`);
        renderProgress();
        location.assign(url.toString());
        return true;
    }

    /** 一次完整循环，运行在「上一次搜索跳转后的新页面」上，最后以一次跳转结束。 */
    async function runCycle(savedPhase) {
        try {
            if (savedPhase) await resumePhase(savedPhase);

            if (isResultsPage()) {
                // 先在结果页上扫一眼——真人也是先看几眼结果再点进去——然后再打开首条结果
                if (config.serpScrollTime > 0) await scrollPhase(humanize(config.serpScrollTime));
                await visitPhase();
                if (config.waitTime > 0) {
                    const settle = humanize(config.waitTime);
                    setStatus(`停留 ${settle} 秒，等待 Bing 记账...`);
                    await waitSeconds(settle, Phase.SETTLE);
                }
                await checkPhase();
            } else {
                // 不在结果页（比如首页）就别装浏览了，直接读一次奖励面板
                await checkPhase();
            }

            // 唯一的终止条件：检索够 targetSearches 次。
            if (state.searchCount >= config.targetSearches) {
                showCompletionNotification();
                stop(`已完成 ${state.searchCount} 次检索 🎉`);
                return;
            }

            // 每搜够 restEvery 次歇一会儿。以前这个休息由「进度没涨」触发，
            // 但那个判断依赖积分读数，读错就乱歇，现在直接按次数来。
            if (config.restEvery > 0 && state.searchCount > 0 &&
                state.searchCount % config.restEvery === 0) {
                const rest = humanize(config.restTime);
                setStatus(`已连续检索 ${state.searchCount} 次，休息 ${Math.round(rest / 60 * 10) / 10} 分钟`);
                await waitSeconds(rest, Phase.REST);
            }

            readMainPageTerms();

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
        // 用户主动点了开始，说明他知道自己在做什么，解除刷新保护
        clearLoopGuard();
        state.running = true;
        state.day = today();
        state.phase = Phase.IDLE;
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

        if (state.searchCount >= config.targetSearches) {
            stop(`今日已检索 ${state.searchCount} 次，达到设定次数`);
            return;
        }
        // 起始话题池永远兜得住，不再需要「没有搜索词就无法开始」这条分支
        doSearch();
    }

    function stop(message) {
        runToken++;          // 让正在 await 的阶段自行退出
        clearTimers();
        closeVisitTab();
        state.running = false;
        state.phase = Phase.IDLE;
        state.phaseUntil = 0;
        updateCountdown(0);
        clearSession();
        setButtonRunning(false);
        setStatus(message || '搜索已停止');
    }

    // ==========================================================================
    // 7. 访问模式：本页是主标签页打开的「首条结果」
    // ==========================================================================
    // 脚本在所有站点上加载，但只有确认自己是被主标签页打开的结果页时才做事：
    // 滚动一会儿，然后把自己关掉。其余页面立刻返回，不注入面板也不碰任何东西。

    function isHelperPage() {
        // /ck/a 是 Bing 的点击跳转页，虽然也在 bing.com 上，但那是结果页的中转站，
        // 助手不该在那里再开一份面板、更不该接着跑搜索循环。
        return HELPER_HOSTS.includes(location.hostname) && !/^\/ck\//i.test(location.pathname);
    }

    /** 时间戳落在合理区间内才认，免得一条存下来的旧链接把页面关掉。 */
    function saneDeadline(value) {
        const deadline = Number(value);
        if (!deadline) return 0;
        const now = Date.now();
        return (deadline > now - VISIT_MAX_MS && deadline < now + VISIT_MAX_MS) ? deadline : 0;
    }

    function visitDeadlineFromHash() {
        const hit = new RegExp(VISIT_HASH_KEY + '=(\\d+)').exec(location.hash || '');
        return hit ? saneDeadline(hit[1]) : 0;
    }

    /**
     * 滚动到点，记一笔「浏览完了」，然后关掉自己。主标签页也会来关，两边谁先到都行。
     * 页面加载得慢时截止时间可能已经过了，那也至少浏览 VISIT_MIN_BROWSE——
     * 开了个标签页却一下都没滚就关掉，跟没打开是一样的。
     */
    function runVisitMode(deadline) {
        const until = Math.max(deadline, Date.now() + VISIT_MIN_BROWSE);
        log('访问模式：浏览', Math.round((until - Date.now()) / 1000), '秒后关闭本页');
        const stopScroll = startScrolling();
        const tick = () => {
            if (Date.now() < until) {
                setTimeout(tick, 400);
                return;
            }
            stopScroll();
            markVisitDone();
            // 扩展开出来的标签页不许自己关（浏览器会在控制台留一句警告），
            // 关不掉也无所谓：主标签页看到「浏览完了」就会来收尾。
            try {
                pageWindow.close();
            } catch (e) { /* 忽略 */ }
        };
        tick();
    }

    /** Bing 的点击跳转中转页：马上就要跳走，不滚也不认领票据，把机会留给真正的落地页。 */
    function isBingRedirectPage() {
        return BING_HOST_RE.test(location.hostname) && /^\/ck\//i.test(location.pathname);
    }

    /**
     * hash 丢了的兜底：朝打开自己的窗口要一个截止时间。
     * 没人应答就什么都不做——那说明这个标签页不是脚本开的，只是个普通的新标签页。
     */
    function askOpenerForVisit() {
        let opener = null;
        try {
            opener = pageWindow.opener;
        } catch (e) { /* 忽略 */ }
        if (!opener || !BING_HOST_RE.test(referrerHost())) return;

        let timer = null;
        let tries = 0;
        const onMessage = (event) => {
            if (event.source !== opener) return;
            const data = event.data;
            if (!data || data.type !== VISIT_MSG || data.role !== 'visit') return;
            const deadline = saneDeadline(data.deadline);
            if (!deadline) return;
            stopAsking();
            runVisitMode(deadline);
        };
        const stopAsking = () => {
            clearInterval(timer);
            pageWindow.removeEventListener('message', onMessage);
        };
        const ask = () => {
            if (++tries > 10) {          // 问满 5 秒还没人应，就当自己是普通标签页
                stopAsking();
                return;
            }
            try {
                opener.postMessage({ type: VISIT_MSG, role: 'hello' }, '*');
            } catch (e) {
                stopAsking();
            }
        };
        pageWindow.addEventListener('message', onMessage);
        ask();
        timer = setInterval(ask, 500);
    }

    function referrerHost() {
        try {
            return new URL(document.referrer).hostname;
        } catch (e) {
            return '';
        }
    }

    // ==========================================================================
    // 8. 初始化
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
        state.usedTerms = new Set(saved.usedTerms || []);   // v1 在这里被清空，导致重复搜索
        state.recentTerms = saved.recentTerms || [];
        state.usedTopics = new Set(saved.usedTopics || []);
        state.currentTopic = saved.currentTopic || '';
        state.walkSteps = saved.walkSteps || 0;
        state.walkLimit = saved.walkLimit || 0;
        state.clickedOffers = new Set(saved.clickedOffers || []);
        state.searchCount = saved.searchCount || 0;
        state.sidebarFailures = saved.sidebarFailures || 0;
        state.day = saved.day || today();
        state.running = true;
        setButtonRunning(true);
        renderProgress();
        setStatus('检测到上次任务，正在继续...');
    }

    function init() {
        // Bing 的点击跳转中转页：等它跳到真正的落地页再说
        if (isBingRedirectPage()) return;

        // 本页带着脚本写的标记，就是被打开的首条结果：滚一会儿再关掉自己，别的都不做
        const marked = visitDeadlineFromHash();
        if (marked) {
            markVisitClaimed();
            runVisitMode(marked);
            return;
        }

        if (!isHelperPage()) {
            // 标记在跳转里丢了的兜底：认领主标签页刚写下的访问票据（GM 存储跨域可读）。
            // 认不到就再问一次打开自己的窗口（window.open 那条路才有 opener）。
            const claimed = claimVisitTicket();
            if (claimed) {
                runVisitMode(claimed);
                return;
            }
            askOpenerForVisit();
            return;
        }

        loadConfig();
        createUI();
        applyCollapse();
        renderProgress();
        installInterceptors();
        watchTheme();

        window.addEventListener('beforeunload', () => {
            clearTimers();
            closeVisitTab();   // 本页要走了，别把浏览用的标签页留在那儿
            saveSession();
        });

        if (detectReloadLoop()) {
            state.loopGuard = true;
            clearSession();
            setButtonRunning(false);
            setStatus('⚠ 检测到页面反复刷新，已暂停全部自动操作。请换到搜索结果页再开始。');
            log('刷新循环保护已触发');
            return;
        }

        const saved = loadSession();
        if (saved) {
            restore(saved);
            runCycle(saved);
        } else {
            // 空闲时只做被动读取，绝不点击页面上的任何元素。
            // v2.1.0 及以前会在这里调用 openRewardsSidebar()，而首页的积分入口
            // 是普通导航链接，点下去就跳转，重载后又点——首页会一直刷新。
            setTimeout(() => {
                readMainPageTerms();
                setStatus(readSidebar() ? '就绪' : '就绪（点开积分面板可显示每日任务）');
            }, 1200);
        }

        log(`已加载 v${VERSION}（开标签页方式: ${openInTab ? 'GM_openInTab' : 'window.open'}）`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
