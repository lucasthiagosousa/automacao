"use strict";

const dgram = require("node:dgram");

const PRINTERS = [
  ["192.168.5.20", "HP LaserJet Pro MFP M428fdw"],
  ["192.168.5.21", "HP LaserJet Pro MFP M428fdw"],
  ["192.168.5.22", "HP LaserJet Pro MFP M428fdw"],
  ["192.168.5.23", "HP LaserJet Pro MFP M428fdw"],
  ["192.168.5.25", "HP LaserJet Pro MFP M428fdw"],
  ["192.168.3.239", "HP Color LaserJet Flow E57540"],
  ["192.168.3.253", "HP LaserJet Flow MFP E52645"],
  ["192.168.3.220", "HP Color LaserJet E55040"],
  ["192.168.3.227", "HP LaserJet Flow MFP E52645"],
  ["192.168.3.221", "HP Color LaserJet E55040"],
  ["192.168.3.228", "HP LaserJet Flow MFP E52645"],
  ["192.168.3.234", "HP LaserJet Flow MFP E52645"],
  ["192.168.3.243", "HP Color LaserJet Pro MFP M479fdw"],
  ["192.168.3.235", "HP Color LaserJet Pro M454dw"],
  ["192.168.3.237", "HP Color LaserJet MFP E57540"],
  ["192.168.3.222", "HP LaserJet Pro MFP M428fdw"],
  ["192.168.3.244", "HP Color LaserJet MFP M479fdw"],
  ["192.168.3.242", "HP LaserJet Pro MFP M428fdw"],
  ["192.168.3.236", "HP LaserJet MFP E42540"],
  ["192.168.3.224", "HP Color LaserJet E55040"],
  ["192.168.3.252", "L1455 Series (Epson - tanque de tinta)"],
  ["192.168.3.238", "Samsung SL-M4070FR"],
  ["192.168.3.254", "HP LaserJet Flow MFP E52645"],
  ["192.168.6.5", "HP LaserJet Flow MFP E52645"],
  ["192.168.6.4", "HP LaserJet Pro MFP M428fdw"]
];

const CARTRIDGES = {
  "HP LaserJet Pro MFP M428fdw": "HP 58A / 58X (CF258A / CF258X)",
  "HP LaserJet Flow MFP E52645": "HP 89A / 89X / 89Y (CF289A / CF289X / CF289Y)",
  "HP LaserJet MFP E42540": "HP 87A / 87X (CF287A / CF287X)",
  "HP Color LaserJet Flow E57540": "HP 658A/X/Y (série W20xx)",
  "HP Color LaserJet MFP E57540": "HP 658A/X/Y (série W20xx)",
  "HP Color LaserJet E55040": "HP 656A/X (série CF46x)",
  "HP Color LaserJet Pro MFP M479fdw": "HP 415A / 415X (série W203x)",
  "HP Color LaserJet MFP M479fdw": "HP 415A / 415X (série W203x)",
  "HP Color LaserJet Pro M454dw": "HP 414A / 414X (série W142x)",
  "Samsung SL-M4070FR": "Samsung MLT-D203 (L / E / U)",
  "L1455 Series (Epson - tanque de tinta)": "Garrafas Epson 664 / 774"
};

const OIDS = {
  hostname: "1.3.6.1.2.1.1.5.0",
  description: "1.3.6.1.2.1.43.11.1.1.6.1",
  maximum: "1.3.6.1.2.1.43.11.1.1.8.1",
  level: "1.3.6.1.2.1.43.11.1.1.9.1"
};

function length(value) {
  if (value < 128) return Buffer.from([value]);
  const bytes = [];
  while (value) { bytes.unshift(value & 255); value >>= 8; }
  return Buffer.from([128 | bytes.length, ...bytes]);
}

function tlv(tag, value) { return Buffer.concat([Buffer.from([tag]), length(value.length), value]); }
function integer(value) {
  if (!value) return tlv(2, Buffer.from([0]));
  const bytes = [];
  while (value) { bytes.unshift(value & 255); value >>>= 8; }
  if (bytes[0] & 128) bytes.unshift(0);
  return tlv(2, Buffer.from(bytes));
}
function oid(value) {
  const parts = value.split(".").map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  parts.slice(2).forEach(function (part) {
    const encoded = [part & 127];
    while ((part >>= 7)) encoded.unshift(128 | (part & 127));
    bytes.push(...encoded);
  });
  return tlv(6, Buffer.from(bytes));
}
function sequence(...values) { return tlv(48, Buffer.concat(values)); }
function requestPacket(community, targetOid, requestId, pduType) {
  const variable = sequence(oid(targetOid), tlv(5, Buffer.alloc(0)));
  const pdu = tlv(pduType, Buffer.concat([integer(requestId), integer(0), integer(0), sequence(variable)]));
  return sequence(integer(1), tlv(4, Buffer.from(community)), pdu);
}

function readTlv(buffer, offset) {
  const tag = buffer[offset++];
  let size = buffer[offset++];
  if (size & 128) {
    const count = size & 127;
    size = buffer.readUIntBE(offset, count);
    offset += count;
  }
  return { tag, value: buffer.subarray(offset, offset + size), next: offset + size };
}
function decodeOid(buffer) {
  const output = [Math.floor(buffer[0] / 40), buffer[0] % 40];
  let value = 0;
  for (let index = 1; index < buffer.length; index += 1) {
    value = (value << 7) | (buffer[index] & 127);
    if (!(buffer[index] & 128)) { output.push(value); value = 0; }
  }
  return output.join(".");
}
function decodeValue(tag, value) {
  if (tag === 4) return value.toString("utf8").replace(/\0/g, "").trim();
  if ([2, 65, 66, 67, 70].includes(tag)) return value.readIntBE(0, value.length);
  return null;
}
function parsePacket(buffer) {
  const message = readTlv(buffer, 0).value;
  let offset = 0;
  offset = readTlv(message, offset).next;
  offset = readTlv(message, offset).next;
  const pdu = readTlv(message, offset).value;
  let position = 0;
  position = readTlv(pdu, position).next;
  const error = readTlv(pdu, position); position = error.next;
  position = readTlv(pdu, position).next;
  const variables = readTlv(pdu, position).value;
  const variable = readTlv(variables, 0).value;
  const parsedOid = readTlv(variable, 0);
  const parsedValue = readTlv(variable, parsedOid.next);
  return { error: Number(decodeValue(2, error.value) || 0), oid: decodeOid(parsedOid.value),
    tag: parsedValue.tag, value: decodeValue(parsedValue.tag, parsedValue.value) };
}

function query(ip, targetOid, pduType, timeout, requestId) {
  return new Promise(function (resolve) {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(function () { socket.close(); resolve(null); }, timeout);
    socket.once("message", function (message) {
      clearTimeout(timer);
      socket.close();
      try { resolve(parsePacket(message)); } catch { resolve(null); }
    });
    socket.once("error", function () { clearTimeout(timer); socket.close(); resolve(null); });
    const packet = requestPacket("public", targetOid, requestId, pduType);
    socket.send(packet, 161, ip, function (error) {
      if (error) { clearTimeout(timer); socket.close(); resolve(null); }
    });
  });
}

async function walk(ip, baseOid, timeout) {
  const rows = [];
  let current = baseOid;
  for (let index = 0; index < 40; index += 1) {
    const row = await query(ip, current, 0xa1, timeout, index + 10);
    if (!row || row.error || row.tag >= 128 || !row.oid.startsWith(baseOid + ".")) break;
    rows.push(row);
    if (row.oid === current) break;
    current = row.oid;
  }
  return rows;
}

function tonerSupply(description) {
  return /(toner|cartridge|cartucho|tinta|ink)/i.test(description);
}

async function checkPrinter(printer, threshold, timeout) {
  const [ip, model] = printer;
  const hostname = await query(ip, OIDS.hostname, 0xa0, timeout, 1);
  if (!hostname) return { ip, model, hostname: "", online: false, supplies: [], status: "offline",
    cartridge: CARTRIDGES[model] || "Confirmar pelo consumível informado" };
  const [descriptions, levels, maximums] = await Promise.all([
    walk(ip, OIDS.description, timeout), walk(ip, OIDS.level, timeout), walk(ip, OIDS.maximum, timeout)
  ]);
  const levelMap = new Map(levels.map(function (row) { return [row.oid.split(".").pop(), row.value]; }));
  const maxMap = new Map(maximums.map(function (row) { return [row.oid.split(".").pop(), row.value]; }));
  const supplies = descriptions.map(function (row) {
    const key = row.oid.split(".").pop();
    const level = Number(levelMap.get(key));
    const maximum = Number(maxMap.get(key));
    const percent = maximum > 0 && level >= 0 ? Math.max(0, Math.min(100, Math.round(level * 100 / maximum))) : null;
    return { description: String(row.value || "Consumível"), percent,
      isToner: tonerSupply(String(row.value || "")), status: percent === null ? "unknown" : percent <= threshold ? "critical" : percent <= threshold + 15 ? "warning" : "ok" };
  });
  const toner = supplies.filter(function (item) { return item.isToner; });
  const statuses = toner.map(function (item) { return item.status; });
  const status = statuses.includes("critical") ? "critical" : statuses.includes("warning") ? "warning"
    : statuses.includes("ok") ? "ok" : "unknown";
  return { ip, model, hostname: String(hostname.value || ""), online: true, supplies, status,
    cartridge: CARTRIDGES[model] || "Confirmar pelo consumível informado" };
}

async function scan(options = {}) {
  const threshold = Math.max(1, Math.min(99, Number(options.threshold) || 20));
  const timeout = Math.max(500, Math.min(10000, Number(options.timeout) || 2200));
  const printerList = Array.isArray(options.printers) ? options.printers : PRINTERS;
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < printerList.length) {
      const index = cursor++;
      results[index] = await checkPrinter(printerList[index], threshold, timeout);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  const summary = {
    total: results.length,
    online: results.filter(function (item) { return item.online; }).length,
    offline: results.filter(function (item) { return !item.online; }).length,
    critical: results.filter(function (item) { return item.status === "critical"; }).length,
    warning: results.filter(function (item) { return item.status === "warning"; }).length
  };
  return { updatedAt: new Date().toISOString(), threshold, summary, printers: results };
}

module.exports = { scan, printers: PRINTERS };
