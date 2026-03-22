// ==UserScript==
// @name         Github Downloader
// @namespace    http://tampermonkey.net/
// @version      0.1.0
// @description  在 Github 仓库页面添加多文件下载按钮, 方便下载。
// @author       yys
// @match        https://github.com/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @require      https://unpkg.com/jszip@3.10.1/dist/jszip.min.js
// @require      https://unpkg.com/file-saver@2.0.5/dist/FileSaver.min.js
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_xmlhttpRequest
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

    // Github 页面元素属性
    const githubAtrribute = {
        // 页面根级元素 ID
        githubRootId: "repo-content-pjax-container",

        // 文件夹或文件行 ID 前缀
        githubFileRowIdPrefix: "folder-row-", // + number, 例如 folder-row-1
    };

    const githubSelectors = {
        // 文件表格本体
        // 主策略依赖“table 内含文件/目录条目链接”来判定是否命中，
        // 因此这里可以接受较宽的候选；
        // 后面的 module class 仅作为备选，Github 可能随时调整样式导致其失效
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
    };

    const SETTINGS = {
        // 下载并发数限制
        CONCURRENCY_LIMIT: 6,

        // 压缩等级
        COMPRESS_LEVEL: 3,

        // 调试
        LOG_LEVEL: 'info',

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
            const prefix = scope ? `[Github Downloader][${scope}]` : "[Github Downloader]";
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
     * @typedef {Object} DownloadPlan
     * @property {DownloadItem[]} items 本次要下载的文件项
     * @property {'single'|'zip'} outputMode 输出模式：单文件或 ZIP
     * @property {string} zipFilename ZIP 下载文件名
     * @property {string[]} skippedFolders 跳过的文件夹列表
     */



    logger.info("app", "Github Downloader 脚本启动");

    setTimeout(() => {
        apply();
        observeRootChanges();
    }, 1000);

    function apply() {
        const pageKey = getPageKey();
        if (pageKey !== currentPageKey) {
            resetSelectionState();
            currentPageKey = pageKey;
        }

        const table = findRepositoryFileTable();
        if (!table) {
            logger.warn("ui", "未找到代码表格元素, 退出");
            return;
        }
        ensureHeader(table);
        addCheckboxes(table);
        addDownloadButton(table);
        bindTableEvents(table);
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
            const rowId = githubAtrribute.githubFileRowIdPrefix + (i + 1);

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
        const refCell = rowElement.firstElementChild;

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

    // 在表格上方添加下载按钮
    function addDownloadButton(table) {
        if (!table) {
            logger.warn("ui", "未找到代码表格元素, 退出");
            return;
        }

        const container = table.parentElement;
        if (!container) {
            logger.warn("ui", "未找到表格容器元素, 退出");
            return;
        }

        let btn = document.querySelector('.tm-download-btn');
        if (btn) {
            logger.debug("ui", "下载按钮已存在, 退出");
            return;
        }

        btn = document.createElement('button');
        btn.className = 'tm-download-btn';
        btn.textContent = '下载所选文件';
        btn.style.marginBottom = '8px';
        btn.disabled = false;
        btn.addEventListener('click', () => {
            startDownload();
        });
        container.insertBefore(btn, table);
        logger.debug("ui", "添加下载按钮");
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

    function observeRootChanges() {
        const root = document.getElementById(githubAtrribute.githubRootId);
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
            alert("未选择任何文件！");
            return;
        }

        logger.info("download", `开始下载，选中 ${entries.length} 个项目`);
        setDownloadButtonState({ disabled: true, text: '下载中...' });

        try {
            const plan = buildDownloadPlan(entries);
            if (plan.items.length === 0) {
                alert("没有有效的文件可下载！(暂不支持文件夹下载)");
                return;
            }

            if (plan.skippedFolders.length > 0) {
                let skippedListTop5Msg =
                    plan.skippedFolders
                        .slice(0, 5)
                        .map((folderPath) => decodeGitHubRepoPath(folderPath.split('/')))
                        .join('\n');
                if (plan.skippedFolders.length > 5) skippedListTop5Msg += '\n...';
                let ok = confirm(`有 ${plan.skippedFolders.length} 个文件夹被跳过，是否继续下载？\n${skippedListTop5Msg}`);
                if (!ok) {
                    return;
                }
            }

            await executeDownloadPlan(plan);
        } finally {
            resetDownloadButtonState();
        }
    }

    /**
     * 根据选中项构建下载计划
     *
     * @param {SelectionEntry[]} entries
     * @returns {DownloadPlan}
     */
    function buildDownloadPlan(entries) {
        const items = [];
        const skippedFolders = [];

        for (const entry of entries) {
            if (entry.kind === 'folder') {
                skippedFolders.push(entry.githubPath);
                logger.warn("plan", `跳过文件夹: ${entry.githubPath}`);
                continue;
            }

            const rawUrl = blobToGithubRawUrl(entry.githubPath);
            if (!rawUrl) {
                logger.warn("plan", `无法转换为 raw URL, 跳过: ${entry.githubPath}`);
                continue;
            }

            items.push({
                githubPath: entry.githubPath,
                rawUrl,
                outputPath: entry.repoPath,
                fileName: entry.fileName,
            });
        }

        logger.info("plan", `下载计划已生成，文件数: ${items.length}，模式: ${items.length === 1 ? 'single' : 'zip'}`);

        return {
            items,
            outputMode: items.length === 1 ? 'single' : 'zip',
            zipFilename: `github_files_${Date.now()}.zip`,
            skippedFolders,
        }
    }

    async function executeDownloadPlan(plan) {
        const result = await fetchDownloadItems(plan.items);

        if (result.succeeded.length === 0) {
            alert("下载失败，没有成功获取任何文件");
            return;
        }
        let artifact;
        if (plan.outputMode === 'single') {
            artifact = buildSingleFileArtifact(result.succeeded[0]);
        } else if (plan.outputMode === 'zip') {
            artifact = buildZipArtifact(result.succeeded, plan.zipFilename);
        } else {
            alert(`未知的输出模式: ${plan.outputMode}`);
            return;
        }


        saveBlob(artifact.blob, artifact.downloadName);
        logger.info("download", `下载完成，成功 ${result.succeeded.length} 个，失败 ${result.failed.length} 个`);

        if (result.failed.length > 0) {
            // TODO: 优化提示或提供重试功能
            alert(`部分文件下载失败: \n${result.failed.map(f => f.item.githubPath).join('\n')}`);
        }
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

    async function fetchDownloadItems(items) {
        const queue = [...items];
        const succeeded = [];
        const failed = [];

        async function worker() {
            while (queue.length > 0) {
                const item = queue.pop();

                try {
                    logger.debug("download", `正在下载 [剩余:${queue.length}]: ${item.outputPath}`);
                    const buf = await gmFetchArrayBuffer(item.rawUrl);

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

        const parts = path.split('/');
        // ["", owner, repo, "blob"|"tree", ref, ...path]
        if (parts.length < 6) {
            return null;
        }

        const ariaLabel = entryLink.getAttribute('aria-label') || '';

        let kind = null;
        if (ariaLabel.endsWith(', (File)')) {
            kind = 'file';
        } else if (ariaLabel.endsWith(', (Directory)')) {
            kind = 'folder';
        } else if (parts[3] === 'blob') {
            kind = 'file';
        } else if (parts[3] === 'tree') {
            kind = 'folder';
        }

        if (!kind) {
            return null;
        }

        const repoPath = decodeGitHubRepoPath(parts.slice(5));
        const fileName = repoPath.split('/').pop() || '';

        return {
            kind,
            githubPath: path,
            repoPath,
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
     * 获取 GitHub 仓库列表中某一行对应条目的站内路径。
     *
     * 当前:
     * - 文件: "/owner/repo/blob/ref/path/to/file"
     * - 文件夹: "/owner/repo/tree/ref/path/to/folder"
     *
     * @param {HTMLElement} rowElement
     * @returns {string|null}
     */
    function getFilePath(rowElement) {
        const entryLink = getEntryLink(rowElement);
        if (!entryLink) {
            return null;
        }

        return entryLink.getAttribute('href');
    }


    /**
     * 获取目录行中代表文件或文件夹的主链接。
     *
     * 优先使用 aria-label 中带有 "(File)" 或 "(Directory)" 的链接，
     * 失败时再退回到 href 中包含 /blob/ 或 /tree/ 的链接。
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

    function gmFetchArrayBuffer(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                responseType: "arraybuffer",
                anonymous: false,
                withCredentials: true, // 让 github.com 登录态生效
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) resolve(res.response);
                    else reject(new Error(`HTTP ${res.status}`));
                },
                onerror: () => reject(new Error("Network error")),
            });
        });
    }

    function saveBlob(blob, downloadName) {
        saveAs(blob, downloadName);
    }

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

    GM_addStyle(`
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
        button.tm-download-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        `
    );

}());
