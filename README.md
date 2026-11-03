# 我的笔记

个人学习知识库，使用 GitHub Pages 托管，笔记通过 GitHub Contents API 保存为 Markdown 文件。

- 网站：<https://532313.github.io/my-notes/>
- 仓库：<https://github.com/532313/my-notes>
- 网站发布分支：`gh-pages`，笔记读写分支：`main`。

## 使用

打开网站即可阅读已发布的笔记和 iTOP-RK3568 驱动开发指南。支持新建笔记、Markdown 编辑和预览、笔记本分类、收藏、回收站、导入 Markdown / 文本 / PDF，以及导出 Markdown。

在指南中点击“记笔记”，可关联当前章节。

写入云端时，点击“连接 GitHub”，使用仅选择本仓库、授予 Contents 读写权限的 fine-grained personal access token。令牌只存在于当前标签页的内存，关闭或刷新后需要重新连接；不会存入 localStorage、源码或仓库。

编辑内容自动保存为当前设备的本机草稿。点击“保存到 GitHub”后，其他设备可以通过“同步”读取。多设备同时编辑相同版本时，保存使用文件 SHA 检查冲突；冲突时保留草稿，可以另存副本，不自动覆盖。

**网站、指南和已发布的笔记公开可见。** 本机草稿不会自动发布。笔记本分类随已发布的笔记同步；阅读位置与最近访问记录保存在当前浏览器。

## 文件

```text
index.html          网站入口
assets/             界面、Markdown 渲染和 GitHub 同步
guide/              已接入的驱动开发指南及图像
notes/*.md          公开笔记，首行注释保存标题、分类等元数据
documents/*.pdf     导入的 PDF，单个不超过 10 MB
```

也可以直接向 `main` 分支的 `notes/` 目录添加 Markdown 文件，网站会在同步后显示。没有网站元数据时，从第一个一级标题或文件名获取笔记名称。

指南保留原作者版权声明，版权归北京迅为电子有限公司。未上传大体积的原 PDF，在线版本保留全部原页图像供核对。

## 本地预览

```sh
python3 -m http.server 8787 --bind 127.0.0.1
```

打开 <http://127.0.0.1:8787/>。网站使用本地打包的 marked、DOMPurify 和 highlight.js；第三方许可证在对应的 vendor 目录中。

前端改动检查后推送 `gh-pages` 分支发布。笔记写入 `main` 不会触发重新构建整份指南。
