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
    wiPosition: "",                   // 写入世界书时使用的插入位置键名（从当前酒馆版本动态探测）
    wiDepth: 4,                       // 位置为"指定深度"时使用
    wiRole: "system",                 // 位置为"指定深度"时使用：system / user / assistant
    corePromptTemplate:
        "请从以下多段剧情摘要中提取核心记忆信息（如：角色生日、重要约定、" +
        "作息习惯、兴趣爱好、重要事件、关键物品、人物关系确认等永久性事实），" +
        "以简洁的条目列表形式输出，每条一行，只输出核心事实，" +
        "不要输出剧情经过或口水内容：\n\n{{content}}",
    coreInjectCount: 5,               // 注入时合并最近几条核心记忆
    summaryPageSize: 20,              // 长期记忆列表每页/默认显示条数

    // 面板"高级"折叠分组的展开/收起状态（仅影响 UI 显示，不影响任何数据）。
    // 默认全部收起，手机端打开面板时只看到"基础模式"的 4 项常用控件。
    sectionOpenSummary: false,        // ▼ 总结设置
    sectionOpenInject: false,         // ▼ 注入设置
    sectionOpenWorldbook: false,      // ▼ 世界书
    sectionOpenLongterm: false,       // ▼ 长期记忆（含核心记忆）

    summaryOrder: "desc",             // 长期记忆列表显示/注入顺序："desc"=倒序(新在前) "asc"=正序(旧在前)
    filterMinChars: 0,                // 筛选：最小字数，0=不限
    filterMaxChars: 0,                // 筛选：最大字数，0=不限
    filterTimeRange: "all",           // 筛选：时间范围 "all" / "1h" / "24h" / "7d" / "30d"
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
    // 兼容旧版本缺字段的情况（包括本次新增的 wiPosition/wiDepth/wiRole）
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

    return prefix + s.promptTemplate.replace("{{content}}", newContent);
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
            time: new Date().toLocaleString(), // 这条摘要真实的生成完成时间，用于条目右上角显示
            range: [startIdx, endIdx],
            content: trimmed,
            auto: !manual,
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

function updateInjection() {
    const settings = getSettings();
    const context = getContext();
    const data = getChatData();

    if (!settings.autoInject) {
        context.setExtensionPrompt(MODULE_NAME, "", extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    const recentCore = (data.coreMemories || []).slice(-settings.coreInjectCount);
    // 注入时也遵循用户设置的顺序
    const orderedForInject = settings.summaryOrder === "asc"
        ? data.summaries.slice()
        : data.summaries.slice().reverse();
    const recentSummary = orderedForInject.slice(0, settings.injectCount);

    if (recentCore.length === 0 && recentSummary.length === 0) {
        context.setExtensionPrompt(MODULE_NAME, "", extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    const parts = [];
    if (recentCore.length > 0) {
        parts.push(
            "【核心记忆（绝对优先，不可违反、不可遗忘）】\n" +
            recentCore.map((c) => `- ${c.content}`).join("\n")
        );
    }
    if (recentSummary.length > 0) {
        parts.push(
            "【剧情记忆摘要】\n" +
            recentSummary.map((s) => `- ${s.content}`).join("\n")
        );
    }
    const combined = parts.join("\n\n");

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

        const prompt = settings.corePromptTemplate.replace("{{content}}", combinedContent);
        const result = await context.generateQuietPrompt(prompt, false, false);

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
            content: trimmed,
            sourceIds: selectedIds.slice(),
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
                range: [
                    Math.min(...selectedEntries.map((s) => s.range?.[0] ?? 0)),
                    Math.max(...selectedEntries.map((s) => s.range?.[1] ?? 0)),
                ],
                content: mergedContent,
                auto: false,
            };
            // 移除原始条目
            data.summaries = data.summaries.filter((s) => !selectedIds.includes(s.id));
            // 插入到数组最前面（最旧的位置）
            data.summaries.unshift(mergedEntry);
        } else {
            // 删除：直接移除原始条目，lastSummarizedIndex 不变
            data.summaries = data.summaries.filter((s) => !selectedIds.includes(s.id));
        }

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

// 点击"写入世界书"按钮的入口：先弹出预览确认框，用户确认之后才真正写入。
async function openWiWritePreview(entry, triggerBtn) {
    const s = getSettings();
    const bookSelect = document.getElementById("mem-wi-book");
    const bookName = bookSelect?.value;
    if (!bookName) {
        toastError("请先选择一个世界书");
        return;
    }
    const list = document.getElementById("mem-summary-list");
    const keysInput = list?.querySelector(`.mem-wi-keys[data-id="${entry.id}"]`);
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
        <div class="mem-modal-line">内容预览（共 ${entry.content.length} 字）：</div>
        <textarea class="mem-preview-textarea" readonly>${escapeHtml(entry.content)}</textarea>
    `;

    if (triggerBtn) triggerBtn.disabled = true;
    try {
        const confirmed = await showModal({
            title: "写入世界书前确认",
            bodyHtml,
            confirmText: "确认写入",
            cancelText: "取消",
        });
        if (!confirmed) return;

        // 弹窗展示期间聊天/摘要状态可能已经变化（比如这条摘要被删除了），
        // 真正写入之前用 id 重新取一次最新内容，避免写入过期或不存在的数据。
        const freshData = getChatData();
        const fresh = freshData.summaries.find((x) => x.id === entry.id);
        if (!fresh) {
            toastError("这条总结已被删除，写入已取消");
            return;
        }

        await writeToWorldInfo(bookName, fresh.content, keysInput?.value, s.wiPosition, s.wiDepth, s.wiRole);
    } finally {
        if (triggerBtn) triggerBtn.disabled = false;
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
                    content: String(raw.content),
                    sourceIds: Array.isArray(raw.sourceIds) ? raw.sourceIds : [],
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
                    range: Array.isArray(raw.range) && raw.range.length === 2 ? raw.range : [0, 0],
                    content: String(raw.content),
                    auto: !!raw.auto,
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
    setChecked("mem-inject", s.autoInject);
    setVal("mem-inject-pos", s.injectPosition);
    setVal("mem-inject-depth", s.injectDepth);
    setVal("mem-inject-role", s.injectRole);
    setVal("mem-inject-n", s.injectCount);
    setVal("mem-wi-depth", s.wiDepth);
    setVal("mem-wi-role", s.wiRole);
    setVal("mem-core-prompt", s.corePromptTemplate);
    setVal("mem-core-inject-n", s.coreInjectCount);
    populateWiPositionSelect();
    toggleWiAtDepthRow();
}

// ------------------------ UI 渲染 ------------------------

// 折叠分组 key -> 对应 settings 里记录展开/收起状态的字段名。
// 新增分组时只需要在这里加一行映射，加载/持久化逻辑不用改。
const SECTION_SETTING_KEYS = {
    summary: "sectionOpenSummary",
    inject: "sectionOpenInject",
    worldbook: "sectionOpenWorldbook",
    longterm: "sectionOpenLongterm",
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
        <div class="mem-row mem-status" id="mem-status"></div>`;

    // ------ 注入设置 ------
    const injectSectionHtml = `
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
        <div class="mem-hint">
            注意：生成新摘要时会临时关闭这里的注入，避免总结这次新内容时把刚注入的旧摘要又重复喂给 AI 一次；
            总结完成后会自动恢复，不影响正常聊天。
        </div>`;

    // ------ 世界书 ------
    const worldbookSectionHtml = `
        <div class="mem-row">
            <label>写入世界书（每条总结下方都有单独按钮，点击后会先预览确认，不会自动写入）：</label>
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
        <div class="mem-hint">
            完全不想用世界书的话，用下面"长期记忆"里的"复制全部总结"手动粘贴到你需要的地方即可，不点"写入世界书"就不会有任何自动写入行为。
        </div>`;

    // ------ 长期记忆（内含"核心记忆"、"长期记忆列表"两张分类样式卡） ------
    const longtermSectionHtml = `
        <div class="mem-subsection mem-subsection-core">
            <div class="mem-subsection-title"><i class="fa-solid fa-gem"></i> 核心记忆</div>
            <div class="mem-hint">
                核心记忆的优先级高于长期记忆，注入时会标记为"绝对不可违反"。
                从下方长期记忆列表中勾选条目，然后点击"提取核心"按钮。
            </div>
            <div class="mem-row">
                <label>核心记忆提取提示词（用 {{content}} 代表选中的摘要内容）：</label>
                <textarea id="mem-core-prompt" rows="4">${escapeHtml(s.corePromptTemplate)}</textarea>
            </div>
            <div class="mem-row mem-inline">
                <label>注入最近核心记忆条数：<input type="number" id="mem-core-inject-n" min="1" value="${s.coreInjectCount}" style="width:60px"/></label>
            </div>
            <div id="mem-core-status" class="mem-row mem-status"></div>
            <div id="mem-core-list" class="mem-summary-list"></div>
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
                <button id="mem-order-toggle" class="menu_button" title="切换显示/注入顺序">
                    <i class="fa-solid ${s.summaryOrder === "desc" ? "fa-arrow-down-wide-short" : "fa-arrow-up-wide-short"}"></i>
                    <span>${s.summaryOrder === "desc" ? "倒序(新→旧)" : "正序(旧→新)"}</span>
                </button>
            </div>
            <div class="mem-hint">
                排序会同时影响面板显示和注入给 AI 的上下文顺序；长按某条记忆可拖动调整顺序（自动保存）。筛选仅影响面板显示，不影响注入。
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

            <div class="mem-row mem-inline">
                <button id="mem-export-btn" class="menu_button"><i class="fa-solid fa-file-export"></i> 导出记忆数据</button>
                <button id="mem-import-btn" class="menu_button"><i class="fa-solid fa-file-import"></i> 导入记忆数据</button>
                <input type="file" id="mem-import-file" accept="application/json" style="display:none" />
            </div>
            <div class="mem-hint">
                导出会把当前聊天的全部摘要、总结进度和插件设置打包成一个 JSON 文件，方便备份或换设备；
                导入时可以分别选择只导入摘要、只导入设置，摘要会追加在当前聊天已有摘要之后，不会覆盖。
            </div>

            <div id="mem-summary-list" class="mem-summary-list"></div>
            <div id="mem-summary-pagination" class="mem-row mem-inline" style="justify-content:center"></div>
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

            </div>
        </div>
    </div>
    `;
}

function buildSummaryItemHtml(entry) {
    const badge = entry.auto
        ? '<span class="mem-badge mem-badge-auto"><i class="fa-solid fa-robot"></i> 自动</span>'
        : '<span class="mem-badge mem-badge-manual"><i class="fa-solid fa-hand"></i> 手动</span>';
    const charCount = (entry.content || "").length;
    const rangeStart = Array.isArray(entry.range) ? entry.range[0] + 1 : "?";
    const rangeEnd = Array.isArray(entry.range) ? entry.range[1] : "?";
    // 刚生成的这一条播放一次入场动画，之后（比如编辑了别的条目触发整表重渲染）不会再重复播放。
    const isNew = entry.id === lastAddedSummaryId;
    return `
    <div class="mem-summary-item${isNew ? " mem-item-new" : ""}" data-id="${entry.id}">
        <div class="mem-summary-header">
            <div class="mem-summary-header-left">
                <input type="checkbox" class="mem-select-for-core" data-id="${entry.id}" title="选中以提取核心记忆" />
                ${badge}
                <span>消息 ${rangeStart}-${rangeEnd} · ${charCount} 字</span>
            </div>
            <div class="mem-summary-time" title="真实的总结完成时间">${escapeHtml(entry.time)}</div>
        </div>
        <textarea class="mem-summary-text" data-id="${entry.id}" rows="3">${escapeHtml(entry.content)}</textarea>
        <div class="mem-summary-actions">
            <input type="text" class="mem-wi-keys" data-id="${entry.id}" placeholder="世界书关键词(逗号分隔，留空=常驻)" />
            <button class="menu_button mem-write-wi" data-id="${entry.id}"><i class="fa-solid fa-book"></i> 写入世界书</button>
            <button class="menu_button mem-copy-one" data-id="${entry.id}"><i class="fa-solid fa-copy"></i> 复制</button>
            <button class="menu_button mem-delete-one danger" data-id="${entry.id}"><i class="fa-solid fa-trash"></i> 删除</button>
        </div>
    </div>
    `;
}

function buildCoreMemoryItemHtml(entry) {
    const charCount = (entry.content || "").length;
    const isNew = entry.id === lastAddedCoreId;
    return `
    <div class="mem-summary-item mem-core-item${isNew ? " mem-item-new" : ""}" data-id="${entry.id}">
        <div class="mem-summary-header">
            <div class="mem-summary-header-left">
                <span class="mem-badge mem-badge-core">核心</span>
                <span>${charCount} 字</span>
            </div>
            <div class="mem-summary-time" title="真实的总结完成时间">${escapeHtml(entry.time)}</div>
        </div>
        <textarea class="mem-core-text" data-id="${entry.id}" rows="3">${escapeHtml(entry.content)}</textarea>
        <div class="mem-summary-actions">
            <button class="menu_button mem-core-copy" data-id="${entry.id}"><i class="fa-solid fa-copy"></i> 复制</button>
            <button class="menu_button mem-core-delete danger" data-id="${entry.id}"><i class="fa-solid fa-trash"></i> 删除</button>
        </div>
    </div>
    `;
}

function renderCoreMemories() {
    const coreList = document.getElementById("mem-core-list");
    const coreStatus = document.getElementById("mem-core-status");
    if (!coreList) return;
    const data = getChatData();
    const cores = data.coreMemories || [];

    if (coreStatus) {
        const totalChars = cores.reduce((sum, x) => sum + (x.content ? x.content.length : 0), 0);
        const lastCore = cores.length > 0 ? cores[cores.length - 1] : null;
        coreStatus.innerHTML = cores.length > 0
            ? `<div class="mem-status-line"><span>核心记忆：<b>${cores.length}</b> 条 · 共 <b>${totalChars}</b> 字 · 上次更新：${escapeHtml(lastCore.time)}</span></div>`
            : `<div class="mem-status-line"><span>暂无核心记忆</span></div>`;
    }

    if (cores.length === 0) {
        coreList.innerHTML = `<div class="mem-empty-hint">暂无核心记忆，从下方长期记忆中勾选条目后点击"提取核心"</div>`;
        lastAddedCoreId = null;
        return;
    }
    coreList.innerHTML = cores.slice().reverse().map(buildCoreMemoryItemHtml).join("");
    lastAddedCoreId = null;
}

// 运行时状态：长期记忆列表是否已展开全部
let summaryShowAll = false;

// 解析条目的 time 字符串为毫秒时间戳，解析失败返回 0
function parseEntryTime(entry) {
    if (!entry || !entry.time) return 0;
    // entry.time 是 new Date().toLocaleString() 产生的，格式因系统语言不同而不同，
    // 但 Date 构造函数对大部分常见 locale 格式都能解析。
    const t = new Date(entry.time).getTime();
    return Number.isFinite(t) ? t : 0;
}

// 根据当前筛选设置，返回应该在面板里显示的 summaries 子集（不修改原数组）
function getFilteredSummaries() {
    const s = getSettings();
    const data = getChatData();
    let items = data.summaries.slice(); // 浅拷贝，不动原数据

    // 时间筛选
    if (s.filterTimeRange && s.filterTimeRange !== "all") {
        const now = Date.now();
        const rangeMs = {
            "1h": 3600_000,
            "24h": 86400_000,
            "7d": 604800_000,
            "30d": 2592000_000,
        }[s.filterTimeRange];
        if (rangeMs) {
            items = items.filter((x) => {
                const t = parseEntryTime(x);
                return t > 0 && (now - t) <= rangeMs;
            });
        }
    }

    // 字数筛选
    const minC = s.filterMinChars || 0;
    const maxC = s.filterMaxChars || 0;
    if (minC > 0) {
        items = items.filter((x) => (x.content || "").length >= minC);
    }
    if (maxC > 0) {
        items = items.filter((x) => (x.content || "").length <= maxC);
    }

    return items;
}

// 根据设置里的 summaryOrder 对数组进行排序（返回新数组，不修改原数组）
// "desc" = 倒序（数组末尾 = 最新的排在显示最前面）
// "asc"  = 正序（数组开头 = 最旧的排在显示最前面）
function getOrderedSummaries(arr) {
    const s = getSettings();
    if (s.summaryOrder === "asc") {
        return arr.slice(); // 数组本身就是正序存储的（旧的在前），直接返回
    }
    return arr.slice().reverse(); // 倒序
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
        basicStatsDiv.innerHTML = `当前记忆：<b>${data.summaries.length}</b> 条`;
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
    `;
}

function renderPanel() {
    const container = document.getElementById("mem-summarizer-panel");
    if (!container) return;
    const data = getChatData();
    const settings = getSettings();
    updateStatusLine();
    renderCoreMemories();

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

    //：绑定拖拽排序
    bindDragSort(list);
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

    // 提取核心按钮
    document.getElementById("mem-core-summarize-btn")?.addEventListener("click", async () => {
        const checkboxes = document.querySelectorAll(".mem-select-for-core:checked");
        const selectedIds = Array.from(checkboxes).map((cb) => cb.dataset.id);
        await runCoreSummarization(selectedIds);
    });

    // 核心记忆列表事件委托
    document.getElementById("mem-core-list")?.addEventListener("click", (e) => {
        const target = e.target.closest("button");
        const id = target?.dataset?.id;
        if (!id) return;
        const data = getChatData();
        const cores = data.coreMemories || [];
        const idx = cores.findIndex((x) => x.id === id);
        if (idx === -1) return;

        if (target.classList.contains("mem-core-copy")) {
            copyToClipboard(cores[idx].content, "已复制该条核心记忆");
        } else if (target.classList.contains("mem-core-delete")) {
            if (!confirm("删除这条核心记忆？删除后不可恢复。")) return;
            cores.splice(idx, 1);
            saveChatData();
            updateInjection();
            renderPanel();
        }
    });

    // 核心记忆文本编辑保存
    document.getElementById("mem-core-list")?.addEventListener("change", (e) => {
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

    document.getElementById("mem-run-now")?.addEventListener("click", async () => {
        await runSummarization(true);
    });

    document.getElementById("mem-inject")?.addEventListener("change", (e) => {
        s.autoInject = e.target.checked;
        saveSettings();
        updateInjection();
    });
    document.getElementById("mem-inject-pos")?.addEventListener("change", (e) => {
        s.injectPosition = e.target.value;
        saveSettings();
        updateInjection();
    });
    document.getElementById("mem-inject-depth").addEventListener("change", (e) => {
        s.injectDepth = parseInt(e.target.value) || 0;
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
                <div class="mem-modal-line">此操作不可撤销。</div>
            `,
            confirmText: "确认清空",
            cancelText: "取消",
            danger: true,
        });
        if (!confirmed) return;
        data.summaries = [];
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
            range: [0, 0], // 手动添加的没有消息范围
            content: content,
            auto: false,
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

    // 排序切换按钮
    document.getElementById("mem-order-toggle")?.addEventListener("click", () => {
        s.summaryOrder = s.summaryOrder === "desc" ? "asc" : "desc";
        saveSettings();
        updateInjection(); // 排序也影响注入
        renderPanel();
        // 更新按钮自身的显示
        const btn = document.getElementById("mem-order-toggle");
        if (btn) {
            const icon = btn.querySelector("i");
            const span = btn.querySelector("span");
            if (icon) {
                icon.className = s.summaryOrder === "desc"
                    ? "fa-solid fa-arrow-down-wide-short"
                    : "fa-solid fa-arrow-up-wide-short";
            }
            if (span) {
                span.textContent = s.summaryOrder === "desc" ? "倒序(新→旧)" : "正序(旧→新)";
            }
        }
    });

    populateWorldBookSelect();
    populateWiPositionSelect();
    toggleWiAtDepthRow();

    // 事件委托：总结列表里的按钮（列表会被重新渲染，所以在父容器上监听）
    const list = document.getElementById("mem-summary-list");
    if (!list) return; // 面板没渲染出来时不绑定，避免空指针
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
            // 删除只移除这条摘要文本，不会让对应的消息重新变回"待总结"状态
            // （lastSummarizedIndex 不受影响），避免同一段对话被重复总结、重复消耗 Token。
            if (!confirm('删除这条总结？删除后不可恢复，对应的消息也不会重新变为"待总结"状态。')) return;
            data.summaries.splice(entryIndex, 1);
            saveChatData();
            updateInjection();
            renderPanel();
        } else if (target.classList.contains("mem-write-wi")) {
            await openWiWritePreview(data.summaries[entryIndex], target);
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
            updateInjection();
        }
    });
}

// ===================== 拖拽排序 =====================
// 在触摸屏上通过长按触发拖拽，桌面端通过 mousedown 长按触发。
// 拖拽期间移动到哪个条目上方就把被拖动的条目插到它前面，松手后保存到 chatMetadata。
// 只对 mem-summary-list 里的 .mem-summary-item 生效，核心记忆列表不受影响。

function bindDragSort(listEl) {
    if (!listEl) return;
    // 防止重复绑定：如果已经绑过，先清理旧的 document 级监听
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

        // 读取当前 DOM 顺序，更新 data.summaries 的顺序
        const newOrderIds = Array.from(listEl.querySelectorAll(".mem-summary-item"))
            .map((el) => el.dataset.id)
            .filter(Boolean);

        if (newOrderIds.length > 0) {
            const data = getChatData();
            const s = getSettings();
            const idToEntry = new Map(data.summaries.map((x) => [x.id, x]));

            // 如果当前显示的是倒序，DOM 顺序和存储顺序是相反的：
            // DOM 第一个 = 最新的 = 存储数组的最后一个。
            // 所以倒序时要把 DOM 顺序 reverse 回来再存。
            const displayIds = s.summaryOrder === "desc"
                ? newOrderIds.slice().reverse()
                : newOrderIds;

            // 重建 summaries 数组：先按 displayIds 排，剩余不在当前筛选结果里的条目
            // 保持原来的相对位置追加在后面（筛选隐藏的条目不能丢）
            const reorderedSet = new Set(displayIds);
            const reordered = displayIds.map((id) => idToEntry.get(id)).filter(Boolean);
            const remaining = data.summaries.filter((x) => !reorderedSet.has(x.id));
            data.summaries = reordered.concat(remaining);

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

    // 记录清理函数，下次 bindDragSort 调用时先清理，防止重复绑定
    listEl._memDragCleanup = () => {
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

        // 监听消息事件，自动计数/自动总结
        eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
        eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
        eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
        eventSource.on(event_types.CHAT_CHANGED, () => {
            try {
                manualReminderCount = 0;
                summaryShowAll = false;
                renderPanel();
                updateInjection();
            } catch (e) {
                console.error("[记忆总结助手] 处理聊天切换事件异常：", e);
            }
        });

        console.log("[记忆总结助手] 插件已加载 v1.0.0");
    });
}
