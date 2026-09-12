import {
    GITHUB_ROOT_ID,
    githubSelectors,
    logger,
} from './config.js';
import { openGitHubTokenDialog } from './dialogs.js';
import { startDownload } from './download.js';
import {
    findParentDirectoryRow,
    findRepositoryFileTable,
    getCurrentRefButton,
    getEntryRows,
    parseSelectionFromRow,
} from './github.js';

/** @type {Map<string, { kind: 'file'|'folder', githubPath: string, repoPath: string, fileName: string }>} */
const selectedEntries = new Map();

let currentPageKey = null;

export function bootstrap() {
    logger.info('app', 'GitHub Downloader 脚本启动');

    setTimeout(() => {
        apply();
        observeRootChanges();
        registerMenuCommands();
    }, 200);
}

function apply() {
    const pageKey = getPageKey();
    if (pageKey !== currentPageKey) {
        selectedEntries.clear();
        currentPageKey = pageKey;
    }

    const table = findRepositoryFileTable();
    if (!table) {
        logger.warn('ui', '未找到代码表格元素, 退出');
        return;
    }

    // ref 按钮在仓库页面稳定存在，用它作为标志位避免在非仓库页面错误注入
    const refButton = getCurrentRefButton();
    if (!refButton) {
        logger.debug('ui', '当前页面不存在 ref 选择按钮，跳过注入');
        return;
    }
    addCheckboxes(table);
    addDownloadToolbar(table);
    bindTableEvents(table);
}

function observeRootChanges() {
    const root = document.getElementById(GITHUB_ROOT_ID);
    if (!root) {
        logger.warn('app', '未找到页面根级元素, 退出');
        return;
    }
    if (root.dataset.tmObserved === '1') return;
    root.dataset.tmObserved = '1';

    let timer = null;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(apply, 50); // 简单防抖：DOM 连续变化时只跑一次
    };

    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });

    window.addEventListener('popstate', schedule);

    schedule();
}

function registerMenuCommands() {
    GM_registerMenuCommand('设置 GitHub Token', openGitHubTokenDialog);
}

// 在表格中添加复选框列，上一级目录行的复选框禁用，文件行的复选框可用
function addCheckboxes(table) {
    // 所有页面都需要表头占位列，确保它与文件行新增的复选框列对齐。
    // 仓库首页的原生表头高度为 0，空单元格不会额外撑开一行。
    const headerCell = ensureHeader(table);

    // 下面需要先处理上一级目录行，再处理其余文件行
    // 先后顺序不可调换，否则按钮禁用状态将无法正确设置
    // 当前逻辑依赖于 addCheckboxToRow 中的幂等检查，以跳过上一级目录行的重复添加

    const parentDirRow = findParentDirectoryRow(table);

    if (parentDirRow) {
        addCheckboxToRow(parentDirRow, true);
    }

    // 遍历文件行, 添加复选框
    const fileRows = getEntryRows(table);
    logger.debug('ui', `找到 ${fileRows.length} 个文件行元素`);

    for (const row of fileRows) {
        addCheckboxToRow(row);
    }

    addSelectAllCheckbox(table, headerCell, Boolean(parentDirRow));
}

function addCheckboxToRow(rowElement, disabled = false) {
    if (rowElement.querySelector('.tm-left-cb')) {
        return;
    }

    const cell = document.createElement('td');
    cell.className = 'tm-left-cell';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tm-left-cb';
    checkbox.disabled = disabled;

    cell.appendChild(checkbox);
    rowElement.insertBefore(cell, rowElement.firstElementChild);
}

function addSelectAllCheckbox(table, headerCell, isSubdirectory) {
    const target = isSubdirectory
        ? headerCell
        : githubSelectors.latestCommitAnchorCandidate
            .map(selector => document.querySelector(selector))
            .find(Boolean);

    // GitHub 首页会分阶段渲染提交栏，目标尚未出现时等待下一次 DOM 变更重试。
    if (!target) {
        return;
    }

    const existingCheckbox = document.querySelector('.tm-select-all-cb');
    if (existingCheckbox?.parentElement === target) {
        return;
    }

    // SPA 页面切换时如果旧复选框仍在 DOM 中，删除后用当前 table 重新绑定事件。
    existingCheckbox?.remove();

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tm-select-all-cb';
    if (!isSubdirectory) {
        checkbox.classList.add('tm-select-all-cb--commit');
    }
    checkbox.setAttribute('aria-label', '全选当前目录');
    checkbox.addEventListener('change', () => {
        setAllRowsSelected(table, checkbox.checked);
    });

    if (isSubdirectory) {
        target.appendChild(checkbox);
        return;
    }

    target.prepend(checkbox);
}

function setAllRowsSelected(table, checked) {
    const checkboxes = table.querySelectorAll(
        'tbody .tm-left-cb:not(:disabled)'
    );

    for (const checkbox of checkboxes) {
        const rowElement = checkbox.closest('tr');
        const entry = parseSelectionFromRow(rowElement);

        if (!entry) {
            continue;
        }

        checkbox.checked = checked;

        if (checked) {
            selectedEntries.set(entry.githubPath, entry);
        } else {
            selectedEntries.delete(entry.githubPath);
        }
    }
}

// 确保表格有表头单元格, 并返回该单元格(空单元格，用于放置复选框)
function ensureHeader(table) {
    const headRow = table.querySelector('thead tr');
    if (!headRow) {
        logger.warn('ui', '未找到表头行, 退出');
        return;
    }

    const existingCell = headRow.querySelector('th.tm-left-cell');
    if (existingCell) {
        return existingCell;
    }


    const referenceCell = headRow.firstElementChild;
    const headerCell = document.createElement('th');

    headerCell.className = 'tm-left-cell';
    headerCell.textContent = '';

    // 复制参考单元格的背景色
    if (referenceCell) {
        const computedStyle = getComputedStyle(referenceCell);
        headerCell.style.backgroundColor = computedStyle.backgroundColor;
    }

    headRow.insertBefore(headerCell, headRow.firstElementChild);
    return headerCell;
}

// 在表格上方添加下载工具栏(下载按钮与状态显示)
function addDownloadToolbar(table) {
    const container = table.parentElement;
    if (!container) {
        logger.warn('ui', '未找到表格容器元素, 退出');
        return;
    }

    let toolbar = document.querySelector('.tm-download-toolbar');

    if (toolbar) {
        if (toolbar.parentElement !== container ||
            toolbar !== container.firstElementChild) {
            container.prepend(toolbar);
        }
        return;
    }

    toolbar = createDownloadToolbar();
    container.prepend(toolbar);
    logger.debug('ui', '添加下载工具栏');
}

function createDownloadToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'tm-download-toolbar';

    const button = document.createElement('button');
    button.className = 'tm-download-btn';
    button.textContent = '下载所选文件';
    button.disabled = false;
    button.addEventListener('click', () => {
        startDownload(Array.from(selectedEntries.values()));
    });

    const status = document.createElement('span');
    status.className = 'tm-download-status is-empty';

    toolbar.appendChild(button);
    toolbar.appendChild(status);

    return toolbar;
}

function bindTableEvents(table) {
    if (table.dataset.tmBound === '1') {
        return;
    }
    table.dataset.tmBound = '1';

    table.addEventListener('change', (event) => {
        const target = event.target;
        // 只处理在文件行复选框的事件, 忽略全选复选框点击事件
        if (!(target instanceof HTMLInputElement) || !target.classList.contains('tm-left-cb')) {
            return;
        }

        const rowElement = target.closest('tr');
        const entry = parseSelectionFromRow(rowElement);
        if (!entry) {
            return;
        }

        logger.debug('ui', `复选框状态改变, 文件路径: ${entry.githubPath}, 选中: ${target.checked}`);

        if (target.checked) {
            selectedEntries.set(entry.githubPath, entry);
        } else {
            selectedEntries.delete(entry.githubPath);
        }
    });
}

function getPageKey() {
    return location.pathname + location.search;
}
