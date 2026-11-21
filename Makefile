#
# Copyright (C) 2026 shorekeeper-blackshore
#
# This is free software, licensed under the MIT License.
# See the LICENSE file for details.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-hlimit
PKG_VERSION:=1.3.4
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=shorekeeper-blackshore

LUCI_NAME:=hlimit
LUCI_TITLE:=LuCI app: hlimit - per-device/per-range/default rate limit (iptables hashlimit)
LUCI_DESCRIPTION:=Per-device, per-range and default upload/download policing \
	for fw3 + iptables networks without tc/nft. Rules are qualified with the \
	detected LAN interface (-i/-o) so overlapping WAN subnets are never \
	limited; mangle PREROUTING/POSTROUTING, MAC devices, per-group whitelists.
LUCI_DEPENDS:=+luci-base +rpcd +rpcd-mod-file +iptables +iptables-mod-hashlimit \
	+iptables-mod-iprange +firewall
LUCI_PKGARCH:=all

# The LuCI build framework (feeds/luci/luci.mk) packages the conventional
# `root/`, `htdocs/`, `luasrc/` and `ucode/` directories.  The project keeps
# all runtime files in `files/` (see docs/CONTRACT.md section 5), and the
# `root` symlink in this directory points to `files` so luci.mk picks them up
# without duplicating the tree.  Override LUCI_MK for a non-standard SDK layout.
LUCI_MK ?= $(TOPDIR)/feeds/luci/luci.mk

# /etc/config/hashlimit-qos is a conffile: keep user settings on upgrade.
define Package/$(PKG_NAME)/conffiles
/etc/config/hashlimit-qos
endef

# Install time: enable the boot script, install the fw3 hook and apply rules.
# Everything is idempotent, so reinstall/upgrade is harmless.
define Package/$(PKG_NAME)/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
rm -f /tmp/luci-indexcache* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
if [ -x /usr/sbin/hlimit-ctl ]; then
	/usr/sbin/hlimit-ctl install-hook >/dev/null 2>&1
	/etc/init.d/hashlimit-qos enable >/dev/null 2>&1
	/usr/sbin/hlimit-ctl migrate >/dev/null 2>&1
	/usr/sbin/hlimit-ctl offload-apply >/dev/null 2>&1
	/usr/sbin/hlimit-ctl render >/dev/null 2>&1
fi
/etc/init.d/rpcd reload >/dev/null 2>&1
exit 0
endef

# Remove time: stop the service, drop our rules and the firewall.user hook.
define Package/$(PKG_NAME)/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
if [ -x /etc/init.d/hashlimit-qos ]; then
	/etc/init.d/hashlimit-qos stop >/dev/null 2>&1
	/etc/init.d/hashlimit-qos disable >/dev/null 2>&1
fi
[ -x /usr/sbin/hlimit-ctl ] && /usr/sbin/hlimit-ctl remove-hook >/dev/null 2>&1
[ -x /usr/sbin/hlimit-ctl ] && /usr/sbin/hlimit-ctl offload-restore >/dev/null 2>&1
exit 0
endef

# luci.mk sets PKGARCH:=all (LUCI_PKGARCH) and calls BuildPackage at its end.
include $(LUCI_MK)
