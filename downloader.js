// ==UserScript==
// @name         Github Downloader
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  在 Github 仓库页面添加多文件下载按钮, 方便下载。
// @author       yys
// @match        https://github.com/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant GM_addStyle
// ==/UserScript==

(function() {
    'use strict';
    // @ts-check

    const DEBUG = true;


    // Github 页面元素属性
    const githubAtrribute = {
        // 页面根级元素 ID
        githubRootId: "repo-content-pjax-container",

        // 代码表格 CSS
        githubTableCss: ".Table-module__Box--KyMHK", 

        // 文件夹或文件行 CSS
        githubFileRowCss: ".react-directory-row",

        // 上一级目录文件行 CSS
        githubParentDirRowCss: ".Table-module__Box_3--CeioY",
        
        // 文件夹或文件行 ID 前缀
        githubFileRowIdPrefix: "folder-row-", // + number, 例如 folder-row-1

        // 文件行中第一个单元格的类名
        githubFirstCellOnRow:  "react-directory-row-name-cell-large-screen",

        // 提交信息行 CSS 
        githubCommitInfoRowCss: ".DirectoryContent-module__Box_3--zI0N1",

    };
    
    debugLog("Github Downloader 脚本启动");

    setTimeout(() => {
        observeRootChanges();
    }, 1000);

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

    function apply() {
        const table = document.querySelector(githubAtrribute.githubTableCss);
        if (!table) {
            debugLog("未找到代码表格元素, 退出");
            return;
        }

        ensureHeader(table);
        addCheckboxes(table);
    }

    function addCheckboxes(table) {
        if (!table) {
            debugLog("代码表格元素为空, 退出");
            return;
        }

        // 遍历文件行, 添加复选框
        const fileRows = table.querySelectorAll(githubAtrribute.githubFileRowCss);
        debugLog(`找到 ${fileRows.length} 个文件行元素`);

        for(let i = 0; i < fileRows.length; i++) {
            const row = fileRows[i];
            const rowId = githubAtrribute.githubFileRowIdPrefix + (i + 1);
            
            addCheckboxToRow(row, rowId);
            debugLog(`在行 ${rowId} 添加复选框`);
        }

        const parentDirRow = table.querySelector(githubAtrribute.githubParentDirRowCss);

        // 如果在子目录层级，禁用上一级目录的复选框
        if(parentDirRow) {
            addCheckboxToRow(parentDirRow, "parent-dir-row", true);
            debugLog("在上一级目录行添加禁用的复选框");
        }
    }

    function addCheckboxToRow(rowElement, rowId, disabled = false) {
        if (rowElement.querySelector('.tm-left-cb')) return;

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
        if(!table) {
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


    function debugLog(msg) {
        if(DEBUG === true) {
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

})();