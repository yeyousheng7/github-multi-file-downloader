import {
    GITHUB_ORIGIN,
    GITHUB_ROOT_ID,
    SETTINGS,
    githubSelectors,
    logger,
} from './config.js';

/**
 * @typedef {Object} GitHubEntryContext
 * @property {string} owner
 * @property {string} repo
 * @property {'blob'|'tree'} viewKind
 * @property {string} ref
 * @property {string} repoPath
 */

/**
 * @typedef {Object} GitTreeNode
 * @property {string} path 相对于本次请求 Tree 根目录的路径
 * @property {'blob'|'tree'|'commit'} type
 * @property {string} sha
 */

/**
 * @typedef {Object} GitTreeResponse
 * @property {string} sha
 * @property {GitTreeNode[]} tree
 * @property {boolean} truncated
 */

/** @typedef {Map<string, Promise<GitTreeResponse>>} TreeRequestCache */

/**
 * 从表格行中解析选中项。
 *
 * @param {HTMLElement} rowElement
 * @returns {{ kind: 'file'|'folder', githubPath: string, repoPath: string, fileName: string }|null}
 */
export function parseSelectionFromRow(rowElement) {
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
        repoPath: ctx.repoPath,
        fileName,
    };
}

/**
 * 构造同一文件的 GitHub 页面路径和原始下载 URL。
 *
 * @param {GitHubEntryContext} ctx
 * @param {string} repoPath
 * @returns {{ githubPath: string, rawUrl: string }}
 */
export function buildGitHubFileUrls(ctx, repoPath) {
    const encodedRef = encodeGitHubPath(ctx.ref);
    const encodedRepoPath = encodeGitHubPath(repoPath);
    const repoBasePath = `/${ctx.owner}/${ctx.repo}`;

    return {
        githubPath: `${repoBasePath}/blob/${encodedRef}/${encodedRepoPath}`,
        rawUrl: new URL(`${repoBasePath}/raw/${encodedRef}/${encodedRepoPath}`, GITHUB_ORIGIN).href,
    };
}

/**
 * @param {string} basePath
 * @param {string} childPath
 * @returns {string}
 */
export function joinRepoPath(basePath, childPath) {
    return [basePath, childPath].filter(Boolean).join('/');
}

/**
 * 从文件表格中提取所有文件/目录条目行。
 *
 * @param {HTMLElement} table
 * @returns {HTMLTableRowElement[]}
 */
export function getEntryRows(table) {
    if (!table) {
        return [];
    }

    const links = table.querySelectorAll(githubSelectors.entryLinkCandidate.join(', '));
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
 * @param {ParentNode} root
 * @returns {HTMLTableElement|null}
 */
export function findRepositoryFileTable(root = document) {
    const entryLinkSelector = githubSelectors.entryLinkCandidate.join(', ');

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
 * 定位包含最近提交栏和文件表格的共同容器。
 * GitHub 新版首页将提交栏移到了表格父容器之外。
 *
 * @param {HTMLTableElement} table
 * @returns {HTMLElement|null}
 */
export function findRepositoryFileContainer(table) {
    const tableContainer = table.parentElement;
    const root = table.closest(`#${GITHUB_ROOT_ID}`) || document;
    const latestCommit = queryFirst(githubSelectors.latestCommitAnchorCandidate, root);

    if (!latestCommit) {
        return tableContainer;
    }

    for (let container = tableContainer; container; container = container.parentElement) {
        if (container.contains(latestCommit)) {
            return container;
        }
    }

    return tableContainer;
}

/**
 * 在文件表格中定位“上一级目录”对应的行。
 *
 * @param {HTMLElement} table
 * @returns {HTMLTableRowElement|null}
 */
export function findParentDirectoryRow(table) {
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
 * 从 GitHub 页面路径和当前 ref 解析仓库上下文。
 *
 * @param {string} githubPath
 * @returns {GitHubEntryContext|null}
 */
export function parseGitHubEntryContext(githubPath) {
    if (!githubPath) {
        return null;
    }

    const ref = getCurrentRefName();
    if (!ref) {
        logger.warn('plan', '无法获取当前 ref');
        return null;
    }

    const parts = githubPath.split('/');
    // ['', owner, repo, 'blob'|'tree', ...refAndPath]
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
 * @param {{ responseType: 'arraybuffer'|'json', headers?: Record<string, string>, timeoutMs?: number }} options
 * @returns {Promise<any>}
 */
export function gmRequest(url, options) {
    const timeoutMs = options.timeoutMs ?? SETTINGS.REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            responseType: options.responseType,
            timeout: timeoutMs,
            anonymous: false,
            withCredentials: true, // 让 github.com 登录态生效
            ...(options.headers ? { headers: options.headers } : {}),
            onload: (res) => {
                if (res.status >= 200 && res.status < 300) resolve(res.response);
                else reject(new Error(`HTTP ${res.status}`));
            },
            onerror: () => reject(new Error('Network error')),
            ontimeout: () => reject(new Error(`Request timeout after ${timeoutMs}ms`)),
        });
    });
}

/**
 * 获取指定 ref 或 SHA 对应的 Git Tree。
 *
 * @param {GitHubEntryContext} ctx
 * @param {string} treeish
 * @param {boolean} recursive
 * @param {TreeRequestCache} treeRequestCache
 * @returns {Promise<GitTreeResponse>}
 */
export function fetchGitTree(ctx, treeish, recursive, treeRequestCache) {
    const encodedTreeish = encodeURIComponent(treeish);
    const recursiveQuery = recursive ? '?recursive=1' : '';
    const url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/git/trees/${encodedTreeish}${recursiveQuery}`;
    let request = treeRequestCache.get(url);

    if (!request) {
        request = gmRequest(url, {
            responseType: 'json',
            headers: buildGitHubApiHeaders(),
        }).then(response => {
            if (!response || typeof response.sha !== 'string' || !Array.isArray(response.tree)) {
                throw new Error(`Tree API 返回异常: ${treeish}`);
            }

            return response;
        });
        treeRequestCache.set(url, request);
    }

    return request;
}

export function getCurrentRefButton() {
    return queryFirst(githubSelectors.refButtonCandidate);
}

export function setGitHubToken(token) {
    GM_setValue(SETTINGS.GITHUB_TOKEN_STORED_KEY, token);
}

export function clearGitHubToken() {
    GM_deleteValue(SETTINGS.GITHUB_TOKEN_STORED_KEY);
}

function getEntryLink(rowElement) {
    if (!rowElement) {
        return null;
    }

    return queryFirst(githubSelectors.entryLinkCandidate, rowElement);
}

function isSpecialFileRow(rowElement) {
    if (!rowElement) {
        return false;
    }

    return githubSelectors.specialFileRowCandidate.some(selector => rowElement.matches(selector));
}

function decodeGitHubRepoPath(pathSegments) {
    return pathSegments.map(segment => {
        try {
            return decodeURIComponent(segment);
        } catch {
            return segment;
        }
    }).join('/');
}

function encodeGitHubPath(value) {
    return value
        .split('/')
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment))
        .join('/');
}

function queryFirst(selectors, root = document) {
    for (const selector of selectors) {
        const element = root.querySelector(selector);
        if (element) return element;
    }
    return null;
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

    if (label.endsWith(' branch')) {
        return label.slice(0, -' branch'.length);
    }
    if (label.endsWith(' tag')) {
        return label.slice(0, -' tag'.length);
    }

    return null;
}

function getGitHubToken(defaultValue = '') {
    return SETTINGS.GITHUB_TOKEN_OVERRIDE
        || GM_getValue(SETTINGS.GITHUB_TOKEN_STORED_KEY, defaultValue);
}

function buildGitHubApiHeaders() {
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };

    const token = getGitHubToken();
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    return headers;
}
