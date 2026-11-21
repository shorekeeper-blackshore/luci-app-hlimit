# luci-app-hlimit v1.2 前端兼容性说明（compat-notes）

目标设备：Cudy TR3000 v1（LEDE / OpenWrt 24.10 底包），LuCI `luci-base git-25.041.08701`，ArgonTheme v2.3.1；同时兼容 10.x / 192.168.x 等任意私网 IPv4 LAN。
参考源码：固件解包根 `/tmp/fw/rootfs`（只读）。API 结论均来自实际读取 `resources/form.js`、`ui.js`、`uci.js`、`luci.js`。

## 1. v1.2 改动概览（原生风格保持）

| 区块 | 组件 | v1.2 变化 |
|---|---|---|
| 状态 | `NamedSection('defaults')` + `Flag` + 自定义 `DummyValue` | 新增 **LAN 作用域**、**默认限速状态**、**告警**（stale/invalid/down_unresolved/scan 不可用） |
| 单独设备 | `GridSection('device')` | 新增弹窗顶部「已发现设备」下拉（`scan.hosts`），选中自动填 IP/MAC/名称；表格名称列只读回退：label → 主机名 → IP/MAC；0/0 显示「不限速」 |
| 批量限速 | `GridSection('group')` | CIDR 改为弹窗编辑：扫描候选下拉（cidr + 首尾 + 在线数）、自定义 CIDR 实时区间/地址数、起始 IP + 掩码（/22~/32，默认 /28）生成；不在 LAN 时红字警告；**每行下注入「不限速名单（N）」展开区**（chips + 该 CIDR 内主机下拉 + 自定义 IP/MAC，调 `group-exclude-add/del`） |
| 默认限速 | `NamedSection('defaults')` | **删除** `default_cidr` 与全局 `default_exclude` 输入；保留开关/上下行（Mbps）；只读显示后端 `status.defaults.lan` 的自动作用范围 |
| 保存并应用 | 原生页脚 | 仍为 `Map.save()` → `uci.apply()`（commit）→ `hlimit-ctl apply`（offload-apply + render）→ 成功通知 + 刷新 |

v1.1 的本地 CIDR/白名单/状态列已不存在；旧 UCI 字段 `default_cidr` / `default_exclude` 由后端 `migrate` 清理，UI 不再映射/写入。

## 2. 新增/依赖的后端 JSON（docs/CONTRACT-v3.md）

### `hlimit-ctl scan`（新增，UI 核心数据源）

```
{"lan":[{"network":"lan","device":"br-lan","ip":"10.0.0.1","netmask":"255.0.0.0","cidr":"10.0.0.0/8"}],
 "pool":{"start":"10.0.0.100","end":"10.0.0.249"},
 "hosts":[{"ip":"10.0.0.162","mac":"aa:bb:cc:dd:ee:01","name":"客厅电视","source":"lease","online":"1"}],
 "candidates":[{"cidr":"10.0.0.0/24","first":"10.0.0.0","last":"10.0.0.255","hosts":"4","label":"..."}]}
```

UI 归一化（`normalizeScan`）：`lan[] / hosts[] / candidates[] / pool`，并把 host 过滤到 LAN 网段内。
**LAN 未知时不过滤**（旧后端/scan 不可用时回退 `devices`，页面降级但可用）。
注意：当 LAN=`10.0.0.0/8` 时，WAN 的 `10.148.0.0/14` 在 CIDR 上属于 LAN 之内，UI **不能**按 CIDR 排除 WAN 邻居；这一步由后端 `scan` 按 LAN 接口过滤（契约 §5.1）。

### `status/list` v1.2

- `devices[]`（kind=device/group/default）；group 元素新增 `exclude:[...]`；
- `defaults.lan[]`（`{device,network,cidr,ip}`）、`defaults.scope:"all-lan"`；
- 顶层 `warnings[]`；不再要求 `default_cidr/effective_cidr/default_exclude`。
- UI 兼容 v1.1 结构（缺 lan/warnings/exclude 时不报错）。

### `group-exclude-add|del <cidr> <ip|mac>`

- 写权限由 ACL 的 `"/usr/sbin/hlimit-ctl group-*"` 覆盖；失败（非 0）用 `ui.addNotification(...,'danger')` 显示 stderr。
- UI 本地先校验：IPv4/MAC 格式、IP 必须在该 group CIDR 内；重复/网段外由后端兜底。
- 成功后 `refreshRuntime()`（status+scan）并重新注入各行展开区，不整页刷新。

### ACL

```
read : file { list, status, devices, scan, offload-status } + ubus.file exec
       uci  [ hashlimit-qos ]
write: file { apply, render, offload-apply/restore/*, set *, delete *, toggle *,
              global *, group-*, set-default *, exclude-* } + ubus.file exec
       uci  [ hashlimit-qos ]
```

v1.2 新增 read `"/usr/sbin/hlimit-ctl scan": ["exec"]`（Lead 批准；root 不受影响，非 root 需要）。

## 3. 表格 / 弹窗的原生实现方式（form.js 依据）

| 需求 | 实现 | 依据 |
|---|---|---|
| 表格行内编辑 | `option.editable = true` | `form.js:466-480`、`form.js:3352` |
| 只在弹窗出现 | `option.modalonly = true`（表格跳过） | `form.js:497`、`form.js:3356`、`form.js:3106-3112` |
| 只读名称/CIDR 显示 | `DummyValue.textvalue()` 返回 DOM 节点 | 原生 `view/firewall/rules.js`；`form.js:3370-3385` |
| 弹窗内辅助控件 | `form.DummyValue.extend({ renderWidget })` 返回 select/input/button | 原生 `view/network/dhcp.js` 的 `CBILeaseStatus` |
| 互填 IP/MAC/名称/CIDR | `map.lookupOption(name, sid)` + `option.getUIElement(sid).setValue()` + 派发 `widget-change` | `form.js:716-743`、`form.js:1800-1815`、`form.js:3690-3700`（`handleValueChange` 监听 widget-change） |
| CIDR 实时区间 | `option.onchange` → 更新 `#hlimit-group-info-<sid>` 文本 | `form.js:3670-3690` |
| 每行下展开区 | 渲染后 DOM 注入 `<tr class="hlimit-exclude-row">`（原生 GridSection 不支持行内子表格）；包一层 `map.renderContents`，任何重绘后重新注入 | `form.js:716-760`（renderContents） |
| 列宽不截断 | `option.width` + 渲染后 `table-layout:fixed`、覆盖主题 `.cbi-dropdown` 的 min-width；外层 `overflow-x:auto` | v1.1 E1 实测结论；`form.js:1500-1520`（width） |
| 状态区 12s 刷新 | `poll.add(statusPoller, 12)` + 固定 id 局部 setText | `luci.js:1051-1175` |

## 4. 地址兼容（10.x / 192.168.x / 任意私网）

- 作用范围、网关、区间全部来自后端 `scan.lan` / `status.defaults.lan`，UI 不假设 10.x；
- 输入框 placeholder 同时给出两类示例：
  - IP：`10.0.0.50 或 192.168.2.50`
  - CIDR：`10.0.0.128/25 或 192.168.2.96/28`
  - 排除名单：`10.0.0.110 或 192.168.2.110（也支持 MAC）`
- CIDR 计算使用 `ipToInt/intToIp/parseCidr`，前缀 0–32；起始 IP + 掩码换算成网络地址/前缀；
- 不在任何 LAN 网段内的 group 会给出红字「该网段不在当前 LAN 内，规则不会生效」，但仍允许保存（后端不生成规则）。

## 5. 自测（可重复执行）

```bash
cd openwrt-hlimit
node --check files/www/luci-static/resources/view/hlimit/overview.js
python3 -c "import json; json.load(open('files/usr/share/luci/menu.d/luci-app-hlimit.json')); json.load(open('files/usr/share/rpcd/acl.d/luci-app-hlimit.json'))"
node tests/ui/test-ui.js
```

`tests/ui/test-ui.js` 为零依赖 Node 测试（自写极简 form/DOM/uci/fs/poll/ui 桩），当前 **187 checks / 0 failure**，覆盖：

- menu/ACL（含 scan 读、group-exclude-* 写）；
- 静态：仅允许模块、标准 form 组件、无自定义横幅/外部库、无硬编码 `default_cidr/default_exclude`、placeholder 含两类私网示例；
- 10.0.0.0/8 夹具：LAN 作用域/网关、默认限速状态、告警（stale/invalid/down_unresolved）、名称回退、0/0 不限速、CIDR 区间/在线数/LAN 警告；
- DevicePicker 自动填 IP/MAC/名称；扫描候选/起始 IP+掩码生成（/28、/24、非法输入）；
- 每行不限速名单：注入、chip 显示、添加/删除命令（group-exclude-add/del）、本地拒绝非法 IP/网段外 IP；
- 192.168.2.0/24 夹具：作用域/网关动态显示、不假设 10.x、LAN 外规则警告；
- 保存并应用顺序、失败通知；Map 重绘后重新注入不限速名单；
- scan 不可用回退 devices、后端全失败/非法 JSON 降级不白屏；poll 12s 刷新与自清理。

## 5.1 E1 独立副本实测（2026-11-18，v1.2 UI + backend 1.2.0）

为避免影响 emu-v11 的环境，用 `rootfs-base.ext4` 新建独立 qcow2 overlay，QEMU 跑在 **8081/2223**（E1 原实例仍占 8080/2222），安装 v1.2 UI + 当前 v1.2 `hlimit-ctl`，并写入 10.0.2.0/24 LAN + 2 设备 + 2 批量 + 默认开启的示例配置；`/tmp/dhcp.leases` 构造 4 台 LAN 主机（另外 2 条 arp 记录来自 QEMU 侧）。

实测结果：

- `hlimit-ctl scan`：`lan=[br-lan 10.0.2.0/24]`，`hosts` 6（4 lease + 2 arp），`candidates=[10.0.2.0/24（6 台在线）]`；UI 下拉显示 `cidr 首–尾（N 台在线）`。
- `hlimit-ctl status`：`defaults.lan/scope/gateway` 正确；`groups[].exclude` 正确；`warnings` 含 IPv6 提示。
- 页面（bootstrap 1280×800）4 个 section 全部渲染；LAN 作用域显示 `br-lan 10.0.2.0/24（网关 10.0.2.15），自动跟随 LAN 网段`；默认限速区无 CIDR/白名单输入，只有只读作用范围。
- 设备表：名称列 label→主机名→IP 回退正确（客厅电视 / REDMI-K90），0/0 设备显示「不限速」。
- 批量表：CIDR 区间 + 在线数、`不限速名单（N）` 行注入；展开后 chips 正常；**实点「添加」→ `group-exclude-add` → UCI list + `HLIMIT_UP/DOWN -j RETURN` 生效；点 chip × → `group-exclude-del` 清理成功**。
- 批量编辑弹窗：扫描候选下拉、起始 IP + /28→`10.0.2.64/26` 生成、实时区间/在线数、非 LAN CIDR 红字「⚠ 该网段不在当前 LAN 内，规则不会生效」均实测通过。
- 设备新增弹窗：选择「REDMI-K90（10.0.2.124）」后 IP/MAC/名称自动填（DOM 实测）。
- `Save & Apply`：改 客厅电视 下行 50→45 Mbps，UCI `down_kbps=45000`，mangle `HLIMIT_DOWN -d 10.0.2.162 -o br-lan --hashlimit-above 5494kb/s` 生效；跳转仍各 1 条，旧 filter 钩子无残留。
- 截图：`emulator/v1.2-screens/01-v12-overview-full.png`、`02-v12-device-group-exclude.png`、`03-v12-group-edit-modal.png`、`04-v12-device-add-modal.png`、`05-v12-group-cidr-warning.png`。

（注：E1 副本的 LAN 是 10.0.2.0/24，因此截图体现 10.x；192.168.x 兼容由 `tests/ui/test-ui.js` 的 192.168.2.0/24 夹具覆盖。）

## 6. 仍需联调/实机确认

1. **E1 1280px 截图（A20）**：使用独立拷贝的 E1 环境（不触碰 emu-v11 实例）安装 v1.2 UI + v1.2 backend 后截图；重点看：批量 CIDR 列（区间两行）、不限速名单展开行、设备名称列、默认限速只读范围。
2. **真实 Argon 主题下的 `table-layout:fixed` + 注入行**：bootstrap 下已实测（E1 副本）；Argon 的 table/flex 样式差异仍需真机截图核对，注入的 `<tr>` 在窄屏 flex 表格下可能需要额外样式（当前 1280 桌面优先）。
3. **`map.renderContents` 包装 + 弹窗保存后的重绘**：依赖 form.js 私有方法，25.041 上已核对存在；E1 副本上已验证「保存」后表格布局与不限速名单区重新注入（自测 4.9 也覆盖）。
4. **`group-exclude-add/del` 后的计数刷新**：当前成功后会再跑 `status+scan` 并重注入；若后端命令返回慢，界面有短暂延迟。
5. **非 root ACL**：scan 读 + group-exclude 写组合未在受限用户下实测。
6. **scan 数据量**：candidates 最多 30 条、hosts 数量由后端限制；UI 未做分页（下拉原生滚动）。

## 7. 交付文件（本 UI 作用域）

```
files/www/luci-static/resources/view/hlimit/overview.js
files/usr/share/rpcd/acl.d/luci-app-hlimit.json（仅新增 scan 读权限）
files/usr/share/luci/menu.d/luci-app-hlimit.json（未变）
tests/ui/test-ui.js
tests/ui/compat-notes.md
```
