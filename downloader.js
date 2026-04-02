// ==UserScript==
// @name         GitHub Multi-File Downloader
// @name:zh-CN   GitHub 批量下载器
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description:zh-CN  在 GitHub 仓库页面添加多文件下载按钮, 方便下载。
// @homepageURL  https://github.com/yeyousheng7/github-multi-file-downloader
// @supportURL   https://github.com/yeyousheng7/github-multi-file-downloader/issues
// @author       yyyyys
// @license      MIT
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @match        https://github.com/*
// @require      https://unpkg.com/file-saver@2.0.5/dist/FileSaver.min.js
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      github.com
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      objects.githubusercontent.com
// ==/UserScript==

(function () {
    'use strict';

    /** @type {Map<string, SelectionEntry>} */
    const selectedEntries = new Map();

    let currentPageKey = null; // 当前页面唯一标识, 用于检测页面变化

    // GitHub 页面元素属性
    const githubAttribute = {
        // 页面根级元素 ID
        githubRootId: "repo-content-pjax-container",

        // 文件夹或文件行 ID 前缀
        githubFileRowIdPrefix: "folder-row-", // + number, 例如 folder-row-1
    };

    const githubSelectors = {
        // 文件表格本体
        // 主策略依赖“table 内含文件/目录条目链接”来判定是否命中，
        // 因此这里可以接受较宽的候选；
        // 后面的 module class 仅作为备选，GitHub 可能随时调整样式导致其失效
        tableCandidate: [
            'table',
            '.Table-module__Box__HZKiQ',
        ],
        // 文件/目录主链接
        // 优先使用 aria-label 中带 "(File)/(Directory)" 的语义化链接，
        // 再退回到 href 中的 /blob/ /tree/ 特征
        entryLinkCandidate: [
            'a[aria-label$=", (File)"]',
            'a[aria-label$=", (Directory)"]',
            'a[href*="/blob/"]',
            'a[href*="/tree/"]',
        ],
        // 文件列表中的功能行，例如 "View all files"
        specialFileRowCandidate: [
            'tr[data-testid="view-all-files-row"]',
        ],
        // “上一级目录”链接
        parentDirLinkCandidate: [
            'a[aria-label="Parent directory"]',
        ],
        // 首页 latest commit 区块内部的稳定锚点
        latestCommitAnchorCandidate: [
            '[data-testid="latest-commit"]',
            '[data-testid="latest-commit-details"]',
        ],
        // 分支选择按钮
        refButtonCandidate: [
            '#ref-picker-repos-header-ref-selector',
            'button[data-testid="anchor-button"][id="ref-picker-repos-header-ref-selector"]',
            'button[aria-label$=" branch"][data-testid="anchor-button"]',
            'button[aria-label$=" tag"][data-testid="anchor-button"]',
        ],
    };

    const SETTINGS = {
        // 下载并发数限制
        CONCURRENCY_LIMIT: 6,

        // 压缩等级
        COMPRESS_LEVEL: 3,

        // 单个请求超时时间
        REQUEST_TIMEOUT_MS: 15000,

        // 单个文件失败后的重试次数
        RETRY_COUNT: 2,

        // 重试前等待时间
        RETRY_DELAY_MS: 800,

        // 调试
        LOG_LEVEL: 'info',

        // GitHub API token，用于访问私有仓库的 API
        // 此字段会被优先使用（仅调试时填入），如果留空则尝试从 Tampermonkey 持久化存储中读取
        GITHUB_TOKEN_OVERRIDE: '',

        GITHUB_TOKEN_STORED_KEY: 'github_token',
    };

    const LOG_LEVELS = {
        debug: 10,
        info: 20,
        warn: 30,
        error: 40,
        silent: 99,
    };

    const logger = {
        shouldLog(level) {
            const current = LOG_LEVELS[SETTINGS.LOG_LEVEL] ?? LOG_LEVELS.info;
            const target = LOG_LEVELS[level] ?? LOG_LEVELS.info;
            return target >= current;
        },

        format(scope, message) {
            const prefix = scope ? `[GitHub Downloader][${scope}]` : "[GitHub Downloader]";
            return `${prefix} ${message}`;
        },

        write(method, level, scope, message, data) {
            if (!this.shouldLog(level)) return;

            const text = this.format(scope, message);
            if (data !== undefined) {
                console[method](text, data);
            } else {
                console[method](text);
            }
        },

        debug(scope, message, data) {
            this.write('debug', 'debug', scope, message, data);
        },

        info(scope, message, data) {
            this.write('info', 'info', scope, message, data);
        },

        warn(scope, message, data) {
            this.write('warn', 'warn', scope, message, data);
        },

        error(scope, message, data) {
            this.write('error', 'error', scope, message, data);
        },
    };

    /**
     * @typedef {Object} SelectionEntry
     * @property {'file'|'folder'} kind
     * @property {string} githubPath
     * @property {string} repoPath
     * @property {string} fileName
     */

    /**
     * @typedef {Object} GitHubEntryContext
     * @property {string} owner
     * @property {string} repo
     * @property {'blob'|'tree'} viewKind
     * @property {string} ref
     * @property {string} repoPath
     */

    /**
     * @typedef {Object} ResolveSelectionResult
     * @property {DownloadItem[]} items
     * @property {SelectionEntry[]} failedEntries
     */

    /**
     * @typedef {Object} DownloadItem
     * @property {string} githubPath GitHub 页面中的站内路径，例如 /owner/repo/blob/main/src/a.js
     * @property {string} rawUrl 文件下载地址
     * @property {string} outputPath ZIP 内输出路径，例如 src/a.js
     * @property {string} fileName 文件名，例如 a.js
     */

    /**
     * @typedef {Object} DownloadArtifact
     * @property {Blob} blob
     * @property {string} downloadName
     */

    /**
     * @typedef {Object} DownloadExecutionResult
     * @property {Array<DownloadItem & { bytes: Uint8Array }>} succeeded
     * @property {Array<{ item: DownloadItem, error: Error }>} failed
     */

    /**
     * @typedef {Object} DownloadPlan
     * @property {DownloadItem[]} items 本次要下载的文件项
     * @property {'single'|'zip'} outputMode 输出模式：单文件或 ZIP
     * @property {string} zipFilename ZIP 下载文件名
     * @property {SelectionEntry[]} failedEntries 下载计划中解析失败的条目列表
     */

    /**
     * @typedef {Object} DialogOptions
     * @property {string} title
     * @property {string} message
     * @property {string} [confirmText]
     * @property {string} [cancelText]
     * @property {boolean} [confirmOnly]
     */

    logger.info("app", "GitHub Downloader 脚本启动");

    setTimeout(() => {
        apply();
        observeRootChanges();
        registerMenuCommands();
    }, 200);

    function apply() {
        const pageKey = getPageKey();
        if (pageKey !== currentPageKey) {
            resetSelectionState();
            currentPageKey = pageKey;
        }

        // ref 按钮在仓库页面稳定存在，用它作为标志位避免在非仓库页面错误注入
        const refButton = getCurrentRefButton();
        if (!refButton) {
            logger.debug("ui", "当前页面不存在 ref 选择按钮，跳过注入");
            return;
        }

        const table = findRepositoryFileTable();
        if (!table) {
            logger.warn("ui", "未找到代码表格元素, 退出");
            return;
        }
        ensureHeader(table);
        addCheckboxes(table);
        addDownloadToolbar(table);
        bindTableEvents(table);
    }

    function observeRootChanges() {
        const root = document.getElementById(githubAttribute.githubRootId);
        if (!root) {
            logger.warn("app", "未找到页面根级元素, 退出");
            return;
        }
        if (root.dataset.tmObserved === '1') return;
        root.dataset.tmObserved = '1';

        let t = null;
        const schedule = () => {
            clearTimeout(t);
            t = setTimeout(apply, 50); // 简单防抖：DOM 连续变化时只跑一次
        };

        const obs = new MutationObserver(schedule);
        obs.observe(root, { childList: true, subtree: true });

        window.addEventListener('popstate', schedule);

        schedule();
    }

    function registerMenuCommands() {
        GM_registerMenuCommand('设置 GitHub Token', () => {
            openGitHubTokenDialog();
        });
    }

    function addCheckboxes(table) {
        if (!table) {
            logger.warn("ui", "代码表格元素为空, 退出");
            return;
        }

        // 下面需要先处理上一级目录行，再处理其余文件行
        // 先后顺序不可调换，否则按钮禁用状态将无法正确设置
        // 当前逻辑依赖于 addCheckboxToRow 中的防抖判断，以跳过上一级目录行的重复添加

        // 如果在子目录层级，禁用上一级目录的复选框
        const parentDirRow = findParentDirectoryRow(table);
        if (parentDirRow) {
            addCheckboxToRow(parentDirRow, "parent-dir-row", true);
            logger.debug("ui", "在上一级目录行添加禁用的复选框");
        }

        // 遍历文件行, 添加复选框
        const fileRows = getEntryRows(table);
        logger.debug("ui", `找到 ${fileRows.length} 个文件行元素`);

        for (let i = 0; i < fileRows.length; i++) {
            const row = fileRows[i];
            const rowId = githubAttribute.githubFileRowIdPrefix + (i + 1);

            addCheckboxToRow(row, rowId);
            logger.debug("ui", `在行 ${rowId} 添加复选框`);
        }
    }

    function addCheckboxToRow(rowElement, rowId, disabled = false) {
        if (!rowElement) {
            logger.warn("ui", `行元素 ${rowId} 为空, 退出`);
            return;
        }
        if (rowElement.querySelector('.tm-left-cb')) {
            logger.debug("ui", `行元素 ${rowId} 已存在复选框, 退出`);
            return;
        }

        const td = document.createElement('td');

        td.className = `tm-left-cell`;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'tm-left-cb';
        cb.disabled = disabled;

        td.appendChild(cb);
        rowElement.insertBefore(td, rowElement.firstElementChild);
    }

    function ensureHeader(table) {
        if (!table) {
            logger.warn("ui", "代码表格元素为空, 退出");
            return;
        }

        const headTr = table.querySelector('thead tr');
        if (!headTr) {
            logger.warn("ui", "未找到表头行, 退出");
            return;
        };
        if (headTr.querySelector('th.tm-left-cell')) {
            logger.debug("ui", "表头行已存在复选框列, 退出");
            return;
        }

        const ref = headTr.firstElementChild;
        const th = document.createElement('th');

        th.className = `tm-left-cell`;
        th.textContent = '';

        // 复制参考单元格的背景色
        if (ref) {
            const cs = getComputedStyle(ref);
            th.style.backgroundColor = cs.backgroundColor;
        }

        headTr.insertBefore(th, headTr.firstElementChild);
        fixColumnWidths(table);
    }

    // 在表格上方添加下载工具栏(下载按钮与状态显示)
    function addDownloadToolbar(table) {
        if (!table) {
            logger.warn("ui", "未找到代码表格元素, 退出");
            return;
        }

        const container = table.parentElement;
        if (!container) {
            logger.warn("ui", "未找到表格容器元素, 退出");
            return;
        }

        const existingToolbar = document.querySelector('.tm-download-toolbar');
        if (existingToolbar) {
            logger.debug("ui", "下载工具栏已存在, 退出");
            return;
        }

        const toolbar = document.createElement('div');
        toolbar.className = 'tm-download-toolbar';
        toolbar.style.marginBottom = '8px';

        const btn = document.createElement('button');
        btn.className = 'tm-download-btn';
        btn.textContent = '下载所选文件';
        btn.disabled = false;
        btn.addEventListener('click', () => {
            startDownload();
        });

        const status = document.createElement('span');
        status.className = 'tm-download-status is-empty';

        toolbar.appendChild(btn);
        toolbar.appendChild(status);
        container.insertBefore(toolbar, table);
        logger.debug("ui", "添加下载工具栏");
    }

    function fixColumnWidths(table) {
        // 首页的 latest commit 行需要补上新增的复选框列宽度。
        const latestCommitRow = findLatestCommitRow(table);
        latestCommitRow?.querySelectorAll('td[colspan]').forEach(td => {
            const colspan = td.getAttribute('colspan');
            if (colspan) {
                const newColspan = parseInt(colspan) + 1;
                td.setAttribute('colspan', newColspan.toString());
                logger.debug("ui", `更新 latest commit 行的 colspan 为 ${newColspan}`);
            }
        });
    }

    function bindTableEvents(table) {
        if (!table) {
            logger.warn("ui", "代码表格元素为空, 退出");
            return;
        }

        if (table.dataset.tmBound === '1') {
            return;
        }
        table.dataset.tmBound = '1';

        table.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement) || !target.classList.contains('tm-left-cb')) {
                return;
            }

            const rowElement = target.closest('tr');
            const entry = parseSelectionFromRow(rowElement);
            if (!entry) {
                return;
            }

            logger.debug("ui", `复选框状态改变, 文件路径: ${entry.githubPath}, 选中: ${target.checked}`);

            if (target.checked) {
                selectedEntries.set(entry.githubPath, entry);
            } else {
                selectedEntries.delete(entry.githubPath);
            }
        });
    }

    async function startDownload() {
        const entries = getSelectionEntries();
        if (entries.length === 0) {
            clearDownloadStatus();
            await showAlertDialog({
                title: '提示',
                message: '未选择任何文件！',
            });
            return;
        }

        logger.info("download", `开始下载，选中 ${entries.length} 个项目`);
        setDownloadButtonState({ disabled: true, text: '下载中...' });

        try {
            setDownloadStatus('解析下载计划...');
            const plan = await buildDownloadPlan(entries);
            if (plan.failedEntries.length > 0) {
                let failedListTop5Msg =
                    plan.failedEntries
                        .slice(0, 5)
                        .map(entry => entry.repoPath || entry.githubPath)
                        .join('\n');

                if (plan.failedEntries.length > 5) {
                    failedListTop5Msg += '\n...';
                }

                if (plan.items.length === 0) {
                    clearDownloadStatus();
                    await showAlertDialog({
                        title: '没有可下载的文件',
                        message: `所选条目全部解析失败，无法继续下载。\n${failedListTop5Msg}`,
                    });
                    return;
                }

                const ok = await showConfirmDialog({
                    title: '继续下载其余成功项？',
                    message: `有 ${plan.failedEntries.length} 个条目解析失败，是否继续下载其余成功项？\n${failedListTop5Msg}`,
                    confirmText: '继续下载',
                    cancelText: '取消',
                });

                if (!ok) {
                    clearDownloadStatus();
                    return;
                }
            }

            if (plan.items.length === 0) {
                clearDownloadStatus();
                await showAlertDialog({
                    title: '没有可下载的文件',
                    message: '没有有效的文件可下载！',
                });
                return;
            }

            const result = await executeDownloadPlan(plan);
            if (result.failed.length === 0) {
                return;
            }

            const shouldRetry = await confirmRetryFailedItems(result);
            if (!shouldRetry) {
                return;
            }

            const retryPlan = buildRetryPlanFromFailed(plan, result.failed);
            const retryResult = await executeDownloadPlan(retryPlan);
            if (retryResult.failed.length > 0) {
                await alertFinalFailedItems(retryResult);
            }
        } finally {
            resetDownloadButtonState();
        }
    }

    /**
     * 根据选中项构建下载计划
     *
     * @param {SelectionEntry[]} entries
     * @returns {Promise<DownloadPlan>}
     */
    async function buildDownloadPlan(entries) {
        const items = [];
        const failedEntries = [];

        for (const entry of entries) {
            const resolved = await resolveSelectionEntry(entry);
            items.push(...resolved.items);
            failedEntries.push(...resolved.failedEntries);
        }

        logger.info("plan", `下载计划已生成，文件数: ${items.length}，模式: ${items.length === 1 ? 'single' : 'zip'}`);

        return {
            items,
            outputMode: items.length === 1 ? 'single' : 'zip',
            zipFilename: `github_files_${Date.now()}.zip`,
            failedEntries,
        }
    }

    // failedItems: Array<{ item: DownloadItem, error: Error }>
    function buildRetryPlanFromFailed(plan, failedItems) {
        const items = failedItems.map(f => f.item);

        return {
            items,
            outputMode: items.length === 1 ? 'single' : 'zip',
            // plan 中的 zipFilename: github_files_${Date.now()}.zip
            zipFilename: `_RETRY_${plan.zipFilename}`,
            failedEntries: [], // 重试计划只包含已解析成功但下载失败的文件项
        }
    }

    /**
     * 执行下载计划，并在存在成功文件时立即保存结果。
     * 此函数不涉及用户交互
     *
     * @param {DownloadPlan} plan
     * @returns {Promise<DownloadExecutionResult>}
     */
    async function executeDownloadPlan(plan) {
        const result = await fetchDownloadItems(plan.items, ({ completed, total }) => {
            setDownloadStatus(`下载中 ${completed} / ${total}`);
        });

        if (result.succeeded.length > 0) {
            let artifact;
            if (plan.outputMode === 'single') {
                setDownloadStatus('保存中...');
                artifact = buildSingleFileArtifact(result.succeeded[0]);
            } else if (plan.outputMode === 'zip') {
                setDownloadStatus('打包中...');
                artifact = buildZipArtifact(result.succeeded, plan.zipFilename);
            } else {
                logger.error("download", `未知的输出模式: ${plan.outputMode}`);
                return result;
            }
            saveBlob(artifact.blob, artifact.downloadName);
            logger.info("download", `下载完成，成功 ${result.succeeded.length} 个，失败 ${result.failed.length} 个`);
        }

        if (result.failed.length === 0) {
            setTransientDownloadStatus('下载完成');
        } else if (result.succeeded.length > 0) {
            setTransientDownloadStatus(`部分完成，失败 ${result.failed.length} 个`);
        } else {
            setTransientDownloadStatus('下载失败');
        }

        return result;
    }

    /**
     * 将选中项解析为一个或多个下载项。
     *
     * @param {SelectionEntry} entry
     * @returns {Promise<ResolveSelectionResult>}
     */
    async function resolveSelectionEntry(entry) {
        if (!entry) {
            return { items: [], failedEntries: [] };
        }

        if (entry.kind === 'file') {
            const item = toDownloadItem(entry);
            return item ? { items: [item], failedEntries: [] } : { items: [], failedEntries: [entry] };
        }

        if (entry.kind === 'folder') {
            try {
                const items = await expandFolderEntry(entry);
                return { items, failedEntries: [] };
            } catch (error) {
                logger.error("plan", `展开文件夹失败: ${entry.githubPath}`, error);
                return { items: [], failedEntries: [entry] };
            }
        }

        return { items: [], failedEntries: [] };
    }

    /**
     * 将单个文件选中项转换为下载项。
     *
     * @param {SelectionEntry} entry
     * @returns {DownloadItem|null}
     */
    function toDownloadItem(entry) {
        if (!entry || entry.kind !== 'file') {
            return null;
        }

        const rawUrl = blobToGithubRawUrl(entry.githubPath);
        if (!rawUrl) {
            logger.warn("plan", `无法转换为 raw URL: ${entry.githubPath}`);
            return null;
        }

        return {
            githubPath: entry.githubPath,
            rawUrl,
            outputPath: entry.repoPath,
            fileName: entry.fileName,
        };
    }

    /**
     * 展开文件夹选中项为下载项列表。
     *
     * @param {SelectionEntry} entry
     * @returns {Promise<DownloadItem[]>}
     */
    async function expandFolderEntry(entry) {
        const ctx = parseGitHubEntryContext(entry.githubPath);
        if (!ctx || ctx.viewKind !== 'tree') {
            throw new Error(`无法解析文件夹上下文: ${entry?.githubPath}`);
        }

        const treeData = await fetchGitTreeRecursive(ctx);
        if (!treeData || !Array.isArray(treeData.tree)) {
            throw new Error(`Tree API 返回异常: ${entry.githubPath}`);
        }

        if (treeData.truncated) {
            throw new Error(`文件夹过大，无法展开: ${entry.githubPath}`);
        }

        const folderPrefix = `${ctx.repoPath}/`;
        const items = [];

        for (const node of treeData.tree) {
            if (node.type !== 'blob') {
                continue;
            }

            if (!node.path.startsWith(folderPrefix)) {
                continue;
            }

            const encodedRepoPath = encodeGitHubRepoPath(node.path);

            items.push({
                githubPath: `/${ctx.owner}/${ctx.repo}/blob/${ctx.ref}/${encodedRepoPath}`,
                rawUrl: `https://github.com/${ctx.owner}/${ctx.repo}/raw/${ctx.ref}/${encodedRepoPath}`,
                outputPath: node.path,
                fileName: node.path.split('/').pop() || '',
            });
        }

        return items;
    }

    /**
     * @param {DownloadItem & { bytes: Uint8Array }} file
     * @returns {DownloadArtifact}
     */
    function buildSingleFileArtifact(file) {
        const blob = new Blob([file.bytes], { type: "application/octet-stream" });
        return { blob, downloadName: file.fileName };
    }

    /**
     * @param {Array<DownloadItem & { bytes: Uint8Array }>} files
     * @param {string} zipFilename
     * @returns {DownloadArtifact}
     */
    function buildZipArtifact(files, zipFilename) {
        const entries = {};

        for (const file of files) {
            entries[file.outputPath] = file.bytes;
        }

        logger.debug("download", "开始打包");
        const zipU8 = fflate.zipSync(entries, { level: SETTINGS.COMPRESS_LEVEL });
        logger.debug("download", "打包完成!");

        const blob = new Blob([zipU8], { type: "application/zip" });
        return { blob, downloadName: zipFilename };
    }

    /**
     * 并发下载文件列表，并在每个文件完成后上报进度。
     *
     * 无论单个文件成功还是失败，都会计入已完成数量。
     *
     * @param {DownloadItem[]} items
     * @param {(progress: { completed: number, total: number, succeeded: number, failed: number }) => void} [onProgress]
     * @returns {Promise<DownloadExecutionResult>}
     */
    async function fetchDownloadItems(items, onProgress) {
        const queue = [...items];
        const succeeded = [];
        const failed = [];
        const total = items.length;

        async function worker() {
            while (queue.length > 0) {
                const item = queue.pop();

                try {
                    logger.debug("download", `正在下载 [剩余:${queue.length}]: ${item.outputPath}`);
                    const buf = await fetchArrayBufferWithRetry(item);

                    succeeded.push({
                        ...item,
                        bytes: new Uint8Array(buf),
                    });

                    logger.debug("download", `下载完成: ${item.outputPath}`);
                } catch (err) {
                    failed.push({
                        item,
                        error: err,
                    });
                    logger.error("network", `文件下载失败: ${item.rawUrl}`, err);
                } finally {
                    const completed = succeeded.length + failed.length;
                    onProgress?.({
                        completed,
                        total,
                        succeeded: succeeded.length,
                        failed: failed.length,
                    });
                }
            }
        }

        const workers = [];
        const limit = SETTINGS.CONCURRENCY_LIMIT || 3;

        for (let i = 0; i < limit; i++) {
            workers.push(worker());
        }

        await Promise.all(workers);

        return { succeeded, failed };
    }

    /**
     * @param {DownloadExecutionResult} result
     * @returns {boolean}
     */
    async function confirmRetryFailedItems(result) {
        const title = result.succeeded.length > 0
            ? `下载完成，成功 ${result.succeeded.length} 个，失败 ${result.failed.length} 个。`
            : `本次下载全部失败，共 ${result.failed.length} 个文件失败。`;

        return await showConfirmDialog({
            title: '是否重试失败文件？',
            message: `${title}\n是否重试失败文件？\n${buildFailedItemsMessage(result.failed)}`,
            confirmText: '重试',
            cancelText: '取消',
        });
    }


    /**
     * @param {DownloadExecutionResult} result
     * @returns {void}
     */
    async function alertFinalFailedItems(result) {
        const title = result.succeeded.length > 0
            ? '部分文件仍下载失败'
            : '文件仍然全部下载失败';

        const messagePrefix = result.succeeded.length > 0
            ? '部分文件仍下载失败，请检查网络或稍后重试。'
            : '文件仍然全部下载失败，请检查网络或稍后重试。';

        await showAlertDialog({
            title,
            message: `${messagePrefix}\n失败文件列表:\n${buildFailedItemsMessage(result.failed)}`,
            confirmText: '知道了',
        });
    }


    /**
     * @param {Array<{ item: DownloadItem, error: Error }>} failedItems
     * @returns {string}
     */
    function buildFailedItemsMessage(failedItems) {
        const failedMsg = failedItems
            .slice(0, 5)
            .map(f => f.item.outputPath)
            .join('\n');

        return failedItems.length > 5 ? `${failedMsg}\n...` : failedMsg;
    }

    /**
     * 下载单个文件，并在失败时按配置重试。
     *
     * @param {DownloadItem} item
     * @returns {Promise<ArrayBuffer>}
     */
    async function fetchArrayBufferWithRetry(item) {
        const maxAttempts = SETTINGS.RETRY_COUNT + 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await gmFetchArrayBuffer(item.rawUrl, {
                    timeoutMs: SETTINGS.REQUEST_TIMEOUT_MS,
                });
            } catch (err) {
                if (attempt >= maxAttempts) {
                    throw err;
                }

                logger.warn(
                    "network",
                    `下载失败，准备重试 (${attempt}/${SETTINGS.RETRY_COUNT}): ${item.outputPath}`,
                    err
                );
                await sleep(SETTINGS.RETRY_DELAY_MS);
            }
        }

        throw new Error(`下载重试异常结束: ${item.outputPath}`);
    }

    /**
     * 从表格行中解析选中项
     *
     * @param {HTMLElement} rowElement
     * @returns {SelectionEntry|null}
     */
    function parseSelectionFromRow(rowElement) {
        const entryLink = getEntryLink(rowElement);
        if (!entryLink) {
            return null;
        }

        const path = entryLink.getAttribute('href');
        if (!path) {
            return null;
        }

        const ctx = parseGitHubEntryContext(path);
        if (!ctx) {
            return null;
        }


        const ariaLabel = entryLink.getAttribute('aria-label') || '';

        let kind = null;
        if (ariaLabel.endsWith(', (File)')) {
            kind = 'file';
        } else if (ariaLabel.endsWith(', (Directory)')) {
            kind = 'folder';
        } else if (ctx.viewKind === 'blob') {
            kind = 'file';
        } else if (ctx.viewKind === 'tree') {
            kind = 'folder';
        }

        if (!kind) {
            return null;
        }

        // 文件名通常不包含路径符号，可直接取最后一段
        const fileName = ctx.repoPath.split('/').pop() || '';

        return {
            kind,
            githubPath: path,
            repoPath: ctx.repoPath, // 仓库内相对路径
            fileName,
        };
    }

    /**
     * 将 GitHub URL path 中的仓库相对路径段解码为可读名称。
     *
     * 若某个路径段不是合法的 URI 编码，则保留原值。
     *
     * @param {string[]} pathSegments
     * @returns {string}
     */
    function decodeGitHubRepoPath(pathSegments) {
        return pathSegments.map(segment => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        }).join('/');
    }

    /**
     * 将仓库相对路径编码回 GitHub URL 可用形式。
     *
     * @param {string} repoPath
     * @returns {string}
     */
    function encodeGitHubRepoPath(repoPath) {
        return repoPath
            .split('/')
            .filter(Boolean)
            .map(segment => encodeURIComponent(segment))
            .join('/');
    }

    /**
     * 获取目录行中代表文件或文件夹的主链接。
     *
     * 使用 aria-label 中带有 "(File)" 或 "(Directory)" 的链接，
     * 如果没有则退回到 href 中包含 /blob/ 或 /tree/ 的链接。
     *
     * @param {HTMLElement} rowElement
     * @returns {HTMLAnchorElement|null}
     */
    function getEntryLink(rowElement) {
        if (!rowElement) {
            return null;
        }

        return queryFirst(githubSelectors.entryLinkCandidate, rowElement);
    }

    /**
     * 判断是否为文件列表中的特殊功能行，例如 "View all files"。
     *
     * @param {HTMLTableRowElement} rowElement
     * @returns {boolean}
     */
    function isSpecialFileRow(rowElement) {
        if (!rowElement) {
            return false;
        }

        return githubSelectors.specialFileRowCandidate.some(selector => rowElement.matches(selector));
    }

    /**
     * 从文件表格中提取所有文件/目录条目行。
     *
     * 通过条目链接反推所属的 tr。
     *
     * @param {HTMLElement} table
     * @returns {HTMLTableRowElement[]}
     */
    function getEntryRows(table) {
        if (!table) {
            return [];
        }

        const links = queryAll(githubSelectors.entryLinkCandidate, table);

        const rows = [];
        const seenRows = new Set();

        for (const link of links) {
            const row = link.closest('tr');
            if (!row || isSpecialFileRow(row) || seenRows.has(row)) {
                continue;
            }

            seenRows.add(row);
            rows.push(row);
        }

        return rows;
    }

    /**
     * 定位当前页面中的仓库文件表格。
     *
     * 优先寻找包含文件/目录条目链接的 table，CSS class 只作为候选。
     *
     * @param {ParentNode} root
     * @returns {HTMLTableElement|null}
     */
    function findRepositoryFileTable(root = document) {
        const entryLinkSelector = joinSelectors(githubSelectors.entryLinkCandidate);

        for (const selector of githubSelectors.tableCandidate) {
            const tables = root.querySelectorAll(selector);
            for (const table of tables) {
                if (!(table instanceof HTMLTableElement)) {
                    continue;
                }

                if (table.querySelector(entryLinkSelector)) {
                    return table;
                }
            }
        }

        return null;
    }

    /**
     * 在文件表格中定位“上一级目录”对应的行。
     *
     * @param {HTMLElement} table
     * @returns {HTMLTableRowElement|null}
     */
    function findParentDirectoryRow(table) {
        if (!table) {
            return null;
        }

        const parentDirLink = queryFirst(githubSelectors.parentDirLinkCandidate, table);
        if (!parentDirLink) {
            return null;
        }

        const row = parentDirLink.closest('tr');
        if (!row || isSpecialFileRow(row)) {
            return null;
        }

        return row;
    }

    /**
     * 在首页文件表格中定位 latest commit 行。
     *
     * 无法定位时返回 null。该行需要特殊处理以适配新增的复选框列。
     *
     * @param {HTMLElement} table
     * @returns {HTMLTableRowElement|null}
     */
    function findLatestCommitRow(table) {
        if (!table) {
            return null;
        }

        const latestCommitAnchor = queryFirst(githubSelectors.latestCommitAnchorCandidate, table);
        if (!latestCommitAnchor) {
            return null;
        }

        const row = latestCommitAnchor.closest('tr');
        return row instanceof HTMLTableRowElement ? row : null;
    }


    function getSelectionEntries() {
        return Array.from(selectedEntries.values());
    }

    /**
     * 将 GitHub blob path 转换为 raw URL，在无法转化时，返回 null。
     *
     * 例如:
     * - 输入: "/owner/repo/blob/ref/path/to/file"
     * - 输出: "https://github.com/owner/repo/raw/ref/path/to/file"
     *
     * @param {string} filePath
     * @returns {string|null}
     */
    function blobToGithubRawUrl(filePath) {
        const u = new URL(filePath, location.origin);
        const parts = u.pathname.split('/');
        // ["", owner, repo, "blob", ref, ...path]
        if (parts.length < 6 || parts[3] !== 'blob') {
            return null;
        }
        parts[3] = 'raw';
        return `https://github.com/${parts.join('/')}`;
    }

    /**
     * 从 GitHub 页面路径和当前 ref 解析仓库上下文。
     *
     * @param {string} githubPath
     * @returns {GitHubEntryContext|null}
     */
    function parseGitHubEntryContext(githubPath) {
        if (!githubPath) {
            return null;
        }

        const ref = getCurrentRefName();
        if (!ref) {
            logger.warn("plan", "无法获取当前 ref");
            return null;
        }

        const parts = githubPath.split('/');
        // ["", owner, repo, "blob"|"tree", ...refAndPath]
        if (parts.length < 6) {
            return null;
        }

        const owner = parts[1];
        const repo = parts[2];
        const viewKind = parts[3];

        if (!owner || !repo || (viewKind !== 'blob' && viewKind !== 'tree')) {
            return null;
        }

        const refSegments = ref.split('/').filter(Boolean);
        const pathStartIndex = 4 + refSegments.length;
        const repoPathSegments = parts.slice(pathStartIndex);

        if (repoPathSegments.length === 0) {
            return null;
        }

        const repoPath = decodeGitHubRepoPath(repoPathSegments);

        return {
            owner,
            repo,
            viewKind,
            ref,
            repoPath,
        };
    }

    /**
     * @param {string} url
     * @param {{ timeoutMs?: number }} [options]
     * @returns {Promise<ArrayBuffer>}
     */
    function gmFetchArrayBuffer(url, options = {}) {
        const timeoutMs = options.timeoutMs ?? SETTINGS.REQUEST_TIMEOUT_MS;

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                responseType: "arraybuffer",
                timeout: timeoutMs,
                anonymous: false,
                withCredentials: true, // 让 github.com 登录态生效
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) resolve(res.response);
                    else reject(new Error(`HTTP ${res.status}`));
                },
                onerror: () => reject(new Error("Network error")),
                ontimeout: () => reject(new Error(`Request timeout after ${timeoutMs}ms`)),
            });
        });
    }

    /**
     * @param {string} url
     * @param {{ headers?: Record<string, string> }} [options]
     * @returns {Promise<any>}
     */
    function gmFetchJson(url, options = {}) {
        const headers = options.headers || {};
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                responseType: "json",
                timeout: SETTINGS.REQUEST_TIMEOUT_MS,
                anonymous: false,
                withCredentials: true,
                headers,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        resolve(res.response);
                    } else {
                        reject(new Error(`HTTP ${res.status}`));
                    }
                },
                onerror: () => reject(new Error("Network error")),
                ontimeout: () => reject(new Error(`Request timeout after ${SETTINGS.REQUEST_TIMEOUT_MS}ms`)),
            });
        });
    }


    // 为 GitHub REST API 请求构建认证头，私有仓库场景会附带 token
    function buildGitHubApiHeaders() {
        const headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        };

        const token = getGitHubToken();
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        return headers;
    }

    /**
     * 获取当前 ref 下的完整 Git tree
     *
     * 请求头由 buildGitHubApiHeaders() 统一构建，支持私有仓库 API 访问
     *
     * @param {GitHubEntryContext} ctx
     * @returns {Promise<any>}
     */
    async function fetchGitTreeRecursive(ctx) {
        const treeRef = encodeURIComponent(ctx.ref);
        const url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/git/trees/${treeRef}?recursive=1`;

        return await gmFetchJson(url, { headers: buildGitHubApiHeaders() });
    }


    /**
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Dialog & UI Helpers
    function saveBlob(blob, downloadName) {
        saveAs(blob, downloadName);
    }

    let activeDialogResolver = null;
    let activeDialogOverlay = null;
    let downloadStatusClearTimer = null;

    /**
     * 显示通用弹窗。
     *
     * @param {DialogOptions} options
     * @returns {Promise<boolean>}
     */
    function showDialog(options) {
        const {
            title,
            message,
            confirmText = '确定',
            cancelText = '取消',
            confirmOnly = false,
        } = options;

        closeActiveDialog(false);

        const overlay = document.createElement('div');
        overlay.className = 'tm-dialog-overlay';
        overlay.setAttribute('aria-hidden', 'false');

        const dialog = document.createElement('div');
        dialog.className = 'tm-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const header = document.createElement('div');
        header.className = 'tm-dialog-header';

        const titleEl = document.createElement('h2');
        titleEl.className = 'tm-dialog-title';
        titleEl.textContent = title;

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'tm-dialog-close';
        closeBtn.setAttribute('aria-label', '关闭弹窗');
        closeBtn.textContent = '×';

        const content = document.createElement('div');
        content.className = 'tm-dialog-content';
        content.textContent = message;

        const footer = document.createElement('div');
        footer.className = 'tm-dialog-footer';

        closeBtn.addEventListener('click', () => closeActiveDialog(false));

        if (!confirmOnly) {
            footer.appendChild(createDialogButton(cancelText, '', () => closeActiveDialog(false)));
        }
        footer.appendChild(createDialogButton(confirmText, 'primary', () => closeActiveDialog(true)));

        header.appendChild(titleEl);
        header.appendChild(closeBtn);
        dialog.appendChild(header);
        dialog.appendChild(content);
        dialog.appendChild(footer);
        overlay.appendChild(dialog);

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                closeActiveDialog(false);
            }
        });

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                closeActiveDialog(false);
            }
        };

        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKeyDown);
        activeDialogOverlay = overlay;
        overlay.classList.add('is-open');

        return new Promise((resolve) => {
            activeDialogResolver = (result) => {
                document.removeEventListener('keydown', onKeyDown);
                resolve(result);
            };
        });
    }

    /**
     * @param {{ title: string, message: string, confirmText?: string }} options
     * @returns {Promise<boolean>}
     */
    function showAlertDialog(options) {
        return showDialog({
            ...options,
            confirmOnly: true,
            confirmText: options.confirmText || '确定',
        });
    }

    /**
     * @param {{ title: string, message: string, confirmText?: string, cancelText?: string }} options
     * @returns {Promise<boolean>}
     */
    function showConfirmDialog(options) {
        return showDialog({
            ...options,
            confirmOnly: false,
            confirmText: options.confirmText || '继续',
            cancelText: options.cancelText || '取消',
        });
    }

    function openGitHubTokenDialog() {
        closeActiveDialog(false);

        const storedToken = GM_getValue(SETTINGS.GITHUB_TOKEN_STORED_KEY, '');

        const overlay = document.createElement('div');
        overlay.className = 'tm-dialog-overlay';
        overlay.setAttribute('aria-hidden', 'false');

        const dialog = document.createElement('div');
        dialog.className = 'tm-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const header = document.createElement('div');
        header.className = 'tm-dialog-header';

        const titleEl = document.createElement('h2');
        titleEl.className = 'tm-dialog-title';
        titleEl.textContent = 'GitHub Token 设置';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'tm-dialog-close';
        closeBtn.setAttribute('aria-label', '关闭弹窗');
        closeBtn.textContent = '×';

        const content = document.createElement('div');
        content.className = 'tm-dialog-content';

        const form = document.createElement('div');
        form.className = 'tm-token-form';

        const field = document.createElement('div');
        field.className = 'tm-token-field';

        const inputWrap = document.createElement('div');
        inputWrap.className = 'tm-token-input-wrap';

        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'tm-token-input';
        input.value = storedToken || '';
        input.placeholder = 'ghp_xxx 或 github_pat_xxx';
        input.autocomplete = 'off';
        input.spellcheck = false;

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'tm-token-toggle';
        toggleBtn.textContent = '显示';

        const captionRow = document.createElement('div');
        captionRow.className = 'tm-token-caption-row';

        const caption = document.createElement('p');
        caption.className = 'tm-token-caption';
        caption.textContent = '留空后点击保存，将清空已保存的 token。';

        captionRow.appendChild(caption);

        inputWrap.appendChild(input);
        inputWrap.appendChild(toggleBtn);
        field.appendChild(inputWrap);
        field.appendChild(captionRow);
        form.appendChild(field);
        content.appendChild(form);

        const footer = document.createElement('div');
        footer.className = 'tm-dialog-footer';

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                closeTokenDialog();
            }
        };

        const closeTokenDialog = () => {
            document.removeEventListener('keydown', onKeyDown);
            closeActiveDialog(false);
        };

        const cancelBtn = createDialogButton('取消', '', () => closeTokenDialog());
        const saveBtn = createDialogButton('保存', 'primary', () => {
            const value = input.value.trim();

            if (value) {
                setGitHubToken(value);
                closeTokenDialog();
                return;
            }

            clearGitHubToken();
            closeTokenDialog();
        });

        closeBtn.addEventListener('click', closeTokenDialog);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                closeTokenDialog();
            }
        });

        toggleBtn.addEventListener('click', () => {
            const nextType = input.type === 'password' ? 'text' : 'password';
            input.type = nextType;
            toggleBtn.textContent = nextType === 'password' ? '显示' : '隐藏';
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);

        header.appendChild(titleEl);
        header.appendChild(closeBtn);
        dialog.appendChild(header);
        dialog.appendChild(content);
        dialog.appendChild(footer);
        overlay.appendChild(dialog);

        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKeyDown);
        activeDialogOverlay = overlay;
        activeDialogResolver = null;
        overlay.classList.add('is-open');
    }

    /**
     * @param {string} text
     * @param {string} extraClass
     * @param {() => void} onClick
     * @returns {HTMLButtonElement}
     */
    function createDialogButton(text, extraClass, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `tm-dialog-btn ${extraClass}`.trim();
        button.textContent = text;
        button.addEventListener('click', onClick);
        return button;
    }

    /**
     * 关闭当前活动弹窗，并返回结果。
     *
     * @param {boolean} result
     */
    function closeActiveDialog(result) {
        if (activeDialogOverlay) {
            activeDialogOverlay.remove();
            activeDialogOverlay = null;
        }

        if (activeDialogResolver) {
            const resolver = activeDialogResolver;
            activeDialogResolver = null;
            resolver(result);
        }
    }

    // 通用工具函数

    // 尝试多个选择器，返回第一个匹配的元素，无法匹配时返回 null
    function queryFirst(selectors, root = document) {
        for (const selector of selectors) {
            const el = root.querySelector(selector);
            if (el) return el;
        }
        return null;
    }

    // 将多个候选选择器拼成 querySelectorAll 可用的逗号表达式
    function joinSelectors(selectors) {
        return selectors.join(', ');
    }

    // 使用候选选择器组批量查询元素
    function queryAll(selectors, root = document) {
        return root.querySelectorAll(joinSelectors(selectors));
    }

    function setDownloadButtonState({ disabled, text }) {
        const btn = getDownloadButton();
        if (!btn) {
            logger.warn("ui", "未找到下载按钮元素");
            return;
        }
        btn.disabled = disabled;
        btn.textContent = text;
    }

    function resetSelectionState() {
        selectedEntries.clear();
    }

    function resetDownloadButtonState() {
        setDownloadButtonState({ disabled: false, text: '下载所选文件' });
    }

    function getPageKey() {
        return location.pathname + location.search;
    }

    function getDownloadButton() {
        return document.querySelector('.tm-download-btn');
    }

    function getDownloadStatusElement() {
        return document.querySelector('.tm-download-status');
    }

    function getDownloadToolbar() {
        return document.querySelector('.tm-download-toolbar');
    }

    function setDownloadStatus(text) {
        const status = getDownloadStatusElement();
        const toolbar = getDownloadToolbar();
        if (!status) {
            return;
        }

        if (downloadStatusClearTimer) {
            clearTimeout(downloadStatusClearTimer);
            downloadStatusClearTimer = null;
        }

        status.textContent = text || '';
        status.classList.toggle('is-empty', !text);
        toolbar?.classList.toggle('has-status', Boolean(text));
    }

    function setTransientDownloadStatus(text, delayMs = 1500) {
        setDownloadStatus(text);

        downloadStatusClearTimer = setTimeout(() => {
            downloadStatusClearTimer = null;
            clearDownloadStatus();
        }, delayMs);
    }

    function clearDownloadStatus() {
        if (downloadStatusClearTimer) {
            clearTimeout(downloadStatusClearTimer);
            downloadStatusClearTimer = null;
        }

        setDownloadStatus('');
    }

    function getCurrentRefButton() {
        return queryFirst(githubSelectors.refButtonCandidate);
    }

    function getCurrentRefName() {
        const button = getCurrentRefButton();
        if (!button) {
            return null;
        }

        const label = button.getAttribute('aria-label') || '';
        const text = button.textContent?.trim() || '';

        if (text) {
            return text;
        }

        // RefButton 的 aria-label 可能包含分支或标签名称
        // label 值可能为： "main branch"
        if (label.endsWith(' branch')) {
            return label.slice(0, -' branch'.length);
        }
        // label 值可能为： "v1.0.0 tag"
        if (label.endsWith(' tag')) {
            return label.slice(0, -' tag'.length);
        }

        return null;
    }

    function getGitHubToken(defaultValue = '') {
        return SETTINGS.GITHUB_TOKEN_OVERRIDE || GM_getValue(SETTINGS.GITHUB_TOKEN_STORED_KEY, defaultValue);
    }

    function setGitHubToken(token) {
        GM_setValue(SETTINGS.GITHUB_TOKEN_STORED_KEY, token);
    }

    function clearGitHubToken() {
        GM_deleteValue(SETTINGS.GITHUB_TOKEN_STORED_KEY);
    }

    GM_addStyle(`
        .tm-dialog-overlay {
            position: fixed;
            inset: 0;
            z-index: 99999;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 24px;
            background: rgba(27, 31, 36, 0.5);
        }
        .tm-dialog-overlay.is-open {
            display: flex;
        }
        .tm-dialog {
            width: min(560px, calc(100vw - 32px));
            max-height: min(78vh, 760px);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            border: 1px solid #d0d7de;
            border-radius: 8px;
            background: #ffffff;
            color: #24292f;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }
        .tm-dialog-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            padding: 24px 24px 8px 24px;
        }
        .tm-dialog-title {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
            line-height: 1.4;
        }
        .tm-dialog-close {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            padding: 0;
            border: 0;
            border-radius: 6px;
            background: transparent;
            color: #57606a;
            font-size: 24px;
            line-height: 1;
            cursor: pointer;
        }
        .tm-dialog-close:hover {
            background: rgba(175, 184, 193, 0.2);
            color: #24292f;
        }
        .tm-dialog-content {
            padding: 12px 24px 24px 24px;
            max-height: 44vh;
            overflow-y: auto;
            white-space: pre-wrap;
            line-height: 1.6;
            color: #57606a;
            background: inherit;
        }
        .tm-dialog-footer {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            padding: 0 24px 24px 24px;
        }
        .tm-dialog-btn {
            appearance: none;
            border-radius: 6px;
            border: 1px solid #d0d7de;
            background: #f6f8fa;
            color: #24292f;
            font: inherit;
            font-weight: 500;
            padding: 8px 16px;
            cursor: pointer;
        }
        .tm-dialog-btn:hover {
            background: #eef2f6;
        }
        .tm-dialog-btn.primary {
            background: #1f883d;
            border-color: rgba(27, 31, 36, 0.15);
            color: #ffffff;
        }
        .tm-dialog-btn.primary:hover {
            background: #1a7f37;
        }
        .tm-download-toolbar {
            display: inline-flex;
            align-items: stretch;
        }
        .tm-download-btn {
            appearance: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 32px;
            padding: 0 14px;
            border: 1px solid rgba(31, 35, 40, 0.15);
            border-radius: 6px;
            background: #f6f8fa;
            color: #24292f;
            font: inherit;
            font-size: 14px;
            font-weight: 500;
            line-height: 1;
            cursor: pointer;
            box-shadow: 0 1px 0 rgba(27, 31, 36, 0.04);
        }
        .tm-download-btn:hover {
            background: #f3f4f6;
            border-color: rgba(31, 35, 40, 0.18);
        }
        .tm-download-btn:active {
            background: #ebedf0;
            transform: translateY(1px);
        }
        .tm-download-btn:disabled {
            cursor: not-allowed;
            background: #f6f8fa;
            color: #57606a;
            border-color: #d0d7de;
        }
        .tm-download-toolbar.has-status .tm-download-btn {
            border-top-right-radius: 0;
            border-bottom-right-radius: 0;
        }
        .tm-download-status {
            display: inline-flex;
            align-items: center;
            min-height: 32px;
            padding: 0 10px;
            border: 1px solid #d8dee4;
            border-left: 0;
            border-radius: 0 6px 6px 0;
            background: rgba(246, 248, 250, 0.9);
            color: #57606a;
            font-size: 12px;
            line-height: 1;
            white-space: nowrap;
        }
        .tm-download-status.is-empty {
            display: none;
        }
        .tm-token-form {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        .tm-token-field {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .tm-token-input-wrap {
            position: relative;
        }
        .tm-token-input {
            width: 100%;
            min-height: 40px;
            padding: 10px 56px 10px 12px;
            border: 1px solid #d0d7de;
            border-radius: 6px;
            background: #ffffff;
            color: #24292f;
            font: inherit;
        }
        .tm-token-input:focus {
            outline: none;
            border-color: #0969da;
            box-shadow: 0 0 0 3px rgba(9, 105, 218, 0.15);
        }
        .tm-token-toggle {
            position: absolute;
            top: 50%;
            right: 8px;
            transform: translateY(-50%);
            min-width: 40px;
            padding: 4px 8px;
            border: 0;
            border-radius: 6px;
            background: transparent;
            color: #57606a;
            font: inherit;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
        }
        .tm-token-toggle:hover {
            background: rgba(175, 184, 193, 0.18);
            color: #24292f;
        }
        .tm-token-caption-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .tm-token-caption {
            margin: 0;
            font-size: 12px;
            color: #656d76;
        }
        th.tm-left-cell {
            box-sizing: border-box !important;
            width: 32px !important;
            min-width: 32px !important;
            max-width: 32px !important;

            vertical-align: middle !important;
            padding: 0 !important;
            text-align: center !important;

        }
        td.tm-left-cell {
            box-sizing: border-box !important;

            width: 32px !important;
            min-width: 32px !important;
            max-width: 32px !important;

            vertical-align: middle !important;
            padding: 4px 0 0 0 !important;
            text-align: center !important;

            background: inherit !important;
        }
        input.tm-left-cb {
            margin: 0 !important;
            display: inline-block !important;
        }
        @media (prefers-color-scheme: dark) {
            .tm-dialog-overlay {
                background: rgba(1, 4, 9, 0.68);
            }
            .tm-dialog {
                border-color: #30363d;
                background: #161b22;
                color: #e6edf3;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }
            .tm-dialog-close {
                color: #8b949e;
            }
            .tm-dialog-close:hover {
                background: rgba(139, 148, 158, 0.2);
                color: #e6edf3;
            }
            .tm-dialog-content {
                color: #8b949e;
            }
            .tm-dialog-btn {
                border-color: #30363d;
                background: #21262d;
                color: #e6edf3;
            }
            .tm-dialog-btn:hover {
                background: #30363d;
            }
            .tm-dialog-btn.primary {
                background: #238636;
                border-color: rgba(240, 246, 252, 0.1);
                color: #ffffff;
            }
            .tm-dialog-btn.primary:hover {
                background: #2ea043;
            }
            .tm-download-btn {
                border-color: #30363d;
                background: #21262d;
                color: #e6edf3;
                box-shadow: 0 1px 0 rgba(1, 4, 9, 0.24);
            }
            .tm-download-btn:hover {
                background: #30363d;
                border-color: #3d444d;
            }
            .tm-download-btn:active {
                background: #262c36;
            }
            .tm-download-btn:disabled {
                background: #21262d;
                border-color: #30363d;
                color: #8b949e;
                opacity: 1;
            }
            .tm-download-status {
                border-color: #30363d;
                background: rgba(13, 17, 23, 0.9);
                color: #8b949e;
            }
            .tm-token-input {
                border-color: #30363d;
                background: #0d1117;
                color: #e6edf3;
            }
            .tm-token-input:focus {
                border-color: #1f6feb;
                box-shadow: 0 0 0 3px rgba(31, 111, 235, 0.22);
            }
            .tm-token-toggle {
                color: #8b949e;
            }
            .tm-token-toggle:hover {
                background: rgba(110, 118, 129, 0.16);
                color: #e6edf3;
            }
            .tm-token-caption {
                color: #8b949e;
            }
        }
        `
    );

}());
