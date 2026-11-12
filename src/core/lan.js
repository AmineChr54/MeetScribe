/**
 * Which of this machine's addresses a phone on the same network can reach.
 * Pure: takes the shape of os.networkInterfaces() so it is unit-tested with
 * made-up tables (tests/lan.test.js).
 */

// Adapters that exist on the PC but no phone can reach: WSL, Hyper-V, VMs,
// containers, Bluetooth PAN.
const VIRTUAL = /vethernet|wsl|hyper-v|virtualbox|vmware|vmnet|vbox|docker|br-|veth|virbr|loopback|bluetooth|npcap/i;
// The adapters people mean: Wi-Fi first, then wired.
const WIFI = /wi-?fi|wlan|wireless|^wl/i;
const WIRED = /ethernet|^eth|^en/i;

function octets(address) {
  const parts = String(address || '').split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

/** 10/8, 172.16/12, 192.168/16: home and office networks. */
function isPrivate(address) {
  const ip = octets(address);
  if (!ip) return false;
  return ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168);
}

function isUsable(address) {
  const ip = octets(address);
  if (!ip) return false;
  if (ip[0] === 127 || ip[0] === 0 || ip[0] >= 224) return false; // loopback, "this host", multicast
  if (ip[0] === 169 && ip[1] === 254) return false; // link-local: no DHCP answer
  return true;
}

/**
 * @param {Record<string, Array<{ address: string, family: string|number, internal: boolean }>>} interfaces
 * @returns {Array<{ address: string, name: string }>} best first
 */
function candidates(interfaces) {
  const found = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    if (VIRTUAL.test(name)) continue;
    for (const entry of entries || []) {
      // Node reports the family as 'IPv4' (or 4 in some 18.x builds).
      if (!entry || entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) continue;
      if (!isUsable(entry.address)) continue;
      const rank = (isPrivate(entry.address) ? 0 : 10) + (WIFI.test(name) ? 0 : WIRED.test(name) ? 1 : 2);
      found.push({ address: entry.address, name, rank });
    }
  }
  found.sort((a, b) => a.rank - b.rank);
  const seen = new Set();
  return found
    .filter((entry) => !seen.has(entry.address) && seen.add(entry.address))
    .map(({ address, name }) => ({ address, name }));
}

module.exports = { candidates, isPrivate, isUsable };
