# 共享工程基座接入验证

## 复跑

在项目根目录使用 [mise 工具链](../../mise.toml)。[基座锁](../../dsh-engineering.lock.json)固定 `takboo/dsh-plugin-engineering` 的 v0.1.0-rc.4 和提交 `eabb38152196fdbf3a5a5d470609675bbfecc8c5`。基座 checkout 需要持有锁定 tag。将 checkout 的绝对路径设为 `DSH_ENGINEERING_CHECKOUT`，或写入 `${XDG_CONFIG_HOME:-$HOME/.config}/dsh-plugin-engineering/checkout`。工具核对 origin、tag 和完整提交，再从 Git 对象导出并核对执行文件，因此 checkout 当前分支可停在其他提交。[基座发布页](https://github.com/takboo/dsh-plugin-engineering/releases/tag/v0.1.0-rc.4)

```sh
mise run verify:engineering -- all
```

需要 Docker 和 npm registry 网络。默认从 `HEAD` 的 Git 归档做 frozen install、构建和打包，也可在 `all` 后指定源码提交。探针随当前项目工作区提供，产物、探针和报告保存到命令打印的 `.local/engineering/shared-*` 目录。共享 Web 使用基座固定的 Linux Chromium。托管 runner 的双语 GUI、五平台正式组合和发布仍由 [Session Bin lifecycle](../../.github/workflows/host-lifecycle.yml) 执行，新版宿主由[兼容性巡检](../compatibility.md)跟踪。

[目标配置](../../scripts/engineering/targets.json)中的 `admit` 和 `refuse` 均设置 `ignoreInstallScripts: true`。rc.4 将 `--ignore-scripts` 传给官方 `dsh plugin add`，并在报告中核对每个目标的选项。准入由实际 DSH 按包内声明判定。

Apple Silicon 上使用配置好的共享 Tart 实验室。用 `DSH_TART_HOME` 或同一配置目录的 `tart-home` 指定实验室存储。原生探针需要目标版本官方 macOS ARM64 ZIP 和对应发布 feed 的 base64 SHA-512。来宾复核输入和签名，在临时项目与 `DSH_HOME` 中从候选包取出原样 `dist`，运行已有 Electron/ASAR production probe 和 raw/zstd 原生删除及恢复套件。项目也保留 `mise run verify:desktop` 和 `mise run verify:desktop:gui` 作为独立验收入口。

```sh
mise run verify:engineering -- doctor
mise run verify:engineering -- tart-status
mise run verify:engineering -- tart-readiness
mise run verify:engineering -- tart-native "$shared_run_dir" "$official_desktop_zip" "$official_feed_sha512"
```

## rc.4 接入记录（DSH rc.1，2026-11-12）

本机默认基座 checkout 尚无 rc.4 tag，本次使用同一 origin 的临时 checkout。官方附注 tag 对象 `e263003c757837df6ba7e221958220c56d6c1e04` 指向 `eabb38152196fdbf3a5a5d470609675bbfecc8c5`。

```sh
DSH_ENGINEERING_CHECKOUT=/private/tmp/dsh-base-rc4.bTQh3a/repo \
  mise run verify:engineering -- all 62d5e2b9186d55742813fa9361e36e1fbfb26ecd
```

- 命令退出码为 0。重建的 `@takboo/dsh-session-bin@0.3.0` 与 rc.3 候选逐字节相同，SHA-256 为 `cdf1371188cb91412fae3f3a069bdf822dc5ae424973f6d9ea98d3104b7af0fa`。Web 探针摘要也相同。[命令日志](../../.local/engineering/rc4-shared-command.log)
- 使用 Linux ARM64 / LinuxKit `7.0.14` / Node `24.22.2` / pnpm `11.28.5` / Playwright `1.56.1`，容器 image ID 为 `sha256:4ed32e3fe08ba97f9dda137427ca84cc17efbb633248f753ad512dedb2974744`。报告的 producer 为 `git-archive`，提交与锁一致，五份执行文件摘要均与固定提交的 Git 对象匹配。两个目标的 `ignoreInstallScripts` 均为 `true`。[rc.4 原始报告](../../.local/engineering/shared-uqDGzl/report.json)
- DSH `0.2.2-rc.1` 通过安装、配置合成、Chromium `141.0.7390.37` 中的四项真实 Web 断言及卸载。隔离 fixture 验证了既有原生归档、原生 Archive、取消归档与其他归档保留，以及该容器组合下的永久删除拒绝。
- DSH `0.2.1-rc.5` 对包内 `engines.dsh: 0.2.2-rc.1` 给出预期拒绝。拒绝后 profile manifest 和 lockfile 与安装前一致，合成配置中未出现该插件。
- 接入轮次复跑范围为共享 CLI 与 Web。Tart 沿用下面 rc.3 的原始证据。文档检查及兼容性巡检和发布的 30 项定向回归通过。新版宿主的运行记录见[DSH rc.2 验证](dsh-0.2.2-rc2.md)。

## rc.3 历史记录（2026-11-12）

- 插件远端默认分支为 `main`，当时为 `62d5e2b9186d55742813fa9361e36e1fbfb26ecd`。本地 `codex/dsh022-rc1-compatibility` 为 `d3109efbdd1dcea58c190a9ffb6a2fef5dbac28c`，开始时干净，两个提交文件树相同。本轮用前者的 Git 归档构建。官方基座 `v0.1.0-rc.3` 的附注 tag 对象为 `377700be9a7381d34814f79c074a9ea3c15dbd0b`，指向历史基座提交 `5178a049eddcf03778125be1db3ae523621f2fc3`。
- 候选为 `@takboo/dsh-session-bin@0.3.0`，构建用 Node `24.18.1` / pnpm `11.23.0`。tarball SHA-256 为 `cdf1371188cb91412fae3f3a069bdf822dc5ae424973f6d9ea98d3104b7af0fa`。安装、拒绝、Web 及 Tart 产品探针均引用此包。当时的宿主 npm integrity 和官方 tag 提交记录于下方基座报告。[允许宿主上游 tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1) · [拒绝宿主上游 tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.5)
- 固定基座命令为 `mise run verify:engineering -- all 62d5e2b9186d55742813fa9361e36e1fbfb26ecd`。Linux ARM64 / LinuxKit `7.0.14` / Node `24.22.2` / pnpm `11.28.5`，容器 image ID 为 `sha256:4ed32e3fe08ba97f9dda137427ca84cc17efbb633248f753ad512dedb2974744`。两个 DSH 均通过版本与 profile 准备，默认安装被 `koffi@3.1.1` 的 pnpm 构建审批阻塞。兼容拒绝和 Web 阶段未到达。原版 `verify-host.mjs` SHA-256 为 `1018550ea695af2f47e5d2609a1cf86c257b702a896d13c94e913487b044bbcb`，其余执行文件、镜像和输入摘要见[基座报告](../../.local/engineering/shared-KA4KAq/report.json)。
- 诊断当时运行 `mise run verify:engineering -- diagnose .local/engineering/shared-KA4KAq`，沿用同一 Linux 容器和候选，在 rc.3 的临时导出中给官方 `dsh plugin add` 增加 `--ignore-scripts`。DSH `0.2.2-rc.1` 安装、配置合成、Chromium `141.0.7390.37` 中的 Web 激活及卸载均通过。用本轮生成的四个 SDK fixture 验证原生归档列表、原生 Archive、插件取消归档、其他归档保留和未准入时的删除阻止。DSH `0.2.1-rc.5` 返回精确的 `engines.dsh` 拒绝，profile manifest、lockfile 及合成配置复核通过。报告中的生产者为 `unversioned`，临时修改的 `verify-host.mjs` SHA-256 为 `8f40f9d86eeea59b54f4814fca1f7347854f8dc2d887a23175105873388ccadb`。[诊断报告](../../.local/engineering/shared-KA4KAq/diagnostic-ZnMIfA/report.json)
- Tart 就绪通过。实验室 `shared-tart` 的镜像为 `ghcr.io/cirruslabs/macos-sequoia-base@sha256:eee659985b01e4df2a6c0754bd8d25e54969933c43fdcd4edef8bea337b3d354`，来宾 macOS `15.7.7` / build `24G720` / ARM64。就绪来宾 `dsh-job-20261112T090124-57985` 已回收。[就绪日志](../../.local/engineering/tart-readiness.log)
- 同基线的产品来宾 `dsh-job-20261112T091258-65274` 已回收。挂载点确认为 APFS，来宾 statfs 编号为 `0x1b`。官方 DSH Desktop `0.2.2-rc.1` 的签名团队为 `NAN929V4UM`，实际 Electron `44.7.0` / Node `24.21.0` / libuv `1.52.1`。原样候选 `dist` 的 ASAR production probe 和原生套件 **13 项全部通过**，覆盖 raw/zstd 日志、缓存和 SQLite 清除、七处 SIGKILL 边界恢复、活动会话拒绝和 sibling 保留。ZIP feed SHA-512 为 `mHn+lwXZd7I3ZvakFhRg0lxrGe0pNSmWhMU65AQiyrjy/yfa0C8Rq6nQ6tLcxnqdFYl+j5BN4ghOToTLiT2qGA==`，固定 `run-tart.sh` SHA-256 为 `f391065ef4295fb48dbe2da05579064932c687e13b0cd58e689eddca6395948d`。[原生验收日志](../../.local/engineering/shared-KA4KAq/tart-native-apfs.log)
- 项目 Node `24.18.1` 下 Host/Client 类型检查、GUI 定向回归 21 项、兼容性巡检与发布定向回归 30 项以及文档和市场静态检查均通过。巡检和隔离 Linux 的源码副本包含新锁文件，便于其中的文档检查解析入口。

原生 Desktop shell、官方图形插件管理器安装和其他原生平台未在上述接入验证中运行。生产永久删除资格、历史数据保护与发布门禁以项目各自的契约及验证报告为准。
