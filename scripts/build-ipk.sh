#!/bin/sh
# ---------------------------------------------------------------------------
# build-ipk.sh - build a standard luci-app-hlimit .ipk without the OpenWrt SDK
#
# The .ipk format used by the target's opkg is a **gzip compressed tar**
# archive containing three members (verified against official OpenWrt 24.10
# packages: `tar -tzf pkg.ipk` lists ./debian-binary ./control.tar.gz
# ./data.tar.gz).  A Debian style `ar` archive is rejected by this opkg with
# "Malformed package file".
#
#   ./debian-binary   -> "2.0\n"
#   ./control.tar.gz  -> ./control ./postinst ./prerm ./conffiles
#   ./data.tar.gz     -> ./etc/... ./usr/... ./www/...
#
# Usage:
#   scripts/build-ipk.sh                # output into ./build/
#   OUT_DIR=/tmp/out scripts/build-ipk.sh
#   HLIMIT_VERSION=1.0.1 scripts/build-ipk.sh
#
# Requirements on the build host: tar, gzip.
# ---------------------------------------------------------------------------
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PKG_NAME=luci-app-hlimit
PKG_VERSION=${HLIMIT_VERSION:-1.3.4}
PKG_ARCH=all
OUT_DIR=${OUT_DIR:-$ROOT_DIR/build}

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v tar >/dev/null 2>&1 || die "tar not found"
command -v gzip >/dev/null 2>&1 || die "gzip not found"

# ---------------------------------------------------------------------------
# sanity check the payload
# ---------------------------------------------------------------------------
required_files="
etc/config/hashlimit-qos
etc/init.d/hashlimit-qos
etc/uci-defaults/90-hlimit-qos
etc/hotplug.d/dhcp/90-hlimit
usr/sbin/hlimit-ctl
usr/share/luci-app-hlimit/uninstall.sh
"

for rel in $required_files; do
	[ -f "$ROOT_DIR/files/$rel" ] || die "missing required file: files/$rel"
done

ui_files="
usr/share/luci/menu.d/luci-app-hlimit.json
usr/share/rpcd/acl.d/luci-app-hlimit.json
www/luci-static/resources/view/hlimit/overview.js
"
for rel in $ui_files; do
	[ -f "$ROOT_DIR/files/$rel" ] || warn "UI file missing: files/$rel (the .ipk will not ship the LuCI page)"
done

log "checking shell syntax"
for s in \
	"$ROOT_DIR/files/usr/sbin/hlimit-ctl" \
	"$ROOT_DIR/files/etc/init.d/hashlimit-qos" \
	"$ROOT_DIR/files/etc/uci-defaults/90-hlimit-qos" \
	"$ROOT_DIR/files/etc/hotplug.d/dhcp/90-hlimit" \
	"$ROOT_DIR/scripts/uninstall.sh"; do
	[ -f "$s" ] || continue
	sh -n "$s" || die "syntax error: $s"
done

# ---------------------------------------------------------------------------
# stage data
# ---------------------------------------------------------------------------
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/hlimit-ipk.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

DATA_DIR=$TMP_DIR/data
CONTROL_DIR=$TMP_DIR/control
mkdir -p "$DATA_DIR" "$CONTROL_DIR"
cp -a "$ROOT_DIR/files/." "$DATA_DIR/"

chmod 0644 "$DATA_DIR/etc/config/hashlimit-qos"
chmod 0755 "$DATA_DIR/etc/init.d/hashlimit-qos" \
	"$DATA_DIR/etc/uci-defaults/90-hlimit-qos" \
	"$DATA_DIR/etc/hotplug.d/dhcp/90-hlimit" \
	"$DATA_DIR/usr/sbin/hlimit-ctl" \
	"$DATA_DIR/usr/share/luci-app-hlimit/uninstall.sh"
if [ -d "$DATA_DIR/www" ]; then
	find "$DATA_DIR/www" -type f -exec chmod 0644 {} +
fi
if [ -d "$DATA_DIR/usr/share" ]; then
	find "$DATA_DIR/usr/share" -type f -exec chmod 0644 {} +
fi
# the uninstaller is under /usr/share but must stay executable
chmod 0755 "$DATA_DIR/usr/share/luci-app-hlimit/uninstall.sh"
# normalise directory modes (the repository uses setgid/sticky dirs) and use
# root:root ownership inside the archive like opkg-build does.
# chmod 0755 alone keeps the setuid/setgid bits on directories here, so clear
# the special bits first and then apply the plain mode.
find "$DATA_DIR" -type d -exec chmod a-s {} +
find "$DATA_DIR" -type d -exec chmod 0755 {} +

INSTALLED_SIZE=$(du -sk "$DATA_DIR" | awk '{print $1}')
[ -n "$INSTALLED_SIZE" ] || INSTALLED_SIZE=0

# ---------------------------------------------------------------------------
# control archive
# ---------------------------------------------------------------------------
cat >"$CONTROL_DIR/control" <<EOF
Package: $PKG_NAME
Version: $PKG_VERSION
Depends: libc, luci-base, rpcd, rpcd-mod-file, iptables, iptables-mod-hashlimit, iptables-mod-iprange, firewall
Source: $PKG_NAME
SourceName: $PKG_NAME
License: MIT
Section: luci
Priority: optional
Architecture: $PKG_ARCH
Installed-Size: $INSTALLED_SIZE
Maintainer: shorekeeper-blackshore
Description: LuCI per-device/per-range/default rate limit (iptables hashlimit)
 Per-device, per-range (batch) and default upload/download policing for OpenWrt
 fw3 + iptables legacy systems without tc/nft. Rules are bound to the detected
 LAN interface (-i/-o), so overlapping WAN subnets are never limited. Mangle
 PREROUTING/POSTROUTING hooks cover OpenClash REDIRECT/TPROXY traffic.
 Provides the "Network -> Device Rate Limit" LuCI page and hlimit-ctl backend.
EOF

printf '/etc/config/hashlimit-qos\n' >"$CONTROL_DIR/conffiles"

cat >"$CONTROL_DIR/postinst" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
rm -f /tmp/luci-indexcache* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
if [ -x /usr/sbin/hlimit-ctl ]; then
	# keep rules alive across fw3 reloads and reboots
	/usr/sbin/hlimit-ctl install-hook >/dev/null 2>&1
	/etc/init.d/hashlimit-qos enable >/dev/null 2>&1
	/usr/sbin/hlimit-ctl migrate >/dev/null 2>&1
	/usr/sbin/hlimit-ctl offload-apply >/dev/null 2>&1
	/usr/sbin/hlimit-ctl render >/dev/null 2>&1
fi
/etc/init.d/rpcd reload >/dev/null 2>&1
exit 0
EOF

cat >"$CONTROL_DIR/prerm" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
if [ -x /etc/init.d/hashlimit-qos ]; then
	/etc/init.d/hashlimit-qos stop >/dev/null 2>&1
	/etc/init.d/hashlimit-qos disable >/dev/null 2>&1
fi
[ -x /usr/sbin/hlimit-ctl ] && /usr/sbin/hlimit-ctl remove-hook >/dev/null 2>&1
[ -x /usr/sbin/hlimit-ctl ] && /usr/sbin/hlimit-ctl offload-restore >/dev/null 2>&1
exit 0
EOF

chmod 0644 "$CONTROL_DIR/control" "$CONTROL_DIR/conffiles"
chmod 0755 "$CONTROL_DIR/postinst" "$CONTROL_DIR/prerm"

# ---------------------------------------------------------------------------
# assemble the ipk
# ---------------------------------------------------------------------------
printf '2.0\n' >"$TMP_DIR/debian-binary"

if tar --version 2>/dev/null | grep -q 'GNU tar'; then
	TAR_OWNER="--owner=0 --group=0 --numeric-owner"
else
	TAR_OWNER=""
fi
# shellcheck disable=SC2086
tar -czf "$TMP_DIR/control.tar.gz" $TAR_OWNER -C "$CONTROL_DIR" .
# shellcheck disable=SC2086
tar -czf "$TMP_DIR/data.tar.gz" $TAR_OWNER -C "$DATA_DIR" .

mkdir -p "$OUT_DIR"
IPK_FILE="$OUT_DIR/${PKG_NAME}_${PKG_VERSION}_${PKG_ARCH}.ipk"
rm -f "$IPK_FILE"
(
	cd "$TMP_DIR"
	tar -czf "$IPK_FILE" ./debian-binary ./control.tar.gz ./data.tar.gz
) || die "packaging the .ipk failed"

# ---------------------------------------------------------------------------
# source tarball (for OpenWrt SDK / feed builds)
# ---------------------------------------------------------------------------
SRC_FILE="$OUT_DIR/${PKG_NAME}_${PKG_VERSION}_${PKG_ARCH}.tar.gz"
rm -f "$SRC_FILE"
src_items="Makefile files scripts tests"
[ -L "$ROOT_DIR/root" ] && src_items="$src_items root"
# shellcheck disable=SC2086
tar -czf "$SRC_FILE" -C "$ROOT_DIR" $src_items

log "ipk members:"
tar -tzf "$IPK_FILE"

log "control:"
tar -xzOf "$TMP_DIR/control.tar.gz" ./control | sed -n '1,20p' || true

log "output:"
printf '  %s (%s bytes)\n' "$IPK_FILE" "$(wc -c <"$IPK_FILE" | tr -d ' ')"
printf '  %s (%s bytes)\n' "$SRC_FILE" "$(wc -c <"$SRC_FILE" | tr -d ' ')"
log "done"
