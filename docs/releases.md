# Release 流程

版本号以 package.json 为唯一来源，CLI 和 Bun 构建使用同一版本。推送 v* 标签触发 Release 工作流：先验证标签与版本一致，再运行九个 Node.js/OS 校验作业和八个平台构建，全部成功后才发布附件。仅发布作业具有 contents:write 权限。

1. 更新 package.json 版本及需要更新的依赖锁文件、文档，在 docs/releases/v<版本>.md 编写说明；没有说明文件时使用 GitHub 自动生成的说明。
2. 提交到 main，确认检查通过。在确定的提交上创建带注释标签，再推送该标签。

```sh
git tag -a v0.2.0 <commit-sha> -m 'Release v0.2.0'
git push origin v0.2.0
```

3. 查看 Release 工作流，确认所有校验、打包与发布成功。Windows 使用 ZIP，Unix 使用 tar.gz 保留可执行权限，文件名包含版本和平台。每个包包含单独目录、可执行文件、使用文档、Agent Skill 与许可。只从明确的文件白名单打包。
4. 校验 Release 的八个附件和总 SHA256SUMS；解压对应平台附件，对照内层 SHA256SUMS 并运行 --version、-H、doctor。

需要预发布时使用与 package.json 一致的 v<版本>-<标记> 标签，工作流会标为 prerelease。发布后不移动或覆盖已有版本标签；修复后发布新版本。若在创建 Release 前失败，修复外部临时故障后可重跑；如果已创建 Release，请先核查附件状态，避免覆盖已发布内容。
