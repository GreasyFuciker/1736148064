// ==UserScript==
// @name         Microsoft Rewards 自动助手
// @namespace    https://github.com/GreasyFuciker/1736148064
// @version      2.8.1
// @description  Bing Rewards 助手：在搜索框里逐字输入并提交，按概率点开结果页浏览，时长与间隔走长尾分布、按轮次分时段休息，搜索词来自相关搜索/Bing 热搜与联想词
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

    const VERSION = '2.8.1';
    const CONFIG_KEY = 'bing_rewards_config_v2';
    const SESSION_KEY = 'bing_rewards_session_v2';

    /** 会话在无活动多久之后视为过期（毫秒）。必须大于最长的一次休息（现在有分时段长休）。 */
    const SESSION_TTL = 3 * 60 * 60 * 1000;

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

    /** 每天实际要搜多少次，当天定一次就不再变（存这里，停了再开也是同一个数）。 */
    const DAILY_KEY = 'bing_rewards_daily_v1';

    /** 打字时每个字之间的间隔（毫秒）。真人不是匀速的，所以是一个区间。 */
    const TYPE_DELAY = [40, 170];
    /** 打完字到按下回车之间的停顿（毫秒）——真人会瞄一眼联想列表。 */
    const TYPE_SETTLE = [250, 900];
    /** 表单提交后多久还没跳走，就认为提交没生效，退回直接跳 URL。 */
    const SUBMIT_WATCHDOG = 4 * 1000;

    /**
     * 长尾分布用的几个概率。真人的时间分布不是均匀的：
     * 大量很短的、少量很长的，中间是一个偏左的峰。
     */
    const LONG_PAUSE_CHANCE = 0.12;   // 两次搜索之间偶尔走神几分钟
    const BOUNCE_CHANCE = 0.25;       // 点进去发现不对，几秒就退回来
    const LONG_DWELL_CHANCE = 0.15;   // 看进去了，读很久
    /** 一条结果被点中的衰减系数：第 1 条 45%，第 2 条约 25%，越往下越少。 */
    const CLICK_DECAY = 0.45;

    /**
     * 搜索词历史：最近几天用过的词一律不再重复，这样每天的词都不一样。
     * 只存词和时间戳，按 historyDays 过期，并且限制总条数。
     */
    const HISTORY_KEY = 'bing_rewards_term_history_v1';
    const HISTORY_MAX = 600;

    /** 候选词池低于这个数就去 Bing 那儿补货（热搜 + 联想词）。 */
    const POOL_LOW_WATER = 8;
    /** 一次补货最多拿几个话题去问联想词。问太多既慢又扎眼。 */
    const SUGGEST_BASES = 3;
    /** 补货请求的超时，超了就走本地兜底，绝不把主流程卡住。 */
    const FETCH_TIMEOUT = 5 * 1000;
    /** 连续这么多轮取不到词，就不再请求那两个接口了。 */
    const TERM_FETCH_GIVE_UP = 3;

    /**
     * 组合词后缀。热搜和联想词都拿不到时（断网、接口改版），
     * 用「话题 + 后缀」现造新词——这条路不依赖任何网络，永远不会枯竭。
     */
    const TERM_MODIFIERS = [
        'guide', 'tips', 'review', 'checklist', 'for beginners', 'cost',
        'comparison', 'best options', 'common mistakes', 'step by step',
        'explained', 'pros and cons', 'what to know', 'how long'
    ];
    const TERM_MODIFIERS_CN = [
        '怎么选', '推荐', '教程', '注意事项', '多少钱', '排行榜',
        '入门', '对比', '常见问题', '经验分享', '值得买吗', '步骤'
    ];
    const CJK_RE = /[\u3400-\u9fff]/;

    /** 明显不是搜索词的东西：翻页、导航入口之类。 */
    const TERM_NOISE_RE = /^(下一页|上一页|更多|图片|视频|地图|资讯|新闻|翻译|词典|学术|购物|登录|设置|next|prev(ious)?|more|images|videos|maps|news|shopping|sign in|settings)$/i;

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
        restEvery: 12,             // 每搜索多少次歇一小会儿，0 表示不歇
        longBreakEvery: 12,        // 每搜索多少次歇一次长的（分时段用），0 表示不分时段
        longBreakTime: 25 * 60,    // 长休息的时长（秒）
        targetSearches: 40,        // 每天检索多少次（实际值会按下面的幅度浮动）
        targetJitterPercent: 20,   // 每天实际次数的浮动幅度（±%），0 表示每天都是固定次数
        sidebarEvery: 10,          // 每检索多少次才去查一次奖励面板，0 表示从不查
        clickChance: 55,           // 有多大概率点进结果页（%），其余的只扫一眼结果页
        clickDepth: 5,             // 点的时候在前几条自然结果里挑
        typeQuery: true,           // 在搜索框里逐字输入再提交，而不是直接跳 /search?q=
        jitterPercent: 30,         // 各阶段时长的随机浮动幅度（±%），0 表示关闭
        walkLength: [5, 8],        // 每个话题连续走几步后换新话题
        seedTopics: [...SEED_TOPICS], // 起始话题池，可在面板里编辑
        serpScrollTime: 20,        // 打开首条结果之前，先在结果页上滚动多久（秒），0 表示不滚
        serpJitterPercent: 70,     // 结果页滚动这一段单独的浮动幅度（±%），20 秒 ±70% → 6~34 秒
        useTrending: true,         // 把 Bing 首页的热搜词也纳入词库
        useSuggestions: true,      // 用 Bing 自己的联想接口扩充词库
        historyDays: 3,            // 最近几天用过的词不再重复，0 表示只按天去重
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
        target: 0,                 // 今天实际要搜多少次（当天固定，见 dailyTarget）
        day: today(),
        mainTerms: [],
        iframeTerms: [],
        termPool: [],              // 热搜/联想补进来的候选词，跨跳转保留
        termHistory: new Set(),    // 最近 historyDays 天用过的词
        historyRows: [],           // 历史的原始记录 {t, term}
        trendingTried: false,      // 本页是否已经取过热搜，别一轮问好几次
        termFetchFailures: 0,      // 热搜/联想连续几次没取到词，超限就不再白费请求
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
        if (num(saved.serpJitterPercent, 0, 100)) config.serpJitterPercent = saved.serpJitterPercent;
        if (num(saved.historyDays, 0, 30)) config.historyDays = saved.historyDays;
        if (num(saved.waitTime, 0, 60)) config.waitTime = saved.waitTime;
        if (num(saved.restEvery, 0, 100)) config.restEvery = saved.restEvery;
        if (num(saved.longBreakEvery, 0, 200)) config.longBreakEvery = saved.longBreakEvery;
        if (num(saved.longBreakTime, 60, 7200)) config.longBreakTime = saved.longBreakTime;
        if (num(saved.targetJitterPercent, 0, 60)) config.targetJitterPercent = saved.targetJitterPercent;
        if (num(saved.sidebarEvery, 0, 200)) config.sidebarEvery = saved.sidebarEvery;
        if (num(saved.clickChance, 0, 100)) config.clickChance = saved.clickChance;
        if (num(saved.clickDepth, 1, 10)) config.clickDepth = saved.clickDepth;
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
        if (typeof saved.typeQuery === 'boolean') config.typeQuery = saved.typeQuery;
        if (typeof saved.useTrending === 'boolean') config.useTrending = saved.useTrending;
        if (typeof saved.useSuggestions === 'boolean') config.useSuggestions = saved.useSuggestions;
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
            termPool: state.termPool,
            usedTopics: [...state.usedTopics],
            currentTopic: state.currentTopic,
            walkSteps: state.walkSteps,
            walkLimit: state.walkLimit,
            clickedOffers: [...state.clickedOffers],
            searchCount: state.searchCount,
            sidebarFailures: state.sidebarFailures,
            termFetchFailures: state.termFetchFailures,
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
        { id: 'cfg-serp-jitter', label: '结果页浮动(%)', min: 0, max: 100, get: () => config.serpJitterPercent, set: v => { config.serpJitterPercent = v; }, unit: '%' },
        { id: 'cfg-settle', label: '停留时间(秒)', min: 0, max: 60, get: () => config.waitTime, set: v => { config.waitTime = v; }, unit: '秒' },
        { id: 'cfg-rest-every', label: '小休间隔(次)', min: 0, max: 100, get: () => config.restEvery, set: v => { config.restEvery = v; }, unit: '次' },
        { id: 'cfg-long-every', label: '长休间隔(次)', min: 0, max: 200, get: () => config.longBreakEvery, set: v => { config.longBreakEvery = v; }, unit: '次' },
        { id: 'cfg-long-time', label: '长休时间(分)', min: 1, max: 120, get: () => config.longBreakTime / 60, set: v => { config.longBreakTime = v * 60; }, unit: '分钟' },
        { id: 'cfg-imin', label: '间隔下限(秒)', min: 1, max: 600, get: () => config.searchInterval[0], set: v => { config.searchInterval[0] = Math.min(v, config.searchInterval[1]); }, unit: '秒' },
        { id: 'cfg-imax', label: '间隔上限(秒)', min: 1, max: 600, get: () => config.searchInterval[1], set: v => { config.searchInterval[1] = Math.max(v, config.searchInterval[0]); }, unit: '秒' },
        { id: 'cfg-target', label: '检索次数', min: 1, max: 200, get: () => config.targetSearches, set: v => { config.targetSearches = v; }, unit: '次' },
        { id: 'cfg-jitter', label: '随机幅度(%)', min: 0, max: 60, get: () => config.jitterPercent, set: v => { config.jitterPercent = v; }, unit: '%' },
        { id: 'cfg-target-jitter', label: '次数浮动(%)', min: 0, max: 60, get: () => config.targetJitterPercent, set: v => { config.targetJitterPercent = v; }, unit: '%' },
        { id: 'cfg-click-chance', label: '点击概率(%)', min: 0, max: 100, get: () => config.clickChance, set: v => { config.clickChance = v; }, unit: '%' },
        { id: 'cfg-click-depth', label: '点击范围(条)', min: 1, max: 10, get: () => config.clickDepth, set: v => { config.clickDepth = v; }, unit: '条' },
        { id: 'cfg-sidebar-every', label: '查面板间隔(次)', min: 0, max: 200, get: () => config.sidebarEvery, set: v => { config.sidebarEvery = v; }, unit: '次' },
        { id: 'cfg-wmin', label: '话题步数下限', min: 1, max: 50, get: () => config.walkLength[0], set: v => { config.walkLength[0] = Math.min(v, config.walkLength[1]); }, unit: '步' },
        { id: 'cfg-wmax', label: '话题步数上限', min: 1, max: 50, get: () => config.walkLength[1], set: v => { config.walkLength[1] = Math.max(v, config.walkLength[0]); }, unit: '步' },
        { id: 'cfg-history', label: '不重复天数', min: 0, max: 30, get: () => config.historyDays, set: v => { config.historyDays = v; }, unit: '天' }
    ];

    function createUI() {
        const t = getTheme();

        const container = el('div', {
            id: 'rewards-helper-container',
            css: `position:fixed;bottom:20px;left:20px;background:${t.bg};color:${t.text};
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

        // 配置项越加越多，全展开能有 900px 高。面板是贴着底边往上长的，不限高的话
        // 小屏幕上顶部的几项会跑到视口外面去，所以中间这块自己滚。
        const content = el('div', {
            id: 'rewards-helper-content',
            css: 'padding:12px;max-height:65vh;overflow-y:auto;',
            parent: container
        });

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
                el('div', { id: 'iframe-search-terms', css: 'padding-left:8px;margin-bottom:4px;' }),
                el('div', { text: '热搜/联想:', css: `font-weight:bold;font-size:10px;color:${t.textSecondary};` }),
                el('div', { id: 'pool-terms', css: 'padding-left:8px;' })
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

        for (const box of [
            { id: 'type-query', label: '在搜索框里打字提交', get: () => config.typeQuery, set: v => { config.typeQuery = v; } },
            { id: 'use-trending', label: '纳入 Bing 热搜词', get: () => config.useTrending, set: v => { config.useTrending = v; } },
            { id: 'use-suggestions', label: '用联想词扩充词库', get: () => config.useSuggestions, set: v => { config.useSuggestions = v; } }
        ]) {
            el('div', {
                css: 'grid-column:1/-1;display:flex;align-items:center;gap:6px;margin-top:2px;',
                parent: configForm,
                children: [
                    el('input', {
                        id: box.id,
                        attrs: { type: 'checkbox' },
                        props: { checked: box.get() },
                        css: 'cursor:pointer;width:14px;height:14px;',
                        on: {
                            change: (e) => {
                                box.set(e.target.checked);
                                saveConfig();
                                setStatus(`${box.label}: ` + (e.target.checked ? '开启' : '关闭'));
                            }
                        }
                    }),
                    el('label', { text: box.label, attrs: { for: box.id }, css: 'cursor:pointer;font-size:11px;' })
                ]
            });
        }

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
        const target = runTarget();

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

    /** 词池在面板上只显示前 10 个，够看出「词是从哪儿来的」就行。 */
    function renderPoolTerms() {
        renderTermList('pool-terms', state.termPool.slice(0, 10).map(entry => entry.term));
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
     * 结果页上的前几条自然结果（最多 clickDepth 条）。广告块和站内入口
     * （图片/视频/相关搜索）都排掉，剩下的就是真人可能点进去的那几条。
     * 一条都没有就返回空数组，由调用方退回原地滚动。
     */
    /** 按人的点击习惯挑一条结果：第 1 条最多，越往下越少。 */
    function pickResultLink(links) {
        for (let i = 0; i < links.length - 1; i++) {
            if (Math.random() < CLICK_DECAY) return { link: links[i], rank: i + 1 };
        }
        return { link: links[links.length - 1], rank: links.length };
    }

    function findResultLinks() {
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
        const links = [];
        const seen = new Set();
        for (const selector of selectors) {
            for (const node of document.querySelectorAll(selector)) {
                if (!isVisitableResult(node) || seen.has(node.href)) continue;
                seen.add(node.href);
                links.push(node);
                if (links.length >= Math.max(1, config.clickDepth)) return links;
            }
            if (links.length) return links;   // 精确的选择器有货，就别再往下放宽了
        }
        if (!links.length) logNoResultLink();
        return links;
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

    /**
     * 结果页上能拿到的相关搜索词。
     *
     * v2.6.0 及以前只认三个选择器，而且「第一个有结果的选择器」就收工。真实的 Bing
     * 结果页早就换成了 .b_rs 那套版式，于是这里几乎永远抓不到词——随机游走每一步都
     * 得换一个起始话题，24 个话题用完就报「没有可用的搜索词」停下来，正好三十来次。
     * 现在把已知的几种版式全收一遍取并集，并且允许从 href 的 q 参数里取词。
     */
    function readMainPageTerms() {
        const current = (new URLSearchParams(location.search).get('q') || '').trim().toLowerCase();
        const selectors = [
            '.b_rs a[href*="/search?q="]',              // 底部「相关搜索」（当前版式）
            '.b_vList.b_divsec a[href*="/search?q="]',  // 旧版式
            '.rslist a[href*="/search?q="]',            // 更旧的版式
            '#b_context a[href*="/search?q="]',         // 右栏：相关实体、热搜模块
            '#b_results a[href*="/search?q="]',         // 结果区里任何站内检索链接
            '.richrsrailsuggestion_text',               // 右栏推荐（纯文本，没有链接）
            '.df_alsoAsk .b_algoheader'                 // 「大家还在问」
        ];

        const terms = [];
        for (const selector of selectors) {
            for (const node of document.querySelectorAll(selector)) {
                const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
                const term = isUsableTerm(text) ? text : queryOf(node.href || '');
                if (isUsableTerm(term) && term.toLowerCase() !== current) terms.push(term);
                if (terms.length > 60) break;
            }
        }

        if (!terms.length) {
            log('这一页没抓到相关搜索词（会改用热搜/联想词/组合词）');
            return false;
        }
        state.mainTerms = [...new Set(terms)];
        renderTermList('main-search-terms', state.mainTerms);
        log('主页面搜索词:', state.mainTerms.length, '个');
        return true;
    }

    /** 一条字符串能不能当搜索词用。 */
    function isUsableTerm(term) {
        if (typeof term !== 'string') return false;
        const text = term.trim();
        if (text.length < 2 || text.length > 60) return false;
        if (TERM_NOISE_RE.test(text)) return false;
        if (!/[\p{L}\p{N}]/u.test(text)) return false;      // 纯符号
        if (/^[\d\s.,:/-]+$/.test(text)) return false;      // 纯数字/翻页页码
        return true;
    }

    /** 从一条 /search?q=... 里把查询词取出来。 */
    function queryOf(href) {
        try {
            const value = new URL(href, location.href).searchParams.get('q') || '';
            return value.trim().replace(/\s+/g, ' ');
        } catch (e) {
            return '';
        }
    }

    /**
     * 从任意文本（JSON 或 HTML）里把 /search?q=xxx 的查询词全抠出来。
     * 热搜模块的字段名换来换去，但里面的检索链接总是这个形状，抓链接比抓字段稳。
     */
    function extractSearchQueries(text) {
        const out = [];
        const re = /\/search\?q=([^"'&\\\s<>]{2,120})/g;
        let hit;
        while ((hit = re.exec(text)) !== null && out.length < 40) {
            let term = '';
            try {
                term = decodeURIComponent(hit[1].replace(/\+/g, ' ')).trim();
            } catch (e) { /* 编码坏了就跳过 */ }
            if (isUsableTerm(term)) out.push(term);
        }
        return [...new Set(out)];
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

    /** 记账：全天去重 + 维护最近词窗口 + 记进跨天历史。 */
    function markUsed(term) {
        state.usedTerms.add(term);
        state.recentTerms.push(term);
        while (state.recentTerms.length > RECENT_WINDOW) state.recentTerms.shift();
        rememberTerm(term);
    }

    /**
     * 跨天历史：最近 historyDays 天用过的词都不再用。
     * 没有这一层的话，每天都从同一份起始话题池开工，第二天搜的还是那些词。
     */
    function loadTermHistory() {
        if (config.historyDays <= 0) {          // 关掉跨天历史：只按天去重
            state.historyRows = [];
            state.termHistory = new Set();
            return;
        }
        const rows = readJSON(HISTORY_KEY);
        const keepAfter = Date.now() - Math.max(0, config.historyDays) * 24 * 60 * 60 * 1000;
        state.historyRows = (Array.isArray(rows) ? rows : [])
            .filter(row => row && typeof row.term === 'string' && typeof row.t === 'number' && row.t >= keepAfter)
            .slice(-HISTORY_MAX);
        state.termHistory = new Set(state.historyRows.map(row => row.term));
        if (state.termHistory.size) {
            log(`最近 ${config.historyDays} 天用过 ${state.termHistory.size} 个词，都不再重复`);
        }
    }

    function rememberTerm(term) {
        if (config.historyDays <= 0) return;
        state.termHistory.add(term);
        state.historyRows.push({ t: Date.now(), term });
        if (state.historyRows.length > HISTORY_MAX) {
            state.historyRows = state.historyRows.slice(-HISTORY_MAX);
        }
        writeJSON(HISTORY_KEY, state.historyRows);
    }

    /** 这个词现在能不能用：没用过、最近几天没用过、也不跟刚搜的几个词雷同。 */
    function isFreshTerm(term) {
        return isUsableTerm(term) &&
            !state.usedTerms.has(term) &&
            !state.termHistory.has(term) &&
            !state.recentTerms.some(r => tooSimilar(term, r));
    }

    function pickRandom(list) {
        return list[Math.floor(Math.random() * list.length)];
    }

    function shuffled(list) {
        const out = list.slice();
        for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    }

    /**
     * 补充候选词池。两个来源都是 bing.com 的同源接口，不需要额外权限，也不碰第三方：
     *   1. 热搜：首页数据里的检索链接，就是当天的热词；
     *   2. 联想词：Bing 自己的 osjson 联想接口，返回的是真人常搜的词。
     * 拿不到就静默返回——后面还有组合词兜底，绝不会因为取词失败停下来。
     */
    async function refillTermPool() {
        if (state.termPool.length >= POOL_LOW_WATER) return;
        // 接口连着几轮都取不到词（改版了、被墙了、断网了），就别再每轮白发请求，
        // 后面一路用组合词兜着。这跟侧栏读不到之后不再轮询是一个道理。
        if (state.termFetchFailures >= TERM_FETCH_GIVE_UP) return;

        const found = [];
        let tried = false;

        if (config.useTrending && !state.trendingTried) {
            state.trendingTried = true;
            tried = true;
            const hot = await fetchTrendingTerms();
            if (hot.length) log('热搜词:', hot.length, '个');
            for (const term of hot) found.push({ term, source: '热搜词' });
        }

        if (config.useSuggestions) {
            tried = true;
            for (const base of shuffled(config.seedTopics).slice(0, SUGGEST_BASES)) {
                const list = await fetchSuggestions(base);
                for (const term of list) found.push({ term, source: '联想词' });
            }
        }

        if (tried) {
            if (found.length) {
                state.termFetchFailures = 0;
            } else if (++state.termFetchFailures >= TERM_FETCH_GIVE_UP) {
                log('热搜/联想接口连续取不到词，后面不再请求，改用组合词');
            }
            // 每一页都是新的运行环境，计数不落盘的话下次加载又从 0 开始，永远攒不够
            saveSession();
        }

        if (!found.length) return;

        // 打散：同一个词根的联想词挨在一起搜，看着就是机器在遍历
        const known = new Set(state.termPool.map(entry => entry.term));
        for (const entry of shuffled(found)) {
            if (known.has(entry.term) || !isFreshTerm(entry.term)) continue;
            known.add(entry.term);
            state.termPool.push(entry);
        }
        if (state.termPool.length > 60) state.termPool.length = 60;
        log('候选词池:', state.termPool.length, '个');
        renderPoolTerms();
        saveSession();
    }

    async function fetchTrendingTerms() {
        // 首页数据里带着热搜模块，字段名换过好几轮，但里面的 /search?q=… 链接一直都在
        const text = await fetchText(`${location.origin}/hp/api/model`);
        const fromApi = text ? extractSearchQueries(text) : [];
        if (fromApi.length) return fromApi;

        // 接口不给就退回页面上的热搜/推荐模块（右栏、首页热搜条）
        return [...document.querySelectorAll(
            '#b_context a[href*="/search?q="], .hp_trending a[href*="/search?q="], .trending a[href*="/search?q="]'
        )].map(node => queryOf(node.href)).filter(isUsableTerm);
    }

    async function fetchSuggestions(base) {
        const text = await fetchText(`${location.origin}/osjson.aspx?query=${encodeURIComponent(base)}`);
        if (!text) return [];
        try {
            // 正常返回：["coffee",["coffee near me","coffee maker",...]]
            const data = JSON.parse(text);
            const list = (Array.isArray(data) && Array.isArray(data[1])) ? data[1] : [];
            return list.map(item => String(item).trim()).filter(isUsableTerm);
        } catch (e) {
            // 接口改版返回了 HTML，就走通用的「抠检索链接」那条路
            return extractSearchQueries(text);
        }
    }

    /** 带超时的 GET。取词失败一律当作没取到，绝不把主流程卡住。 */
    async function fetchText(url) {
        const controller = (typeof AbortController === 'function') ? new AbortController() : null;
        let timer = null;
        try {
            if (controller) timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
            const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
            if (!res.ok) return '';
            return await res.text();
        } catch (e) {
            log('取词请求失败:', url.split('?')[0], e && e.message);
            return '';
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** 从词池里拿一个还能用的词。 */
    function takeFromPool() {
        while (state.termPool.length) {
            const entry = state.termPool.shift();
            if (entry && isFreshTerm(entry.term)) return { term: entry.term, source: entry.source || '联想词' };
        }
        return null;
    }

    /**
     * 最后的兜底：话题 + 后缀现造一个词。
     * 24 个话题 × 14 个后缀 = 336 个组合，且完全不依赖网络，
     * 所以「没有可用的搜索词」这条死路基本上不会再走到。
     */
    function buildComboTerm() {
        for (const seed of shuffled(config.seedTopics)) {
            const modifiers = CJK_RE.test(seed) ? TERM_MODIFIERS_CN : TERM_MODIFIERS;
            for (const modifier of shuffled(modifiers)) {
                const term = `${seed} ${modifier}`;
                if (isFreshTerm(term)) return term;
            }
        }
        return null;
    }

    /** 当前页面上还能用的词，主页面优先、侧栏次之，已用过和近似的都排除。 */
    function availableTerms() {
        const usable = (list) => list.filter(isFreshTerm);
        const main = usable(state.mainTerms);
        if (main.length) return { terms: main, source: '主页面' };
        return { terms: usable(state.iframeTerms), source: '侧栏' };
    }

    /** 以某个词为起点开一段新的游走，并掷出这一轮要走的步数。 */
    function startWalk(term) {
        state.currentTopic = term;
        state.walkSteps = 0;
        state.walkLimit = rollWalkLimit();
        markUsed(term);
        log(`切换话题:「${term}」，本轮走 ${state.walkLimit} 步`);
    }

    /**
     * 这一轮在同一个话题上走几步。
     * 固定 5~8 步是机器味最重的地方之一：真人多数时候搜一下就走，
     * 偶尔会在一个话题上连着搜十几次。所以两头都留了尾巴。
     */
    function rollWalkLimit() {
        const [min, max] = config.walkLength;
        const roll = Math.random();
        if (roll < 0.2) return 1;                                        // 看一眼就换话题
        if (roll > 0.85) return max + Math.floor(Math.random() * max);   // 在一个话题上耗很久
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    /**
     * 换一个与当前话题无关的起始话题。
     * 优先挑最近几天都没用过的；实在没有了就只按「今天没用过」来挑；
     * 再没有就返回 null——交给热搜/联想/组合词，而不是像以前那样直接停机。
     */
    function nextTopic() {
        const unusedToday = config.seedTopics.filter(t => !state.usedTopics.has(t));
        const pool = unusedToday.filter(isFreshTerm).length
            ? unusedToday.filter(isFreshTerm)
            : unusedToday.filter(t => !state.usedTerms.has(t));
        if (!pool.length) return null;

        const topic = pickRandom(pool);
        state.usedTopics.add(topic);
        startWalk(topic);
        return topic;
    }

    /**
     * 选词。顺着当前结果页的相关搜索走，走满掷出的步数、或者这一页没有新词了，
     * 就换一个不相关的起点重新开始。起点按这个顺序找，前一个空了才用后一个：
     *
     *   起始话题池 → 热搜词/联想词（Bing 同源接口取来的） → 话题+后缀的组合词
     *
     * 三条路都空了才会返回 null。组合词不依赖网络，所以实际上走不到那一步。
     */
    function pickTerm() {
        const available = availableTerms();

        if (state.walkSteps < state.walkLimit && available.terms.length) {
            const term = pickRandom(available.terms);
            markUsed(term);
            return { term, source: available.source };
        }

        const topic = nextTopic();
        if (topic) return { term: topic, source: '新话题' };

        const pooled = takeFromPool();
        if (pooled) {
            startWalk(pooled.term);
            return { term: pooled.term, source: pooled.source };
        }

        const combo = buildComboTerm();
        if (combo) {
            startWalk(combo);
            return { term: combo, source: '组合词' };
        }

        // 起点全没了，但这一页还有没搜过的词，那就先用着
        if (available.terms.length) {
            const term = pickRandom(available.terms);
            markUsed(term);
            return { term, source: available.source };
        }
        return null;
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
        const seconds = dwellSeconds(config.scrollTime);
        const links = config.visitFirstResult ? findResultLinks() : [];
        if (!links.length) {
            return scrollPhase(seconds, config.visitFirstResult ? '没找到可打开的搜索结果' : '');
        }

        // 不是每次搜索都会点进去。真人的点击率大概只有一半上下，
        // 「每一次检索都恰好点开第一条」本身就是一个很扎眼的模式。
        if (Math.random() * 100 >= config.clickChance) {
            return scrollPhase(dwellSeconds(config.serpScrollTime || config.scrollTime), '这次只看结果页不点进去');
        }

        const { link, rank } = pickResultLink(links);
        // 打开的是链接本身（Bing 的结果链接多半是 /ck/a 点击跳转）：
        // 解码成真实地址虽然更省事，但那样 Bing 侧就完全看不到这次点击了。
        // 票据里存的仍然是解码后的目标域名，落地页照样认得出自己。
        const href = link.href;
        const landing = resolveResultUrl(href);
        const label = (link.textContent || '').trim().slice(0, 24) || hostOf(landing) || `第 ${rank} 条`;
        const deadline = Date.now() + seconds * 1000;

        await hoverResult(link);

        // 票据先写、标签页后开：那一页可能比这行代码之后的任何东西都先加载完
        writeVisitTicket({
            host: hostOf(landing), deadline, createdAt: Date.now(), claimedAt: 0, doneAt: 0
        });

        const handle = openVisitTab(withVisitMarker(href, deadline));
        if (!handle) {
            clearVisitTicket();
            return scrollPhase(seconds, '新标签页被拦截（请允许本站弹出窗口）');
        }

        visitTab = handle;
        if (handle.win) installVisitBridge(handle.win, deadline);
        setStatus(`打开第 ${rank} 条结果浏览 ${seconds} 秒：${label}`);
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

    /**
     * 点之前先把结果滚进视野、在链接上走一遍鼠标事件。
     * Bing 自己的点击埋点挂在这些事件上，直接 window.open 的话，
     * 页面侧看到的是「没有任何鼠标动作，结果却被打开了」。
     * 这里刻意不派发 click —— 那会把当前标签页顶走。
     */
    async function hoverResult(link) {
        try {
            link.scrollIntoView({ block: 'center', behavior: 'smooth' });
            await sleep(220 + Math.random() * 480);
            const rect = link.getBoundingClientRect();
            const options = {
                bubbles: true,
                cancelable: true,
                view: pageWindow,
                clientX: Math.round(rect.left + rect.width * (0.15 + Math.random() * 0.6)),
                clientY: Math.round(rect.top + rect.height * (0.3 + Math.random() * 0.4))
            };
            for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) {
                link.dispatchEvent(new MouseEvent(type, options));
            }
        } catch (e) {
            if (e === ABORT) throw e;
            log('模拟鼠标事件失败（不影响打开）:', e && e.message);
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

    /** 标准正态随机数（Box-Muller），下面几个长尾分布都用它。 */
    function gaussian() {
        let u = 0;
        let v = 0;
        while (!u) u = Math.random();
        while (!v) v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    /** 对数正态：峰偏在左边（偏向 min），尾巴伸向 max。比均匀分布像人得多。 */
    function logNormalBetween(min, max) {
        if (!(max > min)) return min;
        const peak = min + (max - min) * 0.35;
        const value = Math.exp(Math.log(peak) + gaussian() * 0.5);
        return clamp(value, min, max);
    }

    /**
     * 两次搜索之间的间隔。
     * 均匀分布是最容易看出来的一种「随机」：真人的间隔集中在偏短的一段，
     * 偶尔会因为去干别的事而空出好几分钟。所以这里是「对数正态 + 偶发长停顿」。
     */
    function randomInterval() {
        const [min, max] = config.searchInterval;
        if (Math.random() < LONG_PAUSE_CHANCE) {
            return Math.round(max * (1.5 + Math.random() * 2.5));   // 走神了
        }
        return Math.round(logNormalBetween(min, max));
    }

    /**
     * 浏览类时长（结果页扫一眼、落地页停留）。
     * 真人有大量「点进去两秒就退出来」和少量「读很久」，中间才是正常阅读。
     */
    function dwellSeconds(base) {
        if (!base) return base;
        const roll = Math.random();
        if (roll < BOUNCE_CHANCE) return Math.max(2, Math.round(base * (0.15 + Math.random() * 0.25)));
        if (roll > 1 - LONG_DWELL_CHANCE) return Math.round(base * (1.8 + Math.random() * 1.7));
        return Math.max(2, Math.round(logNormalBetween(base * 0.5, base * 1.6)));
    }

    /**
     * 今天实际搜多少次。每天在设定值上下浮动一次，当天定了就不再变
     * （停了再开还是同一个数）——每天都恰好 40 次本身就是个特征。
     */
    function dailyTarget() {
        const saved = readJSON(DAILY_KEY);
        if (saved && saved.day === today() && typeof saved.target === 'number' && saved.target > 0) {
            return saved.target;
        }
        const swing = (Math.random() * 2 - 1) * (config.targetJitterPercent / 100);
        const target = Math.max(1, Math.round(config.targetSearches * (1 + swing)));
        writeJSON(DAILY_KEY, { day: today(), target });
        log(`今天计划检索 ${target} 次（设定 ${config.targetSearches} 次）`);
        return target;
    }

    /** 本轮的目标次数。init 里定好，其余地方一律读这个。 */
    function runTarget() {
        return state.target || config.targetSearches;
    }

    /** 奖励面板不必每轮都查——真人不会每搜一次就点开积分面板看一眼。 */
    function shouldCheckSidebar() {
        if (state.sidebarFailures >= 3 || config.sidebarEvery <= 0) return false;
        if (state.searchCount >= runTarget()) return true;          // 收工前看一眼
        return state.searchCount > 0 && state.searchCount % config.sidebarEvery === 0;
    }

    /**
     * 给一个固定时长加上 ±幅度 的随机浮动。
     * 真人不会每次都停留恰好 8 秒、滚动恰好 10 秒——固定值本身就是特征。
     * 不传 percent 就用全局的 jitterPercent；结果页滚动那一段用自己的 serpJitterPercent。
     */
    function humanize(seconds, percent) {
        const swingPercent = (typeof percent === 'number') ? percent : config.jitterPercent;
        if (!seconds || swingPercent <= 0) return seconds;
        const swing = (Math.random() * 2 - 1) * (swingPercent / 100);
        return Math.max(1, Math.round(seconds * (1 + swing)));
    }

    function remainingSearches() {
        return Math.max(0, runTarget() - state.searchCount);
    }

    function markIntentionalNav() {
        try {
            sessionStorage.setItem(NAV_FLAG_KEY, '1');   // 标记：下一次加载是脚本自己发起的
        } catch (e) { /* 忽略 */ }
    }

    /**
     * 发起一次搜索。
     *
     * 优先走「在搜索框里逐字打字再提交表单」这条路：直接 location.assign 到
     * /search?q=…&form=QBRE 固然可靠，但那一次检索没有任何前戏——没有输入事件、
     * 没有联想请求，URL 上也没有输入框提交才会带上的那些参数。
     * 打字失败（页面上没有搜索框、或者提交没生效）就退回直接跳转，流程不会卡住。
     */
    async function doSearch() {
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

        setStatus(`搜索: ${picked.term}（${picked.source}）· 话题「${state.currentTopic}」${state.walkSteps}/${state.walkLimit} 步 · 第 ${state.searchCount}/${runTarget()} 次`);
        renderProgress();

        if (config.typeQuery && await typeAndSubmit(picked.term)) return true;

        markIntentionalNav();
        const url = new URL('/search', location.origin);
        url.searchParams.set('q', picked.term);
        url.searchParams.set('form', 'QBRE');
        location.assign(url.toString());
        return true;
    }

    /**
     * 把词逐字打进搜索框再提交。每个字之间的间隔是随机的，打完还会停一下
     * ——顺带让 Bing 的联想请求真实发生，这本来就是真人检索的一部分。
     * 返回 false 表示这条路没走通，调用方会退回直接跳转。
     */
    async function typeAndSubmit(term) {
        const box = findSearchBox();
        if (!box) {
            // 把页面上所有候选框打出来，下次一眼就能看出是选择器没覆盖到还是别的原因
            log('页面上没找到可用的搜索框，改用直接跳转。候选:',
                [...document.querySelectorAll('#sb_form_q, input[name="q"], textarea[name="q"]')]
                    .map(node => {
                        const rect = node.getBoundingClientRect();
                        return `${node.tagName}#${node.id || '-'}[type=${node.type}] ${Math.round(rect.width)}x${Math.round(rect.height)}`;
                    }));
            return false;
        }
        const form = box.form || box.closest('form') || document.querySelector('#sb_form');
        if (!form) {
            log('搜索框不在表单里，改用直接跳转');
            return false;
        }

        try {
            log('在搜索框里输入:', term);
            box.focus();
            box.click();
            setNativeValue(box, '');
            for (const ch of term) {
                box.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
                setNativeValue(box, box.value + ch);
                box.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
                await sleep(TYPE_DELAY[0] + Math.random() * (TYPE_DELAY[1] - TYPE_DELAY[0]));
            }
            await sleep(TYPE_SETTLE[0] + Math.random() * (TYPE_SETTLE[1] - TYPE_SETTLE[0]));

            markIntentionalNav();
            // 依次试三种提交方式。哪一种生效了，页面就开始跳转，
            // 后面的代码根本不会执行；全都没动静才退回直接跳 URL。
            pressEnter(box);
            await sleep(600);

            const button = document.querySelector('#sb_form_go, #search_icon, label[for="sb_form_go"], #sb_form button[type="submit"]');
            if (button) button.click();
            await sleep(600);

            if (typeof form.requestSubmit === 'function') form.requestSubmit();
            else form.submit();

            await sleep(SUBMIT_WATCHDOG);
            log('输入完了但页面没跳走，改用直接跳转');
            return false;
        } catch (e) {
            if (e === ABORT) throw e;
            log('搜索框输入失败，改用直接跳转:', e && e.message);
            return false;
        }
    }

    /**
     * 页面上真正能用的那个搜索框。两个坑都在这儿：
     *
     * 1. querySelector 的选择器列表是按「文档顺序」命中的，不是按选择器先后——
     *    Bing 页面里排在 #sb_form_q 前面还有别的 input[name="q"]（备用表单、
     *    移动版布局），直接取会拿到一个用户根本看不见的框，打字打了个寂寞。
     * 2. 不能用 offsetParent 判断可见性：Bing 的搜索框在固定定位的头部里，
     *    只要祖先有 position:fixed，offsetParent 就恒为 null，明明看得见也会被判成隐藏。
     *    改用 getBoundingClientRect 量实际尺寸。
     * 新版 Bing 有的布局把搜索框换成了 textarea，所以两种都收。
     */
    function findSearchBox() {
        const nodes = [...document.querySelectorAll('#sb_form_q, input[name="q"], textarea[name="q"]')];
        return nodes.find(node => {
            if (node.disabled || node.readOnly || node.type === 'hidden') return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 40 && rect.height > 8;
        }) || null;
    }

    /** 真人是按回车提交的，Bing 的提交逻辑也多半挂在键盘事件上。 */
    function pressEnter(box) {
        const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        for (const type of ['keydown', 'keypress', 'keyup']) {
            box.dispatchEvent(new KeyboardEvent(type, options));
        }
    }

    /**
     * 给受控输入框赋值。React/框架化的输入框会拦截 value 的直接赋值，
     * 走原型上的 setter 再补一个 input 事件才能让页面自己的监听收到。
     */
    function setNativeValue(input, value) {
        const kind = (input.tagName === 'TEXTAREA') ? pageWindow.HTMLTextAreaElement : pageWindow.HTMLInputElement;
        const proto = kind && kind.prototype;
        const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /** 一次完整循环，运行在「上一次搜索跳转后的新页面」上，最后以一次跳转结束。 */
    async function runCycle(savedPhase) {
        try {
            if (savedPhase) await resumePhase(savedPhase);

            if (isResultsPage()) {
                // 先在结果页上扫一眼——真人也是先看几眼结果再点进去——然后再打开首条结果
                if (config.serpScrollTime > 0) await scrollPhase(humanize(config.serpScrollTime, config.serpJitterPercent));
                await visitPhase();
                if (config.waitTime > 0) {
                    const settle = humanize(config.waitTime);
                    setStatus(`停留 ${settle} 秒，等待 Bing 记账...`);
                    await waitSeconds(settle, Phase.SETTLE);
                }
                if (shouldCheckSidebar()) await checkPhase();
            } else {
                // 不在结果页（比如首页）就别装浏览了，直接读一次奖励面板
                if (shouldCheckSidebar()) await checkPhase();
            }

            // 唯一的终止条件：搜够今天计划的次数。
            if (state.searchCount >= runTarget()) {
                showCompletionNotification();
                stop(`已完成 ${state.searchCount} 次检索 🎉`);
                return;
            }

            // 两级休息：小休是喝口水，长休是「这一轮先到这儿」——
            // 一天 40 次一口气连着搜完，本身就不像人在用搜索引擎。
            const longBreak = config.longBreakEvery > 0 && state.searchCount > 0 &&
                state.searchCount % config.longBreakEvery === 0;
            const shortRest = config.restEvery > 0 && state.searchCount > 0 &&
                state.searchCount % config.restEvery === 0;
            if (longBreak) {
                const rest = humanize(config.longBreakTime);
                setStatus(`这一轮告一段落，休息 ${Math.round(rest / 60)} 分钟再继续`);
                await waitSeconds(rest, Phase.REST);
            } else if (shortRest) {
                const rest = humanize(config.restTime);
                setStatus(`已连续检索 ${state.searchCount} 次，休息 ${Math.round(rest / 60 * 10) / 10} 分钟`);
                await waitSeconds(rest, Phase.REST);
            }

            readMainPageTerms();
            // 词池见底就趁这会儿去补：请求带超时，失败也不影响后面的流程
            await refillTermPool().catch(() => {});

            const gap = randomInterval();
            setStatus(`等待 ${gap} 秒后进行下一次搜索`);
            await waitSeconds(gap, Phase.INTERVAL);

            await doSearch();
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

        if (state.searchCount >= runTarget()) {
            stop(`今日已检索 ${state.searchCount} 次，达到今天的计划次数`);
            return;
        }
        // 起始话题池永远兜得住，不再需要「没有搜索词就无法开始」这条分支
        try {
            await doSearch();
        } catch (e) {
            if (e === ABORT) return;          // 打字打到一半被按了停止
            log('发起搜索失败:', e && e.message);
            stop('因错误停止');
        }
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
        state.termPool = Array.isArray(saved.termPool) ? saved.termPool : [];
        state.usedTopics = new Set(saved.usedTopics || []);
        state.currentTopic = saved.currentTopic || '';
        state.walkSteps = saved.walkSteps || 0;
        state.walkLimit = saved.walkLimit || 0;
        state.clickedOffers = new Set(saved.clickedOffers || []);
        state.searchCount = saved.searchCount || 0;
        state.sidebarFailures = saved.sidebarFailures || 0;
        state.termFetchFailures = saved.termFetchFailures || 0;
        state.day = saved.day || today();
        state.running = true;
        setButtonRunning(true);
        renderProgress();
        renderPoolTerms();
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
        loadTermHistory();
        state.target = dailyTarget();
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
