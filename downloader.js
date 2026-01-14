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
        githubTableCss: ".Table-module__Box--KyMHK", 

        // 文件夹或文件行 CSS
        githubFileRowCss: ".react-directory-row",
        
        // 文件夹或文件行 ID 前缀
        githubFileRowIdPrefix: "folder-row-", // + number, 例如 folder-row-1

        // 文件行中第一个单元格的类名
        githubFirstCellOnRow:  "react-directory-row-name-cell-large-screen",

        // 提交信息行 CSS 
        githubCommitInfoRowCss: ".DirectoryContent-module__Box_3--zI0N1",

    };
    
    debugLog("Github Downloader 脚本启动");

    setTimeout(() => {
        initCheckboxes();
    }, 1000);


    function initCheckboxes() {
        // 获取代码表格元素
        const codeTable = document.querySelector(githubAtrribute.githubTableCss);
        if (!codeTable) {
            debugLog("未找到代码表格元素, 退出");
            return;
        }
        debugLog("成功获取代码表格元素");

        // 确保表头有复选框列
        ensureHeader(codeTable);

        // 将 colspan += 1, 以适应新增的复选框列
        const commitInfoRow = codeTable.querySelector(githubAtrribute.githubCommitInfoRowCss);
        commitInfoRow?.querySelectorAll('td').forEach(td => {
            const colspan = td.getAttribute('colspan');
            if (colspan) {
                const newColspan = parseInt(colspan) + 1;
                td.setAttribute('colspan', newColspan.toString());
                debugLog(`更新提交信息行的 colspan 为 ${newColspan}`);
            }
        });

        // 遍历文件行, 添加复选框
        const fileRows = codeTable.querySelectorAll(githubAtrribute.githubFileRowCss);
        debugLog(`找到 ${fileRows.length} 个文件行元素`);

        for(let i = 0; i < fileRows.length; i++) {
            const row = fileRows[i];
            const rowId = githubAtrribute.githubFileRowIdPrefix + (i + 1);
            
            addCheckboxToRow(row, rowId);
            debugLog(`在行 ${rowId} 添加复选框`);
        }
    }

    function addCheckboxToRow(rowElement, rowId) {
        if (rowElement.querySelector('.tm-left-cb')) return;

        const td = document.createElement('td');
        const refCell = rowElement.firstElementChild;

        td.className = `tm-left-cell`;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'tm-left-cb';

        td.appendChild(cb);
        rowElement.insertBefore(td, rowElement.firstElementChild);
    }

    function ensureHeader(table) {
        const headTr = table?.querySelector('thead tr');
        if (!headTr) {
            debugLog("未找到表头行, 退出");
            return;
        };
        if (headTr.querySelector('th.tm-left-cell')) return;

        const th = document.createElement('th');
        th.className = `tm-left-cell`;
    
        th.textContent = '';
        headTr.insertBefore(th, headTr.firstElementChild);
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
            
            background: inherit !important;
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