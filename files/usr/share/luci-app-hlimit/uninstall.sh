#!/bin/sh
# ---------------------------------------------------------------------------
# uninstall.sh - completely remove luci-app-hlimit (1.2.0) from a running device.
#
# Safe to run multiple times. It removes, in this order:
#   1. the /etc/firewall.user hook (before any firewall restart, otherwise the
#      hook would immediately re-add the rules)
#   2. the service (stop + disable) and our iptables rules: mangle
#      PREROUTING/POSTROUTING jumps + chains, plus any stale v1.0 filter
#      FORWARD/INPUT/OUTPUT jumps and filter chains
#   3. restored FLOWOFFLOAD/turboacc settings (offload-restore)
#   4. the UCI config
#   5. the installed files / LuCI menu / ACL / view / DHCP hotplug helper
#   6. rc.d symlinks and LuCI caches; finally restarts rpcd and uhttpd
#
# It does NOT touch /etc/dropbear/authorized_keys: that file may hold the
# user's own SSH keys, removing it could lock the owner out.
# ---------------------------------------------------------------------------
set -u

IPT=${HLIMIT_IPTABLES:-iptables}
FW_USER=${HLIMIT_FIREWALL_USER:-/etc/firewall.user}

say()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

say "removing /etc/firewall.user hook"
if [ -x /usr/sbin/hlimit-ctl ]; then
	/usr/sbin/hlimit-ctl remove-hook >/dev/null 2>&1
else
	# hlimit-ctl already gone: strip the marked block with awk
	if [ -f "$FW_USER" ]; then
		tmp="$FW_USER.hlimit.$$"
		awk '
			$0 ~ /^# BEGIN hlimit-qos/ { skip = 1; next }
			skip && $0 ~ /^# END hlimit-qos/ { skip = 0; next }
			skip { next }
			$0 ~ /^\[ -x \/usr\/sbin\/hlimit-ctl \] && .*hlimit-ctl render/ { next }
			{ print }
		' "$FW_USER" >"$tmp" && cat "$tmp" >"$FW_USER"
		rm -f "$tmp"
	fi
fi

say "stopping service"
if [ -x /etc/init.d/hashlimit-qos ]; then
	/etc/init.d/hashlimit-qos disable >/dev/null 2>&1
fi
if [ -x /usr/sbin/hlimit-ctl ]; then
	# flush drops both the mangle jumps and the stale v1.0 filter jumps
	/usr/sbin/hlimit-ctl flush >/dev/null 2>&1
fi

say "restoring FLOWOFFLOAD/turboacc settings"
if [ -x /usr/sbin/hlimit-ctl ]; then
	/usr/sbin/hlimit-ctl offload-restore >/dev/null 2>&1
fi

say "removing iptables rules"
remove_jump() {
	# remove_jump <table> <parent chain> <our chain>
	n=0
	while [ "$n" -lt 32 ]; do
		"$IPT" -t "$1" -C "$2" -j "$3" >/dev/null 2>&1 || break
		"$IPT" -t "$1" -D "$2" -j "$3" >/dev/null 2>&1 || break
		n=$((n + 1))
	done
}
# v1.1 locations
remove_jump mangle PREROUTING HLIMIT_UP
remove_jump mangle POSTROUTING HLIMIT_DOWN
# stale v1.0 locations
remove_jump filter FORWARD HLIMIT_UP
remove_jump filter FORWARD HLIMIT_DOWN
remove_jump filter INPUT HLIMIT_UP
remove_jump filter OUTPUT HLIMIT_DOWN

for table in mangle filter; do
	for chain in HLIMIT_UP HLIMIT_DOWN; do
		"$IPT" -t "$table" -F "$chain" >/dev/null 2>&1
		"$IPT" -t "$table" -X "$chain" >/dev/null 2>&1
	done
done

say "removing UCI configuration"
uci -q delete hashlimit-qos >/dev/null 2>&1
uci -q commit >/dev/null 2>&1
rm -f /etc/config/hashlimit-qos

say "removing installed files"
if command -v opkg >/dev/null 2>&1 && opkg list-installed 2>/dev/null | grep -q '^luci-app-hlimit '; then
	opkg remove luci-app-hlimit >/dev/null 2>&1 || warn "opkg remove failed, removing files manually"
fi
rm -f /etc/init.d/hashlimit-qos \
	/etc/uci-defaults/90-hlimit-qos \
	/etc/hotplug.d/dhcp/90-hlimit \
	/usr/sbin/hlimit-ctl \
	/usr/share/luci/menu.d/luci-app-hlimit.json \
	/usr/share/rpcd/acl.d/luci-app-hlimit.json
rm -rf /www/luci-static/resources/view/hlimit
rm -rf /usr/share/luci-app-hlimit
rm -f /etc/rc.d/S99hashlimit-qos /etc/rc.d/K10hashlimit-qos
rm -f "${FW_USER}.bak.hlimit"
rm -f /tmp/hlimit-hotplug-render.lock
rmdir /tmp/hlimit-hotplug-render.lock 2>/dev/null

say "clearing LuCI caches"
rm -f /tmp/luci-indexcache* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null

say "restarting rpcd/uhttpd"
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd restart >/dev/null 2>&1
[ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart >/dev/null 2>&1

say "done - luci-app-hlimit removed"
