export const GITHUB_ORIGIN = 'https://github.com';
export const GITHUB_ROOT_ID = 'repo-content-pjax-container';

export const githubSelectors = {
    // 文件表格本体
    // 通过文件列表的 aria-labelledby 定位表格
    tableCandidate: [
        'table[aria-labelledby="folders-and-files"]',
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
    // latest commit 左侧内容区；不能使用右侧的 latest-commit-details 作为回退，
    // 否则 GitHub 分阶段渲染时会把全选框插入 SHA/日期区域
    latestCommitAnchorCandidate: [
        '[data-testid="latest-commit"]',
    ],
    // 分支选择按钮
    refButtonCandidate: [
        '#ref-picker-repos-header-ref-selector',
        'button[data-testid="anchor-button"][id="ref-picker-repos-header-ref-selector"]',
        'button[aria-label$=" branch"][data-testid="anchor-button"]',
        'button[aria-label$=" tag"][data-testid="anchor-button"]',
    ],
};

export const SETTINGS = {
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

export const logger = {
    shouldLog(level) {
        const current = LOG_LEVELS[SETTINGS.LOG_LEVEL] ?? LOG_LEVELS.info;
        const target = LOG_LEVELS[level] ?? LOG_LEVELS.info;
        return target >= current;
    },

    format(scope, message) {
        const prefix = scope ? `[GitHub Downloader][${scope}]` : '[GitHub Downloader]';
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
