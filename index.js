// ============================================================
// 记忆总结助手 Memory Summarizer  v1.1.0
// 一个 SillyTavern 第三方扩展：
//   - 按设定条数自动/手动把最近的对话喂给 AI 生成摘要
//   - 摘要保存在扩展内，可编辑、复制
//   - 支持"自动注入上下文"（相当于引用到预设）
//   - 支持"写入世界书条目"
//   - 支持总结时携带最近旧摘要作为"风格参考"，统一多次总结的文风（不会重新总结旧摘要）
//
// v1.1.0 更新：
//   - 新增"风格参考"：总结新内容时可选携带最近 N 条旧摘要发给 AI，
//     并在提示词中明确告知"这些仅供参考、不需要重新总结"，用于统一摘要风格。
//     旧摘要本身绝不会被修改或重新生成，新摘要始终追加在数组末尾。
//   - 自动总结触发、成功、失败均有 toast 提示；失败提示会带上具体原因。
//   - 修复：自动模式下如果积压消息超过设定条数，此前会把全部积压一次性塞给 AI
//     （可能非常长/浪费token），现在自动模式固定按"设定条数"分块处理。
//   - 修复：连续触发（比如用户发送消息与AI回复几乎同时到达）可能导致同一段
//     对话被并发总结两次，现在加了执行锁。
//   - 修复：总结内容中若包含 </textarea> 等片段会破坏面板渲染，现在做了转义。
//   - 修复：总结进行到一半切换聊天，结果可能被错误地写入旧聊天的场景，现在会检测并放弃过期结果。
//   - 界面：新增进度条、自动/手动标签、加载状态、空状态提示、世界书列表刷新按钮，
//     记住折叠面板的展开/收起状态，整体在手机浏览器上更好点按。
// ============================================================

import {
    getContext,
    extension_settings,
    renderExtensionTemplateAsync,
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
    injectPosition: "IN_PROMPT",      // IN_PROMPT / IN_CHAT
    injectDepth: 4,
    injectRole: "system",             // system / user / assistant
    injectCount: 3,                   // 注入时合并最近几条摘要
    panelOpen: false,                 // 记住面板展开/收起状态
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
        };
    }
    return context.chatMetadata[MODULE_NAME];
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
    // 兼容旧版本缺字段的情况
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
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

// 转义要塞进 innerHTML 模板里的文本（总结内容来自 AI/用户输入，不可信任），
// 防止内容里出现 </textarea>、<script> 等片段破坏面板或引发意外行为
function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatMessagesForPrompt(messages) {
    return messages
        .filter((m) => !m.is_system && stripHtml(m.mes))
        .map((m) => `${m.name || (m.is_user ? "User" : "AI")}: ${stripHtml(m.mes)}`)
        .join("\n");
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

// ------------------------ 拼装最终发给 AI 的提示词 ------------------------
// 如果开启了"风格参考"，会把最近 N 条旧摘要一起发给 AI，并明确告知
// 这些内容不需要重新总结，只是用来统一多次总结之间的写作风格/语气/剧情脉络。
// 旧摘要数据本身不会被这个函数修改。
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

    return prefix + s.promptTemplate.replace("{{content}}", newContent);
}

// ------------------------ 核心：生成总结 ------------------------

async function runSummarization(manual = false) {
    const settings = getSettings();
    const context = getContext();
    const chat = context.chat || [];
    const data = getChatData();

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
    // 也可以随时点"立即总结一次"手动把剩余积压一次清空。
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

    try {
        if (typeof context.generateQuietPrompt !== "function") {
            throw new Error("当前酒馆版本未找到 generateQuietPrompt 接口，可能与本扩展不兼容");
        }

        const prompt = buildFinalPrompt(content);
        const result = await context.generateQuietPrompt(prompt, false, false);

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
            time: new Date().toLocaleString(),
            range: [startIdx, endIdx],
            content: trimmed,
            auto: !manual,
        };
        data.summaries.push(entry);
        data.lastSummarizedIndex = endIdx;
        saveChatData();

        toastSuccess(`${manual ? "手动" : "自动"}总结完成（消息 ${startIdx + 1}-${endIdx}）`);

        if (settings.autoInject) {
            updateInjection();
        }
    } catch (e) {
        console.error("[记忆总结助手] 生成总结失败：", e);
        toastError(`总结失败：${extractErrorReason(e)}`, { timeOut: 8000, extendedTimeOut: 4000 });
    } finally {
        isSummarizing = false;
        setRunButtonLoading(false);
        renderPanel();
    }
}

// ------------------------ 自动注入到上下文 ------------------------

function updateInjection() {
    const settings = getSettings();
    const context = getContext();
    const data = getChatData();

    if (!settings.autoInject) {
        context.setExtensionPrompt(MODULE_NAME, "", extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    const recent = data.summaries.slice(-settings.injectCount);
    if (recent.length === 0) return;

    const combined =
        "【剧情记忆摘要】\n" + recent.map((s) => `- ${s.content}`).join("\n");

    const positionMap = {
        IN_PROMPT: extension_prompt_types.IN_PROMPT,
        IN_CHAT: extension_prompt_types.IN_CHAT,
    };
    const roleMap = {
        system: extension_prompt_roles.SYSTEM,
        user: extension_prompt_roles.USER,
        assistant: extension_prompt_roles.ASSISTANT,
    };

    context.setExtensionPrompt(
        MODULE_NAME,
        combined,
        positionMap[settings.injectPosition] ?? extension_prompt_types.IN_PROMPT,
        settings.injectDepth,
        false,
        roleMap[settings.injectRole] ?? extension_prompt_roles.SYSTEM
    );
}

// ------------------------ 写入世界书 ------------------------

async function writeToWorldInfo(bookName, content, keysStr) {
    if (!WI_API) {
        toastError("世界书接口未加载成功，无法直接写入，请使用复制按钮手动粘贴");
        return;
    }
    try {
        const data = await WI_API.loadWorldInfo(bookName);
        if (!data) {
            toastError("找不到该世界书，请先在酒馆里创建/选择一个世界书");
            return;
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
        await WI_API.saveWorldInfo(bookName, data, true);
        toastSuccess(`已写入世界书《${bookName}》`);
    } catch (e) {
        console.error("[记忆总结助手] 写入世界书失败：", e);
        toastError(
            `写入世界书失败：${extractErrorReason(e)}（可改用复制按钮手动粘贴）`,
            { timeOut: 8000, extendedTimeOut: 4000 }
        );
    }
}

// ------------------------ 事件：监听新消息，自动计数 ------------------------

async function onChatEvent() {
    const settings = getSettings();
    if (!settings.autoSummarize) {
        renderPanel();
        return;
    }
    try {
        await runSummarization(false);
    } catch (e) {
        // runSummarization 内部已经处理了总结失败的提示，这里兜底防止未捕获异常
        console.error("[记忆总结助手] 自动总结流程异常：", e);
    }
    renderPanel();
}

// ------------------------ UI 渲染 ------------------------

function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
}

function buildPanelHtml() {
    const s = getSettings();
    return `
    <div id="mem-summarizer-panel" class="mem-summarizer-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📝 记忆总结助手</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content"${s.panelOpen ? ' style="display:block"' : ""}>

                <div class="mem-row">
                    <label>每几条对话自动总结一次：</label>
                    <input type="number" id="mem-count" min="1" value="${s.messagesPerSummary}" />
                </div>

                <div class="mem-row">
                    <label><input type="checkbox" id="mem-auto" ${s.autoSummarize ? "checked" : ""}/> 达到条数自动总结</label>
                </div>

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

                <div class="mem-row mem-status" id="mem-status"></div>

                <div class="mem-row">
                    <button id="mem-run-now" class="menu_button mem-btn-primary"><i class="fa-solid fa-wand-magic-sparkles"></i> 立即总结一次</button>
                </div>

                <hr/>

                <div class="mem-row">
                    <label><input type="checkbox" id="mem-inject" ${s.autoInject ? "checked" : ""}/> 自动注入到上下文（相当于引用到预设）</label>
                </div>
                <div class="mem-row mem-inline">
                    <label>位置：
                        <select id="mem-inject-pos">
                            <option value="IN_PROMPT" ${s.injectPosition === "IN_PROMPT" ? "selected" : ""}>主提示词内</option>
                            <option value="IN_CHAT" ${s.injectPosition === "IN_CHAT" ? "selected" : ""}>聊天记录中(按深度)</option>
                        </select>
                    </label>
                    <label>深度：<input type="number" id="mem-inject-depth" min="0" value="${s.injectDepth}" style="width:60px"/></label>
                    <label>角色：
                        <select id="mem-inject-role">
                            <option value="system" ${s.injectRole === "system" ? "selected" : ""}>系统</option>
                            <option value="user" ${s.injectRole === "user" ? "selected" : ""}>用户</option>
                            <option value="assistant" ${s.injectRole === "assistant" ? "selected" : ""}>AI</option>
                        </select>
                    </label>
                    <label>合并最近：<input type="number" id="mem-inject-n" min="1" value="${s.injectCount}" style="width:50px"/> 条</label>
                </div>

                <hr/>

                <div class="mem-row mem-inline">
                    <button id="mem-copy-all" class="menu_button"><i class="fa-solid fa-copy"></i> 复制全部总结</button>
                    <button id="mem-clear-all" class="menu_button danger"><i class="fa-solid fa-trash-can"></i> 清空本聊天全部总结</button>
                </div>

                <div class="mem-row mem-inline">
                    <label>写入世界书 - 选择世界书：</label>
                    <select id="mem-wi-book"></select>
                    <button id="mem-wi-refresh" class="menu_button mem-btn-icon" title="刷新世界书列表"><i class="fa-solid fa-rotate"></i></button>
                </div>

                <div id="mem-summary-list" class="mem-summary-list"></div>
            </div>
        </div>
    </div>
    `;
}

function buildSummaryItemHtml(entry) {
    const badge = entry.auto
        ? '<span class="mem-badge mem-badge-auto">自动</span>'
        : '<span class="mem-badge mem-badge-manual">手动</span>';
    return `
    <div class="mem-summary-item" data-id="${entry.id}">
        <div class="mem-summary-meta">
            ${badge}
            <span>${escapeHtml(entry.time)}（消息 ${entry.range[0] + 1}-${entry.range[1]}）</span>
        </div>
        <textarea class="mem-summary-text" data-id="${entry.id}" rows="3">${escapeHtml(entry.content)}</textarea>
        <div class="mem-summary-actions">
            <button class="menu_button mem-copy-one" data-id="${entry.id}"><i class="fa-solid fa-copy"></i> 复制</button>
            <input type="text" class="mem-wi-keys" data-id="${entry.id}" placeholder="世界书关键词(逗号分隔，留空=常驻)" />
            <button class="menu_button mem-write-wi" data-id="${entry.id}"><i class="fa-solid fa-book"></i> 写入世界书</button>
            <button class="menu_button mem-delete-one danger" data-id="${entry.id}"><i class="fa-solid fa-trash"></i> 删除</button>
        </div>
    </div>
    `;
}

function populateWorldBookSelect() {
    const select = document.getElementById("mem-wi-book");
    if (!select) return;
    const previousValue = select.value;
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
    }
}

function setRunButtonLoading(loading) {
    const btn = document.getElementById("mem-run-now");
    if (!btn) return;
    btn.disabled = loading;
    btn.innerHTML = loading
        ? '<i class="fa-solid fa-spinner fa-spin"></i> 总结中…'
        : '<i class="fa-solid fa-wand-magic-sparkles"></i> 立即总结一次';
}

function updateStatusLine() {
    const statusDiv = document.getElementById("mem-status");
    if (!statusDiv) return;
    const s = getSettings();
    const context = getContext();
    const data = getChatData();
    const total = (context.chat || []).length;
    const pending = Math.max(0, total - data.lastSummarizedIndex);
    const pct = Math.min(100, Math.round((pending / Math.max(1, s.messagesPerSummary)) * 100));
    const remain = Math.max(0, s.messagesPerSummary - pending);
    const lastTime = data.summaries.length > 0 ? data.summaries[data.summaries.length - 1].time : "尚未总结过";
    const autoNote = s.autoSummarize ? "" : "（自动总结当前已关闭）";

    statusDiv.innerHTML = `
        <div class="mem-status-line">
            <span>共 <b>${total}</b> 条消息 / 已有 <b>${data.summaries.length}</b> 条摘要</span>
            <span>上次总结：${escapeHtml(lastTime)}</span>
        </div>
        <div class="mem-progress" title="距离自动总结还差 ${remain} 条">
            <div class="mem-progress-bar" style="width:${pct}%"></div>
        </div>
        <div class="mem-status-line mem-status-sub">
            <span>距上次总结已过去 ${pending} 条，还差 ${remain} 条将自动触发${autoNote}</span>
        </div>
    `;
}

function renderPanel() {
    const container = document.getElementById("mem-summarizer-panel");
    if (!container) return;
    const data = getChatData();
    updateStatusLine();
    const list = document.getElementById("mem-summary-list");
    if (!list) return;
    if (data.summaries.length === 0) {
        list.innerHTML = `<div class="mem-empty-hint">暂无总结记录，点击上方"立即总结一次"开始，或等待自动总结触发</div>`;
        return;
    }
    list.innerHTML = data.summaries
        .slice()
        .reverse()
        .map(buildSummaryItemHtml)
        .join("");
}

function bindPanelEvents() {
    const s = getSettings();

    document.getElementById("mem-count").addEventListener("change", (e) => {
        s.messagesPerSummary = Math.max(1, parseInt(e.target.value) || 1);
        saveSettings();
        updateStatusLine();
    });

    document.getElementById("mem-auto").addEventListener("change", (e) => {
        s.autoSummarize = e.target.checked;
        saveSettings();
        updateStatusLine();
    });

    document.getElementById("mem-prompt").addEventListener("change", (e) => {
        s.promptTemplate = e.target.value;
        saveSettings();
    });

    document.getElementById("mem-style-ref").addEventListener("change", (e) => {
        s.includeStyleReference = e.target.checked;
        saveSettings();
    });
    document.getElementById("mem-style-ref-n").addEventListener("change", (e) => {
        s.styleReferenceCount = Math.max(0, parseInt(e.target.value) || 0);
        saveSettings();
    });

    document.getElementById("mem-run-now").addEventListener("click", async () => {
        await runSummarization(true);
    });

    document.getElementById("mem-inject").addEventListener("change", (e) => {
        s.autoInject = e.target.checked;
        saveSettings();
        updateInjection();
    });
    document.getElementById("mem-inject-pos").addEventListener("change", (e) => {
        s.injectPosition = e.target.value;
        saveSettings();
        updateInjection();
    });
    document.getElementById("mem-inject-depth").addEventListener("change", (e) => {
        s.injectDepth = parseInt(e.target.value) || 0;
        saveSettings();
        updateInjection();
    });
    document.getElementById("mem-inject-role").addEventListener("change", (e) => {
        s.injectRole = e.target.value;
        saveSettings();
        updateInjection();
    });
    document.getElementById("mem-inject-n").addEventListener("change", (e) => {
        s.injectCount = Math.max(1, parseInt(e.target.value) || 1);
        saveSettings();
        updateInjection();
    });

    document.getElementById("mem-copy-all").addEventListener("click", () => {
        const data = getChatData();
        const text = data.summaries.map((x) => x.content).join("\n\n");
        if (!text) {
            toastInfo("还没有任何总结");
            return;
        }
        copyToClipboard(text, "已复制全部总结");
    });

    document.getElementById("mem-clear-all").addEventListener("click", () => {
        if (!confirm("确定要清空当前聊天的全部总结记录吗？（对话计数也会重置）")) return;
        const data = getChatData();
        data.summaries = [];
        data.lastSummarizedIndex = 0;
        saveChatData();
        renderPanel();
        toastSuccess("已清空当前聊天的全部总结记录");
    });

    document.getElementById("mem-wi-refresh").addEventListener("click", () => {
        populateWorldBookSelect();
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

    populateWorldBookSelect();

    // 事件委托：总结列表里的按钮（列表会被重新渲染，所以在父容器上监听）
    const list = document.getElementById("mem-summary-list");
    list.addEventListener("click", async (e) => {
        const target = e.target.closest("button");
        const id = target?.dataset?.id;
        if (!id) return;
        const data = getChatData();
        const entryIndex = data.summaries.findIndex((x) => x.id === id);
        if (entryIndex === -1) return;

        if (target.classList.contains("mem-copy-one")) {
            copyToClipboard(data.summaries[entryIndex].content, "已复制该条总结");
        } else if (target.classList.contains("mem-delete-one")) {
            if (!confirm("删除这条总结？")) return;
            data.summaries.splice(entryIndex, 1);
            saveChatData();
            renderPanel();
        } else if (target.classList.contains("mem-write-wi")) {
            const bookSelect = document.getElementById("mem-wi-book");
            const bookName = bookSelect?.value;
            if (!bookName) {
                toastError("请先选择一个世界书");
                return;
            }
            const keysInput = list.querySelector(`.mem-wi-keys[data-id="${id}"]`);
            target.disabled = true;
            try {
                await writeToWorldInfo(bookName, data.summaries[entryIndex].content, keysInput?.value);
            } finally {
                target.disabled = false;
            }
        }
    });

    list.addEventListener("change", (e) => {
        const target = e.target;
        if (!target.classList.contains("mem-summary-text")) return;
        const id = target.dataset.id;
        const data = getChatData();
        const entry = data.summaries.find((x) => x.id === id);
        if (entry) {
            entry.content = target.value;
            saveChatData();
        }
    });
}

// ------------------------ 初始化 ------------------------

jQuery(async () => {
    const settingsHtml = buildPanelHtml();
    $("#extensions_settings2").append(settingsHtml);

    bindPanelEvents();
    renderPanel();

    // 监听消息事件，自动计数/自动总结
    eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderPanel();
        updateInjection();
    });

    console.log("[记忆总结助手] 插件已加载 v1.1.0");
});
