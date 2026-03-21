// ==UserScript==
// @name         Github Downloader
// @namespace    http://tampermonkey.net/
// @version      0.1
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

    // Github 页面元素属性
    const githubAtrribute = {
        // 页面根级元素 ID
        githubRootId: "repo-content-pjax-container",

        // 代码表格 CSS
        githubTableCss: ".Table-module__Box__HZKiQ",

        // 文件夹或文件行 CSS
        githubFileRowCss: ".react-directory-row",

        // 上一级目录文件行 CSS
        githubParentDirRowCss: ".Table-module__Box_3--CeioY",

        // 文件夹或文件行 ID 前缀
        githubFileRowIdPrefix: "folder-row-", // + number, 例如 folder-row-1

        // 文件行中第一个单元格的类名
        githubFirstCellOnRow: "react-directory-row-name-cell-large-screen",

        // 提交信息行 CSS 
        githubCommitInfoRowCss: ".DirectoryContent-module__Box_3--zI0N1",

    };

    const SETTINGS = {
        // 下载并发数限制
        CONCURRENCY_LIMIT: 6,

        // 调试模式
        DEBUG: true,

        // 压缩等级
        COMPRESS_LEVEL: 3,
    }

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
     */



    debugLog("Github Downloader 脚本启动");

    setTimeout(() => {
        apply();
        observeRootChanges();
    }, 1000);

    function apply() {
        const table = document.querySelector(githubAtrribute.githubTableCss);
        if (!table) {
            debugLog("未找到代码表格元素, 退出");
            return;
        }

        ensureHeader(table);
        addCheckboxes(table);
        addDownloadButton(table);
        bindTableEvents(table);
    }

    function addCheckboxes(table) {
        if (!table) {
            debugLog("代码表格元素为空, 退出");
            return;
        }

        // 遍历文件行, 添加复选框
        const fileRows = table.querySelectorAll(githubAtrribute.githubFileRowCss);
        debugLog(`找到 ${fileRows.length} 个文件行元素`);

        for (let i = 0; i < fileRows.length; i++) {
            const row = fileRows[i];
            const rowId = githubAtrribute.githubFileRowIdPrefix + (i + 1);

            addCheckboxToRow(row, rowId);
            debugLog(`在行 ${rowId} 添加复选框`);
        }

        const parentDirRow = table.querySelector(githubAtrribute.githubParentDirRowCss);

        // 如果在子目录层级，禁用上一级目录的复选框
        if (parentDirRow) {
            addCheckboxToRow(parentDirRow, "parent-dir-row", true);
            debugLog("在上一级目录行添加禁用的复选框");
        }
    }

    function addCheckboxToRow(rowElement, rowId, disabled = false) {
        if (!rowElement) {
            debugLog(`行元素 ${rowId} 为空, 退出`);
            return;
        }
        if (rowElement.querySelector('.tm-left-cb')) {
            debugLog(`行元素 ${rowId} 已存在复选框, 退出`);
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
            debugLog("代码表格元素为空, 退出");
            return;
        }

        const headTr = table.querySelector('thead tr');
        if (!headTr) {
            debugLog("未找到表头行, 退出");
            return;
        };
        if (headTr.querySelector('th.tm-left-cell')) {
            debugLog("表头行已存在复选框列, 退出");
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
            debugLog("未找到代码表格元素, 退出");
            return;
        }

        const container = table.parentElement;
        if (!container) {
            debugLog("未找到表格容器元素, 退出");
            return;
        }

        let btn = document.querySelector('.tm-download-btn');
        if (btn) {
            debugLog("下载按钮已存在, 退出");
            return;
        }

        btn = document.createElement('button');
        btn.className = 'tm-download-btn';
        btn.textContent = '下载所选文件';
        btn.style.marginBottom = '8px';
        btn.addEventListener('click', () => {
            startDownload();
        });
        container.insertBefore(btn, table);
        debugLog("添加下载按钮");
    }

    function fixColumnWidths(table) {
        // 将 colspan += 1, 以适应新增的复选框列
        const commitInfoRow = table.querySelector(githubAtrribute.githubCommitInfoRowCss);
        commitInfoRow?.querySelectorAll('td').forEach(td => {
            const colspan = td.getAttribute('colspan');
            if (colspan) {
                const newColspan = parseInt(colspan) + 1;
                td.setAttribute('colspan', newColspan.toString());
                debugLog(`更新提交信息行的 colspan 为 ${newColspan}`);
            }
        });
    }

    function observeRootChanges() {
        const root = document.getElementById(githubAtrribute.githubRootId);
        if (!root) {
            debugLog("未找到页面根级元素, 退出");
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
            debugLog("代码表格元素为空, 退出");
            return;
        }

        if (table.dataset.tmBound === '1') {
            return;
        }
        table.dataset.tmBound = '1';

        table.addEventListener('change', (event) => {
            const target = event.target;
            if (target && target.classList.contains('tm-left-cb')) {
                const rowElement = target.closest(githubAtrribute.githubFileRowCss);
                const entry = parseSelectionFromRow(rowElement)

                if (!entry) {
                    return;
                }

                debugLog(`复选框状态改变, 文件路径: ${entry.githubPath}, 选中: ${target.checked}`);

                if (target.checked) {
                    selectedEntries.set(entry.githubPath, entry);
                } else {
                    selectedEntries.delete(entry.githubPath);
                }
            }
        });
    }

    async function startDownload() {
        const entries = getSelectionEntries();
        if (entries.length === 0) {
            alert("未选择任何文件！");
            return;
        }

        const plan = buildDownloadPlan(entries);
        if (plan.items.length === 0) {
            alert("没有有效的文件可下载！");
            return;
        }
        await executeDownloadPlan(plan);
    }

    /**
     * 根据选中项构建下载计划
     *
     * @param {SelectionEntry[]} entries
     * @returns {DownloadPlan}
     */
    function buildDownloadPlan(entries) {
        const items = [];

        for (const entry of entries) {
            if (entry.kind === 'folder') {
                throw new Error(`暂不支持下载文件夹: ${entry.githubPath}`);
            }

            const rawUrl = blobToGithubRawUrl(entry.githubPath);
            if (!rawUrl) {
                debugLog(`无法转换为 raw URL, 跳过: ${entry.githubPath}`);
                continue;
            }

            items.push({
                githubPath: entry.githubPath,
                rawUrl,
                outputPath: entry.repoPath,
                fileName: entry.fileName,
            });
        }

        return {
            items,
            outputMode: items.length === 1 ? 'single' : 'zip',
            zipFilename: `github_files_${Date.now()}.zip`,
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

        debugLog("开始打包");
        const zipU8 = fflate.zipSync(entries, { level: SETTINGS.COMPRESS_LEVEL });
        debugLog("打包完成!");

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
                    debugLog(`正在下载 [剩余:${queue.length}]: ${item.outputPath}`);
                    const buf = await gmFetchArrayBuffer(item.rawUrl);

                    succeeded.push({
                        ...item,
                        bytes: new Uint8Array(buf),
                    });

                    debugLog(`下载完成: ${item.outputPath}`);
                } catch (err) {
                    failed.push({
                        item,
                        error: err,
                    });
                    console.error(`文件下载失败: ${item.rawUrl}`, err);
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
     */
    function parseSelectionFromRow(rowElement) {
        const path = getFilePath(rowElement);
        if (!path) return null;

        const parts = path.split('/');
        // [ "", owner, repo, "blob"|"tree", ref, ...path ]
        if (parts.length < 6) return null;

        const kind = parts[3] === 'blob' ? 'file' : (parts[3] === 'tree' ? 'folder' : null);
        if (!kind) return null;

        const repoPath = parts.slice(5).join('/');
        const fileName = repoPath.split('/').pop();

        return {
            kind,
            githubPath: path,
            repoPath,
            fileName,
        }
    }

    /**
     * 获取 GitHub 仓库列表中某一行对应条目的站内路径。
     * 
     * 该结果依赖当前 GitHub 页面 DOM 结构实现，
     * 后续若 GitHub 修改页面结构，此函数可能失效。
     * 
     * 当前:
     *  - 如果是文件, 返回 "/owner/repo/blob/ref/path/to/file"
     *  - 如果是文件夹, 返回 "/owner/repo/tree/ref/path/to/folder"
     * 
     * 返回值示例：
     * - 文件："/owner/repo/blob/ref/path/to/file"
     * - 文件夹："/owner/repo/tree/ref/path/to/folder"
     * 
     * @param {HTMLElement} rowElement 
     * @returns {string|null}
     */
    function getFilePath(rowElement) {
        if (!rowElement) {
            return null;
        }
        // 从 <a> 标签获取文件路径
        // github 存在多个 <a> 标签, 内容都是相同的
        // 因此此处简单实现, 只获取第一个
        // 如果 github 修改了 DOM 结构, 需要调整此处代码
        const a = rowElement.querySelectorAll('a');
        let href = null;
        if (a && a.length > 0) {
            href = a[0].getAttribute('href');
        }
        return href;
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

    function debugLog(msg) {
        if (SETTINGS.DEBUG === true) {
            console.log(msg);
        }
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
        `
    );

}());