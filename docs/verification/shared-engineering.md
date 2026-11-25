# 共享工程基座接入验证

## 复跑

在项目根目录使用 [mise 工具链](../../mise.toml)（完整任务矩阵与证据分级见 [开发与验证流程](../workflow.md)）。[基座锁](../../dsh-engineering.lock.json)固定 `takboo/dsh-plugin-engineering` 的 `v0.2.0` 与提交 `7477a5dc7e8c062b24deb32a28d8357f92dd6b61`。基座 checkout 必须持有锁定 tag。[基座发布页](https://github.com/takboo/dsh-plugin-engineering/releases/tag/v0.2.0)

**必需前置条件**：`locked-run.mjs` 仅接受 `--checkout <abs-path>`、环境变量 `DSH_ENGINEERING_CHECKOUT`（绝对路径，不含 `..`）或 `${XDG_CONFIG_HOME:-$HOME/.config}/dsh-plugin-engineering/checkout`（单行绝对路径，不含 `..`）解析基座 checkout。`mise.toml` 中的 `../dsh-plugin-engineering` 仅在 `DSH_ENGINEERING_CHECKOUT` 未设置且本地 `checkout` 配置文件已就绪时定位 runner 脚本，不能单独满足 checkout 解析。统一入口 `locked-run.mjs` 会核对 origin、tag 与完整提交，从 Git 对象导出并校验执行文件，再在报告中复核 `provenance`。

```sh
export DSH_ENGINEERING_CHECKOUT=/abs/path/to/dsh-plugin-engineering
node "${DSH_ENGINEERING_CHECKOUT}/scripts/locked-run.mjs" doctor
mise run check
mise run verify:host
```

- `mise run check` 串接 `check:shell`（`locked-run.mjs check-plugin`）、`verify:docs`、`verify:market` 与 `check:types`。
- `mise run verify:host` 按三步串行 DAG 执行（`verify:pack` -> `verify:host:container` -> `verify:host`）：
  1. `verify:pack` 要求全部打包与探针输入与已提交 `HEAD` 一致（脏工作区直接拒绝）；`mise.toml` 为每次 `mise run` 调用自动分配唯一、一次写入的 `DSH_ENGINEERING_ACTIVE_RUN_DIR`（`.local/engineering/run-<rand>`），`verify:pack` 以原子 `mkdir` 创建该独占目录（复用已有目录以 `EEXIST` 直接拒绝），再按捕获的完整 `sourceCommit` SHA 导出 `git archive` 到独立临时目录完成离线 frozen install、隔离构建（不共用工作区 `dist/`）与 `scripts/verify-package.mjs --save-tarball ... --save-report ...` 全量 E1 校验；随后将归档内的 `targets.json` 连同 `candidate.tgz`、`probe.mjs` 原子写出，并按 E1 私有报告摘要绑定 `e1-manifest.json`。
  2. `verify:host:container` 调用 `locked-run.mjs container all`，消费同一独占运行目录内的归档 `targets.json`、`probe.mjs` 与 `candidate.tgz`，在固定 Linux 容器内执行 `admit` CLI/Web 与 `refuse` 检查，输出 `host-report.json`（需要 Docker 与 npm registry 网络）。
  3. `verify:host` 调用只读且幂等的 `node scripts/engineering/pack-host.mjs --verify-report`，交叉复核 `host-report.json`、`e1-manifest.json`、当前 `HEAD`、提交内 `targets.json` 与磁盘产物完全一致。
- 每次 `mise run` 默认使用全新独占的 `DSH_ENGINEERING_ACTIVE_RUN_DIR`，并行运行、单独执行 `mise run verify:pack` 以及容器失败后直接重试均不会冲突；也可显式传入尚未存在的 `DSH_ENGINEERING_RUN_DIR` 作为覆盖。
- 托管 runner 的双语 GUI、五平台正式组合与发布仍由 [Session Bin lifecycle](../../.github/workflows/host-lifecycle.yml) 执行，新版宿主由[兼容性巡检](../compatibility.md)跟踪。

[目标配置](../../scripts/engineering/targets.json)中的 `admit` 和 `refuse` 均设置 `ignoreInstallScripts: true`，基座将 `--ignore-scripts` 传给官方 `dsh plugin add` 并在报告中核对每个目标的选项；准入由实际 DSH 按包内声明判定。

### Apple Silicon 共享 Tart 产品验收（E3）

Apple Silicon 上通过 `locked-run.mjs tart` 调用共享 Tart 实验室（以 `DSH_TART_HOME` 或 `${XDG_CONFIG_HOME:-$HOME/.config}/dsh-plugin-engineering/tart-home` 指定存储）。项目保留来宾探针 [desktop-guest.sh](../../scripts/engineering/desktop-guest.sh) 及独立的 `mise run verify:desktop` / `mise run verify:desktop:gui` 入口。使用同一份已通过 E1/E2 的候选包执行 Tart 产品验收时，准备独立输入目录 `DSH_TART_INPUTS`（包含以下三个文件）并传入对应摘要：

1. `plugin.tgz`：复用同一份已通过 E1/E2 的 `candidate.tgz`，记录其 SHA-256（`<plugin_sha256>`）。
2. `project.tar.gz`：从同一 `sourceCommit` 导出源码、使用固定 Node/pnpm 完成 `pnpm install --frozen-lockfile --ignore-scripts` 后打包，记录其 SHA-256（`<project_sha256>`）。
3. `desktop.zip`：目标版本的官方签名 macOS ARM64 Desktop ZIP，核对其 base64 SHA-512 与官方发布 feed 一致（`<desktop_feed_sha512>`）。

```sh
node "${DSH_ENGINEERING_CHECKOUT:-../dsh-plugin-engineering}/scripts/locked-run.mjs" tart status
DSH_TART_INPUTS="<inputs-dir>" node "${DSH_ENGINEERING_CHECKOUT:-../dsh-plugin-engineering}/scripts/locked-run.mjs" tart run \
  scripts/engineering/desktop-guest.sh "<plugin_sha256>" "<desktop_feed_sha512>" "<project_sha256>" "<engines_dsh>"
```

## rc.5 接入记录（DSH rc.3，2026-11-17）

基座 rc.5 更新了发布后的仓库同步规范。与 rc.4 比较，执行脚本和环境定义逐字节一致。[基座变更](https://github.com/takboo/dsh-plugin-engineering/compare/v0.1.0-rc.4...v0.1.0-rc.5)

- `mise run verify:engineering -- all v0.3.2` 从 `7100f1f21d71ae4a64879c33e6475455f919b9d4` 重建 `@takboo/dsh-session-bin@0.3.2`。tarball SHA-256 为 `e25de03e62ccc3fef5e5cced266a110e761e36b88fd3abc0d81390a9691a6ab6`，与 [0.3.2 验收记录](dsh-0.2.2-rc3.md)一致。
- Linux ARM64 容器使用 Node `24.22.2`、pnpm `11.28.5` 和 Chromium `141.0.7390.37`。DSH `0.2.2-rc.3` 的安装、四项隔离 Web 断言和卸载通过。DSH `0.2.2-rc.2` 按 `engines.dsh` 预期拒绝。报告的 Git 归档提交与 rc.5 锁一致，执行文件摘要和输入摘要已复核。原始报告 (`.local/engineering/shared-NZVQgp/report.json`)
- 本轮复跑覆盖共享 CLI 和 Web。原生 Desktop 与正式平台资格见 [0.3.2 验证](dsh-0.2.2-rc3.md)。

## rc.4 接入记录（DSH rc.1，2026-11-12）

本机默认基座 checkout 尚无 rc.4 tag，本次使用同一 origin 的临时 checkout。官方附注 tag 对象 `e263003c757837df6ba7e221958220c56d6c1e04` 指向 `eabb38152196fdbf3a5a5d470609675bbfecc8c5`。

```sh
DSH_ENGINEERING_CHECKOUT=/private/tmp/dsh-base-rc4.bTQh3a/repo \
  mise run verify:engineering -- all 62d5e2b9186d55742813fa9361e36e1fbfb26ecd
```

- 命令退出码为 0。重建的 `@takboo/dsh-session-bin@0.3.0` 与 rc.3 候选逐字节相同，SHA-256 为 `cdf1371188cb91412fae3f3a069bdf822dc5ae424973f6d9ea98d3104b7af0fa`。Web 探针摘要也相同。命令日志 (`.local/engineering/rc4-shared-command.log`)
- 使用 Linux ARM64 / LinuxKit `7.0.14` / Node `24.22.2` / pnpm `11.28.5` / Playwright `1.56.1`，容器 image ID 为 `sha256:4ed32e3fe08ba97f9dda137427ca84cc17efbb633248f753ad512dedb2974744`。报告的 producer 为 `git-archive`，提交与锁一致，五份执行文件摘要均与固定提交的 Git 对象匹配。两个目标的 `ignoreInstallScripts` 均为 `true`。rc.4 原始报告 (`.local/engineering/shared-uqDGzl/report.json`)
- DSH `0.2.2-rc.1` 通过安装、配置合成、Chromium `141.0.7390.37` 中的四项真实 Web 断言及卸载。隔离 fixture 验证了既有原生归档、原生 Archive、取消归档与其他归档保留，以及该容器组合下的永久删除拒绝。
- DSH `0.2.1-rc.5` 对包内 `engines.dsh: 0.2.2-rc.1` 给出预期拒绝。拒绝后 profile manifest 和 lockfile 与安装前一致，合成配置中未出现该插件。
- 接入轮次复跑范围为共享 CLI 与 Web。Tart 沿用下面 rc.3 的原始证据。文档检查及兼容性巡检和发布的 30 项定向回归通过。新版宿主的运行记录见[DSH rc.2 验证](dsh-0.2.2-rc2.md)。

## rc.3 历史记录（2026-11-12）

- 插件远端默认分支为 `main`，当时为 `62d5e2b9186d55742813fa9361e36e1fbfb26ecd`。本地 `codex/dsh022-rc1-compatibility` 为 `d3109efbdd1dcea58c190a9ffb6a2fef5dbac28c`，开始时干净，两个提交文件树相同。本轮用前者的 Git 归档构建。官方基座 `v0.1.0-rc.3` 的附注 tag 对象为 `377700be9a7381d34814f79c074a9ea3c15dbd0b`，指向历史基座提交 `5178a049eddcf03778125be1db3ae523621f2fc3`。
- 候选为 `@takboo/dsh-session-bin@0.3.0`，构建用 Node `24.18.1` / pnpm `11.23.0`。tarball SHA-256 为 `cdf1371188cb91412fae3f3a069bdf822dc5ae424973f6d9ea98d3104b7af0fa`。安装、拒绝、Web 及 Tart 产品探针均引用此包。当时的宿主 npm integrity 和官方 tag 提交记录于下方基座报告。[允许宿主上游 tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1) · [拒绝宿主上游 tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.5)
- 固定基座命令为 `mise run verify:engineering -- all 62d5e2b9186d55742813fa9361e36e1fbfb26ecd`。Linux ARM64 / LinuxKit `7.0.14` / Node `24.22.2` / pnpm `11.28.5`，容器 image ID 为 `sha256:4ed32e3fe08ba97f9dda137427ca84cc17efbb633248f753ad512dedb2974744`。两个 DSH 均通过版本与 profile 准备，默认安装被 `koffi@3.1.1` 的 pnpm 构建审批阻塞。兼容拒绝和 Web 阶段未到达。原版 `verify-host.mjs` SHA-256 为 `1018550ea695af2f47e5d2609a1cf86c257b702a896d13c94e913487b044bbcb`，其余执行文件、镜像和输入摘要见基座报告 (`.local/engineering/shared-KA4KAq/report.json`)。
- 诊断当时运行 `mise run verify:engineering -- diagnose .local/engineering/shared-KA4KAq`，沿用同一 Linux 容器和候选，在 rc.3 的临时导出中给官方 `dsh plugin add` 增加 `--ignore-scripts`。DSH `0.2.2-rc.1` 安装、配置合成、Chromium `141.0.7390.37` 中的 Web 激活及卸载均通过。用本轮生成的四个 SDK fixture 验证原生归档列表、原生 Archive、插件取消归档、其他归档保留和未准入时的删除阻止。DSH `0.2.1-rc.5` 返回精确的 `engines.dsh` 拒绝，profile manifest、lockfile 及合成配置复核通过。报告中的生产者为 `unversioned`，临时修改的 `verify-host.mjs` SHA-256 为 `8f40f9d86eeea59b54f4814fca1f7347854f8dc2d887a23175105873388ccadb`。诊断报告 (`.local/engineering/shared-KA4KAq/diagnostic-ZnMIfA/report.json`)
- Tart 就绪通过。实验室 `shared-tart` 的镜像为 `ghcr.io/cirruslabs/macos-sequoia-base@sha256:eee659985b01e4df2a6c0754bd8d25e54969933c43fdcd4edef8bea337b3d354`，来宾 macOS `15.7.7` / build `24G720` / ARM64。就绪来宾 `dsh-job-20261112T090124-57985` 已回收。就绪日志 (`.local/engineering/tart-readiness.log`)
- 同基线的产品来宾 `dsh-job-20261112T091258-65274` 已回收。挂载点确认为 APFS，来宾 statfs 编号为 `0x1b`。官方 DSH Desktop `0.2.2-rc.1` 的签名团队为 `NAN929V4UM`，实际 Electron `44.7.0` / Node `24.21.0` / libuv `1.52.1`。原样候选 `dist` 的 ASAR production probe 和原生套件 **13 项全部通过**，覆盖 raw/zstd 日志、缓存和 SQLite 清除、七处 SIGKILL 边界恢复、活动会话拒绝和 sibling 保留。ZIP feed SHA-512 为 `mHn+lwXZd7I3ZvakFhRg0lxrGe0pNSmWhMU65AQiyrjy/yfa0C8Rq6nQ6tLcxnqdFYl+j5BN4ghOToTLiT2qGA==`，固定 `run-tart.sh` SHA-256 为 `f391065ef4295fb48dbe2da05579064932c687e13b0cd58e689eddca6395948d`。原生验收日志 (`.local/engineering/shared-KA4KAq/tart-native-apfs.log`)
- 项目 Node `24.18.1` 下 Host/Client 类型检查、GUI 定向回归 21 项、兼容性巡检与发布定向回归 30 项以及文档和市场静态检查均通过。巡检和隔离 Linux 的源码副本包含新锁文件，便于其中的文档检查解析入口。

原生 Desktop shell、官方图形插件管理器安装和其他原生平台未在上述接入验证中运行。生产永久删除资格、历史数据保护与发布门禁以项目各自的契约及验证报告为准。
