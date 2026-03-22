# Github Downloader

一个用于 GitHub 仓库页面的 Tampermonkey 脚本。

目前支持：

- 在仓库文件列表中为文件项添加复选框
- 单文件直接下载
- 多文件打包为 ZIP 下载
- 中文文件名与路径解码

当前限制：

- 暂不支持文件夹下载

基本用法：

1. 在 Tampermonkey 中安装脚本
2. 打开 GitHub 仓库文件页
3. 勾选需要下载的文件并点击“下载所选文件”
