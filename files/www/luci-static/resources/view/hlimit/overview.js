'use strict';
'require view';
'require form';
'require fs';
'require poll';
'require uci';
'require ui';

/*
 * luci-app-hlimit v1.3 - 设备限速（LAN 自动作用域 + 扫描式批量 IP 区间）
 *
 * 目标环境：Cudy TR3000 v1 / LuCI git-25.041.08701 + ArgonTheme v2.3.1
 *          （OpenWrt 24.10 底包）
 *
 * 设计原则（保持 v1.1 原生风格）：
 *   整页一个 form.Map：
 *     - 状态        : NamedSection + Flag / DummyValue（LAN 作用域、警告）
 *     - 单独设备    : GridSection（扫描选设备 -> 自动填 IP/MAC/名称）
 *     - 批量限速    : GridSection（扫描选 IP 区间 / 自定义 / 起始 IP+掩码生成）
 *                   每行下面注入「不限速名单」展开区（group-exclude-*）
 *     - 默认限速    : NamedSection（不再手填 CIDR/白名单，作用范围自动跟随 LAN）
 *   页脚原生「保存 / 保存并应用 / 复位」：Map.save() -> uci.apply() ->
 *   hlimit-ctl apply（offload-apply + render）-> 刷新页面。
 *
 * v1.3 关键差异（docs/CONTRACT-v3.md）：
 *   - LAN 作用域由后端 scan/status 提供，UI 不写死任何网段（默认规则按 LAN 接口限定）；
 *   - 默认限速不再保存/输入 default_cidr、不再有全局 default_exclude（旧字段忽略）；
 *   - 批量规则按 IP 区间（start - end）匹配，后端用 iptables iprange；
 *     scan.candidates 的值形如 10.0.1.0-10.0.1.255；每 group 的 exclude 列表用
 *     group-exclude-add/del；
 *   - 设备名称显示 label -> 主机名 -> IP 回退；0/0 明确显示「不限速」。
 *
 * 仅使用固件里已核实的稳定 API：
 *   form.Map / NamedSection / GridSection / Flag / Value / DummyValue /
 *   option.editable / option.modalonly / option.cfgvalue|write|validate|onchange
 *   option.renderFrame（向表格单元格追加节点）
 *   fs.exec(command, [args]) -> Promise<{code,stdout,stderr}>
 *   uci.get / map.data.set / uci.apply
 *   ui.addNotification
 *   poll.add / poll.remove
 *   全局 E() / _() / String.prototype.format（主题 cbi.js 提供）
 */

var CTL = '/usr/sbin/hlimit-ctl';
var CONFIG = 'hashlimit-qos';

/* 状态区自动刷新间隔（秒） */
var REFRESH_INTERVAL = 12;

var MAX_MBPS = 1000;

/* TurboACC fastpath 取值 -> 可读名称 */
var OFFLOAD_ENGINES = {
	flow_offloading: '软件 flow offloading',
	fast_classifier: 'Fast Classifier',
	shortcut_fe_cm:  'Shortcut-FE',
	mediatek_hnat:   'MediaTek 硬件 NAT（HNAT）',
	disabled:        '已关闭',
	none:            '未配置'
};

/*
 * 页面运行时数据（scan/status/offload 归一化后）：
 *   status / statusError / offload
 *   scan: { lan[], hosts[], candidates[], pool }  scanError
 *   lan / hosts / candidates 为 scan 的便捷副本（scan 不可用时回退 status/devices）
 */
var runtime = {
	status: null,
	statusError: null,
	offload: null,
	scan: null,
	scanError: null,
	lan: [],
	hosts: [],
	candidates: []
};


/* 白名单操作的互斥状态：同一 group 上一次请求未完成时不再发新请求 */
var excludeBusy = {};

/* form.Map 实例（handleSave 后需要重新装饰表格） */
var mapObject = null;


/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function isIPv4(ip) {
	var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip));

	if (!m)
		return false;

	for (var i = 1; i <= 4; i++)
		if (parseInt(m[i], 10) > 255)
			return false;

	return true;
}

function ipToInt(ip) {
	var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip));

	if (!m)
		return null;

	var n = 0;

	for (var i = 1; i <= 4; i++) {
		var p = parseInt(m[i], 10);

		if (p > 255)
			return null;

		n = n * 256 + p;
	}

	return n;
}

function intToIp(n) {
	n = Number(n) >>> 0;

	return [ (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255 ].join('.');
}

function netmaskToPrefix(mask) {
	var n = ipToInt(mask);

	if (n == null)
		return null;

	var s = ('00000000000000000000000000000000' + (n >>> 0).toString(2)).slice(-32);

	if (!/^1*0*$/.test(s))
		return null;

	return (s.indexOf('0') === -1) ? 32 : s.indexOf('0');
}

/* 严格解析 CIDR；返回 {network,prefix,cidr,first,last,count} 或 null */
function parseCidr(cidr) {
	var m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(str(cidr));

	if (!m)
		return null;

	var ipn = ipToInt(m[1]),
	    prefix = parseInt(m[2], 10);

	if (ipn == null || !(prefix >= 0 && prefix <= 32))
		return null;

	var mask = (prefix === 0) ? 0 : ((0xffffffff << (32 - prefix)) >>> 0),
	    first = (ipn & mask) >>> 0,
	    count = Math.pow(2, 32 - prefix),
	    last = (first + count - 1) >>> 0;

	return {
		network: intToIp(first),
		prefix: prefix,
		cidr: intToIp(first) + '/' + prefix,
		first: first,
		last: last,
		count: count
	};
}

function ipInCidr(ip, c) {
	var n = ipToInt(ip);

	return (n != null && c != null && n >= c.first && n <= c.last);
}

function cidrRangeText(c) {
	if (!c)
		return '';

	return _('%s – %s（%s 个地址）').format(intToIp(c.first), intToIp(c.last), String(c.count));
}

function cidrFromStart(ip, prefix) {
	var n = ipToInt(ip),
	    p = toInt(prefix, NaN);

	if (n == null || !isFinite(p) || p < 0 || p > 32)
		return null;

	var mask = (p === 0) ? 0 : ((0xffffffff << (32 - p)) >>> 0),
	    first = (n & mask) >>> 0,
	    count = Math.pow(2, 32 - p),
	    last = (first + count - 1) >>> 0;

	return {
		network: intToIp(first),
		prefix: p,
		cidr: intToIp(first) + '/' + p,
		first: first,
		last: last,
		count: count
	};
}

/* ------------------------------------------------------------------ */
/* v1.3：IP 区间（start - end）工具                                    */
/* ------------------------------------------------------------------ */

/* 严格解析 "a-b" / "a - b"（也接受 – —）；返回 {start,end,first,last,count,range} 或 null */
function parseRange(value) {
	var m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*(?:-|–|—)\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(str(value));

	if (!m || !isIPv4(m[1]) || !isIPv4(m[2]))
		return null;

	var a = ipToInt(m[1]),
	    b = ipToInt(m[2]);

	if (a == null || b == null || a > b)
		return null;

	return {
		start: m[1],
		end: m[2],
		first: a,
		last: b,
		count: b - a + 1,
		range: m[1] + '-' + m[2]
	};
}

/* 当前 group 的区间：优先 start/end（UI 两个输入框），兼容 range / cidr */
function groupRangeOf(sectionId) {
	var start = str(uci.get(CONFIG, sectionId, 'start')),
	    end = str(uci.get(CONFIG, sectionId, 'end')),
	    r = null;

	if (isIPv4(start) && isIPv4(end))
		r = parseRange(start + '-' + end);

	if (r)
		return r;

	r = parseRange(uci.get(CONFIG, sectionId, 'range'));

	if (r)
		return r;

	var c = parseCidr(uci.get(CONFIG, sectionId, 'cidr'));

	if (!c)
		return null;

	return {
		start: intToIp(c.first),
		end: intToIp(c.last),
		first: c.first,
		last: c.last,
		count: c.count,
		range: intToIp(c.first) + '-' + intToIp(c.last)
	};
}

/* modal 里两个输入框的当前值（未保存时以 DOM 为准） */
function groupStartEndFromDom(sectionId) {
	var s = document.getElementById('widget.cbid.' + CONFIG + '.' + sectionId + '.start'),
	    e = document.getElementById('widget.cbid.' + CONFIG + '.' + sectionId + '.end');

	return {
		start: s ? str(s.value) : str(uci.get(CONFIG, sectionId, 'start')),
		end: e ? str(e.value) : str(uci.get(CONFIG, sectionId, 'end'))
	};
}

function rangeText(r) {
	if (!r)
		return '';

	return _('%s – %s（%s 个地址）').format(r.start, r.end, String(r.count));
}

function ipInRange(ip, r) {
	var n = ipToInt(ip);

	return (n != null && r != null && n >= r.first && n <= r.last);
}

function hostsInRange(r) {
	if (!r)
		return [];

	return runtime.hosts.filter(function(h) {
		return ipInRange(h.ip, r);
	});
}

function rangeInLan(r) {
	if (!r)
		return false;

	for (var i = 0; i < runtime.lan.length; i++) {
		var lc = parseCidr(runtime.lan[i].cidr);

		if (lc && r.first >= lc.first && r.last <= lc.last)
			return true;
	}

	return false;
}

/* 输入提示同时给出 10.x 与 192.168.x 两类私网示例（不写死具体网段） */
function rangeExample() {
	return _('10.0.1.1 - 10.0.2.1 或 192.168.2.10 - 192.168.2.99');
}

function ipExample() {
	return _('10.0.0.50 或 192.168.2.50');
}

function isMac(value) {
	return /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(str(value));
}

/* "5.12"（Mbps） -> 5120（kbit/s）；非法输入返回 NaN */
function parseMbps(value) {
	var s = String(value == null ? '' : value).trim().replace(',', '.');

	if (s === '' || !/^\d+(\.\d+)?$/.test(s))
		return NaN;

	var mbps = parseFloat(s);

	if (!isFinite(mbps) || mbps < 0 || mbps > MAX_MBPS)
		return NaN;

	return Math.round(mbps * 1000);
}

function fmtMbps(kbps) {
	var mbps = (Number(kbps) || 0) / 1000;

	if (mbps === Math.floor(mbps))
		return String(mbps);

	return String(Math.round(mbps * 1000) / 1000);
}

function fmtBytes(bytes) {
	var n = Number(bytes),
	    units = [ 'KB', 'MB', 'GB', 'TB' ],
	    i = -1;

	if (!isFinite(n) || n < 0)
		n = 0;

	if (n < 1024)
		return n + ' B';

	do {
		n = n / 1024;
		i++;
	} while (n >= 1024 && i < units.length - 1);

	return (Math.round(n * 10) / 10) + ' ' + units[i];
}

function toInt(value, dflt) {
	var n = parseInt(value, 10);

	return isFinite(n) ? n : dflt;
}

function toBool(value) {
	return (value === true || value === 1 || value === '1' ||
	        value === 'true' || value === 'yes' || value === 'on');
}

function str(value) {
	return String(value == null ? '' : value).trim();
}

function shortName(name) {
	var s = str(name);

	return (s.length > 12) ? (s.slice(0, 12) + '…') : s;
}

function errText(err) {
	return String(err && err.message != null ? err.message : err);
}

function stderrText(res) {
	var msg = str(res && res.stderr);

	if (!msg)
		msg = str(res && res.stdout);

	if (!msg)
		msg = _('后端命令执行失败（退出码 %d）').format(res ? res.code : -1);

	return msg;
}

function notify(title, message, css) {
	ui.addNotification(title, E('p', {}, [ String(message) ]), css || 'info');
}

function notifyError(title, err) {
	notify(title, errText(err), 'danger');
}

function setText(id, text) {
	var node = document.getElementById(id);

	if (node)
		node.textContent = String(text);
}


/* ------------------------------------------------------------------ */
/* 后端交互（单行 JSON，失败降级为可读提示，不白屏）                   */
/* ------------------------------------------------------------------ */

function parseJson(res) {
	var raw = str(res && res.stdout);

	if (raw === '')
		throw new Error(_('后端没有返回任何数据（stdout 为空）。') + ' ' + stderrText(res));

	try {
		return JSON.parse(raw);
	}
	catch (e) {
		throw new Error(_('后端返回的数据不是合法 JSON：') + ' ' + raw.slice(0, 300));
	}
}

function normalizeEntry(d) {
	return {
		kind: str(d.kind),
		ip: str(d.ip),
		mac: str(d.mac),
		cidr: str(d.cidr),
		range: str(d.range),
		start: str(d.start),
		end: str(d.end),
		resolved_ip: str(d.resolved_ip),
		down_unresolved: toBool(d.down_unresolved),
		label: String(d.label == null ? '' : d.label),
		enabled: toBool(d.enabled),
		exclude: Array.isArray(d.exclude) ? d.exclude.map(function(v) { return str(v); }) : [],
		down_kbps: Math.max(0, toInt(d.down_kbps, 0)),
		up_kbps: Math.max(0, toInt(d.up_kbps, 0)),
		down_bytes: Math.max(0, toInt(d.down_bytes, 0)),
		up_bytes: Math.max(0, toInt(d.up_bytes, 0)),
		down_pkts: Math.max(0, toInt(d.down_pkts, 0)),
		up_pkts: Math.max(0, toInt(d.up_pkts, 0))
	};
}

/*
 * 归一化 list/status（v1.2：devices[] kind=device/group/default、groups[]、
 * defaults{lan,scope}、warnings[]；兼容 v1.1 旧结构）。
 */
function normalizeStatus(obj) {
	if (!obj || typeof obj != 'object' || Array.isArray(obj))
		throw new Error(_('后端返回的 JSON 结构不正确（应为对象）。'));

	var list = Array.isArray(obj.devices) ? obj.devices : [],
	    devices = [],
	    groups = [],
	    defaultEntry = null;

	for (var i = 0; i < list.length; i++) {
		var d = list[i] || {},
		    kind = str(d.kind);

		if (!kind)
			kind = (str(d.cidr) !== '' || str(d.range) !== '') ? 'group' : 'device';

		var e = normalizeEntry(d);

		e.kind = kind;

		if (kind == 'group')
			groups.push(e);
		else if (kind == 'default')
			defaultEntry = e;
		else if (e.ip !== '' || e.mac !== '')
			devices.push(e);
	}

	var rawDefaults = (obj.defaults && typeof obj.defaults == 'object' && !Array.isArray(obj.defaults))
		? obj.defaults : null;

	if (!defaultEntry && rawDefaults) {
		defaultEntry = {
			kind: 'default',
			cidr: str(rawDefaults.effective_cidr || rawDefaults.default_cidr),
			label: _('默认限速'),
			enabled: toBool(rawDefaults.default_enabled),
			exclude: [],
			down_kbps: Math.max(0, toInt(rawDefaults.default_down_kbps, 0)),
			up_kbps: Math.max(0, toInt(rawDefaults.default_up_kbps, 0)),
			down_bytes: 0, up_bytes: 0, down_pkts: 0, up_pkts: 0
		};
	}

	var offload = null;

	if (obj.offload_active != null || obj.offload != null || obj.auto_disable != null) {
		offload = {
			available: false,
			active: toBool(obj.offload_active != null ? obj.offload_active : obj.offload),
			backup_saved: toBool(obj.backup_saved),
			auto_disable: (obj.auto_disable == null ? null : toBool(obj.auto_disable)),
			firewall_fo: false,
			firewall_fo_hw: false,
			turboacc_present: false,
			turboacc_fastpath: '',
			engine: ''
		};
	}

	var warnings = [];

	if (Array.isArray(obj.warnings))
		for (var w = 0; w < obj.warnings.length; w++)
			if (str(obj.warnings[w]) !== '')
				warnings.push(str(obj.warnings[w]));

	return {
		enabled: toBool(obj.enabled),
		devices: devices,
		groups: groups,
		defaultEntry: defaultEntry,
		rawDefaults: rawDefaults,
		warnings: warnings,
		offload: offload
	};
}

function normalizeOffload(obj) {
	var fp = str(obj.turboacc_fastpath);

	return {
		available: true,
		active: toBool(obj.offload_active),
		backup_saved: toBool(obj.backup_saved),
		auto_disable: (obj.auto_disable == null ? null : toBool(obj.auto_disable)),
		firewall_fo: toBool(obj.firewall_fo),
		firewall_fo_hw: toBool(obj.firewall_fo_hw),
		turboacc_present: toBool(obj.turboacc_present),
		turboacc_fastpath: fp,
		engine: (fp !== '' && fp !== 'disabled' && fp !== 'none') ? (OFFLOAD_ENGINES[fp] || fp) : ''
	};
}

function normalizeScan(obj) {
	var out = { lan: [], hosts: [], candidates: [], pool: null };

	if (!obj || typeof obj != 'object')
		return out;

	if (Array.isArray(obj.lan)) {
		for (var i = 0; i < obj.lan.length; i++) {
			var l = obj.lan[i] || {},
			    cidr = str(l.cidr),
			    c = parseCidr(cidr);

			if (!c && l.ip && l.netmask) {
				var p = netmaskToPrefix(l.netmask);

				if (p != null) {
					c = cidrFromStart(l.ip, p);
					cidr = c ? c.cidr : '';
				}
			}

			if (!cidr)
				continue;

			out.lan.push({
				network: str(l.network),
				device: str(l.device),
				ip: str(l.ip),
				netmask: str(l.netmask),
				cidr: cidr
			});
		}
	}

	if (Array.isArray(obj.hosts)) {
		for (var h = 0; h < obj.hosts.length; h++) {
			var hd = obj.hosts[h] || {},
			    hip = str(hd.ip);

			if (!isIPv4(hip))
				continue;

			out.hosts.push({
				ip: hip,
				mac: str(hd.mac),
				name: str(hd.name),
				source: str(hd.source),
				online: toBool(hd.online)
			});
		}
	}

	if (Array.isArray(obj.candidates)) {
		for (var c2 = 0; c2 < obj.candidates.length; c2++) {
			var cd = obj.candidates[c2] || {},
			    pr = parseRange(cd.range);

			if (!pr) {
				var ccidr = str(cd.cidr),
				    pc = parseCidr(ccidr);

				if (pc)
					pr = {
						start: intToIp(pc.first),
						end: intToIp(pc.last),
						first: pc.first,
						last: pc.last,
						count: pc.count,
						range: intToIp(pc.first) + '-' + intToIp(pc.last)
					};
			}

			if (!pr)
				continue;

			out.candidates.push({
				range: pr.range,
				start: pr.start,
				end: pr.end,
				first: pr.start,
				last: pr.end,
				hosts: str(cd.hosts),
				label: str(cd.label)
			});
		}
	}

	if (obj.pool && typeof obj.pool == 'object') {
		out.pool = {
			start: str(obj.pool.start),
			end: str(obj.pool.end)
		};
	}

	return out;
}

/*
 * 读取运行状态；status 失败回退 list（v1.1 兼容）。
 */
function fetchStatus() {
	return fs.exec(CTL, [ 'status' ]).then(function(res) {
		if (res.code === 0)
			return { status: normalizeStatus(parseJson(res)), error: null };

		var firstError = stderrText(res);

		return fs.exec(CTL, [ 'list' ]).then(function(res2) {
			if (res2.code === 0)
				return { status: normalizeStatus(parseJson(res2)), error: null };

			return { status: null, error: stderrText(res2) || firstError };
		});
	}).catch(function(err) {
		return { status: null, error: errText(err) };
	});
}

function fetchOffload() {
	return fs.exec(CTL, [ 'offload-status' ]).then(function(res) {
		if (res.code === 0) {
			var obj = parseJson(res);

			if (obj && typeof obj == 'object' && !Array.isArray(obj))
				return normalizeOffload(obj);
		}

		return null;
	}).catch(function() {
		return null;
	});
}

/*
 * 扫描（v1.2 新命令）：LAN 接口、DHCP pool、LAN 主机、CIDR 候选。
 * 旧后端没有 scan 时回退 devices，页面仍可用（候选为空，提示后端需升级）。
 */
function fetchScan() {
	return fs.exec(CTL, [ 'scan' ]).then(function(res) {
		if (res.code === 0)
			return { scan: normalizeScan(parseJson(res)), error: null };

		var scanError = stderrText(res);

		return fs.exec(CTL, [ 'devices' ]).then(function(res2) {
			var hosts = [];

			if (res2.code === 0) {
				try {
					var obj = parseJson(res2),
					    list = (obj && Array.isArray(obj.devices)) ? obj.devices : [];

					for (var i = 0; i < list.length; i++) {
						var d = list[i] || {},
						    ip = str(d.ip);

						if (!isIPv4(ip))
							continue;

						hosts.push({
							ip: ip,
							mac: str(d.mac),
							name: str(d.name),
							source: str(d.source),
							online: toBool(d.online)
						});
					}
				}
				catch (e) { }
			}

			return {
				scan: { lan: [], hosts: hosts, candidates: [], pool: null },
				error: scanError
			};
		}).catch(function() {
			return { scan: { lan: [], hosts: [], candidates: [], pool: null }, error: scanError };
		});
	}).catch(function(err) {
		return { scan: { lan: [], hosts: [], candidates: [], pool: null }, error: errText(err) };
	});
}

/* 把三次 fetch 结果写入 runtime */
function applyRuntime(statusRes, offloadRes, scanRes) {
	runtime.status = statusRes.status;
	runtime.statusError = statusRes.error;
	runtime.offload = offloadRes || (statusRes.status ? statusRes.status.offload : null);
	runtime.scan = scanRes.scan || { lan: [], hosts: [], candidates: [], pool: null };
	runtime.scanError = scanRes.error;

	/* LAN：scan.lan 优先，其次 status.defaults.lan（后端 v1.2 两个都有） */
	var lan = runtime.scan.lan;

	if ((!lan || !lan.length) && statusRes.status && statusRes.status.rawDefaults &&
	    Array.isArray(statusRes.status.rawDefaults.lan))
		lan = statusRes.status.rawDefaults.lan.map(function(l) {
			return {
				network: str(l.network),
				device: str(l.device),
				ip: str(l.ip),
				netmask: str(l.netmask),
				cidr: str(l.cidr)
			};
		}).filter(function(l) { return parseCidr(l.cidr) != null; });

	runtime.lan = lan || [];

	/* 主机：scan.hosts 优先；否则用 status.devices 兜底（v1.1 后端） */
	var hosts = runtime.scan.hosts;

	if (!hosts || !hosts.length) {
		hosts = [];

		if (statusRes.status) {
			for (var i = 0; i < statusRes.status.devices.length; i++) {
				var d = statusRes.status.devices[i];

				hosts.push({
					ip: d.ip || d.resolved_ip,
					mac: d.mac,
					name: d.label,
					source: 'status',
					online: true
				});
			}
		}
	}

	/* 只保留 LAN 网段内主机（scan 已过滤；这里兜底，lan 未知时不过滤） */
	if (runtime.lan.length) {
		hosts = hosts.filter(function(h) {
			return ipInAnyLan(h.ip);
		});
	}

	runtime.hosts = hosts;
	runtime.candidates = runtime.scan.candidates || [];
}

function refreshRuntime() {
	return Promise.all([
		fetchStatus(),
		fetchOffload(),
		fetchScan()
	]).then(function(res) {
		applyRuntime(res[0], res[1], res[2]);
		return runtime;
	});
}


/* ------------------------------------------------------------------ */
/* 作用域 / 名称 / 状态文案                                            */
/* ------------------------------------------------------------------ */

function ipInAnyLan(ip) {
	if (!isIPv4(ip))
		return false;

	for (var i = 0; i < runtime.lan.length; i++) {
		var c = parseCidr(runtime.lan[i].cidr);

		if (c && ipInCidr(ip, c))
			return true;
	}

	return false;
}

function cidrInLan(cidrInfo) {
	if (!cidrInfo)
		return false;

	for (var i = 0; i < runtime.lan.length; i++) {
		var lc = parseCidr(runtime.lan[i].cidr);

		if (lc && cidrInfo.first >= lc.first && cidrInfo.last <= lc.last)
			return true;
	}

	return false;
}

function hostsInCidr(cidrInfo) {
	if (!cidrInfo)
		return [];

	return runtime.hosts.filter(function(h) {
		return ipInCidr(h.ip, cidrInfo);
	});
}

function hostByIp(ip) {
	for (var i = 0; i < runtime.hosts.length; i++)
		if (runtime.hosts[i].ip === ip)
			return runtime.hosts[i];

	return null;
}

/* 按 IP 或 MAC 找扫描到的主机（MAC 不区分大小写） */
function hostFor(ip, mac) {
	var m = str(mac).toLowerCase();

	for (var i = 0; i < runtime.hosts.length; i++) {
		var h = runtime.hosts[i];

		if (ip !== '' && h.ip === ip)
			return h;

		if (m !== '' && h.mac !== '' && h.mac.toLowerCase() === m)
			return h;
	}

	return null;
}

function lanScopeText() {
	var lan = runtime.lan || [],
	    parts = [],
	    gw = '';

	for (var i = 0; i < lan.length; i++) {
		var l = lan[i],
		    name = str(l.device) || str(l.network) || _('LAN');

		parts.push('%s %s'.format(name, str(l.cidr)));

		if (!gw && isIPv4(l.ip))
			gw = l.ip;
	}

	if (!parts.length) {
		if (runtime.scanError)
			return _('未能识别 LAN 网段（%s）').format(runtime.scanError);

		return _('未能识别 LAN 网段（后端 scan/status 未返回，请检查后端版本）');
	}

	return _('全部局域网：%s（网关 %s），自动跟随 LAN 网段，无需填写')
		.format(parts.join('；'), gw || '—');
}

function defaultStateText() {
	var st = runtime.status;

	if (!st) {
		return runtime.statusError
			? _('无法读取（%s）').format(runtime.statusError)
			: _('未知');
	}

	var de = st.defaultEntry,
	    raw = st.rawDefaults || {},
	    enabled = de ? de.enabled : toBool(raw.default_enabled),
	    down = de ? de.down_kbps : toInt(raw.default_down_kbps, 0),
	    up = de ? de.up_kbps : toInt(raw.default_up_kbps, 0),
	    text;

	if (!enabled)
		text = _('关闭（未生成默认限速规则）');
	else if (down === 0 && up === 0)
		text = _('开启，但上下行均为 0 = 不限速（不会生成 DROP 规则）');
	else
		text = _('开启：下行 %s / 上行 %s').format(
			down > 0 ? fmtMbps(down) + ' Mbps' : _('不限'),
			up > 0 ? fmtMbps(up) + ' Mbps' : _('不限'));

	return text;
}

function warningsText() {
	var st = runtime.status,
	    out = [];

	if (runtime.scanError)
		out.push(_('设备扫描不可用：%s').format(runtime.scanError));

	if (st) {
		for (var w = 0; w < st.warnings.length; w++)
			if (out.indexOf(st.warnings[w]) === -1)
				out.push(st.warnings[w]);

		var unresolved = 0;

		for (var i = 0; i < st.devices.length; i++) {
			var d = st.devices[i];

			if (d.down_unresolved)
				unresolved++;

			/* LAN 已知时，提示 IP 已不在 LAN 内的旧配置（stale） */
			if (runtime.lan.length && d.ip !== '' && isIPv4(d.ip) && !ipInAnyLan(d.ip))
				out.push(_('设备「%s」的 IP %s 不在当前 LAN 网段内（stale），请用扫描重新选择')
					.format(d.label || d.ip, d.ip));
		}

		if (unresolved)
			out.push(_('%d 台设备的 MAC 未解析到当前 IP，下行规则未生效')
				.format(unresolved));

		for (var g = 0; g < st.groups.length; g++) {
			var gr = parseRange(st.groups[g].range);

			if (gr && runtime.lan.length && !rangeInLan(gr))
				out.push(_('批量规则 %s 不在当前 LAN 网段内，规则不会生效')
					.format(gr.range));
		}
	}

	if (!out.length && !st)
		return runtime.statusError
			? _('无法读取运行状态（%s）').format(runtime.statusError)
			: _('—');

	return out.length ? out.join('；') : _('无');
}

function currentOffload() {
	if (runtime.offload)
		return runtime.offload;

	return (runtime.status && runtime.status.offload) ? runtime.status.offload : null;
}

function offloadEngineName(of) {
	if (!of)
		return '';

	var fp = String(of.turboacc_fastpath || '');

	if (of.turboacc_present && fp !== '' && fp !== 'disabled' && fp !== 'none')
		return OFFLOAD_ENGINES[fp] || fp;

	if (of.firewall_fo_hw)
		return _('硬件 flow offloading');

	if (of.firewall_fo)
		return _('软件 flow offloading');

	return '';
}

function offloadStateText() {
	var of = currentOffload();

	if (!of)
		return runtime.statusError
			? _('无法读取（%s）').format(runtime.statusError)
			: _('未知');

	var name = offloadEngineName(of);

	if (!of.active)
		return of.backup_saved
			? _('已关闭（原卸载配置已备份，可恢复）')
			: _('已关闭');

	var text = _('已开启') + (name !== '' ? _('（%s）').format(name) : '');

	if (of.auto_disable === false)
		text += _('；已加速的连接会绕过 iptables，限速可能失效');
	else
		text += _('；保存并应用后将自动备份并关闭');

	return text;
}

function droppedText() {
	var st = runtime.status;

	if (!st)
		return runtime.statusError
			? _('无法读取（%s）').format(runtime.statusError)
			: _('—');

	var all = (st.devices || []).concat(st.groups || []),
	    down = 0,
	    up = 0;

	if (st.defaultEntry) {
		down += st.defaultEntry.down_bytes;
		up += st.defaultEntry.up_bytes;
	}

	for (var i = 0; i < all.length; i++) {
		down += all[i].down_bytes;
		up += all[i].up_bytes;
	}

	return _('↓ %s / ↑ %s（所有规则累计，重启路由器后归零）')
		.format(fmtBytes(down), fmtBytes(up));
}

function rulesSummaryText() {
	var st = runtime.status;

	if (!st)
		return runtime.statusError
			? _('无法读取（%s）').format(runtime.statusError)
			: _('—');

	var nd = (st.devices || []).length,
	    ng = (st.groups || []).length,
	    de = st.defaultEntry;

	return _('单独设备 %d 条 · 批量 %d 条 · 默认限速%s')
		.format(nd, ng, (de && de.enabled) ? _('开启') : _('关闭'));
}

/* 设备状态片段：不限速 / 已停用 / 未解析 / 当前 IP / 正常 / — */
function deviceStatusText(sectionId) {
	var st = runtime.status,
	    enabled = uci.get(CONFIG, sectionId, 'enabled');

	if (enabled == null)
		enabled = '1';

	enabled = toBool(enabled);

	var down = toInt(uci.get(CONFIG, sectionId, 'down_kbps'), 0),
	    up = toInt(uci.get(CONFIG, sectionId, 'up_kbps'), 0);

	if (!enabled)
		return _('已停用');

	if (down === 0 && up === 0)
		return _('不限速');

	if (!st)
		return runtime.statusError ? _('状态未知') : _('—');

	var ip = str(uci.get(CONFIG, sectionId, 'ip')),
	    mac = str(uci.get(CONFIG, sectionId, 'mac')).toLowerCase(),
	    entry = null;

	for (var i = 0; i < st.devices.length; i++) {
		var d = st.devices[i];

		if (ip !== '' && d.ip === ip) {
			entry = d;
			break;
		}

		if (mac !== '' && d.mac !== '' && d.mac.toLowerCase() === mac) {
			entry = d;
			break;
		}
	}

	if (!entry)
		return _('尚未下发');

	if (entry.down_unresolved)
		return _('⚠ 未解析');

	if (entry.resolved_ip !== '' && entry.resolved_ip !== ip)
		return _('→ %s').format(entry.resolved_ip);

	return _('正常');
}

/* 名称列：label -> 主机名 -> IP/MAC 回退 */
function deviceDisplayName(sectionId) {
	var label = str(uci.get(CONFIG, sectionId, 'label')),
	    ip = str(uci.get(CONFIG, sectionId, 'ip')),
	    mac = str(uci.get(CONFIG, sectionId, 'mac')),
	    host = hostFor(ip, mac);

	if (label !== '')
		return { text: label, fallback: false };

	if (host && host.name !== '')
		return { text: host.name, fallback: true };

	if (ip !== '')
		return { text: ip, fallback: true };

	if (mac !== '')
		return { text: mac, fallback: true };

	return { text: _('未命名设备'), fallback: true };
}

function groupDisplayName(sectionId) {
	var label = str(uci.get(CONFIG, sectionId, 'label'));

	if (label !== '')
		return label;

	var r = groupRangeOf(sectionId);

	return r ? (r.start + ' – ' + r.end) : _('未命名区间');
}

/* 批量区间信息（modal 实时区 & 表格显示共用） */
function groupRangeInfoText(sectionId, start, end) {
	if (start == null || end == null) {
		var se = groupStartEndFromDom(sectionId);

		start = se.start;
		end = se.end;
	}

	if (start === '' && end === '')
		return _('尚未填写起止 IP');

	if (!isIPv4(start) || !isIPv4(end))
		return _('请分别填写合法的起始 IP 与结束 IP（示例：%s）。').format(rangeExample());

	if (ipToInt(start) > ipToInt(end))
		return _('⚠ 起始 IP 不能大于结束 IP。');

	var r = parseRange(start + '-' + end),
	    parts = [ rangeText(r) ],
	    online = hostsInRange(r).length;

	if (online > 0)
		parts.push(_('扫描到 %d 台在线主机').format(online));

	if (runtime.lan.length && !rangeInLan(r))
		return _('⚠ 该区间不在当前 LAN 内，规则不会生效。') + parts.join('；');

	return parts.join('；');
}

function updateGroupRangeInfo(sectionId, start, end) {
	var info = document.getElementById('hlimit-group-info-' + sectionId);

	if (!info)
		return;

	var text = groupRangeInfoText(sectionId, start, end);

	info.textContent = text;
	info.style.color = (text.indexOf('⚠') === 0 || text.indexOf('请分别填写') >= 0) ? '#c00' : '';
}

/* 读取 group exclude 列表：status.groups 优先（按 range 匹配），其次 UCI list */
function groupExcludes(sectionId) {
	var r = groupRangeOf(sectionId),
	    st = runtime.status;

	if (st && r) {
		for (var i = 0; i < st.groups.length; i++)
			if (st.groups[i].range === r.range && Array.isArray(st.groups[i].exclude))
				return st.groups[i].exclude;
	}

	var v = uci.get(CONFIG, sectionId, 'exclude');

	if (Array.isArray(v))
		return v.map(function(x) { return str(x); });

	return (v != null && str(v) !== '') ? [ str(v) ] : [];
}

/* group 是否已经在后端配置中（status.groups 里有同 range）；新加/改过区间未应用时不可维护白名单 */
function isGroupApplied(sectionId) {
	var r = groupRangeOf(sectionId);

	if (!r || !runtime.status)
		return false;

	for (var i = 0; i < runtime.status.groups.length; i++)
		if (runtime.status.groups[i].range === r.range)
			return true;

	return false;
}

/* 进入 / 更新 modal 内另一个 option 的值（并触发依赖/onchange） */
function setOptionValue(map, name, sectionId, value) {
	if (!map || typeof map.lookupOption != 'function')
		return false;

	var r = map.lookupOption(name, sectionId);

	if (!r)
		return false;

	var opt = r[0],
	    sid = r[1],
	    elem = (typeof opt.getUIElement == 'function') ? opt.getUIElement(sid) : null;

	if (elem && typeof elem.setValue == 'function') {
		elem.setValue(value);

		if (elem.node && elem.node.dispatchEvent) {
			try {
				elem.node.dispatchEvent(new CustomEvent('widget-change', { bubbles: true }));
			}
			catch (e) { }
		}

		return true;
	}

	return false;
}


/* ------------------------------------------------------------------ */
/* 表单：只读状态值                                                    */
/* ------------------------------------------------------------------ */

var StatusValue = form.DummyValue.extend({
	__name__: 'CBI.HlimitStatusValue',

	renderWidget: function(section_id, option_index, cfgvalue) {
		var value = (cfgvalue != null) ? cfgvalue : this.default;

		return E('div', {
			'id': this.cbid(section_id)
		}, [ (value != null) ? String(value) : '—' ]);
	}
});

/* 表格里的只读名称（label -> 主机名 -> IP） */
function deviceNameNode(sectionId) {
	var name = deviceDisplayName(sectionId),
	    title = name.fallback
		? _('未填写名称，回退显示：%s').format(name.text)
		: _('自定义名称');

	return E('div', { 'style': 'min-width:0' }, [
		E('strong', {
			'style': 'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
			'title': title
		}, name.text)
	]);
}

/* 表格里的批量区间 + 地址数 + 在线数 + LAN 警告 */
function groupRangeNode(sectionId) {
	var r = groupRangeOf(sectionId),
	    small = [],
	    warn = false;

	if (!r) {
		small.push(_('未填写 IP 区间'));
		warn = true;
	}
	else {
		small.push(_('%s 个地址').format(String(r.count)));

		var online = hostsInRange(r).length;

		if (online > 0)
			small.push(_('%d 台在线').format(online));

		if (runtime.lan.length && !rangeInLan(r)) {
			small.push(_('⚠ 不在当前 LAN 内，不会生效'));
			warn = true;
		}
	}

	return E('div', {}, [
		E('strong', { 'style': 'white-space:nowrap' },
			r ? (r.start + ' – ' + r.end) : _('未填写')),
		E('div', {
			'class': 'cbi-value-description',
			'style': warn ? 'color:#c00;white-space:nowrap' : 'white-space:nowrap'
		}, small.join('；'))
	]);
}

/* 表格里的批量名称（label -> 区间） */
function groupNameNode(sectionId) {
	return E('span', { 'style': 'white-space:nowrap' }, groupDisplayName(sectionId));
}


/* ------------------------------------------------------------------ */
/* modal 辅助控件：已发现设备 / 扫描 CIDR / 起始 IP+掩码               */
/* ------------------------------------------------------------------ */

/* 单独设备：从 scan.hosts 选择，自动填 IP/MAC/名称 */
var DevicePickerValue = form.DummyValue.extend({
	__name__: 'CBI.HlimitDevicePicker',

	renderWidget: function(section_id /*, option_index, cfgvalue */) {
		var self = this,
		    current = str(uci.get(CONFIG, section_id, 'ip')),
		    options = [ E('option', { 'value': '' }, _('— 从已发现设备选择 —')) ];

		for (var i = 0; i < runtime.hosts.length; i++) {
			var h = runtime.hosts[i],
			    label = (h.name !== '' ? h.name : h.ip) +
				'（' + h.ip + '）' +
				(h.mac !== '' ? ' · ' + h.mac : '') +
				(h.online ? '' : _(' · 离线'));

			options.push(E('option', {
				'value': h.ip,
				'selected': (h.ip === current) ? '' : null
			}, label));
		}

		var select = E('select', {
			'class': 'cbi-input-select',
			'id': 'hlimit-device-pick-' + section_id,
			'style': 'width:100%'
		}, options);

		select.addEventListener('change', function(ev) {
			self.pickHost(section_id, ev.target.value);
		});

		return E('div', {}, [
			select,
			E('div', { 'class': 'cbi-value-description' },
				runtime.hosts.length
					? _('选中后自动填 IP、MAC 与名称（名称可改；留空由后端补主机名）。')
					: _('没有可用的扫描主机（后端 scan 不可用或 LAN 内暂无设备）。'))
		]);
	},

	pickHost: function(sectionId, ip) {
		var host = hostByIp(ip);

		if (!host)
			return;

		setOptionValue(this.map, 'ip', sectionId, host.ip);

		if (host.mac !== '')
			setOptionValue(this.map, 'mac', sectionId, host.mac);

		if (host.name !== '')
			setOptionValue(this.map, 'label', sectionId, host.name);
	}
});

/* 批量：扫描候选下拉（区间 + 在线数） */
var GroupScanSelect = form.DummyValue.extend({
	__name__: 'CBI.HlimitGroupScan',

	renderWidget: function(section_id /*, option_index, cfgvalue */) {
		var self = this,
		    se = groupStartEndFromDom(section_id),
		    current = (isIPv4(se.start) && isIPv4(se.end)) ? (se.start + '-' + se.end) : '',
		    options = [ E('option', { 'value': '' }, _('— 从扫描结果选择区间 —')) ];

		for (var i = 0; i < runtime.candidates.length; i++) {
			var c = runtime.candidates[i],
			    label = c.start + ' – ' + c.end +
				(c.hosts !== '' ? _('（%s 台在线）').format(c.hosts) : '');

			options.push(E('option', {
				'value': c.range,
				'selected': (c.range === current) ? '' : null
			}, label));
		}

		var select = E('select', {
			'class': 'cbi-input-select',
			'id': 'hlimit-group-scan-' + section_id,
			'style': 'width:100%'
		}, options);

		select.addEventListener('change', function(ev) {
			if (ev.target.value !== '')
				self.applyRange(section_id, ev.target.value);
		});

		return E('div', {}, [
			select,
			E('div', { 'class': 'cbi-value-description' },
				runtime.candidates.length
					? _('候选项含每个 LAN 整段与有在线主机的 /24；选中后自动填入起始与结束 IP，可再手动改。')
					: _('没有扫描候选（后端 scan 不可用），可在下方直接填写起止 IP。'))
		]);
	},

	applyRange: function(sectionId, range) {
		var r = parseRange(range);

		if (!r)
			return;

		setOptionValue(this.map, 'start', sectionId, r.start);
		setOptionValue(this.map, 'end', sectionId, r.end);
		updateGroupRangeInfo(sectionId, r.start, r.end);
	}
});

/* 批量：区间 / LAN 警告（modal 内实时显示） */
var GroupRangeInfoValue = form.DummyValue.extend({
	__name__: 'CBI.HlimitGroupRangeInfo',

	renderWidget: function(section_id, option_index, cfgvalue) {
		var value = (cfgvalue != null) ? cfgvalue : '';

		return E('div', {
			'id': 'hlimit-group-info-' + section_id,
			'class': 'cbi-value-description',
			'style': (String(value).indexOf('⚠') === 0) ? 'color:#c00' : ''
		}, [ String(value) ]);
	},

	cfgvalue: function(section_id) {
		return groupRangeInfoText(section_id);
	}
});


/* ------------------------------------------------------------------ */
/* 表单：状态                                                          */
/* ------------------------------------------------------------------ */

function statusSectionDescription() {
	if (runtime.statusError)
		return _('无法读取运行状态：%s。下方配置仍可编辑，保存并应用后会重新尝试。')
			.format(runtime.statusError);

	var of = currentOffload();

	if (of && of.active && of.auto_disable === false)
		return _('⚠ 检测到 TurboACC 流量卸载处于开启状态：已加速的连接会绕过 iptables，限速会失效。请勾选下方「自动关闭 TurboACC 流量卸载」后保存并应用。');

	if (of && of.active && of.auto_disable === true)
		return _('⚠ 已勾选自动关闭流量卸载，但卸载仍在运行：可能上次应用没有成功。请再次点击「保存并应用」，或到「网络 → TurboACC」手动关闭 Fastpath 引擎。');

	return null;
}

function buildStatusSection(m) {
	var s = m.section(form.NamedSection, 'defaults', 'defaults', _('状态'),
		statusSectionDescription());

	s.addremove = false;

	var o = s.option(form.Flag, 'enabled', _('启用设备限速'));
	o.default = o.enabled;
	o.rmempty = false;
	o.description = _('总开关。关闭后会删除全部限速规则，但保留下方所有设备/批量/默认配置。');

	o = s.option(StatusValue, 'hlimit_offload_state', _('流量卸载状态'));
	o.cfgvalue = function() { return offloadStateText(); };
	o.description = _('TurboACC / firewall 的 flow offloading 状态。开启时已加速连接会绕过 iptables。');

	o = s.option(form.Flag, 'auto_disable_offload', _('自动关闭 TurboACC 流量卸载'));
	o.default = o.enabled;
	o.rmempty = false;
	o.description = _('存在限速规则时自动备份并关闭流量卸载；取消勾选并保存并应用会恢复原配置。');

	o = s.option(StatusValue, 'hlimit_lan_scope', _('LAN 作用域'));
	o.cfgvalue = function() { return lanScopeText(); };
	o.description = _('限速规则只会作用于这些 LAN 接口上的客户端，不会误伤 WAN/上游网段。');

	o = s.option(StatusValue, 'hlimit_default_state', _('默认限速状态'));
	o.cfgvalue = function() { return defaultStateText(); };

	o = s.option(StatusValue, 'hlimit_dropped_total', _('已丢弃流量'));
	o.cfgvalue = function() { return droppedText(); };
	o.description = _('限速规则累计丢弃的字节数，不是设备总流量，也不等于实时网速。');

	o = s.option(StatusValue, 'hlimit_rules_summary', _('规则概览'));
	o.cfgvalue = function() { return rulesSummaryText(); };

	o = s.option(StatusValue, 'hlimit_warnings', _('告警'));
	o.cfgvalue = function() { return warningsText(); };
	o.description = _('stale / invalid / 下行未解析等问题的可读提示。');
}

/* poll 刷新状态区动态文本（不重建整页） */
function updateStatusCells() {
	setText('cbid.' + CONFIG + '.defaults.hlimit_offload_state', offloadStateText());
	setText('cbid.' + CONFIG + '.defaults.hlimit_lan_scope', lanScopeText());
	setText('cbid.' + CONFIG + '.defaults.hlimit_default_state', defaultStateText());
	setText('cbid.' + CONFIG + '.defaults.hlimit_dropped_total', droppedText());
	setText('cbid.' + CONFIG + '.defaults.hlimit_rules_summary', rulesSummaryText());
	setText('cbid.' + CONFIG + '.defaults.hlimit_warnings', warningsText());
}


/* ------------------------------------------------------------------ */
/* 表单：单独设备（GridSection）                                       */
/* ------------------------------------------------------------------ */

function mbpsOption(section, uciOption, title, description) {
	var o = section.option(form.Value, uciOption, title, description);

	o.datatype = 'ufloat';
	o.placeholder = '0';
	o.editable = true;
	o.rmempty = true;

	o.cfgvalue = function(section_id) {
		return fmtMbps(uci.get(CONFIG, section_id, uciOption));
	};

	o.write = function(section_id, value) {
		var mbps = parseMbps(value);

		if (isNaN(mbps))
			mbps = 0;

		return this.map.data.set(CONFIG, section_id, uciOption, String(mbps));
	};

	o.validate = function(section_id, value) {
		if (str(value) === '')
			return true;

		if (isNaN(parseMbps(value)))
			return _('请输入 0–%d 之间的数字（单位 Mbit/s，0 = 不限速）。').format(MAX_MBPS);

		return true;
	};

	return o;
}

function addHostChoices(o, kind) {
	var seen = {};

	for (var i = 0; i < runtime.hosts.length; i++) {
		var h = runtime.hosts[i],
		    key = (kind == 'mac') ? h.mac : h.ip,
		    label;

		if (key === '' || seen[key])
			continue;

		seen[key] = true;

		/* 下拉候选只显示 IP / MAC 本身：选中后 combobox 的显示宽度受列宽限制，
		 * 名称由「已发现设备」下拉和名称列负责，避免选中值被截断。 */
		label = key;

		o.value(key, label);
	}
}

function buildDeviceSection(m) {
	var s = m.section(form.GridSection, 'device', _('单独设备'),
		_('按 IP 或 MAC 单独限速，优先级最高。新增时可直接从「已发现设备」选择，自动填 IP/MAC/名称；名称留空由后端补主机名。只填 MAC 时解析不到当前 IP 的设备，下行规则不会生效。'));

	s.anonymous = true;
	s.addremove = true;
	s.addbtntitle = _('添加设备');
	s.nodescriptions = true;

	/* modal 顶部：已发现设备选择（只在弹窗出现） */
	var o = s.option(DevicePickerValue, '_pick_device', _('已发现设备'));
	o.modalonly = true;

	/* modal：名称编辑（表格里是只读回退显示） */
	o = s.option(form.Value, 'label', _('名称'));
	o.modalonly = true;
	o.placeholder = _('留空自动使用主机名');
	o.datatype = 'maxlength(32)';
	o.rmempty = true;

	/* 表格列 */
	o = s.option(form.Flag, 'enabled', _('启用'));
	o.default = o.enabled;
	o.rmempty = false;
	o.editable = true;
	o.width = '3.5em';

	o = s.option(form.DummyValue, '_name', _('名称'));
	o.modalonly = false;
	o.width = '14em';
	o.textvalue = function(section_id) {
		return deviceNameNode(section_id);
	};

	o = s.option(form.Value, 'ip', _('IP'));
	o.placeholder = _('例如 %s（留空则只按 MAC 匹配）').format(ipExample());
	o.datatype = 'ip4addr';
	o.editable = true;
	o.rmempty = true;
	o.width = '11em';
	o.validate = function(section_id, value) {
		if (str(value) === '')
			return true;

		return isIPv4(value) ? true
			: _('请输入单个 IPv4 地址（例如 %s），不能带掩码。').format(ipExample());
	};
	addHostChoices(o, 'ip');

	o = s.option(form.Value, 'mac', _('MAC'));
	o.placeholder = _('留空则只按 IP 匹配');
	o.datatype = 'macaddr';
	o.editable = true;
	o.rmempty = true;
	o.width = '11em';
	addHostChoices(o, 'mac');

	o = mbpsOption(s, 'down_kbps', _('下行(Mbps)'));
	o.width = '4.5em';

	o = mbpsOption(s, 'up_kbps', _('上行(Mbps)'));
	o.width = '4.5em';
}


/* ------------------------------------------------------------------ */
/* 表单：批量限速（GridSection，白名单在编辑弹窗里）                  */
/* ------------------------------------------------------------------ */

function buildGroupSection(m) {
	var s = m.section(form.GridSection, 'group', _('批量限速'),
		_('一条规则一个 IP 区间（起始 IP - 结束 IP，可跨 CIDR 边界），区间内每台设备各自限速（per-IP 哈希桶），优先级低于「单独设备」、高于「默认限速」。新增/编辑时可从扫描候选选择，或直接填写起始/结束 IP；白名单在编辑弹窗中维护（先保存并应用，再编辑即可添加区间内 IP）。'));

	s.anonymous = true;
	s.addremove = true;
	s.addbtntitle = _('添加批量规则');
	s.nodescriptions = true;

	/* modal 顶部：扫描候选 / 起止 IP 两个输入框 */
	var o = s.option(GroupScanSelect, '_scan_range', _('自动扫描选择'));
	o.modalonly = true;

	o = s.option(form.Value, 'start', _('起始 IP'));
	o.modalonly = true;
	o.placeholder = _('例如 10.0.0.100');
	o.datatype = 'ip4addr';
	o.rmempty = false;
	o.width = '12em';
	o.validate = function(section_id, value) {
		if (!isIPv4(value))
			return _('请输入合法的起始 IPv4 地址（例如 %s）。').format(ipExample());

		var se = groupStartEndFromDom(section_id);

		if (isIPv4(se.end) && ipToInt(value) > ipToInt(se.end))
			return _('起始 IP 不能大于结束 IP。');

		return true;
	};
	o.onchange = function(ev, section_id) {
		updateGroupRangeInfo(section_id);
	};

	o = s.option(form.Value, 'end', _('结束 IP'));
	o.modalonly = true;
	o.placeholder = _('例如 10.0.0.200');
	o.datatype = 'ip4addr';
	o.rmempty = false;
	o.width = '12em';
	o.validate = function(section_id, value) {
		if (!isIPv4(value))
			return _('请输入合法的结束 IPv4 地址（例如 %s）。').format(ipExample());

		var se = groupStartEndFromDom(section_id);

		if (isIPv4(se.start) && ipToInt(se.start) > ipToInt(value))
			return _('结束 IP 不能小于起始 IP。');

		return true;
	};
	o.onchange = function(ev, section_id) {
		updateGroupRangeInfo(section_id);
	};

	o = s.option(GroupRangeInfoValue, '_range_info', _('区间 / 作用域'));
	o.modalonly = true;

	/* modal：名称编辑 */
	o = s.option(form.Value, 'label', _('名称'));
	o.modalonly = true;
	o.placeholder = _('可选，例如：访客网段');
	o.datatype = 'maxlength(32)';
	o.rmempty = true;

	/* 表格列 */
	o = s.option(form.Flag, 'enabled', _('启用'));
	o.default = o.enabled;
	o.rmempty = false;
	o.editable = true;
	o.width = '3.5em';

	o = s.option(form.DummyValue, '_range', _('IP 区间'));
	o.modalonly = false;
	o.width = '20em';
	o.textvalue = function(section_id) {
		return groupRangeNode(section_id);
	};

	o = s.option(form.DummyValue, '_gname', _('名称'));
	o.modalonly = false;
	o.width = '10em';
	o.textvalue = function(section_id) {
		return groupNameNode(section_id);
	};

	o = mbpsOption(s, 'down_kbps', _('下行(Mbps)'));
	o.width = '4.5em';

	o = mbpsOption(s, 'up_kbps', _('上行(Mbps)'));
	o.width = '4.5em';

	/* 白名单：只在编辑弹窗里维护（需先保存并应用） */
	o = s.option(GroupExcludeValue, '_exclude', _('白名单'));
	o.modalonly = true;
}


/* ------------------------------------------------------------------ */
/* 批量「不限速名单」行（渲染后注入到每个 group 行下方）              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 白名单：放在批量规则的编辑弹窗里（modalonly）                       */
/* ------------------------------------------------------------------ */

/* 逐条调用 group-exclude-add / group-exclude-del，最后统一 refreshRuntime */
function applyExcludeChanges(sectionId, add, values) {
	var r = groupRangeOf(sectionId),
	    range = r ? r.range : '',
	    errs = [];

	var chain = Promise.resolve();

	values.forEach(function(v) {
		chain = chain.then(function() {
			return fs.exec(CTL, [ add ? 'group-exclude-add' : 'group-exclude-del', range, v ])
				.then(function(res) {
					if (res.code !== 0)
						errs.push(v + '：' + stderrText(res));
				});
		});
	});

	return chain.then(function() {
		return refreshRuntime();
	}).then(function() {
		if (errs.length) {
			notifyError(add ? _('部分白名单未添加') : _('部分白名单未移除'), errs.join('；'));
			return false;
		}

		if (add) {
			notify(_('已加入白名单'),
				_('已添加 %d 个：%s').format(values.length, values.join('、')), 'success');
		}
		else {
			notify(_('已移出白名单'),
				_('%s 已恢复参与限速').format(values.join('、')), 'success');
		}

		return true;
	});
}

/* 渲染弹窗里的白名单区（box 内部整体重建，便于添加/删除后立即刷新） */
function renderExcludeBox(box, sectionId) {
	box.innerHTML = '';

	var applied = isGroupApplied(sectionId),
	    r = groupRangeOf(sectionId),
	    range = r ? r.range : '',
	    excludes = groupExcludes(sectionId),
	    added = {};

	for (var i = 0; i < excludes.length; i++)
		added[excludes[i].toLowerCase()] = true;

	var chips = E('div', {
		'style': 'display:flex;flex-wrap:wrap;align-items:center;gap:.3rem;min-height:1.6rem'
	});

	for (var e = 0; e < excludes.length; e++) {
		(function(value) {
			var host = hostFor(value, value),
			    title = value + (host && host.name ? ' · ' + host.name : '');

			chips.appendChild(E('span', {
				'style': 'display:inline-flex;align-items:center;padding:.18rem .3rem .18rem .5rem;border:1px solid #c9d8f2;border-radius:12px;background:#eef4ff;color:#1f3b6e;font-size:90%;line-height:1.5',
				'title': title
			}, [
				E('span', {
					'style': 'max-width:14em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
				}, value),
				E('button', {
					'type': 'button',
					'class': 'cbi-button cbi-button-remove',
					'title': _('移出白名单'),
					'style': 'padding:0 .3em;margin-left:.3em;min-width:1.2em;line-height:1.1;border-radius:50%;font-size:90%',
					'click': function() {
						if (excludeBusy[sectionId])
							return;

						excludeBusy[sectionId] = true;

						applyExcludeChanges(sectionId, false, [ value ]).catch(function(err) {
							notifyError(_('修改白名单失败'), err);
						}).then(function() {
							excludeBusy[sectionId] = false;
							renderExcludeBox(box, sectionId);
						});
					}
				}, '×')
			]));
		})(excludes[e]);
	}

	if (!excludes.length) {
		chips.appendChild(E('span', {
			'style': 'padding:.2rem .55rem;border:1px dashed #cfd8e3;border-radius:4px;color:#8a94a6;font-size:90%'
		}, _('暂无，区间内设备全部参与限速')));
	}

	box.appendChild(chips);

	if (!applied) {
		box.appendChild(E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:.35rem' },
			_('该批量规则尚未保存并应用，暂不能维护白名单。请先点「保存并应用」，再回来编辑。')));
		return;
	}

	var customInput = E('input', {
		'type': 'text',
		'class': 'cbi-input-text',
		'style': 'flex:1 1 12em;min-width:8em;max-width:20em',
		'placeholder': _('区间内 IP，如 10.0.0.110（也支持 MAC，可输入多个）'),
		'id': 'hlimit-exclude-custom-' + sectionId
	});

	if (r) {
		var hosts = hostsInRange(r);

		if (hosts.length) {
			var dlId = 'hlimit-exclude-hosts-' + sectionId,
			    dl = E('datalist', { 'id': dlId });

			for (var h = 0; h < hosts.length; h++) {
				var host = hosts[h];

				dl.appendChild(E('option', {
					'value': host.ip,
					'label': (host.name ? host.name + ' · ' : '') + host.ip
				}));
			}

			box.appendChild(dl);
			customInput.setAttribute('list', dlId);
		}
	}

	var addBtn = E('button', {
		'type': 'button',
		'class': 'cbi-button cbi-button-add',
		'title': _('添加到白名单'),
		'style': 'min-width:2.4em;font-weight:700;font-size:110%'
	}, '+');

	var doAdd = function() {
		if (excludeBusy[sectionId])
			return;

		var raw = str(customInput.value);

		if (raw === '') {
			notify(_('请填写 IP'), _('白名单支持区间内的 IPv4 地址，也支持 MAC。'), 'warning');
			customInput.focus();
			return;
		}

		var parts = raw.split(/[\s,，;；]+/).filter(function(s) { return s !== ''; }),
		    bad = [],
		    ok = [],
		    dup = 0;

		parts.forEach(function(v) {
			if (!isIPv4(v) && !isMac(v)) {
				bad.push(v);
				return;
			}

			if (added[v.toLowerCase()]) {
				dup++;
				return;
			}

			if (isIPv4(v) && r && !ipInRange(v, r)) {
				bad.push(v);
				return;
			}

			ok.push(v);
		});

		if (bad.length) {
			notifyError(_('格式或范围不正确'),
				_('%s 不在 %s 内，或不是合法的 IP / MAC。').format(bad.join('、'), range));
			return;
		}

		if (!ok.length) {
			notify(_('无需添加'),
				dup ? _('输入的 IP 已在白名单中。') : _('请填写 IP。'), 'warning');
			customInput.focus();
			return;
		}

		excludeBusy[sectionId] = true;
		customInput.disabled = true;
		addBtn.disabled = true;
		addBtn.textContent = '…';

		applyExcludeChanges(sectionId, true, ok).catch(function(err) {
			notifyError(_('添加白名单失败'), err);
		}).then(function() {
			excludeBusy[sectionId] = false;
			renderExcludeBox(box, sectionId);

			var el = document.getElementById('hlimit-exclude-custom-' + sectionId);

			if (el && el.focus) {
				el.focus();

				if (el.select)
					el.select();
			}
		});
	};

	addBtn.addEventListener('click', doAdd);

	customInput.addEventListener('keydown', function(ev) {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			doAdd();
		}
	});

	box.appendChild(E('div', {
		'style': 'display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;margin-top:.5rem'
	}, [ customInput, addBtn ]));

	box.appendChild(E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:.3rem' },
		_('点 + 或按回车添加；可一次输入多个 IP（空格或逗号分隔）。白名单仅对当前区间生效。')));
}

var GroupExcludeValue = form.DummyValue.extend({
	__name__: 'CBI.HlimitGroupExclude',

	renderWidget: function(section_id /*, option_index, cfgvalue */) {
		var box = E('div', { 'class': 'hlimit-exclude-box' });

		renderExcludeBox(box, section_id);

		return box;
	}
});


/* ------------------------------------------------------------------ */
/* 表单：默认限速（NamedSection defaults）                             */
/* ------------------------------------------------------------------ */

function buildDefaultSection(m) {
	var s = m.section(form.NamedSection, 'defaults', 'defaults', _('默认限速'),
		_('对没有匹配「单独设备」和「批量限速」的 LAN 客户端生效（默认关闭）。作用范围由后端按 LAN 接口自动识别，无需填写网段；哈希桶按源/目的 IP 区分，不会把整段带宽平均分配。'));

	s.addremove = false;

	var o = s.option(form.Flag, 'default_enabled', _('启用默认限速'));
	o.default = o.disabled;
	o.rmempty = false;
	o.description = _('默认关闭。开启且上下行至少一项非 0 时才会生成默认限速规则。');

	o = mbpsOption(s, 'default_down_kbps', _('下行(Mbps)'));
	o.description = _('0 = 不限速。');

	o = mbpsOption(s, 'default_up_kbps', _('上行(Mbps)'));
	o.description = _('0 = 不限速。');

	o = s.option(StatusValue, 'hlimit_default_scope', _('自动作用范围'));
	o.cfgvalue = function() { return lanScopeText(); };
	o.description = _('后端按 LAN 接口限定，WAN/上游网段即使与 LAN CIDR 重叠也不会被限速。');

	o = s.option(StatusValue, 'hlimit_default_note', _('说明'));
	o.cfgvalue = function() {
		return _('0 = 不限速。若只想让个别设备不限速，请在「单独设备」新增该设备并把上下行都设为 0（最高优先级豁免，不需要全局白名单）。');
	};
}


/* ------------------------------------------------------------------ */
/* 保存 / 渲染后处理 / 轮询                                            */
/* ------------------------------------------------------------------ */

function applyRules() {
	return fs.exec(CTL, [ 'apply' ]).then(function(res) {
		if (res.code !== 0)
			throw new Error(stderrText(res));

		return true;
	});
}

/*
 * 列宽兜底：主题给 .cbi-dropdown 设了 min-width，auto 布局会挤压其它列；
 * 对本站表格统一 table-layout:fixed + 覆盖 min-width，窄屏允许横向滚动。
 */
function applyTableLayout(node) {
	if (!node || typeof node.querySelectorAll != 'function')
		return;

	node.querySelectorAll('table.cbi-section-table').forEach(function(table) {
		table.style.tableLayout = 'fixed';

		if (table.parentNode)
			table.parentNode.style.overflowX = 'auto';

		[ '.cbi-dropdown', '.cbi-input-text', '.cbi-input-select' ].forEach(function(sel) {
			table.querySelectorAll(sel).forEach(function(el) {
				el.style.minWidth = '0';
				el.style.width = '100%';
			});
		});

		var ths = table.querySelectorAll('th');

		if (ths.length)
			ths[ths.length - 1].style.width = '8em';
	});
}

function statusPoller() {
	if (!document.getElementById('cbid.' + CONFIG + '.defaults.hlimit_dropped_total')) {
		poll.remove(statusPoller);
		return Promise.resolve();
	}

	return fetchStatus().then(function(res) {
		if (!res.status)
			return;

		runtime.status = res.status;
		runtime.statusError = null;

		if (res.status.offload) {
			if (!runtime.offload) {
				runtime.offload = res.status.offload;
			}
			else {
				runtime.offload.active = res.status.offload.active;
				runtime.offload.backup_saved = res.status.offload.backup_saved;

				if (res.status.offload.auto_disable != null)
					runtime.offload.auto_disable = res.status.offload.auto_disable;
			}
		}

		updateStatusCells();
	});
}

function startPolling() {
	if (poll.add(statusPoller, REFRESH_INTERVAL) === false)
		return;

	if (window.addEventListener)
		window.addEventListener('beforeunload', function() {
			poll.remove(statusPoller);
		});
}


/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

return view.extend({
	load: function() {
		return Promise.all([
			fetchStatus(),
			fetchOffload(),
			fetchScan()
		]).then(function(res) {
			applyRuntime(res[0], res[1], res[2]);
			return runtime;
		});
	},

	render: function() {
		var m = new form.Map(CONFIG, _('设备限速'),
			_('按设备 / IP 区间 / 默认限制上行与下行速率（iptables hashlimit 丢包式限速）。超出设定速率的报文会被直接丢弃，低速档（< 2 Mbps）体验较差；规则挂在 mangle 表，已兼容 OpenClash 代理路径。默认限速自动跟随 LAN 网段；修改后请点「保存并应用」，仅「保存」不会重新下发规则。'));

		mapObject = m;

		/*
		 * Map 的任意重绘（保存/删除行/弹窗保存后的 load+reset）都会走
		 * renderContents()；在这里统一重新应用表格布局与「不限速名单」注入，
		 * 避免 GridSection 重绘后样式和展开区丢失。
		 */
		if (typeof m.renderContents == 'function') {
			var origRenderContents = m.renderContents;

			m.renderContents = function() {
				return Promise.resolve(origRenderContents.apply(this, arguments)).then(function(node) {
					applyTableLayout(node);
					return node;
				});
			};
		}

		buildStatusSection(m);
		buildDeviceSection(m);
		buildGroupSection(m);
		buildDefaultSection(m);

		return m.render().then(function(node) {
			applyTableLayout(node);
			startPolling();
			return node;
		});
	},

	/*
	 * 覆写 handleSave：Map.save() 会重绘表格，注入的「不限速名单」行会丢失，
	 * 因此保存后重新应用布局并重新注入。
	 */
	handleSave: function(ev) {
		var save = mapObject
			? mapObject.save()
			: Promise.resolve(null);

		return save.then(function() {
			var root = document.getElementById('view');

			if (root)
				applyTableLayout(root);
		});
	},

	/*
	 * 「保存并应用」：Map.save() -> uci.apply()（commit）-> hlimit-ctl apply
	 * -> 原生提示 + 刷新页面。
	 */
	handleSaveApply: function(ev, mode) {
		return this.handleSave(ev).then(function() {
			return uci.apply();
		}).then(function() {
			return applyRules();
		}).then(function() {
			ui.addNotification(_('已应用'),
				E('p', {}, _('限速配置已保存，LAN 作用域与 iptables 规则已重新下发。')), 'success');

			window.setTimeout(function() {
				window.location.reload();
			}, 1500);
		}).catch(function(err) {
			notifyError(_('保存并应用失败'),
				(typeof err === 'number')
					? _('UCI 提交失败（ubus 状态 %d）').format(err)
					: err);
		});
	}
});
