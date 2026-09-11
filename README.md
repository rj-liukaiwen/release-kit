# 多项目桌面发布工具

把重复的 GitHub 发布流程集中维护，各软件保留自己的构建和验收脚本。

## 使用入口

接入后的项目：**Actions → 发布软件 → Run workflow**。

- `version`：例如 `v2.1.6`，写入应用元数据；已有 Release/tag 不覆盖。
- `source_ref`：包含接入配置的分支或提交，通常为 `main`。
- `mode`：`check` 只检查条件；`artifacts` 构建下载包；`draft` 创建 Release 草稿；`prerelease` 仅对明确允许的项目开放。

初始版本支持测试签名：Windows 未签名、macOS 完整 ad-hoc 且未公证。没有实现正式证书签名时会直接拒绝相应配置，不把测试签名描述成正式签名。

## 每个项目的文件

```text
.github/workflows/release.yml  手动入口，固定引用工具库提交
.release/config.json           名称、Node、版本文件、平台和发布策略
.release/adapter.mjs           本项目的构建、签名与验收入口
```

调用示例（两处 `TOOLKIT_COMMIT_SHA` 必须替换为同一个完整提交）：

```yaml
name: 发布软件
on:
  workflow_dispatch:
    inputs:
      version:
        required: true
        type: string
      source_ref:
        default: main
        type: string
      mode:
        default: draft
        type: choice
        options: [check, artifacts, draft, prerelease]
permissions:
  contents: read
jobs:
  release:
    permissions:
      contents: write
    uses: rj-liukaiwen/release-kit/.github/workflows/desktop.yml@TOOLKIT_COMMIT_SHA
    with:
      toolkit_sha: TOOLKIT_COMMIT_SHA
      version: ${{ inputs.version }}
      source_ref: ${{ inputs.source_ref }}
      mode: ${{ inputs.mode }}
```

不需要个人 PAT，不传递 `secrets: inherit`。准备候选和发布任务获得本项目的 `contents: write`；构建和测试只有只读权限。外部工具工作流不会自动带入辅助脚本，所以每个 job 另外检出同一个 toolkit SHA。

## 适配器接口

ES module 导出：

| 方法 | 责任 |
| --- | --- |
| `preflight(context)` | 不安装依赖即可检查外部组件、锁文件、架构、授权范围和缺项；返回 `{blockers, notes}` |
| `prepareFiles(context)` | 可选，返回 `[{path, content}]`，把本项目的发布元数据写入同一个候选提交；不能覆盖版本文件 |
| `install(context)` | 安装锁定依赖；不能静默升级依赖图 |
| `build(context)` | 执行项目检查、构建、签名、最终包结构检查 |
| `assets(context)` | 返回明确的文件白名单 `[{path, name?, kind?}]`；只有显式标记 `kind: 'update-feed'` 的标准 latest YAML 可省略版本号 |
| `verify(context)` | 验证最终安装包；需人工完成的项目写入报告 |
| `verifyIntel(context)` | 校验下载的同一 Universal 包哈希，在原生 Intel Mac 验证 |

`context` 包含 `root`、`out`、`config`、`version`、`mode`、`target`、`sourceSha`、`toolkitSha`。中间结果放 `.release-out/`，报告放 `.release-out/evidence/`。构建在项目根目录运行。适配器是受信任的仓库代码，不能用此工作流执行外部 PR 的未审查代码。

配置示例：

```json
{
  "schemaVersion": 1,
  "name": "MyApp",
  "node": "24.12.0",
  "packageManager": "pnpm",
  "versionFiles": ["package.json"],
  "adapter": ".release/adapter.mjs",
  "targets": ["windows-x64", "linux-x64", "macos-universal"],
  "signing": "testing",
  "allowPrerelease": false
}
```

适配器可用于 Electron、Tauri、Python 或其他技术栈，但这里只承诺已经实际验证的项目能力。不能把单架构包改名当成 Universal；原生库与辅助程序必须有正确的双架构支持。

## 产物与发布

1. 固定输入源码；版本变化形成独立候选提交，原 main 不被自动改写。
2. Windows、Linux、Mac 使用同一个候选 SHA。
3. 先保留原始 candidate Artifact，再运行安装包验收，失败仍保留候选与证据。
4. Mac 原生 Intel job 校验同一 Universal 包。
5. 所需平台全部通过，校验每个文件 SHA-256，先创建草稿并逐个上传。
6. 验证 GitHub 返回的大小和 digest。只有明确允许的 prerelease 模式才公开草稿；上传失败保留不完整草稿，防止对外展示半套包。

`draft` 是待验候选。真人登录、TCC、升级和项目许可要求不会因生成草稿自动通过。某项目需要真人验收时，完成后在 GitHub Release 页面查看报告并发布；本版本没有自动代签验收回执或同步企业更新服务器。

Artifacts 默认保存 30 天，candidate/诊断保存 14 天。Release 资产长期保留。任务失败先看 summary 和日志；不要直接覆盖旧版本，处理不完整草稿前先核对 source SHA 和已有文件。

## 首批项目

- [ruijie-harness](https://github.com/rj-liukaiwen/ruijie-harness)：Yarn + electron-builder，Windows NSIS、Linux AppImage/deb、macOS Universal DMG，保留原有签名与验收。
- [OpenMausBot](https://github.com/rj-liukaiwen/OpenMausBot)：pnpm 项目，复用已有测试打包、精确 browser vendor、Feishu 分架构运行时和 Universal 签名检查。测试发布沿用仓库所有者批准的策略；正式发布验收仍独立保留。

执行结果以各项目 Actions 为准，接入文件存在不代表所有平台已经成功构建。

## 验证与扩展

工具库自身：`node --test test/*.test.mjs`。GitHub CI 在三个 OS 上验证路径、版本、校验和与跨平台结果合并边界。工作流另外用 actionlint 检查。

先添加一个项目适配器并完成真实三平台运行，再固定引用工具库版本。将来可以增加 Tauri/Python 适配器及集中调度入口；跨仓库调度需要限定仓库权限的 GitHub App，不能依赖某个项目的 GITHUB_TOKEN。
