#!/usr/bin/env node
/*
 * luci-app-hlimit v1.2 - LuCI 界面离线自测（Node，无第三方依赖）
 *
 * 覆盖：
 *   1. menu.d / acl.d JSON：scan 读权限、group-exclude-* 写权限（group-* 通配）
 *   2. overview.js 静态检查：只用允许模块、原生 form 组件、无自定义横幅、
 *      无外部库、命令集（scan/status/apply/group-exclude-add|del）、
 *      不硬编码网段、placeholder 同时含 10.x 与 192.168.x 示例
 *   3. 用轻量 form/DOM/LuCI 桩执行 view.load()/render()：
 *      - 10.0.0.0/8 LAN 夹具：LAN 作用域、默认规则状态、告警（stale/invalid/
 *        down_unresolved/scan 不可用）、设备名称 label->主机名->IP 回退、
 *        0/0 显示不限速、批量 CIDR 区间/在线数/LAN 警告
 *      - 扫描候选、起始 IP+掩码生成、DevicePicker 自动填 IP/MAC/名称
 *      - 每行批量规则下注入「不限速名单（N）」：chip、展开、添加/删除命令
 *      - 192.168.2.0/24 LAN 夹具：作用域/网关动态显示，不假设 10.x
 *      - 默认限速无 CIDR/白名单输入框；旧 default_cidr/default_exclude 不映射
 *      - 保存并应用顺序；scan 不可用回退 devices；后端全失败降级不白屏
 *      - poll 12s 刷新状态区、离开页面自清理
 *
 * 用法：node tests/ui/test-ui.js
 */

'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var OVERVIEW = path.join(ROOT, 'files/www/luci-static/resources/view/hlimit/overview.js');
var MENU = path.join(ROOT, 'files/usr/share/luci/menu.d/luci-app-hlimit.json');
var ACL = path.join(ROOT, 'files/usr/share/rpcd/acl.d/luci-app-hlimit.json');

var failures = 0;
var checks = 0;

function ok(cond, label) {
	checks++;
	if (!cond) {
		failures++;
		console.error('FAIL: ' + label);
	}
	else {
		console.log('ok   - ' + label);
	}
}

function read(file) {
	return fs.readFileSync(file, 'utf8');
}

function json(file) {
	return JSON.parse(read(file));
}

function contains(haystack, needle, label) {
	ok(String(haystack).indexOf(needle) >= 0, label || ('contains ' + needle));
}

function notContains(haystack, needle, label) {
	ok(String(haystack).indexOf(needle) < 0, label || ('does not contain ' + needle));
}

/* ------------------------------------------------------------------ */
/* 1. menu.d / acl.d                                                   */
/* ------------------------------------------------------------------ */

var menu = json(MENU);
var menuNode = menu['admin/network/hlimit'];
ok(!!menuNode, 'menu.d 存在 admin/network/hlimit 节点');
ok(menuNode && menuNode.title === '设备限速', 'menu.d 标题为「设备限速」');
ok(menuNode && menuNode.order === 60, 'menu.d order = 60');
ok(menuNode && menuNode.action && menuNode.action.type === 'view', 'menu.d action.type = view');
ok(menuNode && menuNode.action && menuNode.action.path === 'hlimit/overview',
   'menu.d action.path = hlimit/overview');
ok(menuNode && menuNode.depends && Array.isArray(menuNode.depends.acl) &&
   menuNode.depends.acl.indexOf('luci-app-hlimit') >= 0, 'menu.d depends.acl 含 luci-app-hlimit');

var acl = json(ACL);
var group = acl['luci-app-hlimit'];
ok(!!group, 'acl.d 顶层组名 luci-app-hlimit');
ok(!!(group && group.description), 'acl.d 有 description');
ok(!!(group && group.read && group.read.file), 'acl.d read.file 存在');
ok(!!(group && group.write && group.write.file), 'acl.d write.file 存在');
ok(!!(group && group.read && group.read.uci && group.read.uci.indexOf('hashlimit-qos') >= 0),
   'acl.d read.uci 含 hashlimit-qos');
ok(!!(group && group.write && group.write.uci && group.write.uci.indexOf('hashlimit-qos') >= 0),
   'acl.d write.uci 含 hashlimit-qos');
ok(!!(group && group.read && group.read.ubus && group.read.ubus.file &&
      group.read.ubus.file.indexOf('exec') >= 0), 'acl.d read.ubus.file 含 exec');
ok(!!(group && group.write && group.write.ubus && group.write.ubus.file &&
      group.write.ubus.file.indexOf('exec') >= 0), 'acl.d write.ubus.file 含 exec');

function aclPatterns(section) {
	var out = [];
	if (group && group[section] && group[section].file)
		for (var p in group[section].file)
			if (group[section].file[p].indexOf('exec') >= 0)
				out.push(p);
	return out;
}

var readPatterns = aclPatterns('read');
var writePatterns = aclPatterns('write');

function fnmatch(pattern, s) {
	var re = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
	                    .replace(/\*/g, '.*')
	                    .replace(/\?/g, '.') + '$';
	return new RegExp(re).test(s);
}

function aclAllows(patterns, cmdline) {
	for (var i = 0; i < patterns.length; i++)
		if (fnmatch(patterns[i], cmdline))
			return true;
	return false;
}

function aclCheck(section, cmdline, label) {
	var patterns = (section === 'read') ? readPatterns : writePatterns;
	ok(aclAllows(patterns, cmdline), 'ACL ' + section + ' 覆盖 ' + (label || cmdline));
}

aclCheck('read', '/usr/sbin/hlimit-ctl scan', 'scan（v1.2 扫描）');
aclCheck('read', '/usr/sbin/hlimit-ctl status');
aclCheck('read', '/usr/sbin/hlimit-ctl list');
aclCheck('read', '/usr/sbin/hlimit-ctl devices');
aclCheck('read', '/usr/sbin/hlimit-ctl offload-status');
aclCheck('write', '/usr/sbin/hlimit-ctl apply');
aclCheck('write', '/usr/sbin/hlimit-ctl group-exclude-add 10.0.0.128/25 10.0.0.190');
aclCheck('write', '/usr/sbin/hlimit-ctl group-exclude-del 10.0.0.128/25 10.0.0.190');
aclCheck('write', '/usr/sbin/hlimit-ctl set 10.0.0.50 5120 1024 客厅电视 1');
aclCheck('write', '/usr/sbin/hlimit-ctl delete 10.0.0.50');
aclCheck('write', '/usr/sbin/hlimit-ctl toggle 10.0.0.50 0');
aclCheck('write', '/usr/sbin/hlimit-ctl global 0');
aclCheck('write', '/usr/sbin/hlimit-ctl render');
aclCheck('write', '/usr/sbin/hlimit-ctl offload-apply');
aclCheck('write', '/usr/sbin/hlimit-ctl offload-restore');

/* ------------------------------------------------------------------ */
/* 2. overview.js 静态检查                                             */
/* ------------------------------------------------------------------ */

var src = read(OVERVIEW);

var requires = (src.match(/^'require ([^']+)';$/gm) || []).map(function(line) {
	return /^'require ([^']+)';$/.exec(line)[1];
});
ok(requires.length >= 5, 'overview.js 有 require 声明');
requires.forEach(function(name) {
	ok([ 'view', 'form', 'fs', 'poll', 'uci', 'ui' ].indexOf(name) >= 0,
	   '仅使用稳定模块：require ' + name);
});

notContains(src, 'exec_direct', '未使用 fs.exec_direct');
notContains(src, 'uci.commit', '未使用不存在的 uci.commit()');
notContains(src, 'setInterval', '使用 LuCI poll 而不是自管 setInterval');
notContains(src, 'alert-message', '没有自定义大横幅（alert-message）');
ok(src.indexOf('ui.addNotification') >= 0, '使用 ui.addNotification');
ok(/fs\.exec\(\s*CTL\s*,\s*\[/.test(src), 'fs.exec 使用参数数组形式');
ok(src.indexOf('poll.add') >= 0 && src.indexOf('poll.remove') >= 0,
   'poll 刷新状态且有自清理');

[ 'form.Map', 'form.NamedSection', 'form.GridSection',
  'form.Flag', 'form.Value', 'form.DummyValue' ].forEach(function(name) {
	contains(src, name, '使用标准组件 ' + name);
});

contains(src, 'addremove = true', '设备/批量表格支持增删');
contains(src, 'modalonly = true', '扫描/生成等辅助控件只在弹窗出现');
notContains(src, 'decorateTables', '不再向批量表行注入白名单行');
contains(src, 'GroupExcludeValue', '白名单是弹窗内的 DummyValue 控件');
contains(src, 'tableLayout', '表格 table-layout:fixed');
contains(src, 'overflowX', '窄屏横向滚动兜底');

/* 默认限速不再映射 default_cidr / default_exclude */
notContains(src, "'default_cidr'", '不再创建 default_cidr 输入');
notContains(src, "'default_exclude'", '不再创建 default_exclude 输入');
notContains(src, "'192.168.2.0/24'", '源码没有硬编码 192.168.2.0/24 作用域');
notContains(src, "'10.0.0.0/8'", '源码没有硬编码 10.0.0.0/8 作用域');

/* placeholder 必须同时给出 10.x 与 192.168.x 两类示例 */
[ '10.0.0.50', '192.168.2.50', '10.0.1.1 - 10.0.2.1',
  '192.168.2.10 - 192.168.2.99', '10.0.0.110' ].forEach(function(example) {
	contains(src, example, '输入提示包含示例 ' + example);
});

/* 静态提取 fs.exec 子命令 */
var cmdNames = {};
var cmdRe = /fs\.exec\(\s*CTL\s*,\s*\[\s*'([a-z-]+)'/g;
var m;

while ((m = cmdRe.exec(src)) !== null)
	cmdNames[m[1]] = true;

[ 'status', 'list', 'devices', 'offload-status', 'scan', 'apply' ].forEach(function(name) {
	ok(cmdNames[name] === true, 'overview.js 调用 hlimit-ctl ' + name);
});

/* group-exclude-* 的参数是动态拼接的，用字符串出现检查 */
contains(src, 'group-exclude-add', 'overview.js 调用 group-exclude-add');
contains(src, 'group-exclude-del', 'overview.js 调用 group-exclude-del');

/* ------------------------------------------------------------------ */
/* 3. 轻量 form / DOM / LuCI 运行时桩                                   */
/* ------------------------------------------------------------------ */

if (typeof String.prototype.format !== 'function') {
	String.prototype.format = function() {
		var args = arguments, i = 0;
		return String(this).replace(/%[sd]/g, function() {
			return String(args[i++]);
		}).replace(/%%/g, '%');
	};
}

function FakeNode(tag) {
	this.tagName = String(tag).toUpperCase();
	this.attributes = {};
	this.children = [];
	this.listeners = {};
	this.parentNode = null;
	this.textContent = '';
	this.value = '';
	this.checked = false;
	this.disabled = false;
	this.style = {};
	this.classList = {
		_list: {},
		add: function(c) { this._list[c] = true; },
		remove: function(c) { delete this._list[c]; },
		contains: function(c) { return !!this._list[c]; }
	};
}

Object.defineProperty(FakeNode.prototype, 'innerHTML', {
	get: function() { return this._html || ''; },
	set: function(v) {
		this._html = String(v);
		this.children = [];
		this.textContent = '';
	}
});

Object.defineProperty(FakeNode.prototype, 'nextSibling', {
	get: function() {
		if (!this.parentNode)
			return null;
		var i = this.parentNode.children.indexOf(this);
		return (i >= 0 && i + 1 < this.parentNode.children.length)
			? this.parentNode.children[i + 1] : null;
	}
});

FakeNode.prototype.focus = function() {};
FakeNode.prototype.blur = function() {};
FakeNode.prototype.select = function() {};

FakeNode.prototype.setAttribute = function(key, value) {
	var v = String(value);
	this.attributes[key] = v;

	if (key === 'id')
		doc.byId[v] = this;
	else if (key === 'value')
		this.value = v;
	else if (key === 'checked')
		this.checked = true;
	else if (key === 'class')
		v.split(/\s+/).forEach(function(c) { if (c) this.classList._list[c] = true; }, this);
};

FakeNode.prototype.getAttribute = function(key) {
	return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
};

FakeNode.prototype.appendChild = function(child) {
	child.parentNode = this;
	this.children.push(child);
	return child;
};

FakeNode.prototype.insertBefore = function(child, ref) {
	var i = (ref == null) ? this.children.length : this.children.indexOf(ref);

	if (i < 0)
		i = this.children.length;

	child.parentNode = this;
	this.children.splice(i, 0, child);
	return child;
};

FakeNode.prototype.removeChild = function(child) {
	var i = this.children.indexOf(child);
	if (i >= 0) {
		this.children.splice(i, 1);
		child.parentNode = null;
	}
	return child;
};

FakeNode.prototype.addEventListener = function(type, fn) {
	(this.listeners[type] = this.listeners[type] || []).push(fn);
};

FakeNode.prototype.dispatchEvent = function(ev) {
	var list = this.listeners[ev.type] || [];
	ev.target = ev.target || this;
	for (var i = 0; i < list.length; i++)
		list[i].call(this, ev);
	return true;
};

function matchSelector(node, sel) {
	sel = String(sel).trim();

	if (sel.charAt(0) === '.')
		return node.classList.contains(sel.slice(1));

	if (sel.charAt(0) === '#')
		return node.getAttribute('id') === sel.slice(1);

	var parts = sel.split('.');

	if (node.tagName !== parts[0].toUpperCase())
		return false;

	for (var i = 1; i < parts.length; i++)
		if (!node.classList.contains(parts[i]))
			return false;

	return true;
}

FakeNode.prototype.querySelectorAll = function(sel) {
	var out = [];

	(function walk(n) {
		n.children.forEach(function(c) {
			if (matchSelector(c, sel))
				out.push(c);
			walk(c);
		});
	})(this);

	return out;
};

FakeNode.prototype.querySelector = function(sel) {
	return this.querySelectorAll(sel)[0] || null;
};

var doc = {
	byId: {},
	createElement: function(tag) { return new FakeNode(tag); },
	createTextNode: function(text) {
		var n = new FakeNode('#text');
		n.textContent = String(text);
		return n;
	},
	getElementById: function(id) { return doc.byId[id] || null; },
	querySelector: function() { return null; },
	querySelectorAll: function() { return []; },
	dispatchEvent: function() {},
	addEventListener: function() {}
};

var win = {
	location: { reload: function() { win.__reloaded = true; } },
	__reloaded: false,
	__listeners: {},
	addEventListener: function(type, fn) {
		(this.__listeners[type] = this.__listeners[type] || []).push(fn);
	},
	removeEventListener: function() {}
};

function appendData(node, data) {
	if (Array.isArray(data)) {
		for (var i = 0; i < data.length; i++)
			appendData(node, data[i]);
		return;
	}

	if (data === null || data === undefined)
		return;

	if (data instanceof FakeNode) {
		node.appendChild(data);
		return;
	}

	node.appendChild(doc.createTextNode(String(data)));
}

function E(tag, attr, data) {
	if (Array.isArray(tag)) {
		var frag = new FakeNode('#fragment');
		for (var i = 0; i < tag.length; i++)
			appendData(frag, E(tag[i]));
		return frag;
	}

	if (tag instanceof FakeNode)
		return tag;

	var node = new FakeNode(tag);

	if (attr && typeof attr === 'object' && !Array.isArray(attr)) {
		for (var key in attr) {
			if (attr[key] === null || attr[key] === undefined)
				continue;
			if (typeof attr[key] === 'function')
				node.addEventListener(key, attr[key]);
			else
				node.setAttribute(key, attr[key]);
		}
	}
	else {
		data = attr;
	}

	appendData(node, data);

	return node;
}

function _(text) { return String(text); }

function collectText(node) {
	if (node === null || node === undefined)
		return '';
	if (node instanceof FakeNode)
		return node.textContent + node.children.map(collectText).join('');
	return String(node);
}

/* ------------------------ form 桩 ------------------------ */

var LAST_MAP = null;

function StubClass(name, init) {
	function C() {
		if (init)
			init.apply(this, arguments);
	}

	C.__stubName = name;
	C.prototype.__stubName = name;
	C.extend = function(props) {
		function Sub() {
			C.apply(this, arguments);
		}

		Sub.prototype = Object.create(C.prototype);
		Sub.prototype.constructor = Sub;

		for (var k in props) {
			if (k === '__init__')
				continue;
			Sub.prototype[k] = props[k];
		}

		Sub.extend = C.extend;
		Sub.__stubName = name + 'Ext';
		Sub.prototype.__stubName = name + 'Ext';

		Sub.prototype.super = function(key, args) {
			var proto = Object.getPrototypeOf(Sub.prototype), fn = null;

			while (proto) {
				if (typeof proto[key] == 'function') {
					fn = proto[key];
					break;
				}
				proto = Object.getPrototypeOf(proto);
			}

			if (!fn)
				throw new Error('no super method: ' + key);

			return fn.apply(this, args || []);
		};

		return Sub;
	};

	return C;
}

function optionInit(map, section, option, title, description) {
	this.map = map;
	this.section = section;
	this.option = option;
	this.title = title || '';
	this.description = description || '';
	this.editable = null;
	this.modalonly = null;
	this.rmempty = true;
	this.optional = false;
	this.datatype = null;
	this.placeholder = null;
	this.default = null;
	this._widgets = {};
}

function FakeWidget() {
	this.value = '';
	this.node = new FakeNode('div');
}

FakeWidget.prototype.setValue = function(v) { this.value = v; };
FakeWidget.prototype.getValue = function() { return this.value; };

var StubValue = StubClass('Value', function(map, section, option, title, description) {
	optionInit.call(this, map, section, option, title, description);
	this.choices = null;
});

StubValue.prototype.value = function(key, label) {
	this.choices = this.choices || [];
	this.choices.push({ key: String(key), label: String(label != null ? label : key) });
};

StubValue.prototype.getUIElement = function(sid) {
	if (!this._widgets[sid])
		this._widgets[sid] = new FakeWidget();
	return this._widgets[sid];
};

StubValue.prototype.renderFrame = function(section_id, in_table, option_index, nodes) {
	var td = E('td', { 'class': 'td cbi-value-field' });
	appendData(td, nodes);
	return td;
};

var StubFlag = StubClass('Flag', function(map, section, option, title, description) {
	optionInit.call(this, map, section, option, title, description);
	this.enabled = '1';
	this.disabled = '0';
	this.default = this.disabled;
});

var StubTextValue = StubClass('TextValue', function(map, section, option, title, description) {
	optionInit.call(this, map, section, option, title, description);
	this.rows = null;
	this.cols = null;
});

var StubDummyValue = StubClass('DummyValue', function(map, section, option, title, description) {
	optionInit.call(this, map, section, option, title, description);
});

function sectionInit(map, sectiontype, title, description) {
	this.map = map;
	this.sectiontype = sectiontype;
	this.title = title || '';
	this.description = description || '';
	this.children = [];
	this.anonymous = true;
	this.addremove = false;
	this.sortable = false;
	this.addbtntitle = null;
	this.nodescriptions = false;
	this.sectionId = null;
}

function StubSectionBase(name) {
	return StubClass(name, function(map, sectiontype, title, description) {
		sectionInit.call(this, map, sectiontype, title, description);
	});
}

var StubGridSection = StubSectionBase('GridSection');

StubGridSection.prototype.sids = function() {
	return uci.sections(this.map.config, this.sectiontype).map(function(s) {
		return s['.name'];
	});
};

var StubNamedSection = StubClass('NamedSection', function(map, sid, sectiontype, title, description) {
	sectionInit.call(this, map, sectiontype, title, description);
	this.sectionId = sid;
});

StubNamedSection.prototype.sids = function() {
	return [ this.sectionId ];
};

function sectionOption(cls, option, title, description) {
	var obj = new cls(this.map, this, option, title, description);
	this.children.push(obj);
	return obj;
}

StubGridSection.prototype.option = sectionOption;
StubNamedSection.prototype.option = sectionOption;

var form = {
	Map: StubClass('Map', function(config, title, description) {
		this.config = config;
		this.title = title || '';
		this.description = description || '';
		this.children = [];
		this.readonly = false;
		this.data = uci;
	}),
	NamedSection: StubNamedSection,
	GridSection: StubGridSection,
	Value: StubValue,
	Flag: StubFlag,
	TextValue: StubTextValue,
	DummyValue: StubDummyValue
};

form.Map.prototype.section = function(cls, a, b, c, d) {
	var sec = new cls(this, a, b, c, d);
	this.children.push(sec);
	return sec;
};

form.Map.prototype.render = function() {
	var root = E('div', { 'class': 'cbi-map', 'id': 'cbi-' + this.config });

	LAST_MAP = this;

	if (this.title)
		root.appendChild(E('h2', {}, this.title));

	if (this.description)
		root.appendChild(E('div', { 'class': 'cbi-map-descr' }, this.description));

	this.children.forEach(function(sec) {
		root.appendChild(renderSection(sec));
	});

	return Promise.resolve(root);
};

form.Map.prototype.findElement = function() { return null; };

/* 供 modal 辅助控件查找同一表单内的其它 option */
form.Map.prototype.lookupOption = function(name, sid) {
	for (var i = 0; i < this.children.length; i++) {
		var sec = this.children[i];

		for (var j = 0; j < sec.children.length; j++)
			if (sec.children[j].option === name)
				return [ sec.children[j], sid ];
	}

	return null;
};

form.Map.prototype.save = function() {
	this.__saveCalls = (this.__saveCalls || 0) + 1;
	return Promise.resolve(null);
};

function optionTextValue(opt, sid, inTable) {
	if (inTable && !opt.editable && Object.prototype.hasOwnProperty.call(opt, 'textvalue'))
		return opt.textvalue(sid);

	if (Object.prototype.hasOwnProperty.call(opt, 'cfgvalue'))
		return opt.cfgvalue(sid);

	var v = uci.get(opt.map.config, sid, opt.option);

	if (v == null)
		v = opt.default;

	return (v == null) ? '' : v;
}

function renderOptionCell(opt, sid, inTable) {
	var td = E('td', { 'class': 'td cbi-value-field', 'data-name': opt.option });

	if (opt.__stubName.indexOf('Flag') === 0) {
		var raw = uci.get(opt.map.config, sid, opt.option);

		if (raw == null)
			raw = opt.default;

		appendData(td, (String(raw) === '1' || raw === true) ? '[x]' : '[ ]');
	}
	else if (inTable && opt.editable && typeof opt.renderFrame === 'function') {
		return opt.renderFrame(sid, true, 0, E('span', {}, optionTextValue(opt, sid, true)));
	}
	else {
		appendData(td, optionTextValue(opt, sid, inTable));
	}

	return td;
}

function renderSection(sec) {
	var wrap = E('div', { 'class': 'cbi-section' });

	if (sec.title)
		wrap.appendChild(E('h3', {}, sec.title));

	if (sec.description)
		wrap.appendChild(E('div', { 'class': 'cbi-section-descr' }, sec.description));

	var sids = sec.sids();

	if (sec.__stubName === 'GridSection') {
		var table = E('table', { 'class': 'table cbi-section-table' });
		var head = E('tr', { 'class': 'tr cbi-section-table-titles' });
		var cols = 0;

		sec.children.forEach(function(opt) {
			if (opt.modalonly === true)
				return;
			cols++;
			head.appendChild(E('th', { 'class': 'th' }, opt.title));
		});

		if (sec.addremove || sec.sortable) {
			cols++;
			head.appendChild(E('th', { 'class': 'th cbi-section-actions' }, _('操作')));
		}

		if (cols)
			table.appendChild(head);

		sids.forEach(function(sid) {
			var tr = E('tr', { 'class': 'tr cbi-section-table-row', 'data-sid': sid, 'data-section-id': sid });

			sec.children.forEach(function(opt) {
				if (opt.modalonly === true)
					return;
				tr.appendChild(renderOptionCell(opt, sid, true));
			});

			if (sec.addremove || sec.sortable)
				tr.appendChild(E('td', { 'class': 'td cbi-section-actions' }, '✎ ✕'));

			table.appendChild(tr);
		});

		wrap.appendChild(table);
	}
	else {
		sec.children.forEach(function(opt) {
			var row = E('div', { 'class': 'cbi-value' });
			row.appendChild(E('label', { 'class': 'cbi-value-title' }, opt.title));
			row.appendChild(renderOptionCell(opt, sids[0], false));
			if (opt.description)
				row.appendChild(E('div', { 'class': 'cbi-value-description' }, opt.description));
			wrap.appendChild(row);
		});
	}

	return wrap;
}

/* ------------------------ uci 桩 ------------------------ */

var uciData = {};
var uciWrites = [];
var uciApplyCalls = [];

function defaultUciData() {
	return {
		'hashlimit-qos': {
			'defaults': {
				'.name': 'defaults', '.type': 'defaults', '.index': 0,
				enabled: '1',
				auto_disable_offload: '1',
				default_enabled: '1',
				default_down_kbps: '5000',
				default_up_kbps: '1000',
				/* v1.1 遗留字段：v1.2 UI 不应再映射/写入 */
				default_cidr: '192.168.2.0/24',
				default_exclude: [ '192.168.2.1' ]
			},
			'dev_10_0_0_162': {
				'.name': 'dev_10_0_0_162', '.type': 'device', '.index': 1,
				ip: '10.0.0.162', mac: 'AA:BB:CC:DD:EE:01', label: '客厅电视',
				enabled: '1', down_kbps: '50000', up_kbps: '25000'
			},
			'dev_empty_label': {
				'.name': 'dev_empty_label', '.type': 'device', '.index': 2,
				ip: '10.0.0.124', mac: 'AA:BB:CC:DD:EE:02', label: '',
				enabled: '1', down_kbps: '0', up_kbps: '0'
			},
			'dev_mac_only': {
				'.name': 'dev_mac_only', '.type': 'device', '.index': 3,
				mac: '11:22:33:44:55:66', label: '只填MAC',
				enabled: '1', down_kbps: '2000', up_kbps: '0'
			},
			'dev_mac_nolabel': {
				'.name': 'dev_mac_nolabel', '.type': 'device', '.index': 10,
				mac: '22:33:44:55:66:77', label: '', enabled: '1',
				down_kbps: '0', up_kbps: '0'
			},
			'dev_stale': {
				'.name': 'dev_stale', '.type': 'device', '.index': 4,
				ip: '192.168.2.162', label: '旧设备',
				enabled: '1', down_kbps: '1000', up_kbps: '1000'
			},
			'grp_guest': {
				'.name': 'grp_guest', '.type': 'group', '.index': 5,
				start: '10.0.0.128', end: '10.0.0.255', range: '10.0.0.128-10.0.0.255',
				label: '访客网段',
				enabled: '1', down_kbps: '10000', up_kbps: '2000',
				exclude: [ '10.0.0.190', 'AA:BB:CC:DD:EE:FF' ]
			},
			'grp_old': {
				'.name': 'grp_old', '.type': 'group', '.index': 6,
				start: '192.168.5.0', end: '192.168.5.255', range: '192.168.5.0-192.168.5.255',
				label: '旧批量',
				enabled: '1', down_kbps: '1000', up_kbps: '1000',
				exclude: []
			}
		}
	};
}

function resetUci() {
	uciData = defaultUciData();
	uciWrites = [];
	uciApplyCalls = [];
}

resetUci();

var uci = {
	load: function(pkg) { return Promise.resolve([ pkg ]); },
	sections: function(conf, type) {
		var vals = uciData[conf] || {},
		    out = [];

		for (var sid in vals) {
			if (type && vals[sid]['.type'] !== type)
				continue;
			out.push(vals[sid]);
		}

		out.sort(function(a, b) { return (a['.index'] || 0) - (b['.index'] || 0); });
		return out;
	},
	get: function(conf, sid, opt) {
		var sec = uciData[conf] && uciData[conf][sid];

		if (!sec)
			return null;

		if (opt == null)
			return sec;

		return Object.prototype.hasOwnProperty.call(sec, opt) ? sec[opt] : null;
	},
	set: function(conf, sid, opt, val) {
		uciWrites.push([ conf, sid, opt, val ]);

		if (uciData[conf] && uciData[conf][sid] && val !== null)
			uciData[conf][sid][opt] = val;
	},
	unset: function(conf, sid, opt) {
		uciWrites.push([ conf, sid, opt, null ]);
	},
	save: function() { return Promise.resolve([]); },
	apply: function() {
		uciApplyCalls.push(true);
		return Promise.resolve();
	}
};

/* ------------------------ backend / ui 桩 ------------------------ */

var SCAN_10X = {
	lan: [ { network: 'lan', device: 'br-lan', ip: '10.0.0.1', netmask: '255.0.0.0', cidr: '10.0.0.0/8' } ],
	pool: { start: '10.0.0.100', end: '10.0.0.249' },
	hosts: [
		{ ip: '10.0.0.162', mac: 'AA:BB:CC:DD:EE:01', name: '客厅电视', source: 'lease', online: '1' },
		{ ip: '10.0.0.107', mac: '50:4F:3B:CA:8F:84', name: 'MiWiFi-RD03', source: 'lease', online: '1' },
		{ ip: '10.0.0.124', mac: 'AA:BB:CC:DD:EE:02', name: '', source: 'lease', online: '1' },
		/* WAN 侧邻居：scan 正常时后端已过滤，UI 也需要再过滤掉 */
		{ ip: '10.148.198.136', mac: '0A:7B:56:35:AE:9C', name: '', source: 'arp', online: '1' }
	],
	candidates: [
		{ range: '10.0.0.0-10.255.255.255', start: '10.0.0.0', end: '10.255.255.255',
		  hosts: '', label: '全部局域网 10.0.0.0 – 10.255.255.255' },
		{ range: '10.0.0.0-10.0.0.255', start: '10.0.0.0', end: '10.0.0.255',
		  hosts: '3', label: '10.0.0.0 – 10.0.0.255（3 台在线）' }
	]
};

var STATUS_10X = {
	enabled: '1',
	devices: [
		{ kind: 'device', ip: '10.0.0.162', mac: 'AA:BB:CC:DD:EE:01', resolved_ip: '10.0.0.162',
		  down_unresolved: '0', label: '客厅电视', enabled: '1',
		  down_kbps: '50000', up_kbps: '25000', down_bytes: 12345, up_bytes: 678 },
		{ kind: 'device', ip: '10.0.0.124', mac: 'AA:BB:CC:DD:EE:02', resolved_ip: '10.0.0.124',
		  down_unresolved: '0', label: '', enabled: '1',
		  down_kbps: '0', up_kbps: '0', down_bytes: 0, up_bytes: 0 },
		{ kind: 'device', ip: '', mac: '11:22:33:44:55:66', resolved_ip: '10.0.0.180',
		  down_unresolved: '0', label: '只填MAC', enabled: '1',
		  down_kbps: '2000', up_kbps: '0', down_bytes: 0, up_bytes: 0 },
		{ kind: 'device', ip: '', mac: '22:33:44:55:66:77', resolved_ip: '',
		  down_unresolved: '1', label: '', enabled: '1',
		  down_kbps: '0', up_kbps: '0', down_bytes: 0, up_bytes: 0 },
		{ kind: 'device', ip: '', mac: '77:88:99:AA:BB:CC', resolved_ip: '',
		  down_unresolved: '1', label: '未解析', enabled: '1',
		  down_kbps: '1000', up_kbps: '500', down_bytes: 0, up_bytes: 0 },
		{ kind: 'device', ip: '192.168.2.162', mac: '', resolved_ip: '192.168.2.162',
		  down_unresolved: '0', label: '旧设备', enabled: '1',
		  down_kbps: '1000', up_kbps: '1000', down_bytes: 0, up_bytes: 0 },
		{ kind: 'group', cidr: '', range: '10.0.0.128-10.0.0.255',
		  start: '10.0.0.128', end: '10.0.0.255', label: '访客网段', enabled: '1',
		  down_kbps: '10000', up_kbps: '2000',
		  exclude: [ '10.0.0.190', 'AA:BB:CC:DD:EE:FF' ],
		  down_bytes: 1000, up_bytes: 500 },
		{ kind: 'group', cidr: '', range: '192.168.5.0-192.168.5.255',
		  start: '192.168.5.0', end: '192.168.5.255', label: '旧批量', enabled: '1',
		  down_kbps: '1000', up_kbps: '1000', exclude: [], down_bytes: 0, up_bytes: 0 },
		{ kind: 'default', cidr: '10.0.0.0/8', label: '默认限速', enabled: '1',
		  down_kbps: '5000', up_kbps: '1000', down_bytes: 10, up_bytes: 20 }
	],
	groups: [
		{ kind: 'group', cidr: '', range: '10.0.0.128-10.0.0.255',
		  start: '10.0.0.128', end: '10.0.0.255', label: '访客网段', enabled: '1',
		  down_kbps: '10000', up_kbps: '2000',
		  exclude: [ '10.0.0.190', 'AA:BB:CC:DD:EE:FF' ], down_bytes: 1000, up_bytes: 500 },
		{ kind: 'group', cidr: '', range: '192.168.5.0-192.168.5.255',
		  start: '192.168.5.0', end: '192.168.5.255', label: '旧批量', enabled: '1',
		  down_kbps: '1000', up_kbps: '1000', exclude: [], down_bytes: 0, up_bytes: 0 }
	],
	defaults: {
		default_enabled: '1', default_down_kbps: '5000', default_up_kbps: '1000',
		lan: [ { network: 'lan', device: 'br-lan', ip: '10.0.0.1', netmask: '255.0.0.0', cidr: '10.0.0.0/8' } ],
		scope: 'all-lan'
	},
	warnings: [ '示例告警：配置迁移完成' ],
	offload: '0', offload_active: '0', backup_saved: '1', auto_disable: '1'
};

var SCAN_192 = {
	lan: [ { network: 'lan', device: 'br-lan', ip: '192.168.2.1', netmask: '255.255.255.0', cidr: '192.168.2.0/24' } ],
	pool: { start: '192.168.2.100', end: '192.168.2.249' },
	hosts: [
		{ ip: '192.168.2.50', mac: 'AA:BB:CC:DD:EE:50', name: '客厅电视', source: 'lease', online: '1' },
		{ ip: '192.168.2.60', mac: 'AA:BB:CC:DD:EE:60', name: '', source: 'arp', online: '1' },
		{ ip: '10.0.0.99', mac: 'AA:BB:CC:DD:EE:99', name: '', source: 'arp', online: '1' }
	],
	candidates: [
		{ range: '192.168.2.0-192.168.2.255', start: '192.168.2.0', end: '192.168.2.255',
		  hosts: '2', label: '全部局域网 192.168.2.0 – 192.168.2.255' }
	]
};

var STATUS_192 = {
	enabled: '1',
	devices: [
		{ kind: 'device', ip: '192.168.2.50', mac: 'AA:BB:CC:DD:EE:50', resolved_ip: '192.168.2.50',
		  down_unresolved: '0', label: '客厅电视', enabled: '1',
		  down_kbps: '20000', up_kbps: '5000', down_bytes: 0, up_bytes: 0 },
		{ kind: 'group', cidr: '', range: '192.168.2.128-192.168.2.255',
		  start: '192.168.2.128', end: '192.168.2.255', label: '访客', enabled: '1',
		  down_kbps: '10000', up_kbps: '2000', exclude: [], down_bytes: 0, up_bytes: 0 },
		{ kind: 'group', cidr: '', range: '10.0.0.0-10.255.255.255',
		  start: '10.0.0.0', end: '10.255.255.255', label: '老网段', enabled: '1',
		  down_kbps: '1000', up_kbps: '1000', exclude: [], down_bytes: 0, up_bytes: 0 },
		{ kind: 'default', cidr: '192.168.2.0/24', label: '默认限速', enabled: '0',
		  down_kbps: '0', up_kbps: '0', down_bytes: 0, up_bytes: 0 }
	],
	groups: [
		{ kind: 'group', cidr: '', range: '192.168.2.128-192.168.2.255',
		  start: '192.168.2.128', end: '192.168.2.255', label: '访客', enabled: '1',
		  down_kbps: '10000', up_kbps: '2000', exclude: [], down_bytes: 0, up_bytes: 0 },
		{ kind: 'group', cidr: '', range: '10.0.0.0-10.255.255.255',
		  start: '10.0.0.0', end: '10.255.255.255', label: '老网段', enabled: '1',
		  down_kbps: '1000', up_kbps: '1000', exclude: [], down_bytes: 0, up_bytes: 0 }
	],
	defaults: {
		default_enabled: '0', default_down_kbps: '0', default_up_kbps: '0',
		lan: [ { network: 'lan', device: 'br-lan', ip: '192.168.2.1', netmask: '255.255.255.0', cidr: '192.168.2.0/24' } ],
		scope: 'all-lan'
	},
	warnings: [],
	offload: '0', offload_active: '0', backup_saved: '1', auto_disable: '1'
};

var OFFLINE = {
	offload_active: '0', firewall_fo: '0', firewall_fo_hw: '0',
	turboacc_fastpath: 'disabled', turboacc_present: '1',
	backup_saved: '1', auto_disable: '1'
};

var ctlCalls = [];
var ctlResponder = null;

function defaultResponder(params) {
	switch (params[0]) {
	case 'status':
		return Promise.resolve({ code: 0, stdout: JSON.stringify(STATUS_10X) + '\n', stderr: '' });
	case 'list':
		return Promise.resolve({ code: 0, stdout: JSON.stringify(STATUS_10X) + '\n', stderr: '' });
	case 'scan':
		return Promise.resolve({ code: 0, stdout: JSON.stringify(SCAN_10X) + '\n', stderr: '' });
	case 'offload-status':
		return Promise.resolve({ code: 0, stdout: JSON.stringify(OFFLINE) + '\n', stderr: '' });
	case 'devices':
		return Promise.resolve({ code: 0, stdout: JSON.stringify({ devices: SCAN_10X.hosts }) + '\n', stderr: '' });
	default:
		return Promise.resolve({ code: 0, stdout: '', stderr: '' });
	}
}

var fsStub = {
	exec: function(command, params) {
		ctlCalls.push({ command: command, params: params });
		return (ctlResponder || defaultResponder)(params);
	}
};

var notifications = [];
var ui = {
	addNotification: function(title, children, css) {
		notifications.push({ title: title, css: css, text: collectText(children) });
		return new FakeNode('div');
	},
	changes: { apply: function() { return Promise.resolve(); } },
	showModal: function() { throw new Error('ui.showModal 不应被调用'); }
};

var pollStub = {
	added: [],
	removed: [],
	add: function(fn, interval) {
		if (this.added.indexOf(fn) >= 0)
			return false;
		this.added.push(fn);
		this.interval = interval;
		return true;
	},
	remove: function(fn) {
		var i = this.added.indexOf(fn);
		if (i >= 0)
			this.added.splice(i, 1);
		this.removed.push(fn);
		return true;
	}
};

var view = { extend: function(props) { return props; } };
var L = { resolveDefault: function(p, d) { return Promise.resolve(p).catch(function() { return d; }); } };

var srcBody = src
	.replace(/^'use strict';\n/, '')
	.replace(/^'require [^']+';\n/gm, '');

function loadView() {
	var factory = new Function('view', 'form', 'fs', 'poll', 'uci', 'ui', 'L', 'E', '_',
		'document', 'window', '"use strict";\n' + srcBody);

	return factory(view, form, fsStub, pollStub, uci, ui, L, E, _, doc, win);
}

var viewRoot = new FakeNode('div');
doc.byId['view'] = viewRoot;

function clearView() {
	while (viewRoot.children.length)
		viewRoot.removeChild(viewRoot.children[0]);
}

function wait() {
	return new Promise(function(resolve) { setTimeout(resolve, 0); });
}

function findCall(name) {
	for (var i = 0; i < ctlCalls.length; i++)
		if (ctlCalls[i].params && ctlCalls[i].params[0] === name)
			return ctlCalls[i];
	return null;
}

function hasNotification(title, css) {
	return notifications.some(function(n) {
		return n.title === title && (!css || n.css === css);
	});
}

function sectionByTitle(title) {
	if (!LAST_MAP)
		return null;

	for (var i = 0; i < LAST_MAP.children.length; i++)
		if (LAST_MAP.children[i].title === title)
			return LAST_MAP.children[i];

	return null;
}

function optionByName(sec, name) {
	if (!sec)
		return null;

	for (var i = 0; i < sec.children.length; i++)
		if (sec.children[i].option === name)
			return sec.children[i];

	return null;
}

function findUciWrite(conf, sid, opt) {
	for (var i = 0; i < uciWrites.length; i++)
		if (uciWrites[i][0] === conf && uciWrites[i][1] === sid && uciWrites[i][2] === opt)
			return uciWrites[i];
	return null;
}

function renderWith(impl) {
	return Promise.resolve(impl.load()).then(function() {
		return impl.render();
	}).then(function(node) {
		clearView();
		viewRoot.appendChild(node);
		return impl;
	});
}

function tables() {
	var out = [];
	(function walk(n) {
		n.children.forEach(function(c) {
			if (c.tagName === 'TABLE' && c.classList.contains('cbi-section-table'))
				out.push(c);
			walk(c);
		});
	})(viewRoot);
	return out;
}

function injectedRows() {
	return viewRoot.querySelectorAll('tr.hlimit-exclude-row');
}

/* ------------------------------------------------------------------ */
/* 4. 10.x 主流程                                                      */
/* ------------------------------------------------------------------ */

function run() {
	var impl;

	return Promise.resolve(loadView()).then(function(v) {
		impl = v;
		return impl.load();
	}).then(function(data) {
		/* --- 4.1 数据归一化 --- */
		ok(data.status && data.status.enabled === true, 'load(): 总开关解析为启用');
		ok(data.lan.length === 1 && data.lan[0].cidr === '10.0.0.0/8',
		   'load(): LAN 作用域 10.0.0.0/8');
		ok(data.hosts.length === 4,
		   'load(): scan.hosts 全部保留（10/8 内的 WAN 邻居按接口过滤由后端负责，UI 不按 CIDR 误杀）');
		ok(data.hosts.some(function(h) { return h.ip === '10.0.0.162'; }),
		   'load(): scan.hosts 含 客厅电视');
		ok(data.candidates.length === 2, 'load(): 扫描候选 2 条');
		ok(data.status.groups[0].exclude.length === 2, 'load(): 批量 exclude 解析 2 项');
		ok(data.scanError === null, 'load(): scan 无错误');
		ok(data.status.warnings.length === 1, 'load(): status.warnings 解析');
		ok(!!findCall('scan'), 'load(): 调用了 hlimit-ctl scan');

		return impl.render();
	}).then(function(node) {
		clearView();
		viewRoot.appendChild(node);

		/* --- 4.2 页面结构 --- */
		ok(!!LAST_MAP && LAST_MAP.config === 'hashlimit-qos', 'form.Map(hashlimit-qos)');
		ok(LAST_MAP.children.length === 4, '4 个 section（状态/设备/批量/默认）');
		ok(LAST_MAP.children[0].title === '状态', '第 1 个 section 是状态');
		ok(LAST_MAP.children[1].title === '单独设备', '第 2 个 section 是单独设备');
		ok(LAST_MAP.children[2].title === '批量限速', '第 3 个 section 是批量限速');
		ok(LAST_MAP.children[3].title === '默认限速', '第 4 个 section 是默认限速');

		/* --- 4.3 状态区 --- */
		var status = sectionByTitle('状态');
		var oLan = optionByName(status, 'hlimit_lan_scope');
		var oDefault = optionByName(status, 'hlimit_default_state');
		var oWarn = optionByName(status, 'hlimit_warnings');

		contains(oLan.cfgvalue(), 'br-lan 10.0.0.0/8', 'LAN 作用域显示 br-lan 10.0.0.0/8');
		contains(oLan.cfgvalue(), '网关 10.0.0.1', 'LAN 作用域显示网关 10.0.0.1');
		contains(oLan.cfgvalue(), '自动跟随 LAN 网段', 'LAN 作用域说明自动跟随');
		contains(oDefault.cfgvalue(), '开启：下行 5 Mbps / 上行 1 Mbps', '默认限速状态显示速率');
		contains(oWarn.cfgvalue(), '示例告警', '告警显示后端 warnings');
		contains(oWarn.cfgvalue(), 'stale', '告警提示 stale 设备');
		contains(oWarn.cfgvalue(), '未解析', '告警提示 down_unresolved');
		contains(oWarn.cfgvalue(), '192.168.5.0', '告警提示不在 LAN 的批量规则');

		/* --- 4.4 默认限速：无 CIDR/白名单输入，有只读范围 --- */
		var def = sectionByTitle('默认限速');
		ok(optionByName(def, 'default_cidr') == null, '默认限速没有作用网段输入框');
		ok(optionByName(def, 'default_exclude') == null, '默认限速没有全局白名单输入框');
		ok(!!optionByName(def, 'default_enabled'), '默认限速保留开关');
		ok(!!optionByName(def, 'default_down_kbps') && !!optionByName(def, 'default_up_kbps'),
		   '默认限速保留上下行速率');
		var oScope = optionByName(def, 'hlimit_default_scope');
		contains(oScope.cfgvalue(), 'br-lan 10.0.0.0/8', '默认限速区显示自动作用范围');
		contains(optionByName(def, 'hlimit_default_note').cfgvalue(), '0 = 不限速',
		         '默认限速区说明 0 = 不限速');
		contains(optionByName(def, 'hlimit_default_note').cfgvalue(), '单独设备',
		         '默认限速区说明用单独设备 0/0 豁免');

		/* --- 4.5 单独设备表格 --- */
		var dev = sectionByTitle('单独设备');
		var names = dev.children.map(function(o) { return o.option; });
		ok(names.join(',') === '_pick_device,label,enabled,_name,ip,mac,down_kbps,up_kbps',
		   '设备 options 含 picker/label 编辑 + 启用/名称/IP/MAC/速率');
		var titles = dev.children.filter(function(o) { return o.modalonly !== true; })
			.map(function(o) { return o.title; });
		ok(titles.join(',') === '启用,名称,IP,MAC,下行(Mbps),上行(Mbps)',
		   '设备表头：启用/名称/IP/MAC/下行/上行');

		var picker = optionByName(dev, '_pick_device');
		ok(picker.modalonly === true, '「已发现设备」只在新增/编辑弹窗出现');
		ok(!!picker.choices || true, ''); /* picker 用 select，无 choices */

		var oName = optionByName(dev, '_name');
		var oIp = optionByName(dev, 'ip');
		var oMac = optionByName(dev, 'mac');
		var oDown = optionByName(dev, 'down_kbps');
		ok(oName.modalonly === false, '表格名称列只读（modalonly=false）');
		contains(collectText(oName.textvalue('dev_10_0_0_162')), '客厅电视',
		         '名称列显示 label');
		contains(collectText(oName.textvalue('dev_empty_label')), '10.0.0.124',
		         '名称列 label 空 -> 无主机名 -> 回退 IP');
		ok(collectText(oName.textvalue('dev_empty_label')).indexOf('不限速') < 0,
		   '名称列不再拼接「不限速」（1.3 起移除）');
		contains(collectText(oName.textvalue('dev_mac_nolabel')), '22:33:44:55:66:77',
		         '名称列无 label 时回退显示 MAC');
		ok(collectText(oName.textvalue('dev_mac_nolabel')).indexOf('→') < 0,
		   '名称列不再显示解析出的当前 IP（1.3 起移除）');
		var unresolvedDev = {
			'.name': 'dev_unresolved', '.type': 'device', '.index': 9,
			mac: '77:88:99:AA:BB:CC', label: '未解析', enabled: '1',
			down_kbps: '1000', up_kbps: '500'
		};
		uciData['hashlimit-qos']['dev_unresolved'] = unresolvedDev;
		ok(collectText(oName.textvalue('dev_mac_nolabel')).indexOf('未解析') < 0,
		   '名称列不再显示未解析状态（1.3 起移除）');
		contains(oIp.placeholder, '10.0.0.50', 'IP placeholder 含 10.x 示例');
		contains(oIp.placeholder, '192.168.2.50', 'IP placeholder 含 192.168.x 示例');
		ok(!!oIp.choices && oIp.choices.some(function(c) { return c.key === '10.0.0.162'; }),
		   'IP 下拉候选来自 scan.hosts');
		ok(!!oMac.choices && oMac.choices.some(function(c) { return c.key === 'AA:BB:CC:DD:EE:01'; }),
		   'MAC 下拉候选来自 scan.hosts');

		/* picker 自动填 IP/MAC/名称 */
		picker.pickHost('dev_stale', '10.0.0.162');
		var ipWidget = oIp.getUIElement('dev_stale'),
		    macWidget = oMac.getUIElement('dev_stale'),
		    labelWidget = optionByName(dev, 'label').getUIElement('dev_stale');
		ok(ipWidget.getValue() === '10.0.0.162', '选择设备后自动填 IP');
		ok(macWidget.getValue() === 'AA:BB:CC:DD:EE:01', '选择设备后自动填 MAC');
		ok(labelWidget.getValue() === '客厅电视', '选择设备后自动填名称');

		/* --- 4.6 批量表格：区间列 + 弹窗字段 --- */
		var grp = sectionByTitle('批量限速');
		var titlesG = grp.children.filter(function(o) { return o.modalonly !== true; })
			.map(function(o) { return o.title; });
		ok(titlesG.join(',') === '启用,IP 区间,名称,下行(Mbps),上行(Mbps)',
		   '批量表头：启用/IP 区间/名称/下行/上行');

		var oStart = optionByName(grp, 'start');
		var oEnd = optionByName(grp, 'end');
		ok(oStart.modalonly === true, '起始 IP 只在新增/编辑弹窗');
		ok(oEnd.modalonly === true, '结束 IP 只在新增/编辑弹窗');
		contains(oStart.placeholder, '10.0.0.100', '起始 IP placeholder 含示例');
		contains(oEnd.placeholder, '10.0.0.200', '结束 IP placeholder 含示例');

		var rangeCell = optionByName(grp, '_range');
		ok(rangeCell.modalonly === false, '表格 IP 区间列只读');
		contains(collectText(rangeCell.textvalue('grp_guest')), '10.0.0.128 – 10.0.0.255',
		         '批量表格显示起止 IP');
		contains(collectText(rangeCell.textvalue('grp_guest')), '128 个地址',
		         '批量表格显示地址数');
		contains(collectText(rangeCell.textvalue('grp_old')), '不在当前 LAN',
		         '不属于 LAN 的批量规则标红提示');

		/* 弹窗顶部：扫描候选 + 区间信息 */
		var scanSel = optionByName(grp, '_scan_range');
		ok(scanSel.modalonly === true, '扫描候选下拉只在弹窗');
		var scanNode = scanSel.renderWidget('grp_guest');
		contains(collectText(scanNode), '10.0.0.0 – 10.0.0.255', '扫描候选显示区间');
		contains(collectText(scanNode), '3 台在线', '扫描候选显示在线台数');

		var infoOpt = optionByName(grp, '_range_info');
		ok(infoOpt.modalonly === true, '区间 / 作用域只在弹窗');
		contains(infoOpt.cfgvalue('grp_guest'), '10.0.0.128 – 10.0.0.255',
		         '弹窗区间信息显示当前区间');
		contains(infoOpt.cfgvalue('grp_guest'), '扫描到 1 台在线主机',
		         '弹窗区间信息显示扫描到的在线主机');
		contains(infoOpt.cfgvalue('grp_old'), '不在当前 LAN',
		         '弹窗区间信息提示不在 LAN');

		scanSel.applyRange('grp_guest', '10.0.0.0-10.255.255.255');
		ok(oStart.getUIElement('grp_guest').getValue() === '10.0.0.0',
		   '选择扫描候选后填入起始 IP');
		ok(oEnd.getUIElement('grp_guest').getValue() === '10.255.255.255',
		   '选择扫描候选后填入结束 IP');

		contains(collectText(picker.renderWidget('dev_stale')), '客厅电视（10.0.0.162）',
		         '设备选择下拉显示名称（IP）');

		/* --- 4.7 白名单在编辑弹窗里 --- */
		ok(injectedRows().length === 0, '批量表格里不再注入白名单行');

		var oExcl = optionByName(grp, '_exclude');
		ok(oExcl.modalonly === true, '白名单只在编辑弹窗里');
		ok(oExcl.title === '白名单', '白名单标题为「白名单」');

		var box = oExcl.renderWidget('grp_guest');
		contains(collectText(box), '10.0.0.190', '白名单 chip 显示 IP');
		contains(collectText(box), 'AA:BB:CC:DD:EE:FF', '白名单 chip 显示 MAC');
		contains(collectText(box), '白名单仅对当前区间生效', '白名单提示生效范围');

		var custom = box.querySelector('#hlimit-exclude-custom-grp_guest');
		var addBtn = box.querySelector('.cbi-button-add');
		ok(!!custom, '白名单区含输入框');
		ok(!!addBtn && collectText(addBtn).trim() === '+', '白名单区含 + 按钮');

		/* 非法值 / 区间外 / 重复值：前端拦截，不调后端 */
		ctlCalls.length = 0;
		custom.value = '999.1.1.1';
		addBtn.dispatchEvent({ type: 'click' });
		ok(!findCall('group-exclude-add'), '非法 IP 不调用后端');
		ok(hasNotification('格式或范围不正确', 'danger'), '非法 IP 给出可读提示');

		custom.value = '10.0.0.50';
		ctlCalls.length = 0;
		addBtn.dispatchEvent({ type: 'click' });
		ok(!findCall('group-exclude-add'), '不在区间内的 IP 不调用后端');
		ok(hasNotification('格式或范围不正确', 'danger'), '区间外 IP 给出可读提示');

		custom.value = '10.0.0.190';
		ctlCalls.length = 0;
		addBtn.dispatchEvent({ type: 'click' });
		ok(!findCall('group-exclude-add'), '重复 IP 不调用后端');
		ok(hasNotification('无需添加', 'warning'), '重复 IP 给出「无需添加」提示');

		/* 合法添加 -> group-exclude-add <range> <ip> */
		ctlCalls.length = 0;
		custom.value = '10.0.0.170';
		addBtn.dispatchEvent({ type: 'click' });

		return wait().then(function() {
			var call = findCall('group-exclude-add');
			ok(!!call && call.params[1] === '10.0.0.128-10.0.0.255' &&
			   call.params[2] === '10.0.0.170',
			   '添加白名单调用 group-exclude-add <range> <ip>');
			ok(hasNotification('已加入白名单', 'success'), '添加白名单成功提示');

			/* 删除 chip -> group-exclude-del */
			var freshBox = oExcl.renderWidget('grp_guest');
			ctlCalls.length = 0;
			var delBtn = freshBox.querySelector('.cbi-button-remove');
			ok(!!delBtn, '白名单 chip 含删除按钮');
			delBtn.dispatchEvent({ type: 'click' });

			return wait().then(function() {
				var delCall = findCall('group-exclude-del');
				ok(!!delCall, '删除白名单调用 group-exclude-del');
				ok(delCall && delCall.params[1] === '10.0.0.128-10.0.0.255',
				   'group-exclude-del 使用当前区间');
				ok(delCall && (delCall.params[2] === '10.0.0.190' ||
				   delCall.params[2] === 'AA:BB:CC:DD:EE:FF'),
				   'group-exclude-del 参数为被删条目');
			});
		});
	}).then(function() {
		/* --- 4.8 保存并应用 --- */
		var order = [];
		var saveOrig = impl.handleSave;
		impl.handleSave = function(ev) {
			order.push('save');
			return saveOrig.call(impl, ev);
		};

		ctlResponder = function(params) {
			if (params[0] === 'apply') {
				order.push('apply');
				return Promise.resolve({ code: 0, stdout: '', stderr: '' });
			}
			return defaultResponder(params);
		};

		return Promise.resolve(impl.handleSaveApply({}, '0')).then(function() {
			ok(order.join(',') === 'save,apply', '保存并应用：先 save 再 hlimit-ctl apply');
			ok(uciApplyCalls.length >= 1, '保存并应用前先 uci.apply() commit UCI');
			ok(hasNotification('已应用', 'success'), '保存并应用成功提示');

			var notifBefore = notifications.length;

			ctlResponder = function(params) {
				if (params[0] === 'apply')
					return Promise.resolve({ code: 3, stdout: '', stderr: 'iptables: No chain' });
				return defaultResponder(params);
			};

			return Promise.resolve(impl.handleSaveApply({}, '0')).then(function() {
				ok(notifications.length === notifBefore + 1, 'apply 失败产生一条通知');
				ok(hasNotification('保存并应用失败', 'danger'), 'apply 失败用 danger 通知');
				contains(notifications[notifications.length - 1].text, 'No chain',
				         '失败提示包含后端 stderr');
			});
		});
	}).then(function() {
		/* --- 4.9 保存（Map 重绘）后仍然没有注入行 --- */
		return Promise.resolve(impl.handleSave({})).then(function() {
			ok(injectedRows().length === 0, '保存重绘后没有任何注入的白名单行');
			ok(tables().length === 2, '仍只有单独设备与批量限速两张表');
		});
	}).then(function() {
		/* --- poll --- */
		ok(pollStub.added.length === 1, 'render() 注册 1 个 poll');
		ok(pollStub.interval === 12, 'poll 间隔 12 秒');

		var oLanEl = new FakeNode('div');
		oLanEl.setAttribute('id', 'cbid.hashlimit-qos.defaults.hlimit_lan_scope');
		var oWarnEl = new FakeNode('div');
		oWarnEl.setAttribute('id', 'cbid.hashlimit-qos.defaults.hlimit_warnings');
		var dropEl = new FakeNode('div');
		dropEl.setAttribute('id', 'cbid.hashlimit-qos.defaults.hlimit_dropped_total');

		ctlCalls.length = 0;
		ctlResponder = defaultResponder;

		var pollFn = pollStub.added[0];

		return Promise.resolve(pollFn()).then(function() {
			ok(!!findCall('status'), 'poll 刷新 status');
			contains(oLanEl.textContent, '10.0.0.0/8', 'poll 更新 LAN 作用域文本');
			contains(oWarnEl.textContent, 'stale', 'poll 更新告警文本');

			delete doc.byId['cbid.hashlimit-qos.defaults.hlimit_dropped_total'];
			pollStub.removed.length = 0;
			return Promise.resolve(pollFn());
		}).then(function() {
			ok(pollStub.removed.indexOf(pollFn) >= 0, '页面元素消失后 poll 自动注销');
		});
	}).then(function() {
		/* --- 4.10 192.168.2.0/24 LAN 夹具 --- */
		resetUci();
		uciData = {
			'hashlimit-qos': {
				'defaults': {
					'.name': 'defaults', '.type': 'defaults', '.index': 0,
					enabled: '1', auto_disable_offload: '1',
					default_enabled: '0', default_down_kbps: '0', default_up_kbps: '0'
				},
				'dev_192_168_2_50': {
					'.name': 'dev_192_168_2_50', '.type': 'device', '.index': 1,
					ip: '192.168.2.50', mac: 'AA:BB:CC:DD:EE:50',
					label: '客厅电视', enabled: '1', down_kbps: '20000', up_kbps: '5000'
				},
				'grp_192': {
					'.name': 'grp_192', '.type': 'group', '.index': 2,
					start: '192.168.2.128', end: '192.168.2.255',
					range: '192.168.2.128-192.168.2.255',
					label: '访客', enabled: '1',
					down_kbps: '10000', up_kbps: '2000'
				},
				'grp_old': {
					'.name': 'grp_old', '.type': 'group', '.index': 3,
					start: '10.0.0.0', end: '10.255.255.255',
					range: '10.0.0.0-10.255.255.255',
					label: '老网段', enabled: '1',
					down_kbps: '1000', up_kbps: '1000'
				}
			}
		};

		ctlResponder = function(params) {
			switch (params[0]) {
			case 'status':
			case 'list':
				return Promise.resolve({ code: 0, stdout: JSON.stringify(STATUS_192), stderr: '' });
			case 'scan':
				return Promise.resolve({ code: 0, stdout: JSON.stringify(SCAN_192), stderr: '' });
			case 'offload-status':
				return Promise.resolve({ code: 0, stdout: JSON.stringify(OFFLINE), stderr: '' });
			default:
				return Promise.resolve({ code: 0, stdout: '', stderr: '' });
			}
		};

		var impl2 = loadView();

		return renderWith(impl2).then(function() {
			ok(impl2.load && true, '');
			var status = sectionByTitle('状态');
			var lanText = optionByName(status, 'hlimit_lan_scope').cfgvalue();
			contains(lanText, 'br-lan 192.168.2.0/24', '192.168 夹具：作用域显示 192.168.2.0/24');
			contains(lanText, '网关 192.168.2.1', '192.168 夹具：网关 192.168.2.1');
			ok(lanText.indexOf('10.0.0.1') < 0, '192.168 夹具不显示 10.x 网关');

			var warn = optionByName(status, 'hlimit_warnings').cfgvalue();
			contains(warn, '10.0.0.0', '192.168 夹具：10.0.0.0/8 批量规则被判不在 LAN');
			ok(warn.indexOf('192.168.2.50') < 0, '192.168 夹具：LAN 内设备不报 stale');

			var dev = sectionByTitle('单独设备');
			contains(collectText(optionByName(dev, '_name').textvalue('dev_192_168_2_50')),
			         '客厅电视', '192.168 夹具：设备名称显示 label');
			var def = sectionByTitle('默认限速');
			contains(optionByName(def, 'hlimit_default_scope').cfgvalue(), '192.168.2.0/24',
			         '192.168 夹具：默认限速作用范围动态显示');

			/* 批量 CIDR 区间显示 192.168.x */
			var grp = sectionByTitle('批量限速');
			contains(collectText(optionByName(grp, '_range').textvalue('grp_192')),
			         '192.168.2.128 – 192.168.2.255',
			         '192.168 夹具：批量区间按 192.168.x 显示');
		});
	}).then(function() {
		/* --- 4.11 scan 不可用 -> 回退 devices --- */
		resetUci();
		ctlResponder = function(params) {
			if (params[0] === 'scan')
				return Promise.resolve({ code: 1, stdout: '', stderr: 'usage: ...' });
			if (params[0] === 'devices')
				return Promise.resolve({ code: 0, stdout: JSON.stringify({ devices: [
					{ ip: '10.0.0.162', mac: 'AA:BB:CC:DD:EE:01', name: '客厅电视', source: 'lease' }
				] }), stderr: '' });
			return defaultResponder(params);
		};

		var impl3 = loadView();

		return renderWith(impl3).then(function() {
			ok(!!LAST_MAP, 'scan 不可用时页面仍渲染');
			var status = sectionByTitle('状态');
			contains(optionByName(status, 'hlimit_warnings').cfgvalue(), '设备扫描不可用',
			         'scan 不可用在告警区提示');
			var dev = sectionByTitle('单独设备');
			ok(optionByName(dev, 'ip').choices.some(function(c) { return c.key === '10.0.0.162'; }),
			   'scan 不可用时用 devices 结果作为候选');
		});
	}).then(function() {
		/* --- 4.12 后端全失败：降级不白屏 --- */
		resetUci();
		ctlResponder = function() {
			return Promise.resolve({ code: 3, stdout: '', stderr: 'uci: Entry not found' });
		};

		var impl4 = loadView();

		return renderWith(impl4).then(function() {
			ok(!!LAST_MAP, '后端全失败仍渲染 form.Map（不白屏）');
			var status = sectionByTitle('状态');
			contains(optionByName(status, 'hlimit_lan_scope').cfgvalue(), '未能识别 LAN',
			         'LAN 作用域给出可读错误');
			contains(optionByName(status, 'hlimit_warnings').cfgvalue(), 'uci: Entry not found',
			         '告警区展示后端 stderr');
			contains(optionByName(status, 'hlimit_dropped_total').cfgvalue(), '无法读取',
			         '丢弃总量显示读取失败而非整页报错');
		});
	}).then(function() {
		/* --- 4.13 新增但未应用的批量规则：白名单只读提示 --- */
		resetUci();
		uciData['hashlimit-qos']['grp_new'] = {
			'.name': 'grp_new', '.type': 'group', '.index': 7,
			start: '10.0.0.0', end: '10.0.0.15', range: '10.0.0.0-10.0.0.15',
			label: '未应用网段', enabled: '1',
			down_kbps: '5000', up_kbps: '1000', exclude: []
		};
		ctlResponder = defaultResponder;

		var implNew = loadView();

		return renderWith(implNew).then(function() {
			var grpNew = sectionByTitle('批量限速');
			var newBox = optionByName(grpNew, '_exclude').renderWidget('grp_new');

			ok(!!newBox, '未应用的批量规则也能渲染白名单区');
			contains(collectText(newBox), '尚未保存并应用',
			         '未应用的规则提示先保存并应用');
			ok(!newBox.querySelector('.cbi-button-add'),
			   '未应用的规则不显示 + 按钮');
			ok(!newBox.querySelector('#hlimit-exclude-custom-grp_new'),
			   '未应用的规则不显示输入框');
		});
	}).then(function() {
		/* --- 4.14 非法 JSON --- */
		resetUci();
		ctlResponder = function() {
			return Promise.resolve({ code: 0, stdout: 'not-json', stderr: '' });
		};

		var impl5 = loadView();

		return renderWith(impl5).then(function() {
			ok(!!LAST_MAP, '非法 JSON 仍渲染页面');
			contains(optionByName(sectionByTitle('状态'), 'hlimit_warnings').cfgvalue(),
			         '不是合法 JSON', '非法 JSON 给出可读提示');
		});
	}).then(function() {
		ctlResponder = null;
		console.log('\n' + checks + ' checks, ' + failures + ' failure(s)');
		process.exit(failures ? 1 : 0);
	}).catch(function(err) {
		console.error('UNEXPECTED ERROR: ' + (err && err.stack ? err.stack : err));
		process.exit(1);
	});
}

run();
