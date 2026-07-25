// ============================================================
// 记忆总结助手 Memory Summarizer  v1.0.0（个人使用，非明确要求，不增长版本号、不记录更新内容）
// ============================================================

import {
    getContext,
    extension_settings,
} from "../../../extensions.js";

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    saveChatConditional,
} from "../../../../script.js";

// world-info.js 里导出的世界书读写函数，不同版本可能略有出入，
// 如果你的酒馆版本导入失败，"写入世界书"按钮会报错提示，
// 但"复制"按钮永远可用，可以手动粘贴进世界书/预设。
let WI_API = null;
try {
    WI_API = await import("../../../world-info.js");
} catch (e) {
    console.warn("[记忆总结助手] 无法加载 world-info.js，写入世界书功能将不可用：", e);
}

const MODULE_NAME = "tavern-memory-summarizer";

// 运行时状态：是否有一次总结正在进行中（防止并发重复触发）
let isSummarizing = false;

// 运行时状态：手动总结提醒计数（关闭自动总结时，提醒用户该总结了）
// 每次实际完成一次总结（手动）或切换聊天时重置为 0
let manualReminderCount = 0;

// 运行时状态（纯 UI，不持久化）：最近一次新增的摘要/核心记忆条目 id，
// 仅用于给它播放一次"新条目入场"动画；渲染完成后会被清空，
// 避免同一条目在后续与它无关的重绘（比如编辑别的条目触发的整表重渲染）中反复播放动画。
let lastAddedSummaryId = null;
let lastAddedCoreId = null;

// 运行时状态（纯 UI，不持久化）：当前勾选了哪些长期记忆条目用于"提取核心"。
// 单独用一个 Set 维护，而不是只依赖 DOM 里的 checkbox 状态，是因为筛选/排序/分页
// 变化会重新生成整个列表的 innerHTML，勾选状态如果只存在 DOM 上就会丢失，
// 用户体验会很差（勾了几条，切一下筛选条件，勾选全没了）。
let selectedForCoreIds = new Set();

// 运行时状态（纯 UI，不持久化）：长期记忆 / 核心记忆的搜索关键词。
// 特意不放进 extension_settings 里：saveSettings() 实际调用的是酒馆全局的
// saveSettingsDebounced()，它保存的是整个 extension_settings 对象，不是只保存
// "这一个字段"——如果搜索词存在 settings 里，只要之后任何一次别的设置变更
// （哪怕跟搜索毫无关系）顺带触发了一次保存，输入框里当时残留的搜索词就会被
// 一起写进磁盘上的配置文件，还会被"导出记忆数据"打包进 JSON、被"导入"覆盖回来，
// 造成困惑（比如导入别人分享的存档后，搜索框明明是空的，列表却莫名其妙被过滤了）。
// 用普通模块级变量，和 summaryShowAll/coreShowAll/selectedForCoreIds 保持一致。
let searchKeyword = "";
let coreSearchKeyword = "";

// ------------------------ 默认配置 ------------------------
const defaultSettings = {
    messagesPerSummary: 20,          // 每次总结发送的对话条数
    autoSummarize: true,             // 达到条数是否自动触发
    promptTemplate:
        "请将下面这段角色扮演对话浓缩为简洁的第三人称剧情摘要，" +
        "保留关键事件、人物关系变化、重要信息和伏笔，去除口水对话与重复内容，" +
        "字数控制在200字以内，直接输出摘要正文，不要加任何前后缀说明：\n\n{{content}}",
    includeStyleReference: true,      // 总结时是否携带最近旧摘要作为风格参考
    styleReferenceCount: 3,           // 携带最近几条旧摘要
    autoInject: false,                // 是否自动注入到上下文（相当于引用到预设）
    // 注入位置，4 档预设（内部映射到酒馆的 extension_prompt_types + depth，见 resolveInjectPositionType）：
    // main_before = Main Prompt↑（主提示词之前）  main_after = Main Prompt↓（主提示词之后，原来的"主提示词内"）
    // chat_top    = Chat History↑（聊天记录中靠前的位置，深度可调）
    // chat_bottom = Chat History↓（聊天记录末尾，紧邻即将生成的回复之前，固定深度 0）
    injectPosition: "main_after",
    injectDepth: 4,                   // 仅 chat_top 时可调（chat_bottom 固定为 0）
    injectRole: "system",             // system / user / assistant（仅 chat_top / chat_bottom 时生效）
    injectCount: 3,                   // 自动注入时合并最近几条摘要
    panelOpen: false,                 // 记住面板展开/收起状态
    wiPosition: "",                   // 写入世界书时使用的插入位置键名（从当前酒馆版本动态探测）
    wiDepth: 4,                       // 位置为"指定深度"时使用
    wiRole: "system",                 // 位置为"指定深度"时使用：system / user / assistant
    wiBookName: "",                   // 上次选择的目标世界书名，自动保存/恢复
    corePromptTemplate:
        "请从以下多段剧情摘要中提取核心记忆信息（如：角色生日、重要约定、" +
        "作息习惯、兴趣爱好、重要事件、关键物品、人物关系确认等永久性事实），" +
        "以简洁的条目列表形式输出，每条一行，只输出核心事实，" +
        "不要输出剧情经过或口水内容：\n\n{{content}}",
    coreInjectCount: 5,               // 自动注入时合并最近几条核心记忆
    summaryPageSize: 20,              // 长期记忆列表每页/默认显示条数

    // 面板"高级"折叠分组的展开/收起状态（仅影响 UI 显示，不影响任何数据）。
    // 默认全部收起，手机端打开面板时只看到"基础模式"的 4 项常用控件。
    sectionOpenSummary: false,        // ▼ 总结设置
    sectionOpenInject: false,         // ▼ 注入设置
    sectionOpenWorldbook: false,      // ▼ 世界书
    sectionOpenLongterm: false,       // ▼ 长期记忆（含核心记忆）
    sectionOpenDataManage: false,     // ▼ 数据管理（统计 / 导出导入 / 回收站）

    summaryOrder: "desc",             // 长期记忆列表显示/注入顺序："desc"=倒序(新在前) "asc"=正序(旧在前)
    filterMinChars: 0,                // 筛选：最小字数，0=不限
    filterMaxChars: 0,                // 筛选：最大字数，0=不限
    filterTimeRange: "all",           // 筛选：时间范围 "all" / "1h" / "24h" / "7d" / "30d"
    filterTier: "all",                // 筛选：分级 "all" / "important" / "normal" / "deprecated"
    coreHideDeprecated: false,        // 核心记忆列表是否隐藏已废弃条目

    // 核心记忆：筛选/顺序调整/分页，字段含义与上面长期记忆的同名字段完全一致，独立存储互不影响
    coreOrder: "desc",
    coreFilterMinChars: 0,
    coreFilterMaxChars: 0,
    coreFilterTimeRange: "all",
    corePageSize: 20,

    // 数据量软限制：超过阈值时在面板里显示提醒，不会自动删除
    summaryWarnThreshold: 200,        // 长期记忆条数警告阈值，0=不提醒
    coreWarnThreshold: 50,            // 核心记忆条数警告阈值，0=不提醒

    // 自定义注入提示词模板：核心记忆 / 长期记忆各一份，无论是"自动注入到上下文"还是
    // "写入世界书"，都统一用这份模板包裹——同一类记忆永远只被同一份模板包一次，
    // 且会先把该类全部记忆合并成一整块（每条一行），再整体套进模板里，不会逐条分散注入。
    // 用 {{memories}} 代表合并后的记忆正文；如果模板里没写 {{memories}}，为避免内容被
    // 静默丢弃，会自动把内容追加在模板末尾（见 applyTemplate）。模板里其余部分原样保留，
    // 包括 {{user}}/{{char}} 这类酒馆自己的宏——本插件不处理它们，留给酒馆自己的宏系统解析。
    injectTemplateSummary: "以下是关于{{user}}的过往剧情记忆，按时间整理：\n{{memories}}",
    injectTemplateCore:
        "以下是我关于{{user}}，一直放在心上的一些事：\n{{memories}}\n\n" +
        "# 记忆应用\n" +
        "以上是需要你始终牢记、不可违背或遗忘的核心事实。回复时请自然地运用这些信息，" +
        "不要逐条复述或以列表形式念出来，也不要在明显不相关的话题下突兀地提起。",
};

// 每个"聊天"独立保存的数据（摘要内容 + 计数指针），存在 chat_metadata 里，
// 这样切换角色卡/切换聊天时数据不会串
function getChatData() {
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[MODULE_NAME]) {
        context.chatMetadata[MODULE_NAME] = {
            lastSummarizedIndex: 0,
            summaries: [], // { id, time, range: [start,end], content, auto }
            coreMemories: [], // { id, time, content, sourceIds: [] }
            trashBin: [], // { deletedAt, type: "summary"|"core", entry: 原始条目 }
        };
    }
    if (!context.chatMetadata[MODULE_NAME].trashBin) {
        context.chatMetadata[MODULE_NAME].trashBin = [];
    }
    return context.chatMetadata[MODULE_NAME];
}

// 回收站常量
const TRASH_MAX_COUNT = 10;      // 回收站最多保留条数
const TRASH_EXPIRE_MS = 86400000; // 24 小时（毫秒）

// 把一条被删除的记忆移入回收站（不做 saveChatData，由调用方统一保存）
function moveToTrash(entry, type) {
    const data = getChatData();
    // 先清理过期条目
    const now = Date.now();
    data.trashBin = data.trashBin.filter((t) => (now - t.deletedAt) < TRASH_EXPIRE_MS);
    // 加入新条目
    data.trashBin.push({
        deletedAt: now,
        type: type, // "summary" 或 "core"
        entry: structuredClone(entry),
    });
    // 超出上限就删最旧的
    while (data.trashBin.length > TRASH_MAX_COUNT) {
        data.trashBin.shift();
    }
}

// 获取回收站中尚未过期的条目
function getValidTrashItems() {
    const data = getChatData();
    const now = Date.now();
    return data.trashBin.filter((t) => (now - t.deletedAt) < TRASH_EXPIRE_MS);
}

// 更新"回收站"按钮上的数量小标，让用户不用点开就知道里面有没有东西
function updateTrashCount() {
    const el = document.getElementById("mem-trash-count");
    if (!el) return;
    const count = getValidTrashItems().length;
    el.textContent = count > 0 ? ` (${count})` : "";
}

// 统计面板用的数据。全部基于当前已有字段实时计算，不额外持久化任何"统计值"本身——
// 这样统计永远和实际数据保持一致，不会出现"计数器"和真实条数对不上的情况。
function computeMemoryStats() {
    const data = getChatData();
    const summaries = data.summaries || [];
    const cores = data.coreMemories || [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const isThisMonth = (x) => Number.isFinite(x.timestamp) && x.timestamp >= monthStart;
    return {
        summaryCount: summaries.length,
        coreCount: cores.length,
        importantCount: summaries.filter((x) => x.tier === "important").length,
        deprecatedSummaryCount: summaries.filter((x) => x.tier === "deprecated").length,
        deprecatedCoreCount: cores.filter((x) => x.deprecated).length,
        newThisMonth: summaries.filter(isThisMonth).length + cores.filter(isThisMonth).length,
        trashCount: getValidTrashItems().length,
    };
}

function updateDataStats() {
    const el = document.getElementById("mem-data-stats");
    if (!el) return;
    const st = computeMemoryStats();
    el.innerHTML = `
        <div class="mem-stats-grid">
            <div class="mem-stat-cell"><div class="mem-stat-num">${st.summaryCount}</div><div class="mem-stat-label">长期记忆</div></div>
            <div class="mem-stat-cell"><div class="mem-stat-num">${st.coreCount}</div><div class="mem-stat-label">核心记忆</div></div>
            <div class="mem-stat-cell"><div class="mem-stat-num">${st.newThisMonth}</div><div class="mem-stat-label">本月新增</div></div>
            <div class="mem-stat-cell"><div class="mem-stat-num">${st.trashCount}</div><div class="mem-stat-label">回收站</div></div>
        </div>
        <div class="mem-status-line mem-status-sub">
            <span>其中：重要 <b>${st.importantCount}</b> 条 · 已废弃（长期）<b>${st.deprecatedSummaryCount}</b> 条 · 已废弃（核心）<b>${st.deprecatedCoreCount}</b> 条</span>
        </div>
    `;
}

function saveChatData() {
    const context = getContext();
    try {
        if (typeof context.saveMetadataDebounced === "function") {
            context.saveMetadataDebounced();
        } else if (typeof saveChatConditional === "function") {
            saveChatConditional();
        }
    } catch (e) {
        console.error("[记忆总结助手] 保存聊天数据失败：", e);
    }
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    // 兼容旧版本缺字段的情况（包括本次新增的 wiPosition/wiDepth/wiRole）
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    // 迁移旧版本 injectPosition 的取值："IN_PROMPT"/"IN_CHAT" 是旧版仅有的两档，
    // 现在扩展为 4 档预设，需要把旧设置映射到对应的新值，不能让老用户的设置失效。
    const oldPositionMap = { IN_PROMPT: "main_after", IN_CHAT: "chat_top" };
    if (oldPositionMap[extension_settings[MODULE_NAME].injectPosition]) {
        extension_settings[MODULE_NAME].injectPosition = oldPositionMap[extension_settings[MODULE_NAME].injectPosition];
    }
    return extension_settings[MODULE_NAME];
}

function saveSettings() {
    saveSettingsDebounced();
}

// ------------------------ 工具函数 ------------------------

function toastInfo(msg, opts) {
    if (window.toastr) toastr.info(msg, "记忆总结助手", opts);
}
function toastSuccess(msg, opts) {
    if (window.toastr) toastr.success(msg, "记忆总结助手", opts);
}
function toastError(msg, opts) {
    if (window.toastr) toastr.error(msg, "记忆总结助手", opts);
}

// 从各种形态的错误对象里尽量提取出人能看懂的原因文本
function extractErrorReason(e) {
    if (!e) return "未知错误";
    if (typeof e === "string") return e;
    if (e.message) return e.message;
    try {
        return JSON.stringify(e);
    } catch {
        return String(e);
    }
}

function stripHtml(str) {
    return String(str || "").replace(/<[^>]*>/g, "").trim();
}

// 转义要塞进 innerHTML 模板里的文本（总结内容来自 AI/用户输入/导入文件，都不可信任），
// 防止内容里出现 </textarea>、<script> 等片段破坏面板或引发意外行为。
// 约定：本文件里所有拼 innerHTML 字符串模板时，凡是来自 AI/用户/文件的动态内容，
// 必须经过这个函数再拼进去；不允许出现 innerHTML = 未转义的动态内容。
function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// 把 content 套进用户自定义的模板里。用于：总结提示词、核心记忆提取提示词、
// 两种注入模板。统一走这一个函数，避免每处各写一套替换逻辑、行为不一致。
// 安全兜底：如果用户编辑模板时手滑删掉了 {{content}} 占位符，直接 replace 会导致
// 内容被静默丢弃（模板本身原样发出，AI 收不到任何实际内容却不会报错，很难发现）。
// 这里改为：找不到占位符时，把内容追加在模板末尾，保证内容永远不会丢，
// 只是提示词的措辞可能没有严格按用户预期的位置摆放。
function applyTemplate(template, content, placeholder = "{{content}}") {
    const t = String(template ?? "");
    if (t.includes(placeholder)) {
        return t.split(placeholder).join(content);
    }
    return t.trim() ? `${t}\n\n${content}` : content;
}

// 统一封装 generateQuietPrompt 的调用方式。
//
// 酒馆这个接口在较新版本里改成了"对象参数"写法：
//   generateQuietPrompt({ quietPrompt, quietToLoud, skipWIAN })
// 旧版本则是"位置参数"写法：
//   generateQuietPrompt(quietPrompt, quietToLoud, skipWIAN)
// 这两种写法互不兼容——如果按旧的位置参数写法，在新版酒馆上传一个纯字符串进去，
// 新版函数会尝试从这个字符串上解构出 quietPrompt 属性，字符串没有这个属性，
// 解构结果是 undefined，于是实际发给 AI 的"要总结的内容"直接丢失，
// 但函数本身并不会报错——AI 只会收到一个空提示词，往往就安静地返回空内容，
// 或者干脆顺着聊天内容随便续写几句，非常隐蔽，很容易被误判成"接口坏了"或"AI抽风"。
//
// 这里优先按新版对象参数调用；如果这次调用本身直接抛错（比较可能发生在
// 更旧版本的酒馆上，把对象当成字符串位置参数处理导致类型错误），
// 就退回旧版的位置参数写法再试一次，尽量兼容新旧两种酒馆版本。
async function callGenerateQuietPrompt(context, promptText) {
    try {
        return await context.generateQuietPrompt({
            quietPrompt: promptText,
            quietToLoud: false,
            skipWIAN: false,
        });
    } catch (e) {
        console.warn("[记忆总结助手] generateQuietPrompt 新版（对象参数）调用方式失败，尝试兼容旧版本酒馆的位置参数写法：", e);
        return await context.generateQuietPrompt(promptText, false, false);
    }
}

function formatMessagesForPrompt(messages) {
    return messages
        .filter((m) => !m.is_system && stripHtml(m.mes))
        .map((m) => `${m.name || (m.is_user ? "User" : "AI")}: ${stripHtml(m.mes)}`)
        .join("\n");
}

// 简单防抖：搜索框这类"输入即触发重渲染"的场景专用。
// 长期记忆/核心记忆列表多起来之后，每敲一个字就整表重新生成一次 innerHTML 会有明显卡顿，
// 等用户停下来（默认 200ms）再渲染一次，观感上仍然是"实时搜索"，但省掉了打字过程中间那些
// 立刻被下一次按键覆盖掉、白白重渲染的中间态。
function debounce(fn, wait = 200) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

function copyToClipboard(text, successMsg = "已复制到剪贴板") {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
            () => toastSuccess(successMsg),
            () => fallbackCopy(text, successMsg)
        );
    } else {
        fallbackCopy(text, successMsg);
    }
}

function fallbackCopy(text, successMsg) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand("copy");
        toastSuccess(successMsg);
    } catch (e) {
        toastError("复制失败，请手动选择文本复制");
    }
    document.body.removeChild(ta);
}

function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
}

// 触发浏览器下载一个 JSON 文件
function downloadJsonFile(filename, dataObj) {
    try {
        const json = JSON.stringify(dataObj, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        return true;
    } catch (e) {
        console.error("[记忆总结助手] 导出文件失败：", e);
        toastError(`导出失败：${extractErrorReason(e)}`);
        return false;
    }
}

// ------------------------ 通用确认/预览弹窗 ------------------------
// 用于"写入世界书前预览确认"和"导入数据前确认"等需要展示较多信息的场景，
// 不依赖酒馆内部的弹窗 API（不同版本可能没有/签名不同），完全自成一体，
// 不会因为酒馆更新而失效；点击遮罩层、按 Esc、点取消都视为"取消"。
//
// bodyHtml 由调用方负责把其中的动态内容用 escapeHtml 处理好之后再传入。
// onConfirm 可选：点击"确认"按钮时会同步调用，参数是弹窗内容区域的 DOM 节点，
// 可以在这里读取用户填的选项，返回值会成为 Promise 的 resolve 结果；
// 不传时确认按钮的 resolve 结果固定为 true。取消/关闭统一 resolve 为 false。
function showModal({ title, bodyHtml, confirmText = "确认", cancelText = "取消", showCancel = true, danger = false, onConfirm = null }) {
    return new Promise((resolve) => {
        let settled = false;
        const overlay = el(`<div class="mem-modal-overlay"></div>`);
        const modal = el(`
            <div class="mem-modal">
                <div class="mem-modal-title">${escapeHtml(title || "")}</div>
                <div class="mem-modal-body"></div>
                <div class="mem-modal-actions">
                    ${showCancel ? `<button type="button" class="menu_button mem-modal-cancel">${escapeHtml(cancelText)}</button>` : ""}
                    <button type="button" class="menu_button mem-modal-confirm ${danger ? "danger" : "mem-btn-primary"}">${escapeHtml(confirmText)}</button>
                </div>
            </div>
        `);
        const bodyEl = modal.querySelector(".mem-modal-body");
        bodyEl.innerHTML = bodyHtml || "";
        overlay.appendChild(modal);

        function cleanup(result) {
            if (settled) return;
            settled = true;
            document.removeEventListener("keydown", onKeydown);
            overlay.remove();
            resolve(result);
        }
        function onKeydown(e) {
            if (e.key === "Escape") cleanup(false);
        }
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) cleanup(false);
        });
        modal.querySelector(".mem-modal-confirm").addEventListener("click", () => {
            let result = true;
            if (typeof onConfirm === "function") {
                try {
                    result = onConfirm(bodyEl);
                } catch (e) {
                    console.error("[记忆总结助手] 弹窗确认回调出错：", e);
                    result = true;
                }
            }
            cleanup(result);
        });
        const cancelBtn = modal.querySelector(".mem-modal-cancel");
        if (cancelBtn) cancelBtn.addEventListener("click", () => cleanup(false));

        document.addEventListener("keydown", onKeydown);
        document.body.appendChild(overlay);
    });
}

// ------------------------ 拼装最终发给 AI 的提示词 ------------------------
// 如果开启了"风格参考"，会把最近 N 条旧摘要一起发给 AI，并明确告知
// 这些内容不需要重新总结，只是用来统一多次总结之间的写作风格/语气/剧情脉络。
// 旧摘要数据本身不会被这个函数修改。
// 注意：这里的"风格参考"是显式拼进 prompt 正文的旧摘要，跟"自动注入上下文"
// （通过 setExtensionPrompt 挂到聊天补全流程里的旧摘要）是两套独立机制，
// 后者在 runSummarization 里会在总结期间被临时清空，避免和这里重复。
function buildFinalPrompt(newContent) {
    const s = getSettings();
    const data = getChatData();
    let prefix = "";

    if (s.includeStyleReference && s.styleReferenceCount > 0 && data.summaries.length > 0) {
        const refs = data.summaries.slice(-s.styleReferenceCount);
        const refText = refs.map((r, i) => `${i + 1}. ${r.content}`).join("\n");
        prefix =
            "【以下是之前已经生成好的剧情摘要，仅供你参考摘要的写作风格、语气和剧情脉络，" +
            "不需要总结、复述或修改这部分内容，也不要把它们写进你的输出里，" +
            "它们只是用来帮助你和之前保持统一的摘要风格】：\n" +
            refText +
            "\n\n【下面才是需要你总结的新内容，请只输出这段新内容对应的摘要正文】：\n\n";
    }

    return prefix + applyTemplate(s.promptTemplate, newContent);
}

// ------------------------ 核心：生成总结 ------------------------

async function runSummarization(manual = false) {
    const settings = getSettings();
    const context = getContext();
    const chat = context.chat || [];
    const data = getChatData();

    // 这里到下面 `isSummarizing = true` 之间全部是同步代码，没有任何 await，
    // JS 单线程执行不会在中间被打断，所以即使 MESSAGE_SENT / MESSAGE_RECEIVED
    // 几乎同时触发，也不会出现两次总结同时跑、重复消耗 token 的竞态问题。
    if (isSummarizing) {
        if (manual) toastInfo("已有一次总结正在进行中，请稍候…");
        return;
    }

    const startIdx = data.lastSummarizedIndex;
    const pending = chat.length - startIdx;

    if (pending <= 0) {
        if (manual) toastInfo("没有新的对话可以总结");
        return;
    }
    if (!manual && pending < settings.messagesPerSummary) {
        return; // 还没攒够条数，自动模式下先不触发
    }

    // 手动总结：一次性总结全部积压的新内容。
    // 自动总结：固定按"设定条数"分块，避免积压很多消息时一次性把全部内容塞给 AI。
    // 如果积压超过一块，剩余部分会在下一次消息事件触发时继续处理；
    // 也可以随时点"立即总结"手动把剩余积压一次清空。
    const endIdx = manual
        ? chat.length
        : Math.min(chat.length, startIdx + settings.messagesPerSummary);

    const slice = chat.slice(startIdx, endIdx);
    const content = formatMessagesForPrompt(slice);

    if (!content) {
        data.lastSummarizedIndex = endIdx;
        saveChatData();
        toastInfo("这段对话没有可提取的文本内容（可能都是系统/空消息），已跳过");
        renderPanel();
        return;
    }

    isSummarizing = true;
    setRunButtonLoading(true);

    const backlogNote =
        !manual && pending > settings.messagesPerSummary
            ? `（共有 ${pending} 条待总结，本次先处理 ${endIdx - startIdx} 条，剩余会继续自动处理）`
            : "";
    toastInfo(
        manual
            ? `正在生成总结（消息 ${startIdx + 1}-${endIdx}）…`
            : `已达到自动总结条数，开始生成总结…${backlogNote}`
    );

    // 记录当前聊天的唯一标识，用于总结完成后校验用户是否已经切换到别的聊天。
    // 注意：context.chat 是原地可变的数组（切聊天时清空重填，引用地址不变），
    // 不能用数组引用来判断是否切换了聊天，必须用 chatId。
    const chatIdSnapshot = context.chatId;

    // 总结这次新内容之前，先清空本插件自己的 extension prompt 注入槽位。
    // 原因：如果开着"自动注入"，这个槽位里正放着"最近几条摘要"；而 generateQuietPrompt
    // 走的是酒馆同一套 prompt 组装逻辑，并不会因为是"安静生成"就自动跳过它——
    // 如果不清空，等于总结这次新内容时又把旧摘要额外喂给 AI 一次，
    // 白白多花 token，也污染了这次总结本身的输入。
    // 总结流程结束后（成功/失败/中途切换聊天都算）在 finally 里用 updateInjection()
    // 按当前设置重新计算一遍，恢复成正常聊天时该有的注入内容，不影响之后的对话。
    context.setExtensionPrompt(MODULE_NAME, "", extension_prompt_types.IN_PROMPT, 0);

    try {
        if (typeof context.generateQuietPrompt !== "function") {
            throw new Error("当前酒馆版本未找到 generateQuietPrompt 接口，可能与本扩展不兼容");
        }

        const prompt = buildFinalPrompt(content);
        const result = await callGenerateQuietPrompt(context, prompt);

        const freshContext = getContext();
        if (freshContext.chatId !== chatIdSnapshot) {
            toastInfo("总结已生成，但聊天已被切换，本次结果已放弃，请回到原聊天后重新总结");
            return;
        }

        const trimmed = String(result || "").trim();
        if (!trimmed) {
            throw new Error("AI 返回了空内容，可能是接口异常、超时或内容被过滤");
        }

        const entry = {
            id: `${Date.now()}`,
            time: new Date().toLocaleString(), // 这条摘要真实的生成完成时间，用于条目右上角显示
            timestamp: Date.now(),             // 数字时间戳，用于时间筛选（locale 字符串在部分浏览器下无法被 Date 解析回去）
            range: [startIdx, endIdx],
            content: trimmed,
            auto: !manual,
            source: "auto",  // 内容始终由 AI 总结生成（不管触发方式是自动还是手动点的"立即总结"）
            tier: "normal",  // 分级：important / normal / deprecated，默认普通
        };
        data.summaries.push(entry); // 新条目始终追加在数组末尾（旧条目下方）
        data.lastSummarizedIndex = endIdx;
        lastAddedSummaryId = entry.id; // 下次 renderPanel() 时给这条播放一次入场动画
        saveChatData();

        // 总结完成后重置手动提醒计数，下一轮积累达到条数时会重新提醒
        manualReminderCount = 0;

        toastSuccess(`${manual ? "手动" : "自动"}总结完成（消息 ${startIdx + 1}-${endIdx}）`);
    } catch (e) {
        console.error("[记忆总结助手] 生成总结失败：", e);
        toastError(`总结失败：${extractErrorReason(e)}`, { timeOut: 8000, extendedTimeOut: 4000 });
    } finally {
        isSummarizing = false;
        setRunButtonLoading(false);
        // 无论成功/失败/中途切换聊天，都要把注入槽位恢复成当前设置该有的样子，
        // 避免出现"总结时清空了、结果没人给它设回去"的注入丢失问题。
        updateInjection();
        renderPanel();
    }
}

// ------------------------ 自动注入到上下文 ------------------------

// 把面板里的 4 档位置预设，翻译成酒馆 setExtensionPrompt 需要的 {type, depth}。
// main_before / main_after 对应酒馆的 BEFORE_PROMPT / IN_PROMPT，depth 对这两种类型无意义，固定传 0。
// chat_top / chat_bottom 都对应 IN_CHAT（聊天记录中按深度插入）：
//   chat_bottom 固定深度 0（紧邻"即将生成的回复"之前，即聊天记录末尾）；
//   chat_top 使用用户在面板里设置的 injectDepth（越大越靠聊天记录前面）。
// 兼容性兜底：BEFORE_PROMPT 是酒馆较新版本才有的类型，如果当前酒馆版本没有这个常量
// （extension_prompt_types.BEFORE_PROMPT 为 undefined），退回到 IN_PROMPT，不让注入直接失效。
function resolveInjectPositionType(positionKey) {
    const beforePrompt = extension_prompt_types.BEFORE_PROMPT ?? extension_prompt_types.IN_PROMPT;
    switch (positionKey) {
        case "main_before": return beforePrompt;
        case "chat_top":
        case "chat_bottom": return extension_prompt_types.IN_CHAT;
        case "main_after":
        default: return extension_prompt_types.IN_PROMPT;
    }
}
function resolveInjectDepth(positionKey, depthSetting) {
    if (positionKey === "chat_top") return Number.isFinite(depthSetting) ? depthSetting : 0;
    return 0; // main_before / main_after / chat_bottom 都固定为 0（后两者类型本身就不需要深度）
}

function updateInjection() {
    const settings = getSettings();
    const context = getContext();
    const data = getChatData();

    if (!settings.autoInject) {
        context.setExtensionPrompt(MODULE_NAME, "", extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    // 注入时遵循各自的显示顺序设置（核心记忆现在也支持拖拽调整顺序，
    // 所以和长期记忆一样，"最近 N 条"要按当前排序设置来取，而不是总取存储数组的末尾，
    // 否则用户手动拖拽调整过顺序后，注入的条目会和面板上看到的顺序对不上）。
    // 已标记"废弃"的条目直接排除在外——这是废弃标记存在的核心意义：不再喂给 AI，
    // 但仍然保留在列表里，随时可以取消废弃、恢复注入。
    const orderedCore = getOrderedCores((data.coreMemories || []).filter((x) => !x.deprecated));
    const recentCore = orderedCore.slice(0, settings.coreInjectCount);
    const orderedSummary = getOrderedSummaries(data.summaries.filter((x) => x.tier !== "deprecated"));
    const recentSummary = orderedSummary.slice(0, settings.injectCount);

    if (recentCore.length === 0 && recentSummary.length === 0) {
        context.setExtensionPrompt(MODULE_NAME, "", extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    // 核心记忆和长期记忆分别合并为一整块（每条一行），再各自套进专属的注入模板里——
    // 保证同一类记忆永远只被自己的模板包一次，不会出现"记忆条目分散、模板触发多次"的情况。
    const parts = [];
    if (recentCore.length > 0) {
        const coreContent = recentCore.map((c) => `- ${c.content}`).join("\n");
        parts.push(applyTemplate(settings.injectTemplateCore, coreContent, "{{memories}}"));
    }
    if (recentSummary.length > 0) {
        const summaryContent = recentSummary.map((s) => `- ${s.content}`).join("\n");
        parts.push(applyTemplate(settings.injectTemplateSummary, summaryContent, "{{memories}}"));
    }
    const combined = parts.join("\n\n");

    const roleMap = {
        system: extension_prompt_roles.SYSTEM,
        user: extension_prompt_roles.USER,
        assistant: extension_prompt_roles.ASSISTANT,
    };

    context.setExtensionPrompt(
        MODULE_NAME,
        combined,
        resolveInjectPositionType(settings.injectPosition),
        resolveInjectDepth(settings.injectPosition, settings.injectDepth),
        false,
        roleMap[settings.injectRole] ?? extension_prompt_roles.SYSTEM
    );
}

// ------------------------ 核心记忆总结 ------------------------

async function runCoreSummarization(selectedIds) {
    const context = getContext();
    const settings = getSettings();
    const data = getChatData();

    if (isSummarizing) {
        toastInfo("已有一次总结正在进行中，请稍候…");
        return;
    }
    if (!selectedIds || selectedIds.length === 0) {
        toastInfo("请先勾选要提取核心记忆的长期记忆条目");
        return;
    }

    const selectedEntries = data.summaries.filter((s) => selectedIds.includes(s.id));
    if (selectedEntries.length === 0) {
        toastInfo("所选条目已不存在");
        return;
    }

    const combinedContent = selectedEntries.map((s) => s.content).join("\n\n");
    if (!combinedContent.trim()) {
        toastInfo("所选条目内容为空");
        return;
    }

    isSummarizing = true;
    const coreSumBtn = document.getElementById("mem-core-summarize-btn");
    if (coreSumBtn) {
        coreSumBtn.disabled = true;
        coreSumBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 提取中…';
    }

    const chatIdSnapshot = context.chatId;
    context.setExtensionPrompt(MODULE_NAME, "", extension_prompt_types.IN_PROMPT, 0);

    try {
        if (typeof context.generateQuietPrompt !== "function") {
            throw new Error("当前酒馆版本未找到 generateQuietPrompt 接口");
        }

        const prompt = applyTemplate(settings.corePromptTemplate, combinedContent);
        const result = await callGenerateQuietPrompt(context, prompt);

        const freshContext = getContext();
        if (freshContext.chatId !== chatIdSnapshot) {
            toastInfo("聊天已被切换，核心记忆提取结果已放弃");
            return;
        }

        const trimmed = String(result || "").trim();
        if (!trimmed) {
            throw new Error("AI 返回了空内容");
        }

        // 生成核心记忆条目
        const coreEntry = {
            id: `core-${Date.now()}`,
            time: new Date().toLocaleString(),
            timestamp: Date.now(),
            content: trimmed,
            sourceIds: selectedIds.slice(),
            source: "extracted", // 从长期记忆 AI 提取生成
        };
        if (!data.coreMemories) data.coreMemories = [];
        data.coreMemories.push(coreEntry);
        lastAddedCoreId = coreEntry.id; // 下次 renderCoreMemories() 时给这条播放一次入场动画

        // 弹窗询问：已提取核心的长期记忆是保留还是删除
        const keepConfirmed = await showModal({
            title: "核心记忆提取完成",
            bodyHtml: `
                <div class="mem-modal-line">已从 ${selectedEntries.length} 条长期记忆中提取出核心记忆。</div>
                <div class="mem-modal-line" style="margin-top:8px"><b>核心记忆内容预览：</b></div>
                <textarea class="mem-preview-textarea" readonly>${escapeHtml(trimmed)}</textarea>
                <div class="mem-modal-line" style="margin-top:10px">对这 ${selectedEntries.length} 条原始长期记忆，你想怎么处理？</div>
                <div class="mem-modal-line">• <b>保留</b>：把它们合并为一条，放在最旧的记忆后面</div>
                <div class="mem-modal-line">• <b>删除</b>：直接移除这些长期记忆（总结进度不受影响）</div>
            `,
            confirmText: "保留（合并）",
            cancelText: "删除",
            showCancel: true,
            danger: false,
        });

        if (keepConfirmed) {
            // 保留：合并为一条，放在最旧记忆后面（即 summaries 数组最前面）
            const mergedContent = selectedEntries.map((s) => s.content).join("\n");
            const mergedEntry = {
                id: `merged-${Date.now()}`,
                time: new Date().toLocaleString(),
                timestamp: Date.now(),
                range: [
                    Math.min(...selectedEntries.map((s) => s.range?.[0] ?? 0)),
                    Math.max(...selectedEntries.map((s) => s.range?.[1] ?? 0)),
                ],
                content: mergedContent,
                auto: false,
                source: "merged", // 已提取核心的原始条目合并生成
                tier: "normal",
            };
            // 移除原始条目
            data.summaries = data.summaries.filter((s) => !selectedIds.includes(s.id));
            // 插入到数组最前面（最旧的位置）
            data.summaries.unshift(mergedEntry);
        } else {
            // 删除：直接移除原始条目，lastSummarizedIndex 不变
            data.summaries = data.summaries.filter((s) => !selectedIds.includes(s.id));
        }

        // 这些 id 已经被消费（合并或删除），把它们从"已勾选"记忆里清掉，
        // 避免残留在 selectedForCoreIds 里（虽然无害，但保持状态干净）
        for (const id of selectedIds) selectedForCoreIds.delete(id);

        saveChatData();
        toastSuccess("核心记忆提取完成");
    } catch (e) {
        console.error("[记忆总结助手] 核心记忆提取失败：", e);
        toastError(`核心记忆提取失败：${extractErrorReason(e)}`, { timeOut: 8000 });
    } finally {
        isSummarizing = false;
        if (coreSumBtn) {
            coreSumBtn.disabled = false;
            coreSumBtn.innerHTML = '<i class="fa-solid fa-gem"></i> 从选中的长期记忆提取核心';
        }
        updateInjection();
        renderPanel();
    }
}

// ------------------------ 写入世界书 ------------------------

// 位置枚举键名 -> 中文说明。键名以当前酒馆版本实际导出的 world_info_position
// 对象为准动态探测，这里的表只是用来把常见键名翻译成好读的中文；
// 探测到了但表里没有的键名会直接显示原始键名，不会因为翻译表没覆盖到就出错。
const WI_POSITION_LABELS = {
    before: "角色定义之前（Before Char）",
    after: "角色定义之后（After Char）",
    EMTop: "示例对话之前（Before Example Msgs）",
    EMBottom: "示例对话之后（After Example Msgs）",
    ANTop: "作者注释顶部（Top of AN）",
    ANBottom: "作者注释底部（Bottom of AN）",
    atDepth: "指定深度（@Depth）",
    outlet: "输出插槽（Outlet）",
};

function populateWiPositionSelect() {
    const select = document.getElementById("mem-wi-position");
    if (!select) return;
    const s = getSettings();
    select.innerHTML = "";

    const posObj = WI_API?.world_info_position;
    if (!posObj || typeof posObj !== "object" || Object.keys(posObj).length === 0) {
        select.appendChild(el(`<option value="">（当前酒馆版本不支持选择写入位置，将使用世界书默认位置）</option>`));
        select.disabled = true;
        return;
    }

    select.disabled = false;
    const keys = Object.keys(posObj);
    for (const key of keys) {
        const label = WI_POSITION_LABELS[key] || key;
        select.appendChild(el(`<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`));
    }
    if (keys.includes(s.wiPosition)) {
        select.value = s.wiPosition;
    } else {
        // 存的设置在当前版本里找不到对应位置（比如换了台设备、换了酒馆版本），
        // 自动回退到第一个可用位置，而不是报错或者保持一个无效的空值。
        s.wiPosition = keys[0];
        select.value = keys[0];
        saveSettings();
    }
}

function toggleWiAtDepthRow() {
    const row = document.getElementById("mem-wi-atdepth-row");
    const select = document.getElementById("mem-wi-position");
    if (!row || !select) return;
    row.style.display = select.value === "atDepth" ? "flex" : "none";
}

// 注入位置的深度/角色行，只有选中 Chat History↑/↓ 两档时才有意义（Main Prompt↑/↓ 不涉及深度）。
// 深度数字本身只对 Chat History↑ 生效，Chat History↓ 固定深度为 0（见 resolveInjectDepth），
// 这里额外把输入框在 Chat History↓ 时禁用掉，避免用户误以为改这个数字有效果。
function toggleInjectPositionSubrow() {
    const row = document.getElementById("mem-inject-subrow");
    const select = document.getElementById("mem-inject-pos");
    const depthInput = document.getElementById("mem-inject-depth");
    if (!row || !select) return;
    const isChatBased = select.value === "chat_top" || select.value === "chat_bottom";
    row.style.display = isChatBased ? "flex" : "none";
    if (depthInput) depthInput.disabled = select.value !== "chat_top";
}

async function writeToWorldInfo(bookName, content, keysStr, positionKey, depth, role) {
    if (!WI_API) {
        toastError("世界书接口未加载成功，无法直接写入，请使用复制按钮手动粘贴");
        return false;
    }
    try {
        const data = await WI_API.loadWorldInfo(bookName);
        if (!data) {
            toastError("找不到该世界书，请先在酒馆里创建/选择一个世界书");
            return false;
        }
        const entry = WI_API.createWorldInfoEntry(bookName, data);
        const keys = (keysStr || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        entry.comment = `AI记忆总结 ${new Date().toLocaleString()}`;
        entry.content = content;
        entry.key = keys;
        entry.constant = keys.length === 0; // 没填关键词就设为常驻条目

        // 只有当前版本真的支持这个位置键名时才去设置，找不到就保持世界书自己的默认值，
        // 绝不往条目里塞一个凭空猜的数值把条目写坏。
        const posObj = WI_API.world_info_position;
        if (posObj && positionKey && posObj[positionKey] !== undefined) {
            entry.position = posObj[positionKey];
            if (positionKey === "atDepth") {
                if (Number.isFinite(depth)) entry.depth = depth;
                const roleMap = {
                    system: extension_prompt_roles.SYSTEM,
                    user: extension_prompt_roles.USER,
                    assistant: extension_prompt_roles.ASSISTANT,
                };
                if (roleMap[role] !== undefined) entry.role = roleMap[role];
            }
        }

        await WI_API.saveWorldInfo(bookName, data, true);
        toastSuccess(`已写入世界书《${bookName}》`);
        return true;
    } catch (e) {
        console.error("[记忆总结助手] 写入世界书失败：", e);
        toastError(
            `写入世界书失败：${extractErrorReason(e)}（可改用复制按钮手动粘贴）`,
            { timeOut: 8000, extendedTimeOut: 4000 }
        );
        return false;
    }
}

// 写入世界书 / 自动注入到上下文，两者都会把同一份"合并 + 模板包裹"的记忆内容喂给 AI。
// 如果两个都开着，AI 会在一次生成里看到两份重复的记忆（一份在预设里、一份在世界书里），
// 白白多花 token 还可能让 AI 犯迷糊，所以两者互斥：开着"自动注入到上下文"时，
// 写入世界书的两个按钮会被禁用，并显示提示，引导用户先关掉自动注入。
function updateWiWriteAvailability() {
    const settings = getSettings();
    const disabled = !!settings.autoInject;
    const btnSummary = document.getElementById("mem-wi-write-summary");
    const btnCore = document.getElementById("mem-wi-write-core");
    const hint = document.getElementById("mem-wi-disabled-hint");
    if (btnSummary) btnSummary.disabled = disabled;
    if (btnCore) btnCore.disabled = disabled;
    if (hint) hint.style.display = disabled ? "" : "none";
    return disabled;
}

// 点击"写入长期记忆"/"写入核心记忆"按钮的入口：把该类全部记忆合并成一条、
// 套上专属注入模板，预览确认后作为一条新的世界书条目写入。
// kind: "summary"（长期记忆）| "core"（核心记忆）
async function writeMergedMemoryToWorldInfo(kind, triggerBtn) {
    const s = getSettings();
    if (s.autoInject) {
        toastError('已开启"自动注入到上下文"，请先在"注入设置"里关闭它，再使用写入世界书功能，避免同一份记忆被重复喂给 AI');
        return;
    }
    const bookSelect = document.getElementById("mem-wi-book");
    const bookName = bookSelect?.value;
    if (!bookName) {
        toastError("请先选择一个世界书");
        return;
    }

    const data = getChatData();
    const isCore = kind === "core";
    const rawList = isCore
        ? (data.coreMemories || []).filter((x) => !x.deprecated)
        : data.summaries.filter((x) => x.tier !== "deprecated");
    if (rawList.length === 0) {
        toastInfo(isCore ? "当前没有可写入的核心记忆（可能全部已标记废弃）" : "当前没有可写入的长期记忆（可能全部已标记废弃）");
        return;
    }

    const ordered = isCore ? getOrderedCores(rawList) : getOrderedSummaries(rawList);
    const merged = ordered.map((x) => `- ${x.content}`).join("\n");
    const template = isCore ? s.injectTemplateCore : s.injectTemplateSummary;
    const finalContent = applyTemplate(template, merged, "{{memories}}");

    const keysInput = document.getElementById(isCore ? "mem-wi-keys-core" : "mem-wi-keys-summary");
    const keys = (keysInput?.value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

    const posObj = WI_API?.world_info_position;
    const positionLabel =
        posObj && s.wiPosition && posObj[s.wiPosition] !== undefined
            ? (WI_POSITION_LABELS[s.wiPosition] || s.wiPosition)
            : "（世界书默认位置）";

    const bodyHtml = `
        <div class="mem-modal-line">目标世界书：<b>${escapeHtml(bookName)}</b></div>
        <div class="mem-modal-line">插入位置：${escapeHtml(positionLabel)}</div>
        <div class="mem-modal-line">关键词：${keys.length ? escapeHtml(keys.join("、")) : "（留空，将设为常驻条目）"}</div>
        <div class="mem-modal-line">已合并 <b>${ordered.length}</b> 条${isCore ? "核心记忆" : "长期记忆"}，用${isCore ? "核心记忆" : "长期记忆"}注入模板包裹后，共 ${finalContent.length} 字：</div>
        <textarea class="mem-preview-textarea" readonly>${escapeHtml(finalContent)}</textarea>
        <div class="mem-modal-line" style="margin-top:10px">⚠️ 这会创建一条<b>新的</b>世界书条目，不会更新或覆盖已有条目。如果你之前已经写入过，请记得去世界书里手动删除旧的那一条，避免同一份记忆重复存在、越堆越多，也避免 AI 看到自相矛盾的新旧版本。</div>
    `;

    if (triggerBtn) triggerBtn.disabled = true;
    try {
        const confirmed = await showModal({
            title: `写入${isCore ? "核心" : "长期"}记忆到世界书前确认`,
            bodyHtml,
            confirmText: "确认写入",
            cancelText: "取消",
        });
        if (!confirmed) return;

        await writeToWorldInfo(bookName, finalContent, keysInput?.value, s.wiPosition, s.wiDepth, s.wiRole);
    } catch (e) {
        // 兜底：理论上 writeToWorldInfo 自己已经 try/catch 过了，这里只是双保险，
        // 防止 showModal 的 onConfirm 逻辑本身出意外时变成未处理的 Promise 拒绝。
        console.error("[记忆总结助手] 写入世界书流程异常：", e);
        toastError(`写入世界书失败：${extractErrorReason(e)}`);
    } finally {
        if (triggerBtn) triggerBtn.disabled = updateWiWriteAvailability();
    }
}

// ------------------------ 事件：监听新消息，自动计数 ------------------------

async function onChatEvent() {
    try {
        const settings = getSettings();
        if (!settings.autoSummarize) {
            checkManualReminder();
            renderPanel();
            return;
        }
        await runSummarization(false);
        renderPanel();
    } catch (e) {
        console.error("[记忆总结助手] 自动总结流程异常：", e);
        try { renderPanel(); } catch (_) { /* 渲染面板失败不再冒泡 */ }
    }
}

function checkManualReminder() {
    const settings = getSettings();
    const context = getContext();
    const data = getChatData();
    const total = (context.chat || []).length;
    const pending = total - data.lastSummarizedIndex;
    const threshold = settings.messagesPerSummary;

    // 只在两个节点提醒：刚好达到设定条数时（第 1 次）、超出 5 条时（第 2 次）
    // 之后不再提醒，直到用户完成一次总结后 manualReminderCount 被重置
    if (manualReminderCount >= 2) return;

    if (manualReminderCount === 0 && pending >= threshold) {
        manualReminderCount = 1;
        toastInfo(
            `已积累 ${pending} 条待总结消息（设定每 ${threshold} 条总结一次），建议点击"立即总结"整理记忆`,
            { timeOut: 8000, extendedTimeOut: 3000 }
        );
    } else if (manualReminderCount === 1 && pending >= threshold + 5) {
        manualReminderCount = 2;
        toastInfo(
            `待总结消息已达 ${pending} 条，超出设定条数较多，建议尽快手动总结，避免遗忘过多细节`,
            { timeOut: 8000, extendedTimeOut: 3000 }
        );
    }
}

// 消息被删除时，把总结进度指针夹回合法范围，避免出现负数待总结数导致的卡死状态。
// 局限说明：如果被删除的是较早、已经计入过总结范围的消息，摘要内容和实际消息之间
// 的对应关系会出现偏差——这是基于消息下标做进度追踪的固有局限，
// 目前没有做逐条消息级别的精确追踪（成本远大于收益，此处如实说明而非掩盖）。
function onMessageDeleted() {
    try {
        const context = getContext();
        const data = getChatData();
        const total = (context.chat || []).length;
        if (data.lastSummarizedIndex > total) {
            data.lastSummarizedIndex = total;
            saveChatData();
        }
        renderPanel();
    } catch (e) {
        console.error("[记忆总结助手] 处理消息删除事件异常：", e);
    }
}

// ------------------------ 导入 / 导出 ------------------------

function exportData() {
    try {
        const context = getContext();
        const data = getChatData();
        const settings = getSettings();
        const payload = {
            schema: 1,
            moduleName: MODULE_NAME,
            exportedAt: new Date().toISOString(),
            chatId: context.chatId ?? null,
            chatData: {
                lastSummarizedIndex: data.lastSummarizedIndex,
                summaries: data.summaries,
                coreMemories: data.coreMemories || [],
            },
            settings: structuredClone(settings),
        };
        const safeName = String(context.chatId ?? "chat").replace(/[^a-zA-Z0-9_-]+/g, "_");
        const filename = `memory-summarizer-${safeName}-${Date.now()}.json`;
        if (downloadJsonFile(filename, payload)) {
            toastSuccess("已导出记忆数据");
        }
    } catch (e) {
        console.error("[记忆总结助手] 导出失败：", e);
        toastError(`导出失败：${extractErrorReason(e)}`);
    }
}

async function importDataFromFile(file) {
    const importBtn = document.getElementById("mem-import-btn");
    if (importBtn) importBtn.disabled = true;
    try {
        let text;
        try {
            text = await file.text();
        } catch (e) {
            toastError(`读取文件失败：${extractErrorReason(e)}`);
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            toastError("导入失败：文件不是合法的 JSON");
            return;
        }
        if (!parsed || typeof parsed !== "object") {
            toastError("导入失败：文件内容格式不正确");
            return;
        }

        const rawSummaries = Array.isArray(parsed?.chatData?.summaries) ? parsed.chatData.summaries : [];
        const validSummaries = rawSummaries.filter((x) => x && typeof x.content === "string" && x.content.trim());
        const skipped = rawSummaries.length - validSummaries.length;
        const rawCores = Array.isArray(parsed?.chatData?.coreMemories) ? parsed.chatData.coreMemories : [];
        const validCores = rawCores.filter((x) => x && typeof x.content === "string" && x.content.trim());
        const hasSettings = !!(parsed.settings && typeof parsed.settings === "object");

        if (validSummaries.length === 0 && validCores.length === 0 && !hasSettings) {
            toastError("导入失败：文件中没有可识别的摘要、核心记忆或设置数据");
            return;
        }

        const bodyHtml = `
            <div class="mem-modal-line">来源聊天：${escapeHtml(String(parsed.chatId ?? "未知"))}</div>
            <div class="mem-modal-line">导出时间：${escapeHtml(String(parsed.exportedAt ?? "未知"))}</div>
            <div class="mem-modal-line">检测到 <b>${validSummaries.length}</b> 条有效摘要${skipped ? `（另有 ${skipped} 条格式异常，会被跳过）` : ""}</div>
            <div class="mem-modal-line">检测到 <b>${validCores.length}</b> 条核心记忆</div>
            <div class="mem-modal-line">${hasSettings ? "检测到插件设置数据" : "未检测到插件设置数据"}</div>
            <label class="mem-modal-check">
                <input type="checkbox" id="mem-import-chk-summaries" ${validSummaries.length ? "checked" : "disabled"}/>
                导入摘要（追加到当前聊天已有摘要之后，不会覆盖/删除现有摘要）
            </label>
            <label class="mem-modal-check">
                <input type="checkbox" id="mem-import-chk-cores" ${validCores.length ? "checked" : "disabled"}/>
                导入核心记忆（追加到当前聊天已有核心记忆之后）
            </label>
            <label class="mem-modal-check">
                <input type="checkbox" id="mem-import-chk-settings" ${hasSettings ? "checked" : "disabled"}/>
                导入插件设置（会覆盖当前的提示词模板、总结条数等设置，注意导入前请确认）
            </label>
        `;

        const result = await showModal({
            title: "导入记忆数据确认",
            bodyHtml,
            confirmText: "确认导入",
            cancelText: "取消",
            onConfirm: (bodyEl) => ({
                importSummaries: !!bodyEl.querySelector("#mem-import-chk-summaries")?.checked,
                importCores: !!bodyEl.querySelector("#mem-import-chk-cores")?.checked,
                importSettings: !!bodyEl.querySelector("#mem-import-chk-settings")?.checked,
            }),
        });
        if (!result) return; // 用户取消

        let importedCoreCount = 0;
        if (result.importCores && validCores.length > 0) {
            const data = getChatData();
            if (!data.coreMemories) data.coreMemories = [];
            const existingIds = new Set(data.coreMemories.map((x) => x.id));
            for (const raw of validCores) {
                let id = typeof raw.id === "string" && raw.id ? raw.id : `core-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                while (existingIds.has(id)) {
                    id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
                }
                existingIds.add(id);
                data.coreMemories.push({
                    id,
                    time: typeof raw.time === "string" && raw.time ? raw.time : new Date().toLocaleString(),
                    timestamp: Number.isFinite(raw.timestamp) ? raw.timestamp : undefined,
                    content: String(raw.content),
                    sourceIds: Array.isArray(raw.sourceIds) ? raw.sourceIds : [],
                    source: SOURCE_LABELS[raw.source] ? raw.source : undefined,
                    deprecated: !!raw.deprecated,
                });
                importedCoreCount++;
            }
            saveChatData();
        }

        let importedCount = 0;
        if (result.importSummaries && validSummaries.length > 0) {
            const data = getChatData();
            const existingIds = new Set(data.summaries.map((x) => x.id));
            for (const raw of validSummaries) {
                let id = typeof raw.id === "string" && raw.id ? raw.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                while (existingIds.has(id)) {
                    id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
                }
                existingIds.add(id);
                data.summaries.push({
                    id,
                    time: typeof raw.time === "string" && raw.time ? raw.time : new Date().toLocaleString(),
                    timestamp: Number.isFinite(raw.timestamp) ? raw.timestamp : undefined,
                    range: Array.isArray(raw.range) && raw.range.length === 2 ? raw.range : [0, 0],
                    content: String(raw.content),
                    auto: !!raw.auto,
                    source: SOURCE_LABELS[raw.source] ? raw.source : undefined,
                    tier: ["important", "normal", "deprecated"].includes(raw.tier) ? raw.tier : "normal",
                });
                importedCount++;
            }
            // 导入摘要不会改动 lastSummarizedIndex，避免打乱当前聊天自己的总结进度。
            saveChatData();
        }

        let settingsImported = false;
        if (result.importSettings && hasSettings) {
            const s = getSettings();
            // 只按白名单（defaultSettings 里已有的字段）拷贝，防止导入文件里混入
            // 未知/多余字段污染设置对象。
            for (const key of Object.keys(defaultSettings)) {
                if (parsed.settings[key] !== undefined) {
                    s[key] = parsed.settings[key];
                }
            }
            saveSettings();
            syncSettingsToForm();
            settingsImported = true;
        }

        updateInjection();
        renderPanel();
        toastSuccess(
            `导入完成：${importedCount ? `新增 ${importedCount} 条摘要` : "未导入摘要"}${importedCoreCount ? `，新增 ${importedCoreCount} 条核心记忆` : ""}${settingsImported ? "，已更新插件设置" : ""}`
        );
    } finally {
        if (importBtn) importBtn.disabled = false;
    }
}

// 导入设置后，把当前设置值同步回面板上所有输入控件的显示（面板本身只在初始化时渲染一次，
// 直接改 settings 对象不会自动更新已经在页面上的 input/select 的值，需要手动同步）。
function syncSettingsToForm() {
    const s = getSettings();
    const setVal = (id, val) => {
        const node = document.getElementById(id);
        if (node) node.value = val;
    };
    const setChecked = (id, val) => {
        const node = document.getElementById(id);
        if (node) node.checked = !!val;
    };

    setVal("mem-count", s.messagesPerSummary);
    setChecked("mem-auto", s.autoSummarize);
    setVal("mem-prompt", s.promptTemplate);
    setChecked("mem-style-ref", s.includeStyleReference);
    setVal("mem-style-ref-n", s.styleReferenceCount);
    setVal("mem-summary-warn-threshold", s.summaryWarnThreshold);
    setVal("mem-core-warn-threshold", s.coreWarnThreshold);
    setChecked("mem-inject", s.autoInject);
    setVal("mem-inject-pos", s.injectPosition);
    setVal("mem-inject-depth", s.injectDepth);
    setVal("mem-inject-role", s.injectRole);
    setVal("mem-inject-n", s.injectCount);
    setVal("mem-inject-template-summary", s.injectTemplateSummary);
    setVal("mem-inject-template-core", s.injectTemplateCore);
    setVal("mem-wi-depth", s.wiDepth);
    setVal("mem-wi-role", s.wiRole);
    setVal("mem-core-prompt", s.corePromptTemplate);
    setVal("mem-core-inject-n", s.coreInjectCount);
    setVal("mem-filter-time", s.filterTimeRange);
    setVal("mem-filter-min", s.filterMinChars);
    setVal("mem-filter-max", s.filterMaxChars);
    setVal("mem-filter-tier", s.filterTier);
    setVal("mem-core-filter-time", s.coreFilterTimeRange);
    setVal("mem-core-filter-min", s.coreFilterMinChars);
    setVal("mem-core-filter-max", s.coreFilterMaxChars);
    setChecked("mem-core-hide-deprecated", s.coreHideDeprecated);
    updateOrderToggleButton("mem-order-toggle", s.summaryOrder);
    updateOrderToggleButton("mem-core-order-toggle", s.coreOrder);
    populateWorldBookSelect();
    populateWiPositionSelect();
    toggleWiAtDepthRow();
    toggleInjectPositionSubrow();
    updateWiWriteAvailability();
}

// ------------------------ UI 渲染 ------------------------

// 折叠分组 key -> 对应 settings 里记录展开/收起状态的字段名。
// 新增分组时只需要在这里加一行映射，加载/持久化逻辑不用改。
const SECTION_SETTING_KEYS = {
    summary: "sectionOpenSummary",
    inject: "sectionOpenInject",
    worldbook: "sectionOpenWorldbook",
    longterm: "sectionOpenLongterm",
    dataManage: "sectionOpenDataManage",
};

// 生成一个"高级"折叠分组的外壳（标题按钮 + 可折叠内容区）。
// innerHtml 由调用方拼好（内部所有动态文本已经过 escapeHtml），这里只负责统一的折叠结构，
// 保证四个分组的展开/收起标记、动画容器结构完全一致，不会出现某个分组漏绑定的问题。
function buildSectionHtml(key, icon, title, innerHtml, extraHeaderHtml = "") {
    const s = getSettings();
    const settingKey = SECTION_SETTING_KEYS[key];
    const open = !!s[settingKey];
    return `
    <div class="mem-section" data-section="${key}">
        <button type="button" class="mem-section-toggle${open ? " open" : ""}" data-target="${key}" aria-expanded="${open ? "true" : "false"}" aria-controls="mem-collapse-${key}">
            <i class="fa-solid fa-chevron-right mem-section-chevron"></i>
            <i class="fa-solid ${icon} mem-section-icon"></i>
            <span class="mem-section-label">${title}</span>
            ${extraHeaderHtml}
        </button>
        <div class="mem-collapse${open ? " open" : ""}" id="mem-collapse-${key}">
            <div class="mem-collapse-inner">
                <div class="mem-collapse-pad">
                    ${innerHtml}
                </div>
            </div>
        </div>
    </div>`;
}

function buildPanelHtml() {
    const s = getSettings();

    // ------ 总结设置 ------
    const summarySectionHtml = `
        <div class="mem-row">
            <label>总结提示词模板（用 {{content}} 代表要总结的对话内容）：</label>
            <textarea id="mem-prompt" rows="5">${escapeHtml(s.promptTemplate)}</textarea>
        </div>
        <div class="mem-row mem-inline">
            <label><input type="checkbox" id="mem-style-ref" ${s.includeStyleReference ? "checked" : ""}/> 总结时附带最近旧摘要作为风格参考</label>
            <label>参考条数：<input type="number" id="mem-style-ref-n" min="0" value="${s.styleReferenceCount}" style="width:60px"/></label>
        </div>
        <div class="mem-hint">
            开启后，每次生成新摘要都会把最近几条旧摘要一起发给 AI，并明确告诉它"这些仅供参考、不需要重新总结"，
            目的是让所有摘要保持统一的写作风格和语气；旧摘要本身不会被修改，新摘要始终追加在后面。
        </div>
        <div class="mem-row mem-inline">
            <label>长期记忆条数警告阈值：<input type="number" id="mem-summary-warn-threshold" min="0" value="${s.summaryWarnThreshold}" style="width:60px" placeholder="0=不提醒"/></label>
            <label>核心记忆条数警告阈值：<input type="number" id="mem-core-warn-threshold" min="0" value="${s.coreWarnThreshold}" style="width:60px" placeholder="0=不提醒"/></label>
        </div>
        <div class="mem-hint">
            条数达到阈值后会在面板里显示提醒（不会自动删除任何东西），提示你该整理一下了；设为 0 可以关闭对应的提醒。
        </div>
        <div class="mem-row mem-status" id="mem-status"></div>`;

    // ------ 注入设置 ------
    const injectSectionHtml = `
        <div class="mem-row">
            <label><input type="checkbox" id="mem-inject" ${s.autoInject ? "checked" : ""}/> 自动注入到上下文（相当于引用到预设）</label>
        </div>
        <div class="mem-row mem-inline">
            <label>位置：
                <select id="mem-inject-pos">
                    <option value="main_before" ${s.injectPosition === "main_before" ? "selected" : ""}>Main Prompt↑（主提示词之前）</option>
                    <option value="main_after" ${s.injectPosition === "main_after" ? "selected" : ""}>Main Prompt↓（主提示词之后）</option>
                    <option value="chat_top" ${s.injectPosition === "chat_top" ? "selected" : ""}>Chat History↑（聊天记录较前，深度可调）</option>
                    <option value="chat_bottom" ${s.injectPosition === "chat_bottom" ? "selected" : ""}>Chat History↓（聊天记录末尾，紧邻回复前）</option>
                </select>
            </label>
            <label>合并最近：<input type="number" id="mem-inject-n" min="1" value="${s.injectCount}" style="width:50px"/> 条</label>
        </div>
        <div class="mem-row mem-inline mem-wi-subrow" id="mem-inject-subrow" style="display:none">
            <label>深度：<input type="number" id="mem-inject-depth" min="0" value="${s.injectDepth}" style="width:60px" title="仅 Chat History↑ 可调；Chat History↓ 固定为 0"/></label>
            <label>角色：
                <select id="mem-inject-role">
                    <option value="system" ${s.injectRole === "system" ? "selected" : ""}>系统</option>
                    <option value="user" ${s.injectRole === "user" ? "selected" : ""}>用户</option>
                    <option value="assistant" ${s.injectRole === "assistant" ? "selected" : ""}>AI</option>
                </select>
            </label>
        </div>
        <div class="mem-hint">
            注意：生成新摘要时会临时关闭这里的注入，避免总结这次新内容时把刚注入的旧摘要又重复喂给 AI 一次；
            总结完成后会自动恢复，不影响正常聊天。
        </div>
        <div class="mem-row" style="margin-top:6px">
            <label>长期记忆注入模板（用 {{memories}} 代表合并后的长期记忆正文，每条一行）：</label>
            <textarea id="mem-inject-template-summary" rows="3">${escapeHtml(s.injectTemplateSummary)}</textarea>
        </div>
        <div class="mem-row">
            <label>核心记忆注入模板（用 {{memories}} 代表合并后的核心记忆正文，每条一行）：</label>
            <textarea id="mem-inject-template-core" rows="4">${escapeHtml(s.injectTemplateCore)}</textarea>
        </div>
        <div class="mem-hint">
            两份模板分别对应"核心记忆"和"长期记忆"，全部记忆会先各自合并成一整块再套进模板，
            不会逐条分散注入、也不会同一份模板重复触发；模板里的 {{user}}/{{char}} 等酒馆宏会
            由酒馆自己解析。修改会自动保存，且同时应用于"自动注入到上下文"和"写入世界书"。
            如果模板里删掉了 {{memories}}，为避免内容丢失，插件会自动把内容追加在模板末尾。
        </div>`;

    // ------ 世界书 ------
    const worldbookSectionHtml = `
        <div class="mem-row">
            <label>写入世界书：会把当前<b>全部</b>长期记忆合并为一条、全部核心记忆合并为一条，
                各自用上面"注入设置"里的专属模板包裹后写入，不会逐条写入。</label>
        </div>
        <div class="mem-row mem-inline">
            <label>目标世界书：
                <select id="mem-wi-book"></select>
            </label>
            <button id="mem-wi-refresh" class="menu_button mem-btn-icon" title="刷新世界书列表"><i class="fa-solid fa-rotate"></i></button>
        </div>
        <div class="mem-row mem-inline">
            <label>插入位置：
                <select id="mem-wi-position"></select>
            </label>
        </div>
        <div class="mem-row mem-inline mem-wi-subrow" id="mem-wi-atdepth-row" style="display:none">
            <label>深度：<input type="number" id="mem-wi-depth" min="0" value="${s.wiDepth}" style="width:60px"/></label>
            <label>角色：
                <select id="mem-wi-role">
                    <option value="system" ${s.wiRole === "system" ? "selected" : ""}>系统</option>
                    <option value="user" ${s.wiRole === "user" ? "selected" : ""}>用户</option>
                    <option value="assistant" ${s.wiRole === "assistant" ? "selected" : ""}>AI</option>
                </select>
            </label>
        </div>
        <div class="mem-row mem-inline">
            <label style="flex:1;min-width:150px">长期记忆关键词：<input type="text" id="mem-wi-keys-summary" class="mem-wi-keys" placeholder="逗号分隔，留空=常驻"/></label>
            <label style="flex:1;min-width:150px">核心记忆关键词：<input type="text" id="mem-wi-keys-core" class="mem-wi-keys" placeholder="逗号分隔，留空=常驻"/></label>
        </div>
        <div class="mem-row mem-inline">
            <button id="mem-wi-write-summary" class="menu_button"><i class="fa-solid fa-book"></i> 写入长期记忆</button>
            <button id="mem-wi-write-core" class="menu_button mem-btn-core"><i class="fa-solid fa-gem"></i> 写入核心记忆</button>
        </div>
        <div class="mem-hint mem-wi-disabled-hint" id="mem-wi-disabled-hint" style="display:none">
            ⚠️ 已开启"自动注入到上下文"，为避免同一份记忆被重复喂给 AI（预设里一份、世界书里又一份），
            写入世界书功能已暂时禁用。如果想改用世界书而不是自动注入，请先在上面"注入设置"里关闭
            "自动注入到上下文"。
        </div>
        <div class="mem-hint">
            每次点击都会创建一条<b>新的</b>世界书条目，不会更新或覆盖已有条目——如果之前写过，
            记得先去世界书里手动删掉旧的那条，避免同一份记忆越堆越多、AI 看到自相矛盾的新旧版本。
            完全不想用世界书的话，用下面"长期记忆"里的"复制全部总结"手动粘贴到你需要的地方即可。
        </div>`;

    // ------ 长期记忆（内含"核心记忆"、"长期记忆列表"两张分类样式卡） ------
    const longtermSectionHtml = `
        <div class="mem-subsection mem-subsection-core">
            <div class="mem-subsection-title"><i class="fa-solid fa-gem"></i> 核心记忆</div>
            <div class="mem-hint">
                核心记忆的优先级高于长期记忆，注入时会标记为"绝对不可违反"。
                从下方长期记忆列表中勾选条目，然后点击"提取核心"按钮，也可以直接手动添加。
            </div>
            <div class="mem-row">
                <label>核心记忆提取提示词（用 {{content}} 代表选中的摘要内容）：</label>
                <textarea id="mem-core-prompt" rows="4">${escapeHtml(s.corePromptTemplate)}</textarea>
            </div>
            <div class="mem-row mem-inline">
                <label>注入最近核心记忆条数：<input type="number" id="mem-core-inject-n" min="1" value="${s.coreInjectCount}" style="width:60px"/></label>
            </div>
            <div id="mem-core-status" class="mem-row mem-status"></div>

            <div class="mem-row">
                <textarea id="mem-core-manual-add-text" rows="2" placeholder="在这里输入要手动添加的核心记忆内容…"></textarea>
            </div>
            <div class="mem-row mem-inline">
                <button id="mem-core-manual-add-btn" class="menu_button mem-btn-primary"><i class="fa-solid fa-plus"></i> 手动添加核心记忆</button>
            </div>

            <div class="mem-row">
                <input type="text" id="mem-search" placeholder="🔍 搜索长期记忆内容…" value="" />
            </div>
            <div class="mem-row mem-inline mem-filter-bar">
                <label>时间：
                    <select id="mem-core-filter-time">
                        <option value="all"${s.coreFilterTimeRange === "all" ? " selected" : ""}>全部</option>
                        <option value="1h"${s.coreFilterTimeRange === "1h" ? " selected" : ""}>最近1小时</option>
                        <option value="24h"${s.coreFilterTimeRange === "24h" ? " selected" : ""}>最近24小时</option>
                        <option value="7d"${s.coreFilterTimeRange === "7d" ? " selected" : ""}>最近7天</option>
                        <option value="30d"${s.coreFilterTimeRange === "30d" ? " selected" : ""}>最近30天</option>
                    </select>
                </label>
                <label>字数≥<input type="number" id="mem-core-filter-min" min="0" value="${s.coreFilterMinChars}" style="width:55px"/></label>
                <label>字数≤<input type="number" id="mem-core-filter-max" min="0" value="${s.coreFilterMaxChars}" style="width:55px" placeholder="0=不限"/></label>
                <label><input type="checkbox" id="mem-core-hide-deprecated" ${s.coreHideDeprecated ? "checked" : ""}/> 隐藏已废弃</label>
                <button id="mem-core-order-toggle" class="menu_button" title="切换显示/注入顺序">
                    <i class="fa-solid ${s.coreOrder === "desc" ? "fa-arrow-down-wide-short" : "fa-arrow-up-wide-short"}"></i>
                    <span>${s.coreOrder === "desc" ? "倒序(新→旧)" : "正序(旧→新)"}</span>
                </button>
            </div>
            <div class="mem-hint">
                排序会同时影响面板显示和注入给 AI 的上下文顺序；长按某条核心记忆可拖动调整顺序（自动保存）。<br/>
                时间/字数筛选、"隐藏已废弃"只影响面板显示；但已标记废弃的条目本身始终会被排除在注入和写入世界书之外，不管这个勾选框状态如何。
            </div>

            <div id="mem-core-list" class="mem-summary-list"></div>
            <div id="mem-core-pagination" class="mem-row mem-inline" style="justify-content:center"></div>
        </div>

        <div class="mem-subsection mem-subsection-longterm">
            <div class="mem-subsection-title"><i class="fa-solid fa-book-open"></i> 长期记忆列表</div>

            <div class="mem-row">
                <textarea id="mem-manual-add-text" rows="3" placeholder="在这里输入要手动添加的记忆内容…"></textarea>
            </div>
            <div class="mem-row mem-inline">
                <button id="mem-manual-add-btn" class="menu_button mem-btn-primary"><i class="fa-solid fa-plus"></i> 手动添加记忆</button>
            </div>
            <div class="mem-hint">
                手动添加的记忆会直接保存为一条新条目，不影响自动总结的计数器（lastSummarizedIndex 不变）。
            </div>

            <div class="mem-row">
                <input type="text" id="mem-core-search" placeholder="🔍 搜索核心记忆内容…" value="" />
            </div>
            <div class="mem-row mem-inline mem-filter-bar">
                <label>时间：
                    <select id="mem-filter-time">
                        <option value="all"${s.filterTimeRange === "all" ? " selected" : ""}>全部</option>
                        <option value="1h"${s.filterTimeRange === "1h" ? " selected" : ""}>最近1小时</option>
                        <option value="24h"${s.filterTimeRange === "24h" ? " selected" : ""}>最近24小时</option>
                        <option value="7d"${s.filterTimeRange === "7d" ? " selected" : ""}>最近7天</option>
                        <option value="30d"${s.filterTimeRange === "30d" ? " selected" : ""}>最近30天</option>
                    </select>
                </label>
                <label>字数≥<input type="number" id="mem-filter-min" min="0" value="${s.filterMinChars}" style="width:55px"/></label>
                <label>字数≤<input type="number" id="mem-filter-max" min="0" value="${s.filterMaxChars}" style="width:55px" placeholder="0=不限"/></label>
                <label>分级：
                    <select id="mem-filter-tier">
                        <option value="all"${s.filterTier === "all" ? " selected" : ""}>全部</option>
                        <option value="important"${s.filterTier === "important" ? " selected" : ""}>⭐ 重要</option>
                        <option value="normal"${s.filterTier === "normal" ? " selected" : ""}>🔵 普通</option>
                        <option value="deprecated"${s.filterTier === "deprecated" ? " selected" : ""}>🚫 废弃</option>
                    </select>
                </label>
                <button id="mem-order-toggle" class="menu_button" title="切换显示/注入顺序">
                    <i class="fa-solid ${s.summaryOrder === "desc" ? "fa-arrow-down-wide-short" : "fa-arrow-up-wide-short"}"></i>
                    <span>${s.summaryOrder === "desc" ? "倒序(新→旧)" : "正序(旧→新)"}</span>
                </button>
            </div>
            <div class="mem-hint">
                排序会同时影响面板显示和注入给 AI 的上下文顺序；长按某条记忆可拖动调整顺序（自动保存）。<br/>
                时间/字数/分级这几个筛选条件只影响面板里显示哪些条目，不影响注入给 AI 的内容——
                唯一的例外是分级里的"🚫 废弃"：被标记废弃的条目本身就会被排除在"自动注入到上下文"和"写入世界书"之外，这条规则始终生效，与筛选框选的是什么无关。
            </div>

            <div class="mem-row mem-inline">
                <button id="mem-copy-all" class="menu_button"><i class="fa-solid fa-copy"></i> 复制全部总结</button>
                <button id="mem-core-summarize-btn" class="menu_button mem-btn-core"><i class="fa-solid fa-gem"></i> 从选中的长期记忆提取核心</button>
            </div>

            <div class="mem-row mem-inline">
                <button id="mem-clear-summaries" class="menu_button danger"><i class="fa-solid fa-trash-can"></i> 清空摘要文本</button>
                <button id="mem-reset-progress" class="menu_button danger"><i class="fa-solid fa-rotate-left"></i> 重置总结进度</button>
            </div>
            <div class="mem-hint">
                "清空摘要文本"只删除已保存的摘要内容，总结进度不受影响，这些消息不会重新进入待总结队列；<br/>
                "重置总结进度"只重置计数指针，让全部聊天记录重新变为待总结状态（开着自动总结的话可能会连续触发较多新总结、消耗更多 Token），不会影响已保存的摘要文本。
            </div>

            <div id="mem-summary-list" class="mem-summary-list"></div>
            <div id="mem-summary-pagination" class="mem-row mem-inline" style="justify-content:center"></div>
        </div>`;

    // ------ 数据管理（统计 / 导出导入 / 回收站）------
    const dataManageSectionHtml = `
        <div class="mem-row mem-status" id="mem-data-stats"></div>
        <div class="mem-hint">
            "本月新增"按条目实际生成时间统计的长期记忆+核心记忆之和；很早以前（本插件更新此功能之前）生成的旧条目
            没有精确时间戳，不会被计入本月新增，但仍会计入下面的总条数，不影响其它任何功能。
        </div>

        <div class="mem-row mem-inline">
            <button id="mem-export-btn" class="menu_button"><i class="fa-solid fa-file-export"></i> 导出记忆数据</button>
            <button id="mem-import-btn" class="menu_button"><i class="fa-solid fa-file-import"></i> 导入记忆数据</button>
            <input type="file" id="mem-import-file" accept="application/json" style="display:none" />
        </div>
        <div class="mem-hint">
            导出会把当前聊天的全部摘要、总结进度和插件设置打包成一个 JSON 文件，方便备份或换设备；
            导入时可以分别选择只导入摘要、只导入设置，摘要会追加在当前聊天已有摘要之后，不会覆盖。
        </div>

        <div class="mem-row mem-inline">
            <button id="mem-trash-btn" class="menu_button"><i class="fa-solid fa-trash-arrow-up"></i> 回收站<span id="mem-trash-count"></span></button>
        </div>
        <div class="mem-hint">
            长期记忆/核心记忆里的单条删除都会先进回收站，24 小时内、最多保留最近 10 条可以恢复；
            "长期记忆"里的"清空摘要文本"这类批量操作不经过回收站，请谨慎使用。
        </div>`;

    return `
    <div id="mem-summarizer-panel" class="mem-summarizer-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header mem-header">
                <b class="mem-header-title-wrap"><span class="mem-header-icon">📝</span><span class="mem-header-title">记忆总结助手</span></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content"${s.panelOpen ? ' style="display:block"' : ""}>

                <!-- 基础模式：始终可见，只保留最常用的 4 项 -->
                <div class="mem-card mem-card-basic">
                    <div class="mem-basic-row">
                        <label class="mem-switch-label">
                            <span class="mem-switch">
                                <input type="checkbox" id="mem-auto" ${s.autoSummarize ? "checked" : ""}/>
                                <span class="mem-switch-track"><span class="mem-switch-thumb"></span></span>
                            </span>
                            <span class="mem-switch-text">自动总结</span>
                        </label>
                        <div class="mem-basic-count">
                            <span>每</span>
                            <input type="number" id="mem-count" min="1" value="${s.messagesPerSummary}" />
                            <span>条一次</span>
                        </div>
                    </div>

                    <button id="mem-run-now" class="menu_button mem-btn-primary mem-btn-run"><i class="fa-solid fa-wand-magic-sparkles"></i><span>立即总结</span></button>

                    <div class="mem-basic-stats" id="mem-basic-stats">当前记忆：<b>0</b> 条</div>

                    <div class="mem-typing-indicator" id="mem-typing-indicator" hidden>
                        <span class="mem-typing-dots"><span></span><span></span><span></span></span>
                        <span class="mem-typing-shimmer"></span>
                        <span class="mem-typing-text">AI 正在生成摘要…</span>
                    </div>
                </div>

                <!-- 高级：默认折叠，点开展开 -->
                ${buildSectionHtml("summary", "fa-sliders", "总结设置", summarySectionHtml)}
                ${buildSectionHtml("inject", "fa-syringe", "注入设置", injectSectionHtml)}
                ${buildSectionHtml("worldbook", "fa-book-atlas", "世界书", worldbookSectionHtml)}
                ${buildSectionHtml("longterm", "fa-layer-group", "长期记忆", longtermSectionHtml, '<span class="mem-section-count" id="mem-section-count-longterm"></span>')}
                ${buildSectionHtml("dataManage", "fa-database", "数据管理", dataManageSectionHtml)}

            </div>
        </div>
    </div>
    `;
}

function buildSummaryItemHtml(entry) {
    const src = getEntrySource(entry);
    const srcLabel = SOURCE_LABELS[src] || SOURCE_LABELS.manual;
    const badge = `<span class="mem-badge mem-badge-${src}"><i class="fa-solid ${srcLabel.icon}"></i> ${srcLabel.text}</span>`;
    const status = getMemoryStatus(entry);
    const charCount = (entry.content || "").length;
    const hasRealRange = Array.isArray(entry.range) && (entry.range[0] !== 0 || entry.range[1] !== 0);
    // 手动添加的记忆没有真实的消息范围（约定用 [0,0] 占位），显示"消息 1-0"会让人以为是个 bug，
    // 这里改为显示更直观的"手动添加"提示。
    const rangeLabel = hasRealRange
        ? `消息 ${entry.range[0] + 1}-${entry.range[1]}`
        : "手动添加";
    // 刚生成的这一条播放一次入场动画，之后（比如编辑了别的条目触发整表重渲染）不会再重复播放。
    const isNew = entry.id === lastAddedSummaryId;
    // entry.id 在"导入数据"场景下来自外部 JSON 文件，不可信，拼进 HTML 属性前必须转义，
    // 否则精心构造的 id（比如含有引号）可以逃出属性、注入任意标签/脚本。
    const safeId = escapeHtml(entry.id);
    const checked = selectedForCoreIds.has(entry.id) ? " checked" : "";
    const tier = entry.tier || "normal";
    const deprecatedClass = tier === "deprecated" ? " mem-item-deprecated" : "";
    return `
    <div class="mem-summary-item${isNew ? " mem-item-new" : ""}${deprecatedClass}" data-id="${safeId}">
        <div class="mem-summary-header">
            <div class="mem-summary-header-left">
                <input type="checkbox" class="mem-select-for-core" data-id="${safeId}"${checked} title="选中以提取核心记忆" />
                <span class="mem-status-icon" title="${status.text}">${status.icon}</span>
                ${badge}
                <span>${rangeLabel} · ${charCount} 字</span>
            </div>
            <div class="mem-summary-time" title="真实的总结完成时间">${escapeHtml(entry.time)}</div>
        </div>
        <textarea class="mem-summary-text" data-id="${safeId}" rows="3">${escapeHtml(entry.content)}</textarea>
        <div class="mem-summary-actions">
            <select class="mem-tier-select mem-tier-${tier}" data-id="${safeId}" title="记忆分级，废弃后不会再注入给 AI">
                <option value="normal"${tier === "normal" ? " selected" : ""}>🔵 普通</option>
                <option value="important"${tier === "important" ? " selected" : ""}>⭐ 重要</option>
                <option value="deprecated"${tier === "deprecated" ? " selected" : ""}>🚫 废弃</option>
            </select>
            <button class="menu_button mem-copy-one" data-id="${safeId}"><i class="fa-solid fa-copy"></i> 复制</button>
            <button class="menu_button mem-delete-one danger" data-id="${safeId}"><i class="fa-solid fa-trash"></i> 删除</button>
        </div>
    </div>
    `;
}

function buildCoreMemoryItemHtml(entry) {
    const charCount = (entry.content || "").length;
    const isNew = entry.id === lastAddedCoreId;
    const safeId = escapeHtml(entry.id); // 同上：来自导入文件的 id 不可信，必须转义
    const src = getEntrySource(entry);
    const srcLabel = src === "manual" ? SOURCE_LABELS.manual : SOURCE_LABELS.extracted;
    const isDeprecated = !!entry.deprecated;
    const statusIcon = isDeprecated ? "🔴" : "🟢";
    const statusText = isDeprecated ? "已废弃" : "已确认";
    return `
    <div class="mem-summary-item mem-core-item${isNew ? " mem-item-new" : ""}${isDeprecated ? " mem-item-deprecated" : ""}" data-id="${safeId}">
        <div class="mem-summary-header">
            <div class="mem-summary-header-left">
                <span class="mem-status-icon" title="${statusText}">${statusIcon}</span>
                <span class="mem-badge mem-badge-core">核心</span>
                <span class="mem-badge mem-badge-${src}"><i class="fa-solid ${srcLabel.icon}"></i> ${srcLabel.text}</span>
                <span>${charCount} 字</span>
            </div>
            <div class="mem-summary-time" title="真实的总结完成时间">${escapeHtml(entry.time)}</div>
        </div>
        <textarea class="mem-core-text" data-id="${safeId}" rows="3">${escapeHtml(entry.content)}</textarea>
        <div class="mem-summary-actions">
            <button class="menu_button mem-core-copy" data-id="${safeId}"><i class="fa-solid fa-copy"></i> 复制</button>
            ${entry.sourceIds && entry.sourceIds.length > 0 ? `<button class="menu_button mem-core-source" data-id="${safeId}"><i class="fa-solid fa-link"></i> 溯源</button>` : ""}
            <button class="menu_button mem-core-toggle-deprecated" data-id="${safeId}" title="废弃后不会再注入给 AI，但仍保留在列表里，可以随时恢复">
                <i class="fa-solid ${isDeprecated ? "fa-rotate-left" : "fa-ban"}"></i> ${isDeprecated ? "恢复启用" : "标记废弃"}
            </button>
            <button class="menu_button mem-core-delete danger" data-id="${safeId}"><i class="fa-solid fa-trash"></i> 删除</button>
        </div>
    </div>
    `;
}

// 运行时状态：长期记忆 / 核心记忆列表是否已展开全部
let summaryShowAll = false;
let coreShowAll = false;

function renderCoreMemories() {
    const coreList = document.getElementById("mem-core-list");
    const coreStatus = document.getElementById("mem-core-status");
    const paginationDiv = document.getElementById("mem-core-pagination");
    if (!coreList) return;
    const data = getChatData();
    const settings = getSettings();
    const cores = data.coreMemories || [];

    if (coreStatus) {
        const totalChars = cores.reduce((sum, x) => sum + (x.content ? x.content.length : 0), 0);
        const lastCore = cores.length > 0 ? cores[cores.length - 1] : null;
        coreStatus.innerHTML = cores.length > 0
            ? `<div class="mem-status-line"><span>核心记忆：<b>${cores.length}</b> 条 · 共 <b>${totalChars}</b> 字 · 上次更新：${escapeHtml(lastCore.time)}</span></div>`
            : `<div class="mem-status-line"><span>暂无核心记忆</span></div>`;
    }

    if (cores.length === 0) {
        coreList.innerHTML = `<div class="mem-empty-hint">暂无核心记忆，可以从下方长期记忆中勾选条目后点击"提取核心"，也可以直接手动添加</div>`;
        if (paginationDiv) paginationDiv.innerHTML = "";
        lastAddedCoreId = null;
        return;
    }

    // 和长期记忆列表一样：先筛选，再排序，再分页
    const filtered = getFilteredCores();
    const ordered = getOrderedCores(filtered);
    const pageSize = settings.corePageSize || 20;
    const total = ordered.length;

    if (total === 0) {
        coreList.innerHTML = `<div class="mem-empty-hint">没有符合当前筛选条件的核心记忆（共 ${cores.length} 条）</div>`;
        if (paginationDiv) paginationDiv.innerHTML = "";
        lastAddedCoreId = null;
        return;
    }

    if (total <= pageSize || coreShowAll) {
        coreList.innerHTML = ordered.map(buildCoreMemoryItemHtml).join("");
        if (paginationDiv) {
            if (total > pageSize && coreShowAll) {
                paginationDiv.innerHTML = `<button id="mem-core-show-less" class="menu_button"><i class="fa-solid fa-chevron-up"></i> 收起，只显示最近 ${pageSize} 条</button>`;
            } else {
                paginationDiv.innerHTML = "";
            }
        }
    } else {
        coreList.innerHTML = ordered.slice(0, pageSize).map(buildCoreMemoryItemHtml).join("");
        if (paginationDiv) {
            paginationDiv.innerHTML = `<button id="mem-core-show-all" class="menu_button"><i class="fa-solid fa-chevron-down"></i> 还有 ${total - pageSize} 条，点击展开全部</button>`;
        }
    }
    lastAddedCoreId = null;
}

// 解析条目的时间为毫秒时间戳，解析失败返回 0。
// 优先使用数字 timestamp 字段（新条目都会写入这个字段，不受 locale 影响，稳定可靠）；
// 老数据/旧版本导入的条目没有这个字段时，才退回到解析 time 字符串——
// 但 entry.time 是 toLocaleString() 产生的，格式因系统语言/浏览器而异，
// 部分浏览器（尤其非 Chromium 内核）对这种格式解析不稳定，只能作为兜底，不保证一定成功。
function parseEntryTime(entry) {
    if (!entry) return 0;
    if (Number.isFinite(entry.timestamp)) return entry.timestamp;
    if (!entry.time) return 0;
    const t = new Date(entry.time).getTime();
    return Number.isFinite(t) ? t : 0;
}

// 条目来源标签。新条目会显式写入 source 字段（见各个创建入口）；
// 老数据没有这个字段时，从已有的 id 前缀 / auto 字段推断，不需要迁移旧数据。
const SOURCE_LABELS = {
    auto: { icon: "fa-robot", text: "自动总结" },
    manual: { icon: "fa-hand", text: "手动添加" },
    merged: { icon: "fa-link", text: "核心合并生成" },
    extracted: { icon: "fa-gem", text: "核心提取" },
};
function getEntrySource(entry) {
    if (entry.source && SOURCE_LABELS[entry.source]) return entry.source;
    const id = String(entry.id || "");
    if (id.startsWith("merged-")) return "merged";
    if (id.startsWith("manual-core-")) return "manual";
    if (id.startsWith("core-")) return "extracted";
    if (id.startsWith("manual-")) return "manual";
    return entry.auto ? "auto" : "manual";
}

// 长期记忆的"状态"指示（🟢已确认 / 🟡待确认 / 🔴已废弃），完全由已有字段推导，
// 不需要额外的人工审核流程：废弃优先；AI 自动生成且没被标记"重要"的算待确认；
// 其余（用户自己写的、AI 生成但用户主动标了"重要"的、核心提取/合并生成的）都算已确认，
// 因为能落到这几种情况本身就意味着有人主动做过一次选择。
function getMemoryStatus(entry) {
    if (entry.tier === "deprecated") return { icon: "🔴", text: "已废弃" };
    const src = getEntrySource(entry);
    if (src === "auto" && entry.tier !== "important") return { icon: "🟡", text: "待确认" };
    return { icon: "🟢", text: "已确认" };
}

// 通用筛选：按时间范围 + 字数区间过滤一个条目数组（不修改原数组）。
// 长期记忆和核心记忆共用这一份逻辑，只是各自传入自己的筛选设置。
function filterEntriesByTimeAndChars(list, timeRange, minChars, maxChars) {
    let items = (list || []).slice();

    if (timeRange && timeRange !== "all") {
        const now = Date.now();
        const rangeMs = {
            "1h": 3600_000,
            "24h": 86400_000,
            "7d": 604800_000,
            "30d": 2592000_000,
        }[timeRange];
        if (rangeMs) {
            items = items.filter((x) => {
                const t = parseEntryTime(x);
                return t > 0 && (now - t) <= rangeMs;
            });
        }
    }

    const minC = minChars || 0;
    const maxC = maxChars || 0;
    if (minC > 0) {
        items = items.filter((x) => (x.content || "").length >= minC);
    }
    if (maxC > 0) {
        items = items.filter((x) => (x.content || "").length <= maxC);
    }

    return items;
}

// 通用排序：desc = 倒序（数组末尾/最新排在显示最前面），asc = 正序（数组开头/最旧排在最前面）。
// 数组本身按追加顺序存储（旧的在前），所以 asc 直接返回浅拷贝，desc 则整体反转。
function orderEntries(arr, order) {
    return order === "asc" ? arr.slice() : arr.slice().reverse();
}

// 更新排序切换按钮自身的图标和文字（长期记忆、核心记忆的排序按钮共用这一份逻辑）
function updateOrderToggleButton(btnId, order) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const icon = btn.querySelector("i");
    const span = btn.querySelector("span");
    if (icon) {
        icon.className = order === "desc" ? "fa-solid fa-arrow-down-wide-short" : "fa-solid fa-arrow-up-wide-short";
    }
    if (span) {
        span.textContent = order === "desc" ? "倒序(新→旧)" : "正序(旧→新)";
    }
}

// 根据当前筛选设置，返回应该在面板里显示的 summaries 子集（不修改原数组）
function getFilteredSummaries() {
    const s = getSettings();
    const data = getChatData();
    let items = filterEntriesByTimeAndChars(data.summaries, s.filterTimeRange, s.filterMinChars, s.filterMaxChars);
    if (s.filterTier && s.filterTier !== "all") {
        items = items.filter((x) => (x.tier || "normal") === s.filterTier);
    }
    const kw = searchKeyword.trim().toLowerCase();
    if (kw) {
        items = items.filter((x) => (x.content || "").toLowerCase().includes(kw));
    }
    return items;
}

// 根据设置里的 summaryOrder 对数组进行排序（返回新数组，不修改原数组）
function getOrderedSummaries(arr) {
    return orderEntries(arr, getSettings().summaryOrder);
}

// 核心记忆版本的筛选/排序，字段/逻辑与长期记忆完全对称，独立设置互不影响
function getFilteredCores() {
    const s = getSettings();
    const data = getChatData();
    let items = filterEntriesByTimeAndChars(data.coreMemories || [], s.coreFilterTimeRange, s.coreFilterMinChars, s.coreFilterMaxChars);
    if (s.coreHideDeprecated) {
        items = items.filter((x) => !x.deprecated);
    }
    const kw = coreSearchKeyword.trim().toLowerCase();
    if (kw) {
        items = items.filter((x) => (x.content || "").toLowerCase().includes(kw));
    }
    return items;
}
function getOrderedCores(arr) {
    return orderEntries(arr, getSettings().coreOrder);
}

function populateWorldBookSelect() {
    const select = document.getElementById("mem-wi-book");
    if (!select) return;
    const s = getSettings();
    // 优先保留当前下拉框已经选中的值（面板运行期间点"刷新"不应该丢失选择），
    // 面板刚打开、下拉框还是空的情况下，才使用上次保存的 wiBookName 恢复选择。
    const previousValue = select.value || s.wiBookName;
    select.innerHTML = "";
    const names = WI_API?.world_names || [];
    if (names.length === 0) {
        select.appendChild(el(`<option value="">(未检测到世界书，请先在酒馆里创建一个)</option>`));
        return;
    }
    for (const name of names) {
        select.appendChild(el(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`));
    }
    if (names.includes(previousValue)) {
        select.value = previousValue;
        // 用户上次选的书如果因为改名/被删而不在列表里了，wiBookName 会在这里静默保留旧值
        // （不强行清空，万一书只是暂时没加载出来），只有真正选中一个存在的书时才更新保存值。
        if (s.wiBookName !== previousValue) {
            s.wiBookName = previousValue;
            saveSettings();
        }
    }
}

function setRunButtonLoading(loading) {
    const btn = document.getElementById("mem-run-now");
    if (btn) {
        btn.disabled = loading;
        btn.classList.toggle("mem-btn-loading", loading);
        btn.innerHTML = loading
            ? '<i class="fa-solid fa-spinner fa-spin"></i><span>总结中…</span>'
            : '<i class="fa-solid fa-wand-magic-sparkles"></i><span>立即总结</span>';
    }
    // 总结进行中时，在基础卡片里显示一个模拟"AI 正在打字"的状态条（跳动圆点 + 呼吸光带），
    // 纯前端视觉反馈，用来缓解"点了按钮却不知道有没有在跑"的等待焦虑；
    // 不代表真实的流式生成进度（generateQuietPrompt 本身不是逐字流式返回的)。
    const indicator = document.getElementById("mem-typing-indicator");
    if (indicator) indicator.hidden = !loading;
}

function updateStatusLine() {
    const statusDiv = document.getElementById("mem-status");
    const basicStatsDiv = document.getElementById("mem-basic-stats");
    const longtermCountEl = document.getElementById("mem-section-count-longterm");
    if (!statusDiv && !basicStatsDiv && !longtermCountEl) return;
    const s = getSettings();
    const context = getContext();
    const data = getChatData();
    const chat = context.chat || [];
    const total = chat.length;
    // 可总结消息数：排除系统消息和空消息，和 formatMessagesForPrompt 的过滤口径一致
    const summarizable = chat.filter((m) => !m.is_system && stripHtml(m.mes)).length;
    const pending = Math.max(0, total - data.lastSummarizedIndex);
    const pct = Math.min(100, Math.round((pending / Math.max(1, s.messagesPerSummary)) * 100));
    const remain = Math.max(0, s.messagesPerSummary - pending);
    const lastEntry = data.summaries.length > 0 ? data.summaries[data.summaries.length - 1] : null;
    const lastTime = lastEntry ? lastEntry.time : "尚未总结过";
    const totalChars = data.summaries.reduce((sum, x) => sum + (x.content ? x.content.length : 0), 0);
    const coreCount = (data.coreMemories || []).length;
    const autoNote = s.autoSummarize ? "" : "（自动总结当前已关闭）";

    // 基础模式下的极简统计：只给一个数字，详细口径（含系统消息/字数/进度）留在"总结设置"里
    if (basicStatsDiv) {
        const warnSummary = s.summaryWarnThreshold > 0 && data.summaries.length >= s.summaryWarnThreshold;
        const warnCore = s.coreWarnThreshold > 0 && coreCount >= s.coreWarnThreshold;
        const warnDot = (warnSummary || warnCore) ? ' <span class="mem-warn-dot" title="记忆条数较多，建议清理">⚠</span>' : "";
        basicStatsDiv.innerHTML = `当前记忆：<b>${data.summaries.length}</b> 条${warnDot}`;
    }
    // "长期记忆"折叠标题右侧的小计数徽章，收起状态下也能一眼看到条数
    if (longtermCountEl) {
        longtermCountEl.textContent = String(data.summaries.length);
    }

    if (!statusDiv) return;
    statusDiv.innerHTML = `
        <div class="mem-status-line">
            <span>共 <b>${summarizable}</b> 条可总结消息${summarizable !== total ? `（含系统消息共 ${total} 条）` : ""} · 长期记忆 <b>${data.summaries.length}</b> 条 · 核心记忆 <b>${coreCount}</b> 条 · 共 <b>${totalChars}</b> 字</span>
        </div>
        <div class="mem-status-line mem-status-sub">
            <span>上次更新：${escapeHtml(lastTime)}</span>
        </div>
        <div class="mem-progress" title="距离自动总结还差 ${remain} 条">
            <div class="mem-progress-bar" style="width:${pct}%"></div>
        </div>
        <div class="mem-status-line mem-status-sub">
            <span>距上次总结已过去 ${pending} 条，还差 ${remain} 条将自动触发${autoNote}</span>
        </div>
        ${s.summaryWarnThreshold > 0 && data.summaries.length >= s.summaryWarnThreshold ? `<div class="mem-data-warn"><i class="fa-solid fa-triangle-exclamation"></i> 长期记忆已达 <b>${data.summaries.length}</b> 条（建议阈值 ${s.summaryWarnThreshold}），过多会拖慢面板加载，建议提取核心后清理旧条目</div>` : ""}
        ${s.coreWarnThreshold > 0 && coreCount >= s.coreWarnThreshold ? `<div class="mem-data-warn"><i class="fa-solid fa-triangle-exclamation"></i> 核心记忆已达 <b>${coreCount}</b> 条（建议阈值 ${s.coreWarnThreshold}），建议合并相似条目以减少注入 token</div>` : ""}
    `;
}

function renderPanel() {
    const container = document.getElementById("mem-summarizer-panel");
    if (!container) return;
    const data = getChatData();
    const settings = getSettings();
    updateStatusLine();
    renderCoreMemories();
    updateDataStats();
    updateTrashCount();

    const list = document.getElementById("mem-summary-list");
    const paginationDiv = document.getElementById("mem-summary-pagination");
    if (!list) return;

    if (data.summaries.length === 0) {
        list.innerHTML = `<div class="mem-empty-hint">暂无总结记录，点击上方"立即总结"开始，或等待自动总结触发</div>`;
        if (paginationDiv) paginationDiv.innerHTML = "";
        lastAddedSummaryId = null;
        return;
    }

    //：先筛选，再排序
    const filtered = getFilteredSummaries();
    const ordered = getOrderedSummaries(filtered);
    const pageSize = settings.summaryPageSize || 20;
    const total = ordered.length;

    if (total === 0) {
        list.innerHTML = `<div class="mem-empty-hint">没有符合当前筛选条件的记忆条目（共 ${data.summaries.length} 条）</div>`;
        if (paginationDiv) paginationDiv.innerHTML = "";
        lastAddedSummaryId = null;
        return;
    }

    if (total <= pageSize || summaryShowAll) {
        list.innerHTML = ordered.map(buildSummaryItemHtml).join("");
        if (paginationDiv) {
            if (total > pageSize && summaryShowAll) {
                paginationDiv.innerHTML = `<button id="mem-show-less" class="menu_button"><i class="fa-solid fa-chevron-up"></i> 收起，只显示最近 ${pageSize} 条</button>`;
            } else {
                paginationDiv.innerHTML = "";
            }
        }
    } else {
        list.innerHTML = ordered.slice(0, pageSize).map(buildSummaryItemHtml).join("");
        if (paginationDiv) {
            paginationDiv.innerHTML = `<button id="mem-show-all" class="menu_button"><i class="fa-solid fa-chevron-down"></i> 还有 ${total - pageSize} 条，点击展开全部</button>`;
        }
    }
    lastAddedSummaryId = null;
}

function bindPanelEvents() {
    const s = getSettings();

    // --- 核心记忆设置 ---
    document.getElementById("mem-core-prompt")?.addEventListener("change", (e) => {
        s.corePromptTemplate = e.target.value;
        saveSettings();
    });
    document.getElementById("mem-core-inject-n")?.addEventListener("change", (e) => {
        s.coreInjectCount = Math.max(1, parseInt(e.target.value) || 1);
        saveSettings();
        updateInjection();
    });

    // 提取核心按钮：以 selectedForCoreIds 为准，而不是只读当前 DOM 里勾选的 checkbox——
    // 因为筛选/分页变化后，之前勾选的条目可能暂时不在当前渲染的页面里（但仍然算"已勾选"），
    // 只读 DOM 会漏掉这部分，导致用户"明明勾了却没被提取"。
    document.getElementById("mem-core-summarize-btn")?.addEventListener("click", async () => {
        const selectedIds = Array.from(selectedForCoreIds);
        await runCoreSummarization(selectedIds);
    });

    // 核心记忆列表事件委托
    const coreList = document.getElementById("mem-core-list");
    coreList?.addEventListener("click", (e) => {
        const target = e.target.closest("button");
        const id = target?.dataset?.id;
        if (!id) return;
        try {
            const data = getChatData();
            const cores = data.coreMemories || [];
            const idx = cores.findIndex((x) => x.id === id);
            if (idx === -1) return;

            if (target.classList.contains("mem-core-copy")) {
                copyToClipboard(cores[idx].content, "已复制该条核心记忆");
            } else if (target.classList.contains("mem-core-source")) {
                // 溯源：展示这条核心记忆的来源长期记忆
                const sourceIds = cores[idx].sourceIds || [];
                if (sourceIds.length === 0) {
                    toastInfo("这条核心记忆没有关联的来源记录（可能是手动添加的）");
                    return;
                }
                const summaries = data.summaries || [];
                const sourceItems = sourceIds.map((sid) => {
                    const found = summaries.find((s) => s.id === sid);
                    if (found) {
                        return `<div class="mem-source-item"><div class="mem-source-header">${escapeHtml(found.time)} · ${(found.content || "").length} 字</div><div class="mem-source-content">${escapeHtml(found.content)}</div></div>`;
                    }
                    return `<div class="mem-source-item mem-source-gone"><i class="fa-solid fa-ghost"></i> 来源条目 (${escapeHtml(String(sid).slice(0, 12))}…) 已被删除或合并</div>`;
                });
                showModal({
                    title: "核心记忆来源追溯",
                    bodyHtml: `
                        <div class="mem-modal-line">这条核心记忆提取自以下 <b>${sourceIds.length}</b> 条长期记忆：</div>
                        <div class="mem-source-list">${sourceItems.join("")}</div>
                    `,
                    confirmText: "知道了",
                    showCancel: false,
                });
            } else if (target.classList.contains("mem-core-toggle-deprecated")) {
                cores[idx].deprecated = !cores[idx].deprecated;
                saveChatData();
                updateInjection(); // 废弃状态直接影响是否还会被注入给 AI
                renderCoreMemories();
            } else if (target.classList.contains("mem-core-delete")) {
                if (!confirm("删除这条核心记忆？将移入回收站（24小时内可恢复，最多保留10条）。")) return;
                const removedCore = cores.splice(idx, 1)[0];
                moveToTrash(removedCore, "core");
                saveChatData();
                updateInjection();
                renderCoreMemories();
                updateTrashCount();
            }
        } catch (err) {
            console.error("[记忆总结助手] 处理核心记忆列表点击事件异常：", err);
            toastError(`操作失败：${extractErrorReason(err)}`);
        }
    });

    // 核心记忆文本编辑保存
    coreList?.addEventListener("change", (e) => {
        const target = e.target;
        if (!target.classList.contains("mem-core-text")) return;
        const id = target.dataset.id;
        const data = getChatData();
        const cores = data.coreMemories || [];
        const entry = cores.find((x) => x.id === id);
        if (entry) {
            entry.content = target.value;
            saveChatData();
            updateInjection();
        }
    });

    // 核心记忆拖拽排序（同长期记忆一样，只绑一次，见 bindDragSort 顶部的说明）
    bindDragSort(coreList, { dataKey: "coreMemories", orderSettingKey: "coreOrder" });

    // 手动添加核心记忆
    document.getElementById("mem-core-manual-add-btn")?.addEventListener("click", () => {
        const textarea = document.getElementById("mem-core-manual-add-text");
        if (!textarea) return;
        const content = textarea.value.trim();
        if (!content) {
            toastInfo("请先输入要添加的核心记忆内容");
            return;
        }
        const data = getChatData();
        if (!data.coreMemories) data.coreMemories = [];
        const entry = {
            id: `manual-core-${Date.now()}`,
            time: new Date().toLocaleString(),
            timestamp: Date.now(),
            content: content,
            sourceIds: [], // 手动添加的没有来源摘要
            source: "manual",
        };
        data.coreMemories.push(entry);
        lastAddedCoreId = entry.id;
        saveChatData();
        updateInjection();
        textarea.value = "";
        renderCoreMemories();
        toastSuccess("已手动添加一条核心记忆");
    });

    // 核心记忆筛选：时间范围 / 最小字数 / 最大字数
    document.getElementById("mem-core-filter-time")?.addEventListener("change", (e) => {
        s.coreFilterTimeRange = e.target.value;
        saveSettings();
        coreShowAll = false;
        renderCoreMemories();
    });
    document.getElementById("mem-core-filter-min")?.addEventListener("change", (e) => {
        s.coreFilterMinChars = Math.max(0, parseInt(e.target.value) || 0);
        saveSettings();
        coreShowAll = false;
        renderCoreMemories();
    });
    document.getElementById("mem-core-filter-max")?.addEventListener("change", (e) => {
        s.coreFilterMaxChars = Math.max(0, parseInt(e.target.value) || 0);
        saveSettings();
        coreShowAll = false;
        renderCoreMemories();
    });
    document.getElementById("mem-core-hide-deprecated")?.addEventListener("change", (e) => {
        s.coreHideDeprecated = e.target.checked;
        saveSettings();
        coreShowAll = false;
        renderCoreMemories();
    });

    // 核心记忆排序切换按钮
    document.getElementById("mem-core-order-toggle")?.addEventListener("click", () => {
        s.coreOrder = s.coreOrder === "desc" ? "asc" : "desc";
        saveSettings();
        updateInjection();
        renderCoreMemories();
        updateOrderToggleButton("mem-core-order-toggle", s.coreOrder);
    });

    // 核心记忆分页按钮事件委托
    document.getElementById("mem-core-pagination")?.addEventListener("click", (e) => {
        const target = e.target.closest("button");
        if (!target) return;
        if (target.id === "mem-core-show-all") {
            coreShowAll = true;
            renderCoreMemories();
        } else if (target.id === "mem-core-show-less") {
            coreShowAll = false;
            renderCoreMemories();
        }
    });

    // 分页按钮事件委托
    document.getElementById("mem-summary-pagination")?.addEventListener("click", (e) => {
        const target = e.target.closest("button");
        if (!target) return;
        if (target.id === "mem-show-all") {
            summaryShowAll = true;
            renderPanel();
        } else if (target.id === "mem-show-less") {
            summaryShowAll = false;
            renderPanel();
        }
    });

    document.getElementById("mem-count")?.addEventListener("change", (e) => {
        s.messagesPerSummary = Math.max(1, parseInt(e.target.value) || 1);
        saveSettings();
        updateStatusLine();
    });

    document.getElementById("mem-auto")?.addEventListener("change", (e) => {
        s.autoSummarize = e.target.checked;
        saveSettings();
        updateStatusLine();
    });

    document.getElementById("mem-prompt")?.addEventListener("change", (e) => {
        s.promptTemplate = e.target.value;
        saveSettings();
    });

    document.getElementById("mem-style-ref")?.addEventListener("change", (e) => {
        s.includeStyleReference = e.target.checked;
        saveSettings();
    });
    document.getElementById("mem-style-ref-n")?.addEventListener("change", (e) => {
        s.styleReferenceCount = Math.max(0, parseInt(e.target.value) || 0);
        saveSettings();
    });
    document.getElementById("mem-summary-warn-threshold")?.addEventListener("change", (e) => {
        s.summaryWarnThreshold = Math.max(0, parseInt(e.target.value) || 0);
        saveSettings();
        updateStatusLine();
    });
    document.getElementById("mem-core-warn-threshold")?.addEventListener("change", (e) => {
        s.coreWarnThreshold = Math.max(0, parseInt(e.target.value) || 0);
        saveSettings();
        updateStatusLine();
    });

    document.getElementById("mem-run-now")?.addEventListener("click", async () => {
        await runSummarization(true);
    });

    document.getElementById("mem-inject")?.addEventListener("change", (e) => {
        s.autoInject = e.target.checked;
        saveSettings();
        updateInjection();
        updateWiWriteAvailability(); // 开关"自动注入"会直接影响"写入世界书"按钮是否可用
    });
    document.getElementById("mem-inject-pos")?.addEventListener("change", (e) => {
        s.injectPosition = e.target.value;
        saveSettings();
        toggleInjectPositionSubrow();
        updateInjection();
    });
    document.getElementById("mem-inject-depth")?.addEventListener("change", (e) => {
        s.injectDepth = Math.max(0, parseInt(e.target.value) || 0);
        saveSettings();
        updateInjection();
    });
    document.getElementById("mem-inject-role")?.addEventListener("change", (e) => {
        s.injectRole = e.target.value;
        saveSettings();
        updateInjection();
    });
    document.getElementById("mem-inject-n")?.addEventListener("change", (e) => {
        s.injectCount = Math.max(1, parseInt(e.target.value) || 1);
        saveSettings();
        updateInjection();
    });
    document.getElementById("mem-inject-template-summary")?.addEventListener("change", (e) => {
        s.injectTemplateSummary = e.target.value;
        saveSettings();
        updateInjection();
    });
    document.getElementById("mem-inject-template-core")?.addEventListener("change", (e) => {
        s.injectTemplateCore = e.target.value;
        saveSettings();
        updateInjection();
    });

    document.getElementById("mem-wi-book")?.addEventListener("change", (e) => {
        s.wiBookName = e.target.value;
        saveSettings();
    });
    document.getElementById("mem-wi-position")?.addEventListener("change", (e) => {
        s.wiPosition = e.target.value;
        saveSettings();
        toggleWiAtDepthRow();
    });
    document.getElementById("mem-wi-depth")?.addEventListener("change", (e) => {
        s.wiDepth = Math.max(0, parseInt(e.target.value) || 0);
        saveSettings();
    });
    document.getElementById("mem-wi-role")?.addEventListener("change", (e) => {
        s.wiRole = e.target.value;
        saveSettings();
    });
    document.getElementById("mem-wi-write-summary")?.addEventListener("click", async (e) => {
        await writeMergedMemoryToWorldInfo("summary", e.currentTarget);
    });
    document.getElementById("mem-wi-write-core")?.addEventListener("click", async (e) => {
        await writeMergedMemoryToWorldInfo("core", e.currentTarget);
    });

    document.getElementById("mem-copy-all")?.addEventListener("click", () => {
        const data = getChatData();
        const text = data.summaries.map((x) => x.content).join("\n\n");
        if (!text) {
            toastInfo("还没有任何总结");
            return;
        }
        copyToClipboard(text, "已复制全部总结");
    });

    document.getElementById("mem-clear-summaries")?.addEventListener("click", async () => {
        const data = getChatData();
        if (data.summaries.length === 0) {
            toastInfo("当前没有可清空的摘要");
            return;
        }
        const confirmed = await showModal({
            title: "清空摘要文本",
            bodyHtml: `
                <div class="mem-modal-line">确定要清空当前聊天已保存的全部 ${data.summaries.length} 条摘要文本吗？</div>
                <div class="mem-modal-line">总结进度不会被重置，这些消息不会重新计入"待总结"队列，也不会被自动重新总结。</div>
                <div class="mem-modal-line" style="color:#e0a05a">⚠️ 注意：这个操作<b>不会经过回收站</b>，清空后无法恢复（回收站只保留单条删除，一次性清空不受保护）。</div>
            `,
            confirmText: "确认清空",
            cancelText: "取消",
            danger: true,
        });
        if (!confirmed) return;
        data.summaries = [];
        selectedForCoreIds.clear();
        saveChatData();
        updateInjection();
        renderPanel();
        toastSuccess("已清空当前聊天的全部摘要文本");
    });

    document.getElementById("mem-reset-progress")?.addEventListener("click", async () => {
        const confirmed = await showModal({
            title: "重置总结进度",
            bodyHtml: `
                <div class="mem-modal-line">确定要重置总结进度吗？</div>
                <div class="mem-modal-line">重置后，全部聊天记录会重新计为"待总结"状态；如果开着自动总结，接下来可能会连续触发多次总结请求，消耗较多 Token。</div>
                <div class="mem-modal-line">已保存的摘要文本不会被清空或修改。</div>
            `,
            confirmText: "确认重置",
            cancelText: "取消",
            danger: true,
        });
        if (!confirmed) return;
        const data = getChatData();
        data.lastSummarizedIndex = 0;
        saveChatData();
        renderPanel();
        toastSuccess("已重置总结进度");
    });

    document.getElementById("mem-export-btn")?.addEventListener("click", () => {
        exportData();
    });
    document.getElementById("mem-import-btn")?.addEventListener("click", () => {
        document.getElementById("mem-import-file")?.click();
    });
    document.getElementById("mem-import-file")?.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        e.target.value = ""; // 重置一下，保证再次选同一个文件也能触发 change
        if (!file) return;
        await importDataFromFile(file);
    });

    // 回收站按钮
    document.getElementById("mem-trash-btn")?.addEventListener("click", async () => {
        const validItems = getValidTrashItems();
        if (validItems.length === 0) {
            toastInfo("回收站是空的（被删除的记忆最多保留 10 条、24 小时内可恢复）");
            return;
        }

        const itemsHtml = validItems.map((t, i) => {
            const ago = Math.round((Date.now() - t.deletedAt) / 60000);
            const agoText = ago < 60 ? `${ago} 分钟前删除` : `${Math.round(ago / 60)} 小时前删除`;
            const typeLabel = t.type === "core" ? "核心记忆" : "长期记忆";
            const preview = (t.entry.content || "").slice(0, 80) + ((t.entry.content || "").length > 80 ? "…" : "");
            return `
                <label class="mem-trash-item">
                    <input type="checkbox" class="mem-trash-chk" data-trash-idx="${i}" checked />
                    <div class="mem-trash-info">
                        <span class="mem-badge ${t.type ==="core" ? "mem-badge-core" : "mem-badge-auto"}">${escapeHtml(typeLabel)}</span>
                        <span class="mem-trash-ago">${escapeHtml(agoText)}</span>
                        <div class="mem-trash-preview">${escapeHtml(preview)}</div>
                    </div>
                </label>`;
        }).join("");

        const result = await showModal({
            title: "回收站",
            bodyHtml: `
                <div class="mem-modal-line">以下是最近删除的记忆（24 小时内可恢复，最多保留 10 条）：</div>
                <div class="mem-modal-line" style="margin-top:4px;font-size:0.82em;opacity:0.65">勾选要恢复的条目，点击"恢复选中"即可放回原位。</div>
                <div class="mem-trash-list">${itemsHtml}</div>
            `,
            confirmText: "恢复选中",
            cancelText: "关闭",
            showCancel: true,
            onConfirm: (bodyEl) => {
                const checked = Array.from(bodyEl.querySelectorAll(".mem-trash-chk:checked"));
                return checked.map((chk) => parseInt(chk.dataset.trashIdx, 10)).filter((n) => !isNaN(n));
            },
        });

        if (!result) return; // 点了"关闭"或按了 Esc，直接退出，不提示
        if (!Array.isArray(result) || result.length === 0) {
            toastInfo("没有勾选任何条目，未恢复");
            return;
        }

        const data = getChatData();
        let restoredSummary = 0;
        let restoredCore = 0;

        // 按索引从大到小排序，这样从后往前 splice 不会打乱前面的索引
        const sortedIndices = result.slice().sort((a, b) => b - a);
        for (const idx of sortedIndices) {
            if (idx < 0 || idx >= validItems.length) continue;
            const trashItem = validItems[idx];
            if (trashItem.type === "core") {
                if (!data.coreMemories) data.coreMemories = [];
                data.coreMemories.push(trashItem.entry);
                restoredCore++;
            } else {
                data.summaries.push(trashItem.entry);
                restoredSummary++;
            }
            // 从 trashBin 里移除已恢复的条目
            const binIdx = data.trashBin.indexOf(trashItem);
            if (binIdx !== -1) data.trashBin.splice(binIdx, 1);
        }

        saveChatData();
        updateInjection();
        renderPanel();
        updateTrashCount();

        const parts = [];
        if (restoredSummary > 0) parts.push(`${restoredSummary} 条长期记忆`);
        if (restoredCore > 0) parts.push(`${restoredCore} 条核心记忆`);
        toastSuccess(`已恢复 ${parts.join("、")}`);
    });

    document.getElementById("mem-wi-refresh")?.addEventListener("click", () => {
        populateWorldBookSelect();
        populateWiPositionSelect();
        toggleWiAtDepthRow();
        toastInfo("世界书列表已刷新");
    });

    // 记住折叠面板展开/收起状态，下次打开酒馆时保持一致
    const toggleEl = document.querySelector("#mem-summarizer-panel .inline-drawer-toggle");
    if (toggleEl) {
        toggleEl.addEventListener("click", () => {
            const st = getSettings();
            st.panelOpen = !st.panelOpen;
            saveSettings();
        });
    }

    // "高级"折叠分组（总结设置 / 注入设置 / 世界书 / 长期记忆）展开收起：
    // 用 CSS class 驱动 grid-template-rows 过渡做平滑动画（见 style.css 的 .mem-collapse），
    // 这里只负责切 class、转箭头方向、更新 aria-expanded，并把状态记到插件设置里，
    // 下次打开面板时保持用户上次留下的展开状态。每个分组只在这里绑定一次监听，
    // 不会随着列表内容重渲染（renderPanel/renderCoreMemories）而重复绑定或丢失。
    document.querySelectorAll(".mem-section-toggle").forEach((toggleBtn) => {
        toggleBtn.addEventListener("click", () => {
            const key = toggleBtn.dataset.target;
            const collapseEl = document.getElementById(`mem-collapse-${key}`);
            const settingKey = SECTION_SETTING_KEYS[key];
            if (!collapseEl) return;
            const isOpen = !collapseEl.classList.contains("open");
            collapseEl.classList.toggle("open", isOpen);
            toggleBtn.classList.toggle("open", isOpen);
            toggleBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
            if (settingKey) {
                s[settingKey] = isOpen;
                saveSettings();
            }
        });
    });

    // =====================  新增事件绑定 =====================

    // 手动添加记忆
    document.getElementById("mem-manual-add-btn")?.addEventListener("click", () => {
        const textarea = document.getElementById("mem-manual-add-text");
        if (!textarea) return;
        const content = textarea.value.trim();
        if (!content) {
            toastInfo("请先输入要添加的记忆内容");
            return;
        }
        const data = getChatData();
        const entry = {
            id: `manual-${Date.now()}`,
            time: new Date().toLocaleString(),
            timestamp: Date.now(),
            range: [0, 0], // 手动添加的没有消息范围
            content: content,
            auto: false,
            source: "manual",
            tier: "normal",
        };
        data.summaries.push(entry);
        // 注意：不修改 lastSummarizedIndex，手动添加不影响自动总结计数器
        lastAddedSummaryId = entry.id;
        saveChatData();
        updateInjection();
        textarea.value = "";
        renderPanel();
        toastSuccess("已手动添加一条记忆");
    });

    // 筛选：时间范围
    document.getElementById("mem-filter-time")?.addEventListener("change", (e) => {
        s.filterTimeRange = e.target.value;
        saveSettings();
        summaryShowAll = false;
        renderPanel();
    });

    // 筛选：最小字数
    document.getElementById("mem-filter-min")?.addEventListener("change", (e) => {
        s.filterMinChars = Math.max(0, parseInt(e.target.value) || 0);
        saveSettings();
        summaryShowAll = false;
        renderPanel();
    });

    // 筛选：最大字数
    document.getElementById("mem-filter-max")?.addEventListener("change", (e) => {
        s.filterMaxChars = Math.max(0, parseInt(e.target.value) || 0);
        saveSettings();
        summaryShowAll = false;
        renderPanel();
    });

    // 筛选：分级
    document.getElementById("mem-filter-tier")?.addEventListener("change", (e) => {
        s.filterTier = e.target.value;
        saveSettings();
        summaryShowAll = false;
        renderPanel();
    });

    // 长期记忆全文搜索：关键词本身立即更新，但重渲染整个列表做了防抖（见 debounce 定义处的说明）
    const debouncedRenderPanelForSearch = debounce(() => renderPanel(), 200);
    document.getElementById("mem-search")?.addEventListener("input", (e) => {
        searchKeyword = e.target.value;
        summaryShowAll = false;
        debouncedRenderPanelForSearch();
    });

    // 核心记忆全文搜索
    const debouncedRenderCoreForSearch = debounce(() => renderCoreMemories(), 200);
    document.getElementById("mem-core-search")?.addEventListener("input", (e) => {
        coreSearchKeyword = e.target.value;
        coreShowAll = false;
        debouncedRenderCoreForSearch();
    });
    // 排序切换按钮
    document.getElementById("mem-order-toggle")?.addEventListener("click", () => {
        s.summaryOrder = s.summaryOrder === "desc" ? "asc" : "desc";
        saveSettings();
        updateInjection(); // 排序也影响注入
        renderPanel();
        updateOrderToggleButton("mem-order-toggle", s.summaryOrder);
    });

    populateWorldBookSelect();
    populateWiPositionSelect();
    toggleWiAtDepthRow();
    toggleInjectPositionSubrow();
    updateWiWriteAvailability();

    // 事件委托：总结列表里的按钮（列表会被重新渲染，所以在父容器上监听）
    const list = document.getElementById("mem-summary-list");
    if (!list) return; // 面板没渲染出来时不绑定，避免空指针
    list.addEventListener("click", async (e) => {
        const target = e.target.closest("button");
        const id = target?.dataset?.id;
        if (!id) return;
        try {
            const data = getChatData();
            const entryIndex = data.summaries.findIndex((x) => x.id === id);
            if (entryIndex === -1) return;

            if (target.classList.contains("mem-copy-one")) {
                copyToClipboard(data.summaries[entryIndex].content, "已复制该条总结");
            } else if (target.classList.contains("mem-delete-one")) {
                // 删除只移除这条摘要文本，不会让对应的消息重新变回"待总结"状态
                // （lastSummarizedIndex 不受影响），避免同一段对话被重复总结、重复消耗 Token。
                if (!confirm('删除这条总结？将移入回收站（24小时内可恢复，最多保留10条）。')) return;
                const removedSummary = data.summaries.splice(entryIndex, 1)[0];
                moveToTrash(removedSummary, "summary");
                selectedForCoreIds.delete(id);
                saveChatData();
                updateInjection();
                renderPanel();
                updateTrashCount();
            }
        } catch (err) {
            // 委托点击回调本身是 async 函数，抛出的异常会变成"未处理的 Promise 拒绝"而不是
            // 正常冒泡，必须自己兜底捕获，否则这次操作会在用户毫无感知的情况下静默失败。
            console.error("[记忆总结助手] 处理长期记忆列表点击事件异常：", err);
            toastError(`操作失败：${extractErrorReason(err)}`);
        }
    });

    list.addEventListener("change", (e) => {
        const target = e.target;
        const id = target?.dataset?.id;
        if (!id) return;
        if (target.classList.contains("mem-summary-text")) {
            const data = getChatData();
            const entry = data.summaries.find((x) => x.id === id);
            if (entry) {
                entry.content = target.value;
                saveChatData();
                updateInjection();
            }
        } else if (target.classList.contains("mem-select-for-core")) {
            // 记住勾选状态，避免筛选/排序/分页变化重渲染整个列表后勾选丢失
            if (target.checked) {
                selectedForCoreIds.add(id);
            } else {
                selectedForCoreIds.delete(id);
            }
        } else if (target.classList.contains("mem-tier-select")) {
            const data = getChatData();
            const entry = data.summaries.find((x) => x.id === id);
            if (entry) {
                entry.tier = target.value;
                saveChatData();
                updateInjection(); // 废弃/重要都会影响注入范围，必须重新计算
                renderPanel();     // 当前如果有分级筛选，这条可能需要从列表里消失/出现
            }
        }
    });

    // 拖拽排序只需要绑定一次：listEl 容器本身在整个面板生命周期内不会被替换
    // （renderPanel 只替换它的 innerHTML），如果放在 renderPanel() 里每次重渲染都重新绑定，
    // touchstart/mousedown 等监听会不断叠加且永远不会被清理，长时间使用后拖拽会越来越卡、
    // 甚至一次触摸触发多次 startDrag。绑定一次，内部逻辑通过实时查询 DOM 适配每次新内容。
    bindDragSort(list, { dataKey: "summaries", orderSettingKey: "summaryOrder" });
}

// ===================== 拖拽排序 =====================
// 在触摸屏上通过长按触发拖拽，桌面端通过 mousedown 长按触发。
// 拖拽期间移动到哪个条目上方就把被拖动的条目插到它前面，松手后保存到 chatMetadata。
// 长期记忆列表、核心记忆列表都用这一份实现，靠 options 区分各自要操作的数据数组和排序设置。
//
// 重要：这个函数只应该在面板初始化时对每个列表容器调用一次（见 bindPanelEvents），
// 不能放进 renderPanel()/renderCoreMemories() 里每次重渲染都调用一次——虽然内部有
// _memDragCleanup 兜底清理，但如果外部反复调用，touchstart/mousedown 等监听会先加后清，
// 频繁增删本身也是不必要的开销；真正的设计意图是"绑一次、内部实时查询 DOM 适配新内容"。
function bindDragSort(listEl, options) {
    if (!listEl) return;
    const dataKey = options?.dataKey === "coreMemories" ? "coreMemories" : "summaries";
    const orderSettingKey = options?.orderSettingKey === "coreOrder" ? "coreOrder" : "summaryOrder";

    // 防止重复绑定：如果这个元素之前已经绑过（正常流程下不会发生，双重保险），
    // 先把上一次绑的全部监听（包括元素自身的 touchstart/mousedown 等）彻底清理掉，
    // 否则重复调用会导致同一个手势触发多次 startDrag，长期使用后越来越卡。
    if (listEl._memDragCleanup) {
        listEl._memDragCleanup();
    }

    let longPressTimer = null;
    let isDragging = false;
    let dragEl = null;
    let dragId = null;
    let placeholder = null;
    let startY = 0;
    let offsetY = 0;

    function getYFromEvent(e) {
        if (e.touches && e.touches.length > 0) return e.touches[0].clientY;
        return e.clientY;
    }

    function startDrag(itemEl, y) {
        isDragging = true;
        dragEl = itemEl;
        dragId = itemEl.dataset.id;
        const rect = itemEl.getBoundingClientRect();
        offsetY = y - rect.top;
        startY = y;

        // 创建占位符
        placeholder = document.createElement("div");
        placeholder.className = "mem-drag-placeholder";
        placeholder.style.height = rect.height + "px";
        itemEl.parentNode.insertBefore(placeholder, itemEl);

        // 让被拖动的元素浮起来
        itemEl.classList.add("mem-dragging");
        itemEl.style.position = "fixed";
        itemEl.style.left = rect.left + "px";
        itemEl.style.top = (y - offsetY) + "px";
        itemEl.style.width = rect.width + "px";
        itemEl.style.zIndex = "10000";
        itemEl.style.pointerEvents = "none";
    }

    function moveDrag(y) {
        if (!isDragging || !dragEl || !placeholder) return;
        dragEl.style.top = (y - offsetY) + "px";

        // 找到当前鼠标/手指所在的目标条目
        const items = Array.from(listEl.querySelectorAll(".mem-summary-item:not(.mem-dragging)"));
        for (const item of items) {
            const rect = item.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (y < midY) {
                if (item !== placeholder.nextElementSibling) {
                    listEl.insertBefore(placeholder, item);
                }
                return;
            }
        }
        // 拖到最下面
        if (placeholder.nextElementSibling !== null) {
            listEl.appendChild(placeholder);
        }
    }

    function endDrag() {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        if (!isDragging || !dragEl || !placeholder) {
            isDragging = false;
            return;
        }

        // 把拖动元素放回占位符的位置
        listEl.insertBefore(dragEl, placeholder);
        placeholder.remove();
        placeholder = null;

        // 恢复样式
        dragEl.classList.remove("mem-dragging");
        dragEl.style.position = "";
        dragEl.style.left = "";
        dragEl.style.top = "";
        dragEl.style.width = "";
        dragEl.style.zIndex = "";
        dragEl.style.pointerEvents = "";

        // 读取当前 DOM 顺序，更新对应数据数组（summaries 或 coreMemories）的顺序
        const newOrderIds = Array.from(listEl.querySelectorAll(".mem-summary-item"))
            .map((el) => el.dataset.id)
            .filter(Boolean);

        if (newOrderIds.length > 0) {
            const data = getChatData();
            const s = getSettings();
            const list = data[dataKey] || [];
            const idToEntry = new Map(list.map((x) => [x.id, x]));

            // 如果当前显示的是倒序，DOM 顺序和存储顺序是相反的：
            // DOM 第一个 = 最新的 = 存储数组的最后一个。
            // 所以倒序时要把 DOM 顺序 reverse 回来再存。
            const displayIds = s[orderSettingKey] === "desc"
                ? newOrderIds.slice().reverse()
                : newOrderIds;

            // 重建数组：先按 displayIds 排，剩余不在当前筛选结果里的条目
            // 保持原来的相对位置追加在后面（筛选隐藏的条目不能丢）
            const reorderedSet = new Set(displayIds);
            const reordered = displayIds.map((id) => idToEntry.get(id)).filter(Boolean);
            const remaining = list.filter((x) => !reorderedSet.has(x.id));
            data[dataKey] = reordered.concat(remaining);

            saveChatData();
            updateInjection();
        }

        dragEl = null;
        dragId = null;
        isDragging = false;
    }

    // 长按 300ms 后开始拖动
    function onPointerDown(e) {
        // 只对 .mem-summary-item 的非交互区域生效（不拦截 textarea、button、input、checkbox 的事件）
        const target = e.target;
        if (target.closest("textarea, button, input, select, a, .mem-summary-actions")) return;

        const itemEl = target.closest(".mem-summary-item");
        if (!itemEl) return;

        const y = getYFromEvent(e);
        startY = y; // 立即记录按下位置，用于滑动取消判断
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            startDrag(itemEl, y);
        }, 300);
    }

    function onPointerMove(e) {
        if (longPressTimer && Math.abs(getYFromEvent(e) - startY) > 10) {
            // 还没触发长按就已经在滑动了，取消长按（用户可能只是想滚动页面）
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        if (isDragging) {
            e.preventDefault(); // 拖动期间阻止滚动
            moveDrag(getYFromEvent(e));
        }
    }

    function onPointerUp() {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        if (isDragging) {
            endDrag();
        }
    }

    // 触摸事件
    listEl.addEventListener("touchstart", onPointerDown, { passive: true });
    listEl.addEventListener("touchmove", onPointerMove, { passive: false });
    listEl.addEventListener("touchend", onPointerUp);
    listEl.addEventListener("touchcancel", onPointerUp);

    // 鼠标事件（桌面端）
    listEl.addEventListener("mousedown", onPointerDown);
    document.addEventListener("mousemove", onPointerMove);
    document.addEventListener("mouseup", onPointerUp);

    // 记录清理函数：下次（理论上）重复调用 bindDragSort 时先清理，防止重复绑定。
    // 之前的版本这里只清理了 document 级的 mousemove/mouseup，遗漏了 listEl 自身的
    // touchstart/touchmove/touchend/touchcancel/mousedown——而 listEl 这个容器节点
    // 在整个面板生命周期内是同一个 DOM 元素（renderPanel 只替换它的 innerHTML），
    // 如果这个函数曾经被每次渲染都调用（本插件之前的版本确实如此），这些监听会只增不减，
    // 用得越久越卡，是长期运行稳定性的一个真实隐患，这里一并修掉。
    listEl._memDragCleanup = () => {
        listEl.removeEventListener("touchstart", onPointerDown);
        listEl.removeEventListener("touchmove", onPointerMove);
        listEl.removeEventListener("touchend", onPointerUp);
        listEl.removeEventListener("touchcancel", onPointerUp);
        listEl.removeEventListener("mousedown", onPointerDown);
        document.removeEventListener("mousemove", onPointerMove);
        document.removeEventListener("mouseup", onPointerUp);
    };
}

// ------------------------ 初始化 ------------------------
// 用一个全局标记防止模块被重复执行时重复绑定事件监听（比如某些环境下的热重载场景），
// 避免出现"同一条消息触发两次自动总结"这类由重复监听导致的问题。
if (window.__memSummarizerLoaded) {
    console.warn("[记忆总结助手] 检测到扩展被重复加载，已跳过本次初始化以避免重复绑定事件监听");
} else {
    window.__memSummarizerLoaded = true;

    jQuery(async () => {
        const settingsHtml = buildPanelHtml();
        $("#extensions_settings2").append(settingsHtml);

        bindPanelEvents();
        renderPanel();
        updateInjection();
        updateTrashCount();

        // 监听消息事件，自动计数/自动总结
        eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
        eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
        eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
        eventSource.on(event_types.CHAT_CHANGED, () => {
            try {
                manualReminderCount = 0;
                summaryShowAll = false;
                coreShowAll = false;
                // 切换聊天后，之前勾选的"待提取核心"条目属于上一个聊天，直接清空，
                // 避免误把这次聊天里同名 id（理论上不会重复，但清空更保险）的条目带入提取。
                selectedForCoreIds.clear();
                // 清空搜索词，避免把上一个聊天的搜索词带到新聊天
                searchKeyword = "";
                coreSearchKeyword = "";
                const searchEl = document.getElementById("mem-search");
                if (searchEl) searchEl.value = "";
                const coreSearchEl = document.getElementById("mem-core-search");
                if (coreSearchEl) coreSearchEl.value = "";
                renderPanel();
                updateInjection();
                // 回收站是存在每个聊天自己的 chatMetadata 里的，换了聊天数量也要跟着刷新
                updateTrashCount();
            } catch (e) {
                console.error("[记忆总结助手] 处理聊天切换事件异常：", e);
            }
        });

        console.log("[记忆总结助手] 插件已加载 v1.0.0");
    });
}
