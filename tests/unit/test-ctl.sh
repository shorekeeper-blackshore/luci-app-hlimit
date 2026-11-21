#!/bin/sh
# ---------------------------------------------------------------------------
# test-ctl.sh - host-side unit tests for the luci-app-hlimit 1.2 backend.
#
# No router required: `uci`, `iptables` and `logger` are replaced by the stubs
# in tests/unit/stubs/.  Two LAN fixtures are used:
#   * 10.0.0.1/8    (the reference device: WAN 10.148.0.0/14 overlaps the LAN)
#   * 192.168.2.1/24 (generic /24 LAN, exercises "any private IPv4 prefix")
#
# Run:  sh tests/unit/test-ctl.sh        (dash)
#       dash tests/unit/test-ctl.sh
#       (busybox ash is used for a second run of the whole suite)
# ---------------------------------------------------------------------------
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)
CTL=${HLIMIT_CTL:-$ROOT/files/usr/sbin/hlimit-ctl}
STUBS=$HERE/stubs
PATH=$STUBS:$PATH
export PATH

TMPBASE=$(mktemp -d "${TMPDIR:-/tmp}/hlimit-unit.XXXXXX")
trap 'rm -rf "$TMPBASE"' EXIT INT TERM

PASS=0
FAIL=0
ENV_N=0
CURRENT_SHELL=sh
E=$TMPBASE
RC=0
OUT=
ERR=
HLIMIT_VER=$(sed -n 's/^VERSION=//p' "$CTL" | head -n 1)
export HLIMIT_VER

pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL [%s] %s\n' "$CURRENT_SHELL" "$*"; }
section() { printf '\n-- %s\n' "$*"; }

assert_rc() {
	if [ "$RC" -eq "$2" ]; then pass; else fail "$1: exit=$RC want=$2 (stderr: $ERR)"; fi
}

assert_eq() {
	if [ "$2" = "$3" ]; then pass; else fail "$1: got [$3] want [$2]"; fi
}

assert_contains() {
	if grep -qF -- "$2" "$3" 2>/dev/null; then pass; else fail "$1: missing [$2] in $3"; fi
}

assert_not_contains() {
	if grep -qF -- "$2" "$3" 2>/dev/null; then fail "$1: unexpected [$2] in $3"; else pass; fi
}

assert_count() {
	_n=$(grep -cF -- "$2" "$3" 2>/dev/null || true)
	[ -n "$_n" ] || _n=0
	if [ "$_n" -eq "$4" ]; then pass; else fail "$1: [$2] occurs $_n times, want $4"; fi
}

assert_before() { # desc needle_before needle_after file
	n1=$(grep -nF -- "$2" "$4" 2>/dev/null | head -n 1 | cut -d: -f1)
	n2=$(grep -nF -- "$3" "$4" 2>/dev/null | head -n 1 | cut -d: -f1)
	if [ -n "$n1" ] && [ -n "$n2" ] && [ "$n1" -lt "$n2" ]; then
		pass
	else
		fail "$1: [$2]@${n1:-none} is not before [$3]@${n2:-none}"
	fi
}

if [ ! -f "$CTL" ]; then
	printf 'ERROR: hlimit-ctl not found at %s\n' "$CTL" >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# environment helpers
# ---------------------------------------------------------------------------

uci_add() { printf '%s\n' "$1" >>"$UCI_STUB_STATE"; }
uci_put() { uci -q set "$1"; }

new_env() {
	ENV_N=$((ENV_N + 1))
	E=$TMPBASE/env.$ENV_N
	mkdir -p "$E/ipt"
	UCI_STUB_STATE=$E/uci.state
	UCI_STUB_LOG=$E/uci.log
	IPT_STUB_DIR=$E/ipt
	HLIMIT_OFFLOAD_LOCK=$E/offload.lock
	LOGGER_LOG=$E/logger.log
	HLIMIT_LEASES=$E/leases
	HLIMIT_ARP=$E/arp
	export UCI_STUB_STATE UCI_STUB_LOG IPT_STUB_DIR HLIMIT_OFFLOAD_LOCK \
		LOGGER_LOG HLIMIT_LEASES HLIMIT_ARP
	: >"$UCI_STUB_STATE"
	: >"$UCI_STUB_LOG"
	: >"$E/firewall.user"
	: >"$E/leases"
	: >"$E/arp"
	: >"$LOGGER_LOG"

	uci_add "hashlimit-qos.defaults=defaults"
	uci_add "hashlimit-qos.defaults.enabled=1"
	uci_add "hashlimit-qos.defaults.auto_disable_offload=1"
	uci_add "hashlimit-qos.defaults.default_enabled=0"
	uci_add "hashlimit-qos.defaults.default_down_kbps=0"
	uci_add "hashlimit-qos.defaults.default_up_kbps=0"

	# firewall zone lan (scope source) + a wan zone that must never be used
	uci_add "firewall.@zone[0]=zone"
	uci_add "firewall.@zone[0].name=lan"
	uci_add "firewall.@zone[0].network=lan"
	uci_add "firewall.@zone[1]=zone"
	uci_add "firewall.@zone[1].name=wan"
	uci_add "firewall.@zone[1].network=wwan"

	# default LAN fixture: 10.0.0.1/8
	uci_add "network.lan=interface"
	uci_add "network.lan.device=br-lan"
	uci_add "network.lan.ipaddr=10.0.0.1"
	uci_add "network.lan.netmask=255.0.0.0"
	uci_add "dhcp.lan=dhcp"
	uci_add "dhcp.lan.interface=lan"
	uci_add "dhcp.lan.start=100"
	uci_add "dhcp.lan.limit=150"

	HLIMIT_CONFIG=hashlimit-qos
	HLIMIT_UCI=uci
	HLIMIT_IPTABLES=iptables
	HLIMIT_FIREWALL_USER=$E/firewall.user
	HLIMIT_LOGGER=$STUBS/logger
	HLIMIT_NO_DNS=1
	export HLIMIT_CONFIG HLIMIT_UCI HLIMIT_IPTABLES HLIMIT_FIREWALL_USER \
		HLIMIT_LOGGER HLIMIT_NO_DNS
	unset IPT_STUB_FAIL_N IPT_STUB_FAIL_ADD IPT_STUB_BURST_MIN HLIMIT_IN_FW3 \
		IPT_STUB_MAC_HELP HLIMIT_MAC_MATCH HLIMIT_LIBXT_DIR HLIMIT_NSLOOKUP \
		HLIMIT_DNS_TIMEOUT 2>/dev/null || true
	RC=0
	OUT=
	ERR=
}

lan_192() {
	# switch the LAN fixture to 192.168.2.1/24 (generic private /24)
	uci_put "network.lan.ipaddr=192.168.2.1"
	uci_put "network.lan.netmask=255.255.255.0"
}

lan_guest_add() {
	# add a second LAN interface/zone network: 10.0.1.1/24 on br-guest
	uci_put "firewall.@zone[0].network=lan guest"
	uci_add "network.guest=interface"
	uci_add "network.guest.device=br-guest"
	uci_add "network.guest.ipaddr=10.0.1.1"
	uci_add "network.guest.netmask=255.255.255.0"
}

dev_add() { # ip down up [enabled] [label] [mac]
	_ip=$1
	_dn=$2
	_up=$3
	_en=${4:-1}
	_lbl=${5:-}
	_mac=${6:-}
	_sec=dev_$(printf '%s' "$_ip" | tr '.' '_')
	{
		printf 'hashlimit-qos.%s=device\n' "$_sec"
		printf 'hashlimit-qos.%s.ip=%s\n' "$_sec" "$_ip"
		printf 'hashlimit-qos.%s.label=%s\n' "$_sec" "$_lbl"
		printf 'hashlimit-qos.%s.enabled=%s\n' "$_sec" "$_en"
		printf 'hashlimit-qos.%s.down_kbps=%s\n' "$_sec" "$_dn"
		printf 'hashlimit-qos.%s.up_kbps=%s\n' "$_sec" "$_up"
		[ -n "$_mac" ] && printf 'hashlimit-qos.%s.mac=%s\n' "$_sec" "$_mac"
	} >>"$UCI_STUB_STATE"
}

dev_add_mac() { # mac down up [enabled] [label] [ip]
	_mac=$1
	_dn=$2
	_up=$3
	_en=${4:-1}
	_lbl=${5:-}
	_ip=${6:-}
	_sec=dev_mac_$(printf '%s' "$_mac" | tr 'A-F:' 'a-f_')
	{
		printf 'hashlimit-qos.%s=device\n' "$_sec"
		[ -n "$_ip" ] && printf 'hashlimit-qos.%s.ip=%s\n' "$_sec" "$_ip"
		printf 'hashlimit-qos.%s.mac=%s\n' "$_sec" "$_mac"
		printf 'hashlimit-qos.%s.label=%s\n' "$_sec" "$_lbl"
		printf 'hashlimit-qos.%s.enabled=%s\n' "$_sec" "$_en"
		printf 'hashlimit-qos.%s.down_kbps=%s\n' "$_sec" "$_dn"
		printf 'hashlimit-qos.%s.up_kbps=%s\n' "$_sec" "$_up"
	} >>"$UCI_STUB_STATE"
}

grp_add() { # start end down up [enabled] [label] [exclude...]
	_start=$1
	_end=$2
	_dn=$3
	_up=$4
	_en=${5:-1}
	_lbl=${6:-}
	_sec=grp_$(printf '%s_%s' "$_start" "$_end" | tr './' '__')
	{
		printf 'hashlimit-qos.%s=group\n' "$_sec"
		printf 'hashlimit-qos.%s.start=%s\n' "$_sec" "$_start"
		printf 'hashlimit-qos.%s.end=%s\n' "$_sec" "$_end"
		printf 'hashlimit-qos.%s.range=%s-%s\n' "$_sec" "$_start" "$_end"
		printf 'hashlimit-qos.%s.label=%s\n' "$_sec" "$_lbl"
		printf 'hashlimit-qos.%s.enabled=%s\n' "$_sec" "$_en"
		printf 'hashlimit-qos.%s.down_kbps=%s\n' "$_sec" "$_dn"
		printf 'hashlimit-qos.%s.up_kbps=%s\n' "$_sec" "$_up"
	} >>"$UCI_STUB_STATE"
	shift 6 2>/dev/null || return 0
	for _ex in "$@"; do
		printf 'hashlimit-qos.%s.exclude=%s\n' "$_sec" "$_ex" >>"$UCI_STUB_STATE"
	done
}

dhcp_host_add() { # index mac ip [name]
	uci_add "dhcp.@host[$1]=host"
	uci_add "dhcp.@host[$1].mac=$2"
	uci_add "dhcp.@host[$1].ip=$3"
	uci_add "dhcp.@host[$1].name=${4:-}"
}

fw_defaults_add() { # fo fo_hw
	uci_add "firewall.@defaults[0]=defaults"
	uci_add "firewall.@defaults[0].flow_offloading=$1"
	uci_add "firewall.@defaults[0].flow_offloading_hw=$2"
}

turboacc_add() { # fastpath [fo_hw]
	uci_add "turboacc.config=config"
	uci_add "turboacc.config.fastpath=$1"
	[ $# -ge 2 ] && uci_add "turboacc.config.fo_hw=$2"
}

ctl() {
	if [ "$CURRENT_SHELL" = busybox ]; then
		busybox ash "$CTL" "$@" >"$E/out" 2>"$E/err"
	else
		sh "$CTL" "$@" >"$E/out" 2>"$E/err"
	fi
	RC=$?
	OUT=$(cat "$E/out" 2>/dev/null || true)
	ERR=$(cat "$E/err" 2>/dev/null || true)
	return 0
}

ipt_log() { printf '%s/log' "$IPT_STUB_DIR"; }
ipt_chains() { printf '%s/chains' "$IPT_STUB_DIR"; }
ipt_jumps() { printf '%s/jumps' "$IPT_STUB_DIR"; }
uci_log() { printf '%s/uci.log' "$E"; }

python_json_ok() {
	if ! command -v python3 >/dev/null 2>&1; then
		fail "python3 not available, cannot validate JSON"
		return 1
	fi
	python3 -c '
import json, sys
raw = open(sys.argv[1], encoding="utf-8").read()
assert "\n" not in raw.rstrip("\n"), "embedded newline in JSON"
json.loads(raw)
' "$1"
}

# ---------------------------------------------------------------------------
# syntax / packaging metadata
# ---------------------------------------------------------------------------
test_syntax() {
	section "syntax + default configuration"
	for f in \
		"$CTL" \
		"$ROOT/files/etc/init.d/hashlimit-qos" \
		"$ROOT/files/etc/uci-defaults/90-hlimit-qos" \
		"$ROOT/files/etc/hotplug.d/dhcp/90-hlimit" \
		"$ROOT/scripts/build-ipk.sh" \
		"$ROOT/scripts/uninstall.sh"; do
		if sh -n "$f" 2>"$E/synerr"; then pass; else fail "sh -n $f: $(cat "$E/synerr")"; fi
		if command -v busybox >/dev/null 2>&1; then
			if busybox ash -n "$f" 2>"$E/synerr"; then pass; else fail "busybox ash -n $f: $(cat "$E/synerr")"; fi
		fi
	done

	if grep -q '^START=99' "$ROOT/files/etc/init.d/hashlimit-qos"; then pass; else fail "init.d START=99 missing"; fi
	if grep -q '^STOP=10' "$ROOT/files/etc/init.d/hashlimit-qos"; then pass; else fail "init.d STOP=10 missing"; fi
	if grep -q 'hlimit-ctl migrate' "$ROOT/files/etc/init.d/hashlimit-qos"; then pass; else fail "init.d start does not migrate"; fi
	if grep -q "option default_enabled '0'" "$ROOT/files/etc/config/hashlimit-qos"; then pass; else fail "default_enabled=0 missing"; fi
	if grep -q "option default_cidr" "$ROOT/files/etc/config/hashlimit-qos"; then fail "default config still has default_cidr"; else pass; fi
	if grep -q "list exclude" "$ROOT/files/etc/config/hashlimit-qos"; then pass; else fail "group exclude example missing"; fi
	if grep -q "10.0.0.162" "$ROOT/files/etc/config/hashlimit-qos"; then pass; else fail "10.x example missing"; fi
	if grep -q "192.168.2.50" "$ROOT/files/etc/config/hashlimit-qos"; then pass; else fail "192.168.x example missing"; fi
	if grep -q '^scan) cmd_scan' "$CTL"; then pass; else fail "scan command not dispatched"; fi
	if grep -q '^migrate) cmd_migrate' "$CTL"; then pass; else fail "migrate command not dispatched"; fi
	if grep -q 'group-exclude-add' "$CTL"; then pass; else fail "group-exclude-add missing"; fi
	# the code must not hardcode a LAN prefix
	if grep -qE 'LAN_CIDR=|10\.0\.0\.0/8"' "$CTL"; then fail "hardcoded LAN cidr in code"; else pass; fi
}

# ---------------------------------------------------------------------------
# LAN scope + render
# ---------------------------------------------------------------------------
test_render_basic_10() {
	section "render: LAN 10.0.0.1/8, interface qualified rules"
	new_env
	dev_add 10.0.0.50 5000 1000 1 '电视'
	ctl render
	assert_rc "render exit" 0

	assert_contains "gateway UP RETURN (-d)" \
		"-t mangle -A HLIMIT_UP -d 10.0.0.1 -j RETURN" "$(ipt_log)"
	assert_not_contains "no DOWN gateway exemption (OpenClash proxy replies must be limited)" \
		"-t mangle -A HLIMIT_DOWN -s 10.0.0.1 -j RETURN" "$(ipt_log)"
	assert_contains "down rule rate + iface" \
		"-A HLIMIT_DOWN -o br-lan -d 10.0.0.50 -m hashlimit --hashlimit-name hl_down_br_lan_10_0_0_50 --hashlimit-mode dstip --hashlimit-above 611kb/s --hashlimit-burst 613kb -j DROP" "$(ipt_log)"
	assert_contains "up rule rate + iface" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.50 -m hashlimit --hashlimit-name hl_up_br_lan_10_0_0_50 --hashlimit-mode srcip --hashlimit-above 123kb/s --hashlimit-burst 125kb -j DROP" "$(ipt_log)"
	assert_contains "device DOWN RETURN" \
		"-A HLIMIT_DOWN -o br-lan -d 10.0.0.50 -j RETURN" "$(ipt_log)"
	assert_contains "device UP RETURN" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.50 -j RETURN" "$(ipt_log)"
	assert_contains "end of chain RETURN up" "-t mangle -A HLIMIT_UP -j RETURN" "$(ipt_log)"
	assert_contains "end of chain RETURN down" "-t mangle -A HLIMIT_DOWN -j RETURN" "$(ipt_log)"

	assert_contains "jump mangle PREROUTING" "-t mangle -I PREROUTING 1 -j HLIMIT_UP" "$(ipt_log)"
	assert_contains "jump mangle POSTROUTING" "-t mangle -I POSTROUTING 1 -j HLIMIT_DOWN" "$(ipt_log)"
	assert_count "one PREROUTING jump" "mangle PREROUTING HLIMIT_UP" "$(ipt_jumps)" 1
	assert_count "one POSTROUTING jump" "mangle POSTROUTING HLIMIT_DOWN" "$(ipt_jumps)" 1
	assert_eq "render stdout empty" "" "$OUT"

	# every non-gateway rule is interface qualified
	if awk '
		/-A HLIMIT_UP/ {
			if ($0 ~ /-d 10\.0\.0\.1 -j RETURN/) next
			if ($0 ~ /^-t mangle -A HLIMIT_UP -j RETURN/) next
			if ($0 !~ / -i br-lan /) bad = 1
		}
		/-A HLIMIT_DOWN/ {
			if ($0 ~ / -s 10\.0\.0\.1 .*-j RETURN/) bad = 1
			if ($0 ~ /^-t mangle -A HLIMIT_DOWN -j RETURN/) next
			if ($0 !~ / -o br-lan /) bad = 1
		}
		END { exit bad ? 1 : 0 }
	' "$(ipt_log)"; then
		pass
	else
		fail "a UP/DOWN rule is missing -i/-o br-lan"
	fi
}

test_render_192() {
	section "render: generic LAN 192.168.2.1/24 (same code path)"
	new_env
	lan_192
	dev_add 192.168.2.50 5000 1000 1 '电视'
	ctl render
	assert_rc "render 192.168" 0
	assert_contains "192.168 gateway" "-A HLIMIT_UP -d 192.168.2.1 -j RETURN" "$(ipt_log)"
	assert_contains "192.168 down rule" \
		"-A HLIMIT_DOWN -o br-lan -d 192.168.2.50 -m hashlimit --hashlimit-name hl_down_br_lan_192_168_2_50" "$(ipt_log)"
	assert_contains "192.168 up rule" \
		"-A HLIMIT_UP -i br-lan -s 192.168.2.50 -m hashlimit --hashlimit-name hl_up_br_lan_192_168_2_50" "$(ipt_log)"
	# no stale 10.x assumption
	assert_not_contains "no 10/8 rule on a 192.168 LAN" "-d 10.0.0." "$(ipt_log)"
}

test_render_multi_lan() {
	section "render: two LAN interfaces (10.0.0.0/8 + 10.0.1.0/24)"
	new_env
	lan_guest_add
	uci_put "hashlimit-qos.defaults.default_enabled=1"
	uci_put "hashlimit-qos.defaults.default_down_kbps=2000"
	uci_put "hashlimit-qos.defaults.default_up_kbps=500"
	dev_add 10.0.1.50 5000 1000 1 'guest-client'
	grp_add 10.0.1.96 10.0.1.111 10000 2000 1 'guest-group'
	ctl render
	assert_rc "render multi LAN" 0
	assert_contains "guest device on br-guest" \
		"-A HLIMIT_UP -i br-guest -s 10.0.1.50 -m hashlimit" "$(ipt_log)"
	assert_contains "guest group on br-guest" \
		"-A HLIMIT_DOWN -o br-guest -m iprange --dst-range 10.0.1.96-10.0.1.111 -m hashlimit" "$(ipt_log)"
	assert_contains "default on br-lan" \
		"-A HLIMIT_UP -i br-lan -m hashlimit --hashlimit-name hl_up_def_br_lan" "$(ipt_log)"
	assert_contains "default on br-guest" \
		"-A HLIMIT_UP -i br-guest -m hashlimit --hashlimit-name hl_up_def_br_guest" "$(ipt_log)"
	assert_contains "guest gateway exempt" "-A HLIMIT_UP -d 10.0.1.1 -j RETURN" "$(ipt_log)"
	assert_not_contains "WAN never scoped" "wwan" "$(ipt_log)"
}

test_render_conversion() {
	section "render: ceil(kbps*125/1024), burst = rate + 2"
	for pair in "1000|123|125" "5000|611|613" "20000|2442|2444" "50000|6104|6106"; do
		_kbps=${pair%%|*}
		_rest=${pair#*|}
		_rate=${_rest%%|*}
		_burst=${_rest#*|}
		new_env
		dev_add 10.0.0.77 "$_kbps" 0 1 t
		ctl render
		if [ "$RC" -ne 0 ]; then
			fail "render ${_kbps}kbps exit=$RC"
			continue
		fi
		if grep -qF -- "--hashlimit-above ${_rate}kb/s --hashlimit-burst ${_burst}kb" "$(ipt_log)"; then
			pass
		else
			fail "conversion ${_kbps}kbps -> ${_rate}kb/s burst ${_burst}kb not found"
		fi
	done
}

test_burst_fallback() {
	section "render: burst retry ladder"
	new_env
	dev_add 10.0.0.78 1000 0 1 oldkernel
	IPT_STUB_BURST_MIN=1024
	export IPT_STUB_BURST_MIN
	ctl render
	assert_rc "render with burst fallback" 0
	assert_contains "first attempt rate+2" "--hashlimit-burst 125kb" "$(ipt_log)"
	assert_contains "second attempt 2x" "--hashlimit-burst 310kb" "$(ipt_log)"
	assert_contains "third attempt 1024kb" "--hashlimit-burst 1024kb" "$(ipt_log)"
	assert_contains "warning logged" "burst 125kb rejected" "$LOGGER_LOG"
	unset IPT_STUB_BURST_MIN
}

test_priority() {
	section "render: strict priority gateway > device > group-exclude > group > default"
	new_env
	uci_put "hashlimit-qos.defaults.default_enabled=1"
	uci_put "hashlimit-qos.defaults.default_down_kbps=2000"
	uci_put "hashlimit-qos.defaults.default_up_kbps=500"
	dev_add 10.0.0.50 5000 1000 1 'dev50'
	dev_add 10.0.0.60 0 0 1 'exempt60'
	grp_add 10.0.0.96 10.0.0.111 10000 2000 1 'grp' '10.0.0.110'
	ctl render
	assert_rc "render priority" 0

	# UP order
	assert_before "gateway before device" \
		"-A HLIMIT_UP -d 10.0.0.1 -j RETURN" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.50 -m hashlimit" "$(ipt_log)"
	assert_before "device DROP before device RETURN" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.50 -m hashlimit" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.50 -j RETURN" "$(ipt_log)"
	assert_before "device RETURN before exempt device RETURN" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.50 -j RETURN" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.60 -j RETURN" "$(ipt_log)"
	assert_before "exempt device before group exclude" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.60 -j RETURN" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.110 -j RETURN" "$(ipt_log)"
	assert_before "group exclude before group DROP" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.110 -j RETURN" \
		"-A HLIMIT_UP -i br-lan -m iprange --src-range 10.0.0.96-10.0.0.111 -m hashlimit" "$(ipt_log)"
	assert_before "group DROP before group RETURN" \
		"-A HLIMIT_UP -i br-lan -m iprange --src-range 10.0.0.96-10.0.0.111 -m hashlimit" \
		"-A HLIMIT_UP -i br-lan -m iprange --src-range 10.0.0.96-10.0.0.111 -j RETURN" "$(ipt_log)"
	assert_before "group RETURN before default" \
		"-A HLIMIT_UP -i br-lan -m iprange --src-range 10.0.0.96-10.0.0.111 -j RETURN" \
		"-A HLIMIT_UP -i br-lan -m hashlimit --hashlimit-name hl_up_def_br_lan" "$(ipt_log)"
	assert_before "default before end of chain" \
		"-A HLIMIT_UP -i br-lan -m hashlimit --hashlimit-name hl_up_def_br_lan" \
		"-t mangle -A HLIMIT_UP -j RETURN" "$(ipt_log)"

	# DOWN order
	assert_before "down device before group exclude" \
		"-A HLIMIT_DOWN -o br-lan -d 10.0.0.50 -j RETURN" \
		"-A HLIMIT_DOWN -o br-lan -d 10.0.0.110 -j RETURN" "$(ipt_log)"
	assert_before "down group RETURN before default" \
		"-A HLIMIT_DOWN -o br-lan -m iprange --dst-range 10.0.0.96-10.0.0.111 -j RETURN" \
		"-A HLIMIT_DOWN -o br-lan -m hashlimit --hashlimit-name hl_down_def_br_lan" "$(ipt_log)"

	# 0/0 enabled device = unlimited, no DROP rule at all
	assert_not_contains "exempt device has no limit rule" \
		"-i br-lan -s 10.0.0.60 -m hashlimit" "$(ipt_log)"
	# group is one CIDR rule, not per host
	assert_count "single group rule" \
		"-A HLIMIT_UP -i br-lan -m iprange --src-range 10.0.0.96-10.0.0.111 -m hashlimit" "$(ipt_log)" 1
	assert_count "single default rule" \
		"-A HLIMIT_UP -i br-lan -m hashlimit --hashlimit-name hl_up_def_br_lan" "$(ipt_log)" 1
}

test_disabled_device() {
	section "render: enabled=0 device produces no rules (v1.2 semantics)"
	new_env
	dev_add 10.0.0.61 5000 5000 0 'disabled'
	uci_put "hashlimit-qos.defaults.default_enabled=1"
	uci_put "hashlimit-qos.defaults.default_down_kbps=2000"
	uci_put "hashlimit-qos.defaults.default_up_kbps=500"
	ctl render
	assert_rc "render" 0
	assert_not_contains "no limit rule for disabled device" "-s 10.0.0.61 -m hashlimit" "$(ipt_log)"
	assert_not_contains "no RETURN for disabled device" "-s 10.0.0.61 -j RETURN" "$(ipt_log)"
}

test_legacy_cleanup() {
	section "upgrade: v1.0 filter jumps/chains removed, mangle only"
	new_env
	iptables -t filter -N HLIMIT_UP
	iptables -t filter -N HLIMIT_DOWN
	iptables -t filter -I FORWARD 1 -j HLIMIT_DOWN
	iptables -t filter -I FORWARD 1 -j HLIMIT_UP
	iptables -t filter -I INPUT 1 -j HLIMIT_UP
	iptables -t filter -I OUTPUT 1 -j HLIMIT_DOWN
	dev_add 10.0.0.50 5000 1000 1 t
	: >"$(ipt_log)"
	ctl render
	assert_rc "render after v1.0 leftovers" 0
	assert_contains "remove FORWARD up jump" "-t filter -D FORWARD -j HLIMIT_UP" "$(ipt_log)"
	assert_contains "remove INPUT up jump" "-t filter -D INPUT -j HLIMIT_UP" "$(ipt_log)"
	assert_contains "remove OUTPUT down jump" "-t filter -D OUTPUT -j HLIMIT_DOWN" "$(ipt_log)"
	if grep -q '^filter .*HLIMIT' "$(ipt_jumps)"; then fail "filter jump survived"; else pass; fi
	if grep -q '^filter HLIMIT' "$(ipt_chains)"; then fail "filter chain survived"; else pass; fi
	assert_count "mangle PREROUTING jump" "mangle PREROUTING HLIMIT_UP" "$(ipt_jumps)" 1
	assert_count "mangle POSTROUTING jump" "mangle POSTROUTING HLIMIT_DOWN" "$(ipt_jumps)" 1
	if grep -qE '^-t filter -I (FORWARD|INPUT|OUTPUT)' "$(ipt_log)"; then fail "render added a filter jump"; else pass; fi
}

test_idempotent_flush() {
	section "render idempotency + flush"
	new_env
	dev_add 10.0.0.50 5000 1000 1 t
	ctl render
	ctl render
	assert_rc "second render" 0
	assert_count "down rule rebuilt twice" "-A HLIMIT_DOWN -o br-lan -d 10.0.0.50 -m hashlimit" "$(ipt_log)" 2
	assert_count "one mangle PREROUTING jump" "mangle PREROUTING HLIMIT_UP" "$(ipt_jumps)" 1
	assert_count "one mangle POSTROUTING jump" "mangle POSTROUTING HLIMIT_DOWN" "$(ipt_jumps)" 1
	ctl flush
	assert_rc "flush" 0
	if grep -q 'HLIMIT' "$(ipt_chains)"; then fail "chains still present after flush"; else pass; fi
	if [ -s "$(ipt_jumps)" ]; then fail "jumps still present after flush"; else pass; fi
}

test_render_failure() {
	section "render: failure handling"
	new_env
	dev_add 10.0.0.50 5000 5000 1 t
	IPT_STUB_FAIL_N=1
	export IPT_STUB_FAIL_N
	ctl render
	assert_rc "chain creation failure" 3
	assert_not_contains "no broken jump" "-I PREROUTING 1 -j HLIMIT_UP" "$(ipt_log)"
	unset IPT_STUB_FAIL_N

	new_env
	dev_add 10.0.0.50 5000 5000 1 t
	IPT_STUB_FAIL_ADD="-d 10.0.0.50"
	export IPT_STUB_FAIL_ADD
	ctl render
	assert_rc "rule add failure exit" 3
	assert_contains "failure logged" "failed to add download rule" "$E/err"
	unset IPT_STUB_FAIL_ADD

	new_env
	dev_add 10.0.0.50 5000 5000 1 t
	IPT_STUB_FAIL_ADD="-d 10.0.0.50"
	export IPT_STUB_FAIL_ADD
	HLIMIT_IN_FW3=1
	export HLIMIT_IN_FW3
	ctl render
	assert_rc "render inside fw3 returns 0" 0
	unset IPT_STUB_FAIL_ADD HLIMIT_IN_FW3
}

# ---------------------------------------------------------------------------
# default limit
# ---------------------------------------------------------------------------
test_default_limit() {
	section "default limit: off by default, 3-arg set-default, ignored old CIDR"
	new_env
	ctl render
	assert_not_contains "no default rule while disabled" "hl_up_def_" "$(ipt_log)"

	# old default_cidr must be ignored (it would be the stale 192.168.2.0/24)
	uci_put "hashlimit-qos.defaults.default_cidr=192.168.2.0/24"
	uci_put "hashlimit-qos.defaults.default_enabled=1"
	uci_put "hashlimit-qos.defaults.default_down_kbps=2000"
	uci_put "hashlimit-qos.defaults.default_up_kbps=500"
	: >"$(ipt_log)"
	ctl render
	assert_rc "render with legacy default_cidr" 0
	assert_contains "default rule on LAN iface" \
		"-A HLIMIT_UP -i br-lan -m hashlimit --hashlimit-name hl_up_def_br_lan" "$(ipt_log)"
	assert_not_contains "no CIDR-based default rule" "-s 192.168.2.0/24" "$(ipt_log)"
	assert_contains "gateway still exempt" "-A HLIMIT_UP -d 10.0.0.1 -j RETURN" "$(ipt_log)"

	# 3-argument set-default
	new_env
	ctl set-default 1 2000 500
	assert_rc "set-default 3 args" 0
	assert_contains "default_enabled stored" "hashlimit-qos.defaults.default_enabled=1" "$UCI_STUB_STATE"
	assert_contains "default down stored" "hashlimit-qos.defaults.default_down_kbps=2000" "$UCI_STUB_STATE"
	assert_contains "default up stored" "hashlimit-qos.defaults.default_up_kbps=500" "$UCI_STUB_STATE"

	# 4-argument v1.1 call: ignored and the stale option is removed
	new_env
	uci_put "hashlimit-qos.defaults.default_cidr=10.0.0.64/26"
	ctl set-default 1 4000 1000 10.0.0.64/26
	assert_rc "set-default 4 args" 0
	if grep -q 'default_cidr' "$UCI_STUB_STATE"; then fail "set-default kept default_cidr"; else pass; fi
	assert_contains "rules still per interface" "-A HLIMIT_DOWN -o br-lan -m hashlimit --hashlimit-name hl_down_def_br_lan" "$(ipt_log)"

	ctl set-default 2 0 0
	assert_rc "invalid flag" 2
	ctl set-default 1 0
	assert_rc "usage" 1
	ctl default-status
	assert_rc "default-status" 0
	python_json_ok "$E/out" && pass
}

# ---------------------------------------------------------------------------
# group + per-group exclude
# ---------------------------------------------------------------------------
test_group_crud() {
	section "group-set / group-toggle / group-delete"
	new_env
	ctl group-set 10.0.0.100/28 10000 2000 '访客' 1
	assert_rc "group-set" 0
	assert_contains "group section" "hashlimit-qos.grp_10_0_0_96_10_0_0_111=group" "$UCI_STUB_STATE"
	assert_contains "range normalised" "hashlimit-qos.grp_10_0_0_96_10_0_0_111.range=10.0.0.96-10.0.0.111" "$UCI_STUB_STATE"
	assert_contains "start stored" "hashlimit-qos.grp_10_0_0_96_10_0_0_111.start=10.0.0.96" "$UCI_STUB_STATE"
	assert_contains "group rule on LAN iface" \
		"-A HLIMIT_UP -i br-lan -m iprange --src-range 10.0.0.96-10.0.0.111 -m hashlimit --hashlimit-name hl_up_grp_br_lan_1" "$(ipt_log)"

	: >"$(ipt_log)"
	ctl group-toggle 10.0.0.96/28 0
	assert_rc "group-toggle off" 0
	assert_not_contains "no rule after toggle off" "-m iprange --src-range 10.0.0.96-10.0.0.111 -m hashlimit" "$(ipt_log)"
	ctl group-delete 10.0.0.96/28
	assert_rc "group-delete" 0
	ctl group-delete 10.0.0.96/28
	assert_rc "group-delete idempotent" 0
	ctl group-set 300.1.1.0/24 100 100
	assert_rc "invalid cidr" 2
	ctl group-toggle 10.0.0.0/8 1
	assert_rc "missing group" 2
}

test_group_exclude() {
	section "per-group whitelist: IP/MAC, validation, idempotency"
	new_env
	grp_add 10.0.0.96 10.0.0.111 10000 2000 1 'grp'
	ctl group-exclude-add 10.0.0.96/28 10.0.0.110
	assert_rc "group-exclude-add ip" 0
	assert_contains "exclude stored" "grp_10_0_0_96_10_0_0_111.exclude=10.0.0.110" "$UCI_STUB_STATE"
	assert_contains "exclude UP RETURN" "-A HLIMIT_UP -i br-lan -s 10.0.0.110 -j RETURN" "$(ipt_log)"
	assert_contains "exclude DOWN RETURN" "-A HLIMIT_DOWN -o br-lan -d 10.0.0.110 -j RETURN" "$(ipt_log)"
	assert_before "exclude before group DROP" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.110 -j RETURN" \
		"-A HLIMIT_UP -i br-lan -m iprange --src-range 10.0.0.96-10.0.0.111 -m hashlimit" "$(ipt_log)"

	ctl group-exclude-add 10.0.0.96/28 10.0.0.110
	assert_rc "duplicate idempotent" 0
	assert_count "one exclude entry" "exclude=10.0.0.110" "$UCI_STUB_STATE" 1

	ctl group-exclude-add 10.0.0.96/28 10.0.0.200
	assert_rc "ip outside cidr rejected" 2
	ctl group-exclude-add 10.0.0.96/28 zz:zz
	assert_rc "invalid mac rejected" 2
	ctl group-exclude-add 10.0.0.0/30 10.0.0.110
	assert_rc "missing group" 2
	ctl group-exclude-add 10.0.0.96/28
	assert_rc "usage" 1

	ctl group-exclude-del 10.0.0.96/28 10.0.0.110
	assert_rc "group-exclude-del" 0
	assert_not_contains "exclude removed" "exclude=10.0.0.110" "$UCI_STUB_STATE"
	ctl group-exclude-del 10.0.0.96/28 10.0.0.110
	assert_rc "del absent idempotent" 0

	# MAC exclude: with xt_mac available the UP rule matches the MAC, DOWN
	# resolves the MAC to the current IP.
	new_env
	grp_add 10.0.0.96 10.0.0.111 10000 2000 1 'grp'
	uci_add "hashlimit-qos.dev_mac_x=device"
	uci_add "hashlimit-qos.dev_mac_x.mac=aa:bb:cc:dd:ee:01"
	uci_add "hashlimit-qos.dev_mac_x.enabled=1"
	uci_add "hashlimit-qos.dev_mac_x.down_kbps=0"
	uci_add "hashlimit-qos.dev_mac_x.up_kbps=0"
	dhcp_host_add 0 aa:bb:cc:dd:ee:01 10.0.0.110 'printer'
	IPT_STUB_MAC_HELP=1
	export IPT_STUB_MAC_HELP
	ctl group-exclude-add 10.0.0.96/28 AA:BB:CC:DD:EE:01
	assert_rc "group-exclude-add mac" 0
	assert_contains "exclude stored lowercase" "exclude=aa:bb:cc:dd:ee:01" "$UCI_STUB_STATE"
	assert_contains "MAC exclude UP" \
		"-A HLIMIT_UP -i br-lan -m mac --mac-source aa:bb:cc:dd:ee:01 -j RETURN" "$(ipt_log)"
	assert_contains "MAC exclude DOWN resolves IP" \
		"-A HLIMIT_DOWN -o br-lan -d 10.0.0.110 -j RETURN" "$(ipt_log)"
	unset IPT_STUB_MAC_HELP
}

# ---------------------------------------------------------------------------
# scan
# ---------------------------------------------------------------------------
_scan_json() { ctl scan; }

test_scan_10() {
	section "scan: 10.0.0.1/8 JSON, LAN filtering, pool, candidates"
	new_env
	dhcp_host_add 0 aa:bb:cc:dd:ee:01 10.0.0.162 '客厅电视'
	cat >"$HLIMIT_LEASES" <<'EOF'
43200 50:4f:3b:ca:8f:84 10.0.0.107 MiWiFi-RD03 01:50
EOF
	cat >"$HLIMIT_ARP" <<'EOF'
IP address       HW type     Flags       HW address            Mask     Device
10.0.0.107       0x1         0x2         50:4f:3b:ca:8f:84     *        br-lan
10.0.0.162       0x1         0x2         aa:bb:cc:dd:ee:01     *        br-lan
10.0.1.5         0x1         0x0         aa:bb:cc:dd:ee:02     *        br-lan
10.149.180.124   0x1         0x2         c0:a4:76:47:3d:31     *        wlan1
EOF
	ctl scan
	assert_rc "scan" 0
	assert_eq "single line" "1" "$(wc -l <"$E/out" | tr -d ' ')"
	if command -v python3 >/dev/null 2>&1; then
		python3 - "$E/out" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1], encoding="utf-8").read())
assert d["lan"][0]["device"] == "br-lan", d
assert d["lan"][0]["cidr"] == "10.0.0.0/8", d
assert d["lan"][0]["ip"] == "10.0.0.1", d
assert d["pool"] == {"start": "10.0.0.100", "end": "10.0.0.249"}, d["pool"]
by_ip = {h["ip"]: h for h in d["hosts"]}
assert set(by_ip) == {"10.0.0.162", "10.0.0.107"}, d["hosts"]
assert by_ip["10.0.0.162"]["mac"] == "aa:bb:cc:dd:ee:01", d
assert by_ip["10.0.0.162"]["name"] == "客厅电视", d
assert by_ip["10.0.0.107"]["source"] == "lease", d
assert by_ip["10.0.0.162"]["online"] == "1", d
ranges = [c["range"] for c in d["candidates"]]
assert "10.0.0.0-10.255.255.255" in ranges, ranges
assert "10.0.0.0-10.0.0.255" in ranges, ranges
c24 = [c for c in d["candidates"] if c["range"] == "10.0.0.0-10.0.0.255"][0]
assert c24["start"] == "10.0.0.0" and c24["end"] == "10.0.0.255", c24
assert c24["hosts"] == "2", c24
c8 = [c for c in d["candidates"] if c["range"] == "10.0.0.0-10.255.255.255"][0]
assert c8["start"] == "10.0.0.0" and c8["end"] == "10.255.255.255", c8
assert "全部局域网" in c8["label"], c8
PY
		if [ $? -eq 0 ]; then pass; else fail "scan JSON assertions failed"; fi
	fi
}

test_scan_192() {
	section "scan: 192.168.2.1/24 pool/range/candidates"
	new_env
	lan_192
	cat >"$HLIMIT_LEASES" <<'EOF'
43200 aa:bb:cc:dd:ee:01 192.168.2.162 客厅电视 01:1c
43200 50:4f:3b:ca:8f:84 192.168.2.107 MiWiFi-RD03 01:50
EOF
	ctl scan
	assert_rc "scan 192" 0
	if command -v python3 >/dev/null 2>&1; then
		python3 - "$E/out" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1], encoding="utf-8").read())
assert d["lan"][0]["cidr"] == "192.168.2.0/24", d["lan"]
assert d["pool"] == {"start": "192.168.2.100", "end": "192.168.2.249"}, d["pool"]
ranges = [c["range"] for c in d["candidates"]]
assert "192.168.2.0-192.168.2.255" in ranges, ranges
c = d["candidates"][0]
assert c["start"] == "192.168.2.0" and c["end"] == "192.168.2.255", c
assert set(h["ip"] for h in d["hosts"]) == {"192.168.2.162", "192.168.2.107"}, d["hosts"]
PY
		if [ $? -eq 0 ]; then pass; else fail "scan 192 JSON failed"; fi
	fi
}

test_scan_empty() {
	section "scan: valid JSON without any host"
	new_env
	ctl scan
	assert_rc "scan empty" 0
	if command -v python3 >/dev/null 2>&1; then
		python3 - "$E/out" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1], encoding="utf-8").read())
assert d["hosts"] == [], d
assert [c["range"] for c in d["candidates"]] == ["10.0.0.0-10.255.255.255"], d["candidates"]
PY
		if [ $? -eq 0 ]; then pass; else fail "empty scan JSON wrong"; fi
	fi
}

# ---------------------------------------------------------------------------
# devices
# ---------------------------------------------------------------------------
test_devices_lan_only() {
	section "devices: LAN only, online flag, WAN/FAILED filtered"
	new_env
	dhcp_host_add 0 aa:bb:cc:dd:ee:01 10.0.0.110 'printer'
	cat >"$HLIMIT_LEASES" <<'EOF'
43200 aa:bb:cc:dd:ee:01 10.0.0.162 客厅电视 01:1c
EOF
	cat >"$HLIMIT_ARP" <<'EOF'
IP address       HW type     Flags       HW address            Mask     Device
10.0.0.107       0x1         0x2         50:4f:3b:ca:8f:84     *        br-lan
10.0.1.5         0x1         0x0         aa:bb:cc:dd:ee:02     *        br-lan
10.149.180.124   0x1         0x2         c0:a4:76:47:3d:31     *        wlan1
10.151.255.254   0x1         0x2         c0:a4:76:47:3d:31     *        wlan1
EOF
	ctl devices
	assert_rc "devices" 0
	if command -v python3 >/dev/null 2>&1; then
		python3 - "$E/out" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1], encoding="utf-8").read())
by_ip = {h["ip"]: h for h in d["devices"]}
assert set(by_ip) == {"10.0.0.162", "10.0.0.107", "10.0.0.110"}, d
assert by_ip["10.0.0.110"]["source"] == "static", d
assert by_ip["10.0.0.110"]["online"] == "0", d
assert by_ip["10.0.0.162"]["online"] == "1", d
assert by_ip["10.0.0.107"]["online"] == "1", d
assert by_ip["10.0.0.162"]["name"] == "客厅电视", d
PY
		if [ $? -eq 0 ]; then pass; else fail "devices filtering wrong: $(cat "$E/out")"; fi
	fi

	new_env
	ctl devices
	assert_eq "empty devices" '{"devices":[]}' "$OUT"
}

# ---------------------------------------------------------------------------
# migrate
# ---------------------------------------------------------------------------
test_migrate_label_192to10() {
	section "migrate: 192.168.2.x -> 10.0.0.x via hostname/label"
	new_env
	uci_put "hashlimit-qos.defaults.default_cidr=192.168.2.0/24"
	uci_put "hashlimit-qos.defaults.default_exclude=192.168.2.1"
	dev_add 192.168.2.162 50000 25000 1 'blasckshore'
	cat >"$HLIMIT_LEASES" <<'EOF'
43200 aa:bb:cc:dd:ee:01 10.0.0.162 客厅电视 01:1c
EOF
	ctl migrate
	assert_rc "migrate" 0
	assert_contains "migrated section (label case-insensitive)" '"section":"dev_192_168_2_162"' "$E/out"
	assert_contains "from old ip" '"from":"192.168.2.162"' "$E/out"
	assert_contains "to new ip" '"to":"10.0.0.162"' "$E/out"
	assert_contains "mac learned" '"mac":"aa:bb:cc:dd:ee:01"' "$E/out"
	assert_contains "default_cidr removed" '"removed default_cidr"' "$E/out"
	assert_contains "default_exclude removed" '"removed default_exclude"' "$E/out"
	assert_contains "ip updated" "dev_192_168_2_162.ip=10.0.0.162" "$UCI_STUB_STATE"
	assert_contains "mac stored" "dev_192_168_2_162.mac=aa:bb:cc:dd:ee:01" "$UCI_STUB_STATE"
	if grep -q 'default_cidr\|default_exclude' "$UCI_STUB_STATE"; then fail "legacy options kept"; else pass; fi
	assert_eq "one commit" "1" "$(grep -c 'commit hashlimit-qos' "$(uci_log)")"

	: >"$(uci_log)"
	ctl migrate
	assert_rc "second migrate" 0
	assert_contains "idempotent migrated=[]" '"migrated":[]' "$E/out"
	assert_eq "no commit on second run" "0" "$(grep -c 'commit hashlimit-qos' "$(uci_log)")"
}

test_migrate_reverse() {
	section "migrate: 10.0.0.x -> 192.168.2.x (generic, not one-way)"
	new_env
	lan_192
	dev_add 10.0.0.162 5000 1000 1 '客厅电视'
	cat >"$HLIMIT_LEASES" <<'EOF'
43200 aa:bb:cc:dd:ee:01 192.168.2.162 客厅电视 01:1c
EOF
	ctl migrate
	assert_rc "reverse migrate" 0
	assert_contains "to 192.168" '"to":"192.168.2.162"' "$E/out"
	assert_contains "ip rewritten" "dev_10_0_0_162.ip=192.168.2.162" "$UCI_STUB_STATE"
}

test_migrate_mac_refresh() {
	section "migrate: MAC refresh inside the same LAN"
	new_env
	uci_add "hashlimit-qos.dev_mac=device"
	uci_add "hashlimit-qos.dev_mac.mac=aa:bb:cc:dd:ee:01"
	uci_add "hashlimit-qos.dev_mac.ip=10.0.0.99"
	uci_add "hashlimit-qos.dev_mac.enabled=1"
	uci_add "hashlimit-qos.dev_mac.down_kbps=5000"
	uci_add "hashlimit-qos.dev_mac.up_kbps=1000"
	cat >"$HLIMIT_LEASES" <<'EOF'
43200 aa:bb:cc:dd:ee:01 10.0.0.162 客厅电视 01:1c
EOF
	ctl migrate
	assert_rc "mac refresh" 0
	assert_contains "ip refreshed" "dev_mac.ip=10.0.0.162" "$UCI_STUB_STATE"
	assert_contains "from/to reported" '"from":"10.0.0.99"' "$E/out"
}

test_migrate_last_octet() {
	section "migrate: last-octet fallback"
	new_env
	# no label, no mac, stale /24 address
	dev_add 192.168.2.107 5000 1000 1 ''
	cat >"$HLIMIT_LEASES" <<'EOF'
43200 50:4f:3b:ca:8f:84 10.0.0.107 MiWiFi-RD03 01:50
EOF
	ctl migrate
	assert_rc "last octet migrate" 0
	assert_contains "ip rewritten" "dev_192_168_2_107.ip=10.0.0.107" "$UCI_STUB_STATE"
	assert_contains "mac learned" "dev_192_168_2_107.mac=50:4f:3b:ca:8f:84" "$UCI_STUB_STATE"
}

test_migrate_stale() {
	section "migrate: stale config kept, note recorded"
	new_env
	dev_add 192.168.2.250 5000 1000 1 'nobody'
	ctl migrate
	assert_rc "stale migrate" 0
	assert_contains "stale note" "stale: dev_192_168_2_250" "$E/out"
	assert_contains "config kept" "dev_192_168_2_250.ip=192.168.2.250" "$UCI_STUB_STATE"
	assert_eq "no commit for stale" "0" "$(grep -c 'commit hashlimit-qos' "$(uci_log)")"
}

test_migrate_invalid_group() {
	section "migrate: group outside LAN reported, not deleted"
	new_env
	grp_add 192.168.2.96 192.168.2.111 10000 2000 1 'old-grp'
	ctl migrate
	assert_rc "invalid group migrate" 0
	assert_contains "invalid group note" 'group 192.168.2.96-192.168.2.111 is outside the current LAN' "$E/out"
	assert_contains "group kept" "hashlimit-qos.grp_192_168_2_96_192_168_2_111=group" "$UCI_STUB_STATE"
}

# ---------------------------------------------------------------------------
# set: labels, MAC handling
# ---------------------------------------------------------------------------
test_set_label() {
	section "set: empty label takes the current hostname"
	new_env
	cat >"$HLIMIT_LEASES" <<'EOF'
43200 aa:bb:cc:dd:ee:01 10.0.0.162 客厅电视 01:1c
EOF
	ctl set 10.0.0.162 5000 1000
	assert_rc "set without label" 0
	assert_contains "hostname used" "dev_10_0_0_162.label=客厅电视" "$UCI_STUB_STATE"

	ctl set 10.0.0.162 4000 800
	assert_rc "update without label" 0
	assert_contains "label preserved" "dev_10_0_0_162.label=客厅电视" "$UCI_STUB_STATE"

	ctl set 10.0.0.150 1000 1000 '-' 1
	assert_rc "set label '-'" 0
	assert_contains "fallback to ip" "dev_10_0_0_150.label=10.0.0.150" "$UCI_STUB_STATE"

	ctl set - 1000 1000 '' 1 aa:bb:cc:dd:ee:01
	assert_rc "MAC-only empty label" 0
	assert_contains "MAC hostname" "dev_mac_aa_bb_cc_dd_ee_01.label=客厅电视" "$UCI_STUB_STATE"
}

test_set_mac_commands() {
	section "set / delete / toggle by MAC"
	new_env
	ctl set - 2000 500 '电视' 1 AA:BB:CC:DD:EE:01
	assert_rc "set mac-only" 0
	assert_contains "mac section" "hashlimit-qos.dev_mac_aa_bb_cc_dd_ee_01=device" "$UCI_STUB_STATE"
	assert_contains "mac lowercase" "dev_mac_aa_bb_cc_dd_ee_01.mac=aa:bb:cc:dd:ee:01" "$UCI_STUB_STATE"
	ctl toggle aa:bb:cc:dd:ee:01 0
	assert_rc "toggle by mac" 0
	assert_contains "disabled" "dev_mac_aa_bb_cc_dd_ee_01.enabled=0" "$UCI_STUB_STATE"
	ctl delete aa:bb:cc:dd:ee:01
	assert_rc "delete by mac" 0
	ctl delete aa:bb:cc:dd:ee:01
	assert_rc "delete by mac idempotent" 0
	ctl set - 1000 1000
	assert_rc "no ip/mac" 2
	ctl set 10.0.0.50 1000 1000 '' 1 zz:zz
	assert_rc "invalid mac" 2
}

# ---------------------------------------------------------------------------
# MAC resolution / matching
# ---------------------------------------------------------------------------
test_mac_resolution() {
	section "MAC: dhcp static -> leases -> ARP"
	new_env
	dhcp_host_add 0 aa:bb:cc:dd:ee:01 10.0.0.50 '手机'
	cat >"$HLIMIT_LEASES" <<'EOF'
43200 aa:bb:cc:dd:ee:02 10.0.0.51 平板 *
EOF
	cat >"$HLIMIT_ARP" <<'EOF'
IP address       HW type     Flags       HW address            Mask     Device
10.0.0.52        0x1         0x2         aa:bb:cc:dd:ee:03     *        br-lan
EOF
	dev_add_mac aa:bb:cc:dd:ee:01 5000 1000 1 '手机'
	dev_add_mac aa:bb:cc:dd:ee:02 4000 800 1 '平板'
	dev_add_mac aa:bb:cc:dd:ee:03 3000 600 1 'ARP'
	dev_add_mac aa:bb:cc:dd:ee:99 2000 400 1 '离线'
	ctl render
	assert_rc "render MAC devices" 0
	assert_contains "static resolution" \
		"-A HLIMIT_UP -i br-lan -s 10.0.0.50 -m hashlimit --hashlimit-name hl_up_br_lan_10_0_0_50" "$(ipt_log)"
	assert_contains "lease resolution" "-A HLIMIT_DOWN -o br-lan -d 10.0.0.51 -m hashlimit" "$(ipt_log)"
	assert_contains "arp resolution" "-A HLIMIT_DOWN -o br-lan -d 10.0.0.52 -m hashlimit" "$(ipt_log)"
	assert_contains "unresolved warning" "not resolved" "$E/err"
	assert_not_contains "unresolved adds no rule" "-d 10.0.0.99" "$(ipt_log)"

	ctl list
	if command -v python3 >/dev/null 2>&1; then
		python3 - "$E/out" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1], encoding="utf-8").read())
devs = {x["mac"]: x for x in d["devices"] if x["kind"] == "device"}
assert devs["aa:bb:cc:dd:ee:01"]["resolved_ip"] == "10.0.0.50", devs
assert devs["aa:bb:cc:dd:ee:99"]["resolved_ip"] == "", devs
assert devs["aa:bb:cc:dd:ee:99"]["down_unresolved"] == "1", devs
assert devs["aa:bb:cc:dd:ee:01"]["lan_dev"] == "br-lan", devs
PY
		if [ $? -eq 0 ]; then pass; else fail "MAC status fields wrong"; fi
	fi
}

test_mac_match() {
	section "MAC: -m mac for upload when xt_mac is available"
	new_env
	dhcp_host_add 0 aa:bb:cc:dd:ee:01 10.0.0.50 '手机'
	dev_add_mac aa:bb:cc:dd:ee:01 5000 1000 1 '手机'
	IPT_STUB_MAC_HELP=1
	export IPT_STUB_MAC_HELP
	ctl render
	assert_rc "render with xt_mac" 0
	assert_contains "UP matches MAC" \
		"-A HLIMIT_UP -i br-lan -m mac --mac-source aa:bb:cc:dd:ee:01 -m hashlimit --hashlimit-name hl_up_br_lan_aa_bb_cc_dd_ee_01" "$(ipt_log)"
	assert_contains "UP RETURN by MAC" \
		"-A HLIMIT_UP -i br-lan -m mac --mac-source aa:bb:cc:dd:ee:01 -j RETURN" "$(ipt_log)"
	assert_contains "DOWN uses resolved IP" \
		"-A HLIMIT_DOWN -o br-lan -d 10.0.0.50 -m hashlimit --hashlimit-name hl_down_br_lan_10_0_0_50" "$(ipt_log)"
	unset IPT_STUB_MAC_HELP

	# MAC resolvable nowhere but xt_mac available: upload-only on every LAN iface
	new_env
	dev_add_mac aa:bb:cc:dd:ee:99 2000 400 1 '离线'
	IPT_STUB_MAC_HELP=1
	export IPT_STUB_MAC_HELP
	ctl render
	assert_rc "render unresolved MAC with xt_mac" 0
	assert_contains "upload-only MAC rule" \
		"-A HLIMIT_UP -i br-lan -m mac --mac-source aa:bb:cc:dd:ee:99 -m hashlimit" "$(ipt_log)"
	assert_not_contains "no download rule" "-d 10.0.0.99" "$(ipt_log)"
	unset IPT_STUB_MAC_HELP

	# explicit override + libxt_mac.so file detection
	new_env
	dhcp_host_add 0 aa:bb:cc:dd:ee:01 10.0.0.50 '手机'
	dev_add_mac aa:bb:cc:dd:ee:01 5000 1000 1 '手机'
	HLIMIT_MAC_MATCH=1
	export HLIMIT_MAC_MATCH
	ctl render
	assert_contains "forced MAC match" "-A HLIMIT_UP -i br-lan -m mac --mac-source aa:bb:cc:dd:ee:01" "$(ipt_log)"
	unset HLIMIT_MAC_MATCH

	new_env
	dhcp_host_add 0 aa:bb:cc:dd:ee:01 10.0.0.50 '手机'
	dev_add_mac aa:bb:cc:dd:ee:01 5000 1000 1 '手机'
	mkdir -p "$E/libxt"
	: >"$E/libxt/libxt_mac.so"
	HLIMIT_LIBXT_DIR=$E/libxt
	export HLIMIT_LIBXT_DIR
	ctl render
	assert_contains "libxt_mac.so enables MAC match" \
		"-A HLIMIT_UP -i br-lan -m mac --mac-source aa:bb:cc:dd:ee:01" "$(ipt_log)"
	unset HLIMIT_LIBXT_DIR
}

# ---------------------------------------------------------------------------
# JSON list/status
# ---------------------------------------------------------------------------
test_json_list() {
	section "list/status: v1.2 JSON schema"
	new_env
	uci_put "hashlimit-qos.defaults.default_enabled=1"
	uci_put "hashlimit-qos.defaults.default_down_kbps=2000"
	uci_put "hashlimit-qos.defaults.default_up_kbps=500"
	dev_add 10.0.0.50 5000 1000 1 '客厅电视'
	grp_add 10.0.0.96 10.0.0.111 10000 2000 1 '访客' '10.0.0.110'
	printf '    1234    56789 DROP all -- * * 0.0.0.0/0 10.0.0.50\n' >"$IPT_STUB_DIR/ls.mangle.HLIMIT_DOWN"
	printf '       7      678 DROP all -- * * 10.0.0.50 0.0.0.0/0\n' >"$IPT_STUB_DIR/ls.mangle.HLIMIT_UP"
	ctl render
	ctl list
	assert_rc "list" 0
	assert_eq "single line" "1" "$(wc -l <"$E/out" | tr -d ' ')"
	python_json_ok "$E/out" && pass
	if command -v python3 >/dev/null 2>&1; then
		python3 - "$E/out" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1], encoding="utf-8").read())
import os
assert d["version"] == os.environ["HLIMIT_VER"], d
assert d["enabled"] == "1", d
dd = d["defaults"]
assert dd["scope"] == "all-lan", dd
assert dd["lan"][0]["device"] == "br-lan", dd
assert dd["lan"][0]["cidr"] == "10.0.0.0/8", dd
assert dd["gateway"] == "10.0.0.1", dd
assert dd["default_cidr"] == "" and dd["effective_cidr"] == "", dd
assert dd["default_exclude"] == [], dd
kinds = [x["kind"] for x in d["devices"]]
assert kinds == ["device", "group", "default"], kinds
dev, grp, dflt = d["devices"]
assert dev["ip"] == "10.0.0.50" and dev["label"] == "客厅电视", dev
assert dev["down_pkts"] == 1234 and dev["down_bytes"] == 56789, dev
assert dev["up_pkts"] == 7 and dev["up_bytes"] == 678, dev
assert dev["in_lan"] == "1" and dev["lan_dev"] == "br-lan", dev
assert grp["range"] == "10.0.0.96-10.0.0.111", grp
assert grp["start"] == "10.0.0.96" and grp["end"] == "10.0.0.111", grp
assert grp["exclude"] == ["10.0.0.110"], grp
assert grp["in_lan"] == "1", grp
assert dflt["interfaces"] == ["br-lan"], dflt
assert isinstance(d["warnings"], list) and d["warnings"], d
assert d["groups"][0]["kind"] == "group", d["groups"]
assert d["default"]["kind"] == "default", d["default"]
PY
		if [ $? -eq 0 ]; then pass; else fail "list schema failed"; fi
	fi

	# /32 rendering still parses counters
	printf '       1        2 DROP all -- * * 0.0.0.0/0 10.0.0.50/32\n' >"$IPT_STUB_DIR/ls.mangle.HLIMIT_DOWN"
	ctl list
	if grep -qF '"down_bytes":2' "$E/out"; then pass; else fail "could not parse /32 counter"; fi

	# status adds offload fields
	ctl status
	assert_rc "status" 0
	python_json_ok "$E/out" && pass
	assert_contains "offload field" '"offload_active":"0"' "$E/out"
}

test_json_escaping() {
	section "list: label escaping / sanitising"
	new_env
	dev_add 10.0.0.51 1000 1000 1 '客厅"电视\A'
	ctl list
	assert_rc "list" 0
	if command -v python3 >/dev/null 2>&1; then
		python3 - "$E/out" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding="utf-8").read()
assert "\n" not in raw.rstrip("\n"), "embedded newline"
d = json.loads(raw)
devs = [x for x in d["devices"] if x["kind"] == "device"]
assert devs[0]["label"] == '客厅"电视\\A', devs[0]
PY
		if [ $? -eq 0 ]; then pass; else fail "label escaping failed"; fi
	fi
}

# ---------------------------------------------------------------------------
# offload
# ---------------------------------------------------------------------------
test_offload() {
	section "offload: disabled while limiting, restored when idle/global off"
	new_env
	fw_defaults_add 1 1
	dev_add 10.0.0.50 5000 1000 1 t
	ctl offload-apply
	assert_rc "offload-apply" 0
	assert_contains "firewall offload disabled" "firewall.@defaults[0].flow_offloading=0" "$UCI_STUB_STATE"
	assert_contains "backup saved" "hashlimit-qos.offload_backup.saved=1" "$UCI_STUB_STATE"

	ctl offload-status
	python_json_ok "$E/out" && pass

	ctl offload-restore
	assert_rc "offload-restore" 0
	assert_contains "restored" "firewall.@defaults[0].flow_offloading=1" "$UCI_STUB_STATE"

	# group-only limit also disables offload
	new_env
	fw_defaults_add 1 1
	grp_add 10.0.0.96 10.0.0.111 10000 2000 1 g
	ctl offload-apply
	assert_contains "group triggers offload off" "firewall.@defaults[0].flow_offloading=0" "$UCI_STUB_STATE"
	ctl group-toggle 10.0.0.96/28 0
	assert_contains "group off restores offload" "firewall.@defaults[0].flow_offloading=1" "$UCI_STUB_STATE"

	# default-only limit also disables offload
	new_env
	fw_defaults_add 1 1
	ctl set-default 1 2000 500
	assert_contains "default triggers offload off" "firewall.@defaults[0].flow_offloading=0" "$UCI_STUB_STATE"
	: >"$(ipt_log)"
	ctl global 0
	assert_contains "global off restores offload" "firewall.@defaults[0].flow_offloading=1" "$UCI_STUB_STATE"
	assert_not_contains "global off flushes rules" "-A HLIMIT_UP -i br-lan" "$(ipt_log)"
}

# ---------------------------------------------------------------------------
# apply / hook / anonymous sections / multi LAN already covered
# ---------------------------------------------------------------------------
test_apply() {
	section "apply: commit + migrate + offload + render"
	new_env
	uci_put "hashlimit-qos.defaults.default_cidr=192.168.2.0/24"
	dev_add 192.168.2.162 5000 1000 1 '客厅电视'
	cat >"$HLIMIT_LEASES" <<'EOF'
43200 aa:bb:cc:dd:ee:01 10.0.0.162 客厅电视 01:1c
EOF
	ctl apply
	assert_rc "apply" 0
	assert_contains "migrated during apply" "dev_192_168_2_162.ip=10.0.0.162" "$UCI_STUB_STATE"
	if grep -q 'default_cidr' "$UCI_STUB_STATE"; then fail "apply left default_cidr"; else pass; fi
	assert_contains "rules rendered" "-A HLIMIT_UP -i br-lan -s 10.0.0.162 -m hashlimit" "$(ipt_log)"
}

test_hook() {
	section "install-hook / remove-hook"
	HOOK_NEEDLE='[ -x /usr/sbin/hlimit-ctl ] && HLIMIT_IN_FW3=1 /usr/sbin/hlimit-ctl render >/dev/null 2>&1'
	new_env
	cat >"$E/firewall.user" <<'EOF'
# user rules
iptables -A INPUT -p tcp --dport 1234 -j ACCEPT
EOF
	cp "$E/firewall.user" "$E/original"
	ctl install-hook
	assert_rc "install-hook" 0
	assert_count "hook once" "$HOOK_NEEDLE" "$E/firewall.user" 1
	assert_contains "original kept" 'iptables -A INPUT -p tcp --dport 1234 -j ACCEPT' "$E/firewall.user"
	ctl install-hook
	assert_count "still one hook" "$HOOK_NEEDLE" "$E/firewall.user" 1
	ctl remove-hook
	assert_rc "remove-hook" 0
	if cmp -s "$E/firewall.user" "$E/original"; then pass; else fail "remove-hook did not restore"; fi
}

test_anonymous_sections() {
	section "UCI: anonymous GridSection sections (cfgXXXXXX)"
	new_env
	{
		printf 'hashlimit-qos.cfg0a1b2c=device\n'
		printf 'hashlimit-qos.cfg0a1b2c.ip=10.0.0.50\n'
		printf 'hashlimit-qos.cfg0a1b2c.label=匿名设备\n'
		printf 'hashlimit-qos.cfg0a1b2c.enabled=1\n'
		printf 'hashlimit-qos.cfg0a1b2c.down_kbps=5000\n'
		printf 'hashlimit-qos.cfg0a1b2c.up_kbps=1000\n'
		printf 'hashlimit-qos.cfg0d4e5f=group\n'
		printf 'hashlimit-qos.cfg0d4e5f.cidr=10.0.0.96/28\n'
		printf 'hashlimit-qos.cfg0d4e5f.enabled=1\n'
		printf 'hashlimit-qos.cfg0d4e5f.down_kbps=10000\n'
		printf 'hashlimit-qos.cfg0d4e5f.up_kbps=2000\n'
	} >>"$UCI_STUB_STATE"
	ctl render
	assert_rc "anonymous render" 0
	assert_contains "anonymous device rule" "-A HLIMIT_UP -i br-lan -s 10.0.0.50 -m hashlimit" "$(ipt_log)"
	assert_contains "anonymous group rule" "-A HLIMIT_DOWN -o br-lan -m iprange --dst-range 10.0.0.96-10.0.0.111 -m hashlimit" "$(ipt_log)"
	ctl set 10.0.0.50 6000 1200 'x' 1
	assert_contains "set reuses anonymous section" "hashlimit-qos.cfg0a1b2c.down_kbps=6000" "$UCI_STUB_STATE"
	if grep -q '^hashlimit-qos\.dev_10_0_0_50=' "$UCI_STUB_STATE"; then fail "duplicate device section"; else pass; fi
}

# ---------------------------------------------------------------------------
# validation / legacy commands
# ---------------------------------------------------------------------------
test_validation() {
	section "validation / deprecated commands / exit codes"
	new_env
	for ip in 999.1.1.1 1.2.3 abc 010.0.0.1 1.2.3.4.5; do
		ctl set "$ip" 1000 1000
		assert_rc "invalid ip '$ip'" 2
	done
	for v in -1 1000001 1.5 abc 001000; do
		ctl set 10.0.0.50 "$v" 1000
		assert_rc "invalid down '$v'" 2
	done
	ctl set 10.0.0.50 1000 1000 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx 1
	assert_rc "label too long" 2
	ctl set 10.0.0.50 0 1000000
	assert_rc "rate boundaries" 0
	ctl set
	assert_rc "set usage" 1
	ctl global 2
	assert_rc "global invalid" 2
	ctl bogus
	assert_rc "unknown command" 1
	ctl exclude-add 10.0.0.5
	assert_rc "deprecated exclude-add" 2
	assert_contains "deprecated hint" "group-exclude-add" "$E/err"
	ctl exclude-del 10.0.0.5
	assert_rc "deprecated exclude-del" 2
}

# ---------------------------------------------------------------------------
# ipk build + init semantics + hotplug
# ---------------------------------------------------------------------------
test_build_ipk() {
	section "build-ipk.sh"
	new_env
	OUT_DIR=$E/build
	HLIMIT_VERSION=9.9.9
	export OUT_DIR HLIMIT_VERSION
	if sh "$ROOT/scripts/build-ipk.sh" >"$E/build.log" 2>&1; then pass; else
		fail "build-ipk.sh failed: $(tail -n 5 "$E/build.log")"
		unset OUT_DIR HLIMIT_VERSION
		return 0
	fi
	unset OUT_DIR HLIMIT_VERSION
	IPK=$E/build/luci-app-hlimit_9.9.9_all.ipk
	[ -f "$IPK" ] && pass || fail "ipk not created"
	[ -f "$E/build/luci-app-hlimit_9.9.9_all.tar.gz" ] && pass || fail "source tarball not created"
	_members=$(tar -tzf "$IPK" | tr '\n' ' ')
	assert_eq "ipk members" "./debian-binary ./control.tar.gz ./data.tar.gz " "$_members"
	tar -xzOf "$IPK" ./control.tar.gz 2>/dev/null | tar -xzOf - ./control >"$E/control" 2>/dev/null
	assert_contains "control Package" "Package: luci-app-hlimit" "$E/control"
	assert_contains "control Version" "Version: 9.9.9" "$E/control"
	assert_contains "control Arch all" "Architecture: all" "$E/control"
	assert_contains "control Depends hashlimit" "iptables-mod-hashlimit" "$E/control"
	_data_list=$E/data.list
	tar -xzOf "$IPK" ./data.tar.gz 2>/dev/null | tar -tzf - 2>/dev/null >"$_data_list"
	assert_contains "data has ctl" "./usr/sbin/hlimit-ctl" "$_data_list"
	assert_contains "data has init.d" "./etc/init.d/hashlimit-qos" "$_data_list"
	assert_contains "data has config" "./etc/config/hashlimit-qos" "$_data_list"
	assert_contains "data has uci-defaults" "./etc/uci-defaults/90-hlimit-qos" "$_data_list"
	assert_contains "data has hotplug" "./etc/hotplug.d/dhcp/90-hlimit" "$_data_list"
}

test_init_semantics() {
	section "init.d / uninstall semantics"
	assert_contains "start migrates" 'hlimit-ctl migrate' "$ROOT/files/etc/init.d/hashlimit-qos"
	assert_contains "start offload first" 'offload-apply' "$ROOT/files/etc/init.d/hashlimit-qos"
	assert_contains "start renders" 'hlimit-ctl render' "$ROOT/files/etc/init.d/hashlimit-qos"
	assert_contains "stop flushes" 'hlimit-ctl flush' "$ROOT/files/etc/init.d/hashlimit-qos"
	assert_contains "stop restores offload" 'offload-restore' "$ROOT/files/etc/init.d/hashlimit-qos"
	assert_contains "uninstall removes mangle up jump" 'remove_jump mangle PREROUTING HLIMIT_UP' "$ROOT/scripts/uninstall.sh"
	assert_contains "uninstall removes v1 filter jump" 'remove_jump filter FORWARD HLIMIT_UP' "$ROOT/scripts/uninstall.sh"
	assert_contains "uninstall removes hotplug" '/etc/hotplug.d/dhcp/90-hlimit' "$ROOT/scripts/uninstall.sh"
	[ -x "$ROOT/files/etc/hotplug.d/dhcp/90-hlimit" ] && pass || fail "hotplug not executable"
}

test_hotplug() {
	section "hotplug: debounced re-render"
	new_env
	HP=$E/bin
	mkdir -p "$HP"
	cat >"$HP/hlimit-ctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$HOTPLUG_LOG"
exit 0
EOF
	chmod 0755 "$HP/hlimit-ctl"
	HOTPLUG_LOG=$E/hotplug.log
	export HOTPLUG_LOG
	: >"$HOTPLUG_LOG"
	HLIMIT_CTL_BIN="$HP/hlimit-ctl" HLIMIT_HOTPLUG_DELAY=0 \
		sh "$ROOT/files/etc/hotplug.d/dhcp/90-hlimit"
	assert_rc "hotplug sync" 0
	assert_contains "hotplug calls render" "render" "$HOTPLUG_LOG"

	: >"$HOTPLUG_LOG"
	mkdir "$E/hotplug.lock"
	HLIMIT_CTL_BIN="$HP/hlimit-ctl" HLIMIT_HOTPLUG_DELAY=5 \
		HLIMIT_HOTPLUG_LOCK="$E/hotplug.lock" \
		sh "$ROOT/files/etc/hotplug.d/dhcp/90-hlimit"
	assert_rc "hotplug with lock" 0
	if [ -s "$HOTPLUG_LOG" ]; then fail "rendered while lock held"; else pass; fi
	rmdir "$E/hotplug.lock"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

test_group_exclude_192() {
	section "per-group whitelist on a 192.168.2.1/24 LAN"
	new_env
	lan_192
	grp_add 192.168.2.96 192.168.2.111 10000 2000 1 g
	ctl group-exclude-add 192.168.2.96/28 192.168.2.100
	assert_rc "group-exclude-add 192" 0
	assert_contains "exclude UP on br-lan" \
		"-A HLIMIT_UP -i br-lan -s 192.168.2.100 -j RETURN" "$(ipt_log)"
	assert_contains "exclude DOWN on br-lan" \
		"-A HLIMIT_DOWN -o br-lan -d 192.168.2.100 -j RETURN" "$(ipt_log)"
	assert_contains "group rule on 192 LAN" \
		"-A HLIMIT_UP -i br-lan -m iprange --src-range 192.168.2.96-192.168.2.111 -m hashlimit --hashlimit-name hl_up_grp_br_lan_1" "$(ipt_log)"
	ctl group-exclude-add 192.168.2.96/28 192.168.2.200
	assert_rc "outside cidr rejected on 192" 2
}

test_default_counters() {
	section "list: default-limit counters by hashlimit name"
	new_env
	ctl set-default 1 2000 500
	_c=$IPT_STUB_DIR
	# `-L` does not show the hashlimit name: build fixtures aligned with -S
	# (locate the default rule dynamically: the DOWN chain no longer starts
	#  with the removed gateway exemption).
	_uidx=$(grep -n -- '--hashlimit-name hl_up_def_br_lan' \
		"$_c/rules.mangle.HLIMIT_UP" | head -n 1 | cut -d: -f1)
	_didx=$(grep -n -- '--hashlimit-name hl_down_def_br_lan' \
		"$_c/rules.mangle.HLIMIT_DOWN" | head -n 1 | cut -d: -f1)
	[ -n "$_uidx" ] || _uidx=2
	[ -n "$_didx" ] || _didx=1
	awk -v want="$_uidx" 'BEGIN { n = 0 }
		{ n++; if (n == want) printf "  111 2222 DROP all -- * * 0.0.0.0/0 0.0.0.0/0\n";
		  else printf "    0 0 RETURN all -- * * 0.0.0.0/0 0.0.0.0/0\n" }' \
		"$_c/rules.mangle.HLIMIT_UP" >"$_c/ls.mangle.HLIMIT_UP"
	awk -v want="$_didx" 'BEGIN { n = 0 }
		{ n++; if (n == want) printf "  333 4444 DROP all -- * * 0.0.0.0/0 0.0.0.0/0\n";
		  else printf "    0 0 RETURN all -- * * 0.0.0.0/0 0.0.0.0/0\n" }' \
		"$_c/rules.mangle.HLIMIT_DOWN" >"$_c/ls.mangle.HLIMIT_DOWN"
	ctl list
	assert_rc "list with fixtures" 0
	if command -v python3 >/dev/null 2>&1; then
		python3 - "$E/out" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1], encoding="utf-8").read())
dflt = d["default"]
assert dflt["up_pkts"] == 111, dflt
assert dflt["up_bytes"] == 2222, dflt
assert dflt["down_pkts"] == 333, dflt
assert dflt["down_bytes"] == 4444, dflt
PY
		if [ $? -eq 0 ]; then pass; else fail "default counters wrong: $(cat "$E/out")"; fi
	fi
}

test_hostname_reverse_dns() {
	section "devices: hostname from dnsmasq reverse lookup"
	new_env
	cat >"$HLIMIT_ARP" <<'EOF'
IP address       HW type     Flags       HW address            Mask     Device
10.0.0.55        0x1         0x2         aa:bb:cc:dd:ee:55     *        br-lan
EOF
	mkdir -p "$E/bin"
	cat >"$E/bin/nslookup" <<'EOF'
#!/bin/sh
printf 'Name:    Reversed.lan\n'
EOF
	chmod 0755 "$E/bin/nslookup"
	DNS_SAVE=$HLIMIT_NO_DNS
	NS_SAVE=${HLIMIT_NSLOOKUP:-}
	HLIMIT_NO_DNS=0
	HLIMIT_NSLOOKUP=$E/bin/nslookup
	export HLIMIT_NO_DNS HLIMIT_NSLOOKUP
	ctl devices
	HLIMIT_NO_DNS=$DNS_SAVE
	if [ -n "$NS_SAVE" ]; then HLIMIT_NSLOOKUP=$NS_SAVE; else unset HLIMIT_NSLOOKUP; fi
	export HLIMIT_NO_DNS
	assert_rc "devices with reverse dns" 0
	assert_contains "reverse name used" '"name":"Reversed"' "$E/out"
}

test_warnings_invalid() {
	section "status/list: warnings for out-of-LAN device/group"
	new_env
	dev_add 192.168.2.50 5000 1000 1 'old-dev'
	grp_add 192.168.2.96 192.168.2.111 10000 2000 1 'old-grp'
	ctl list
	assert_rc "list with invalid config" 0
	if command -v python3 >/dev/null 2>&1; then
		python3 - "$E/out" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1], encoding="utf-8").read())
w = "\n".join(d["warnings"])
assert "old-dev" in w, w
assert "old-grp" in w or "192.168.2.96-192.168.2.111" in w, w
assert "IPv6" in w, w
dev = [x for x in d["devices"] if x["kind"] == "device"][0]
assert dev["in_lan"] == "0", dev
grp = [x for x in d["groups"] if x["kind"] == "group"][0]
assert grp["in_lan"] == "0", grp
PY
		if [ $? -eq 0 ]; then pass; else fail "invalid warnings missing: $(cat "$E/out")"; fi
	fi
}


test_reverse_dns_timeout() {
	section "devices: reverse DNS is time boxed"
	new_env
	cat >"$HLIMIT_ARP" <<'EOF'
IP address       HW type     Flags       HW address            Mask     Device
10.0.0.66        0x1         0x2         aa:bb:cc:dd:ee:66     *        br-lan
EOF
	mkdir -p "$E/bin"
	cat >"$E/bin/slow-nslookup" <<'EOF'
#!/bin/sh
exec sleep 5
EOF
	chmod 0755 "$E/bin/slow-nslookup"
	DNS_SAVE=$HLIMIT_NO_DNS
	NS_SAVE=${HLIMIT_NSLOOKUP:-}
	TMO_SAVE=${HLIMIT_DNS_TIMEOUT:-}
	HLIMIT_NO_DNS=0
	HLIMIT_NSLOOKUP=$E/bin/slow-nslookup
	HLIMIT_DNS_TIMEOUT=1
	export HLIMIT_NO_DNS HLIMIT_NSLOOKUP HLIMIT_DNS_TIMEOUT
	_t0=$(date +%s)
	ctl devices
	_t1=$(date +%s)
	HLIMIT_NO_DNS=$DNS_SAVE
	if [ -n "$NS_SAVE" ]; then HLIMIT_NSLOOKUP=$NS_SAVE; else unset HLIMIT_NSLOOKUP; fi
	if [ -n "$TMO_SAVE" ]; then HLIMIT_DNS_TIMEOUT=$TMO_SAVE; else unset HLIMIT_DNS_TIMEOUT; fi
	export HLIMIT_NO_DNS
	assert_rc "devices with slow DNS" 0
	assert_contains "online detected without name" '"online":"1"' "$E/out"
	if [ "$((_t1 - _t0))" -le 3 ]; then pass; else fail "reverse DNS not time boxed: $((_t1 - _t0))s"; fi
}


test_group_exclude_multi_lan_scope() {
	section "regression: MAC/IP group whitelist must not clobber the group scope"
	# classA-like topology: hlan0 = 10.0.0.1/8, hlan1 = 10.0.1.1/24.
	# The MAC exclude resolves to an IP in the OTHER LAN segment, which used to
	# overwrite render_groups()'s _cidr/_dev through ip_in_lan().
	new_env
	lan_guest_add
	grp_add 10.0.0.96 10.0.0.111 10000 2000 1 'G1'
	grp_add 10.0.1.0 10.0.1.255 10000 2000 1 'G2' '52:44:2b:49:8f:e7'
	dhcp_host_add 0 52:44:2b:49:8f:e7 10.0.0.162 'phone'
	ctl render
	assert_rc "render multi-LAN group with MAC exclude" 0

	assert_contains "G1 keeps its own CIDR/interface" \
		"-A HLIMIT_UP -i br-lan -m iprange --src-range 10.0.0.96-10.0.0.111 -m hashlimit --hashlimit-name hl_up_grp_br_lan_1" "$(ipt_log)"
	assert_contains "G2 UP uses its own CIDR/interface" \
		"-A HLIMIT_UP -i br-guest -m iprange --src-range 10.0.1.0-10.0.1.255 -m hashlimit --hashlimit-name hl_up_grp_br_guest_2" "$(ipt_log)"
	assert_contains "G2 DOWN uses its own CIDR/interface" \
		"-A HLIMIT_DOWN -o br-guest -m iprange --dst-range 10.0.1.0-10.0.1.255 -m hashlimit --hashlimit-name hl_down_grp_br_guest_2" "$(ipt_log)"
	assert_contains "G2 UP RETURN uses its own CIDR/interface" \
		"-A HLIMIT_UP -i br-guest -m iprange --src-range 10.0.1.0-10.0.1.255 -j RETURN" "$(ipt_log)"
	assert_not_contains "G2 was NOT rewritten to the first LAN net/iface (CIDR)" \
		"-s 10.0.0.0/8 -i br-lan -m hashlimit --hashlimit-name hl_up_grp_br_lan_2" "$(ipt_log)"
	# G1 的区间只属于 br-lan，不能被写到 br-guest 上（区间/网口不串用）
	assert_not_contains "G1 range is not applied on br-guest" \
		"-i br-guest -m iprange --src-range 10.0.0.96-10.0.0.111" "$(ipt_log)"
	# the MAC whitelist resolves against the other segment but stays on G2's iface
	assert_contains "MAC exclude resolves to IP on G2 iface (UP)" \
		"-A HLIMIT_UP -i br-guest -s 10.0.0.162 -j RETURN" "$(ipt_log)"
	assert_contains "MAC exclude resolves to IP on G2 iface (DOWN)" \
		"-A HLIMIT_DOWN -o br-guest -d 10.0.0.162 -j RETURN" "$(ipt_log)"

	# same scenario with a plain IP whitelist
	new_env
	lan_guest_add
	grp_add 10.0.0.96 10.0.0.111 10000 2000 1 'G1'
	grp_add 10.0.1.0 10.0.1.255 10000 2000 1 'G2' '10.0.1.50'
	ctl render
	assert_rc "render multi-LAN group with IP exclude" 0
	assert_contains "G2 UP stays on its CIDR/iface (IP exclude)" \
		"-A HLIMIT_UP -i br-guest -m iprange --src-range 10.0.1.0-10.0.1.255 -m hashlimit --hashlimit-name hl_up_grp_br_guest_2" "$(ipt_log)"
	assert_contains "IP exclude RETURN on G2 iface" \
		"-A HLIMIT_UP -i br-guest -s 10.0.1.50 -j RETURN" "$(ipt_log)"
	assert_not_contains "G2 not rewritten to first LAN (IP exclude)" \
		"-s 10.0.0.0/8 -i br-lan -m hashlimit --hashlimit-name hl_up_grp_br_lan_2" "$(ipt_log)"
}


test_proxy_reply_down_not_exempt() {
	section "DOWN: OpenClash proxy replies (src=router LAN IP) are not exempt"
	new_env
	dev_add 10.0.0.162 5000 1000 1 'proxy-client'
	ctl render
	assert_rc "render" 0
	assert_not_contains "no DOWN -s <lan_ip> RETURN" \
		"-t mangle -A HLIMIT_DOWN -s 10.0.0.1 -j RETURN" "$(ipt_log)"
	if grep -q -- "-A HLIMIT_DOWN -s 10.0.0.1" "$(ipt_log)"; then
		fail "DOWN chain matches the router LAN IP as source (proxy replies would bypass)"
	else
		pass
	fi
	# the very first DOWN rule is the device DROP: a proxy reply with
	# src=10.0.0.1 still matches it through -o br-lan -d 10.0.0.162.
	_first=$(grep -E '^-t mangle -A HLIMIT_DOWN ' "$(ipt_log)" | head -n 1)
	case "$_first" in
	*"-o br-lan -d 10.0.0.162 -m hashlimit --hashlimit-name hl_down_br_lan_10_0_0_162"*)
		pass
		;;
	*) fail "first DOWN rule is not the device DROP: $_first" ;;
	esac
	# UP still protects traffic TO the router (LuCI/DNS)
	assert_contains "UP gateway protection kept" \
		"-t mangle -A HLIMIT_UP -d 10.0.0.1 -j RETURN" "$(ipt_log)"

	# default limit: same guarantee, the first DOWN rule is the default DROP
	new_env
	ctl set-default 1 2000 500
	: >"$(ipt_log)"
	ctl render
	assert_rc "render default" 0
	assert_not_contains "no DOWN gateway exemption with default limit" \
		"-A HLIMIT_DOWN -s 10.0.0.1 -j RETURN" "$(ipt_log)"
	_first=$(grep -E '^-t mangle -A HLIMIT_DOWN ' "$(ipt_log)" | head -n 1)
	case "$_first" in
	*"-o br-lan -m hashlimit --hashlimit-name hl_down_def_br_lan"*) pass ;;
	*) fail "first DOWN rule is not the default DROP: $_first" ;;
	esac
}

run_suite() {
	test_syntax
	test_render_basic_10
	test_proxy_reply_down_not_exempt
	test_render_192
	test_render_multi_lan
	test_render_conversion
	test_burst_fallback
	test_priority
	test_disabled_device
	test_legacy_cleanup
	test_idempotent_flush
	test_render_failure
	test_default_limit
	test_group_crud
	test_group_exclude
	test_group_exclude_192
	test_group_exclude_multi_lan_scope
	test_scan_10
	test_scan_192
	test_scan_empty
	test_devices_lan_only
	test_migrate_label_192to10
	test_migrate_reverse
	test_migrate_mac_refresh
	test_migrate_last_octet
	test_migrate_stale
	test_migrate_invalid_group
	test_set_label
	test_set_mac_commands
	test_mac_resolution
	test_mac_match
	test_json_list
	test_json_escaping
	test_default_counters
	test_hostname_reverse_dns
	test_reverse_dns_timeout
	test_warnings_invalid
	test_offload
	test_apply
	test_hook
	test_anonymous_sections
	test_validation
	test_build_ipk
	test_init_semantics
	test_hotplug
}

section "running suite under: sh ($(readlink -f /bin/sh 2>/dev/null || echo sh))"
CURRENT_SHELL=sh
run_suite

if command -v busybox >/dev/null 2>&1; then
	section "running suite under: busybox ash"
	CURRENT_SHELL=busybox
	run_suite
fi

printf '\n============================================\n'
printf 'PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
	exit 1
fi
exit 0
