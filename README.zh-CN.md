# dsh-ui-appearance

[English](README.md) | 简体中文

一个轻量级的 DeepSeek Harness 外观插件。

**Wallpaper. Glass. Accent. 仅此而已。**

## 预览

截图将在发布前补充：

- `preview.webp` — 主界面，展示自定义壁纸 + 玻璃质感面板 + 重点色
- `settings.webp` — 插件的 Appearance 设置区域

## 功能

1. **自定义壁纸**
   - 支持远程图片 URL，或本地上传图片
   - 可调节背景不透明度与背景模糊

2. **玻璃质感面板**
   - 可调节面板透明度，营造轻量的玻璃质感

3. **重点色 (Accent)**
   - 自定义 DSH 界面中受支持状态的重点色
   - 自动适配 DSH 原生浅色 / 深色外观

## 设计理念

`dsh-ui-appearance` 刻意保持小巧、专注、可预期。

- 不建立第二套主题系统。
- 不替代 DSH 原生外观设置。
- Light / Dark / System 完全由 DSH 原生设置管理。插件不会修改原生颜色模式。
- 默认保持 DSH 原生外观，仅在你主动配置后应用对应的视觉效果。

## 兼容性

已在 DeepSeek Harness 0.1.0-rc.7 上完成测试。

DeepSeek Harness 仍在快速迭代，未来版本可能改变插件接口。

## 安装

直接从 GitHub 仓库安装（经 pnpm 底层的 `dsh plugin add`）：

```sh
dsh plugin --profile web add git+https://github.com/mumuer1024/dsh-ui-appearance.git
dsh --profile web
```

如需固定到某个具体版本，可在 URL 后附加 tag：

```sh
dsh plugin --profile web add 'git+https://github.com/mumuer1024/dsh-ui-appearance.git#v0.1.0'
```

`dsh plugin add` 会在首次使用时初始化 profile，并自动接入 bundle。之后启动 Web UI，
打开 **设置 → 外观 (Appearance)** 即可。

## 配置

打开 **设置 → 外观 (Appearance)**（插件在该页新增了自己的分区）：

- **背景**：关闭 / URL / 本地上传；背景不透明度；背景模糊。
- **面板不透明度**：主界面表面的半透明程度。
- **重点色**：选择颜色，或恢复原生值。

配置保存在 DSH 主机端，因此通过不同设备访问时也会使用同一套外观配置。

## 卸载

```sh
dsh plugin --profile web remove dsh-ui-appearance
```

移除插件后外观会恢复原样。注意：上传的壁纸文件与插件配置位于
`$DSH_HOME/ui-appearance/`，卸载命令不会删除它们——如需清理，请手动删除该目录。

## 已知限制

- **面板模糊（`backdrop-filter`）目前未启用。** 在当前构建中，对主面板容器施加
  背景模糊会破坏设置页 / 浮层定位，因此该效果被禁用。背景模糊与面板透明是可用的，
  不受影响。
- 颜色模式（Light / Dark / System）始终由 DSH 原生设置控制——本插件不提供颜色模式切换。

## 开发 / 测试

内置 Node 测试覆盖 host 路由、客户端状态模型，以及“不控制颜色模式”的保证：

```sh
node test/host-smoke.mjs && node test/lifecycle.mjs && node test/no-appearance.mjs
```

设计细节见 `docs/ARCHITECTURE.md`。

## 许可证

[MIT](LICENSE)
