# 版本说明

**这个目录里跑的是 1.7.0，不是 1.6.0。**

目录名 `AESystemMonitor-1.6.0/` 是 1.6.0 那次发布时定的，之后 1.6.1、1.6.2、1.6.3、1.6.4、1.6.6、1.7.0 都在同一个目录里
继续改 —— 沿用旧名是为了省去三棵树比对时路径变化带来的大面积 diff。

于是形成了三层不一致，历史上很容易让人（和以后的工具）踩空：

| 层 | 值 | 说明 |
|---|---|---|
| 工作目录名 | `AESystemMonitor-1.6.0` | 陈旧，对应 1.6.0 发布 |
| `CSXS/manifest.xml` | `ExtensionBundleVersion="1.7.0"` | **当前真实版本**，以这里为准 |
| 部署目标 `%APPDATA%\Adobe\CEP\extensions\AESystemMonitor` | 无版本号 | 装完看不出是哪个版本 |

（`install.bat` 用 `%~dp0` 取源目录，所以目录叫什么都不影响安装。）

## 唯一事实源

`VERSION` 文件。`tests/wiring.test.js` 的 [17] 组会断言：

- `VERSION` 的内容 == `manifest.xml` 的 `ExtensionBundleVersion`
- `VERSION` 的内容 == `ExtensionList` 里每个 `Extension` 的 `Version`

改版本时**只改 `VERSION` 和 manifest 两处**（manifest 有两处 Version 要同步），跑一遍
`node tests/wiring.test.js` —— 漏改任何一处都会红，不会再出现「面板显示一个版本、
manifest 是另一个」的静默错位。

## 为什么不直接改目录名

改目录名本身是安全的（install.bat 不依赖它），但要同步：
归档脚本 `ship_162.py`、`_synchand.py`、`PLUGIN-REPORT.md:882` 的路径表、
以及三棵树逐字节比对时用的路径 —— 收益只是「目录名好看」，代价是一次大面积路径改动
（而这类改动正是上一轮出错的地方）。**所以这里选择把错位显式化 + 上闸，而不是改名。**

> **文件位置说明（2026-10-25 补）**：上列的 `ship_162.py`、`check_layout_162.py`、
> `tools/ci-local.sh` 都**在工作区根**（`<工作区>/`），**不在本插件目录内** —— 本目录里
> 只有 `_synchand.py`。早先这段没写清楚，读的人会以为文件丢了。发布物的归档目录为
> `<工作区>/AE插件-<版本>-归档/`。