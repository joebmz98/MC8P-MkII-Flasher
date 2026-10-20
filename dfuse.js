// STM32 DfuSe flashing over WebUSB, written for the STM32 system (ROM) bootloader.
// Protocol reference: ST AN3156 (USB DFU protocol used in the STM32 bootloader)
// and the USB DFU 1.1 spec.

export const FLASH_BASE = 0x08000000;

const DFU_DNLOAD = 1;
const DFU_UPLOAD = 2;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_ABORT = 6;

const CMD_SET_ADDRESS = 0x21;
const CMD_ERASE = 0x41;

export const STATE = {
  appIDLE: 0,
  appDETACH: 1,
  dfuIDLE: 2,
  dfuDNLOAD_SYNC: 3,
  dfuDNBUSY: 4,
  dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuUPLOAD_IDLE: 9,
  dfuERROR: 10,
};

const STATE_NAMES = Object.fromEntries(Object.entries(STATE).map(([k, v]) => [v, k]));

const STATUS_TEXT = [
  'OK',
  'errTARGET: the address is not writable (read protection may be on)',
  'errFILE: the file was rejected',
  'errWRITE: the flash could not be written',
  'errERASE: the flash could not be erased',
  'errCHECK_ERASED: memory was not blank before writing',
  'errPROG: program memory function failed',
  'errVERIFY: the written data did not read back correctly',
  'errADDRESS: address out of range',
  'errNOTDONE: received a zero length download too early',
  'errFIRMWARE: device firmware is corrupt',
  'errVENDOR: vendor specific error',
  'errUSBR: unexpected USB reset',
  'errPOR: unexpected power on reset',
  'errUNKNOWN: unknown error',
  'errSTALLEDPKT: the device rejected the request',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex32 = (n) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
export { hex32 };

export class DfuError extends Error {}

// ====================================================================
// Intel HEX parsing
// ====================================================================

// Returns [{ address, data: Uint8Array }] in file order (not merged).
export function parseIntelHex(text) {
  const blocks = [];
  let base = 0;
  let current = null;
  let sawEof = false;
  const lines = text.split(/\r?\n/);

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    if (line[0] !== ':' || line.length < 11 || (line.length - 1) % 2) {
      throw new DfuError(`Bad HEX record on line ${n + 1}`);
    }
    const bytes = new Uint8Array((line.length - 1) / 2);
    for (let i = 0; i < bytes.length; i++) {
      const v = parseInt(line.substr(1 + i * 2, 2), 16);
      if (Number.isNaN(v)) throw new DfuError(`Bad HEX digits on line ${n + 1}`);
      bytes[i] = v;
    }
    const len = bytes[0];
    if (bytes.length !== len + 5) throw new DfuError(`Bad HEX record length on line ${n + 1}`);
    if (bytes.reduce((a, b) => (a + b) & 0xff, 0) !== 0) {
      throw new DfuError(`HEX checksum error on line ${n + 1}`);
    }
    const offset = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.subarray(4, 4 + len);

    if (type === 0x00) {
      const addr = (base + offset) >>> 0;
      if (current && current.address + current.length === addr) {
        current.parts.push(data);
        current.length += data.length;
      } else {
        current = { address: addr, length: data.length, parts: [data] };
        blocks.push(current);
      }
    } else if (type === 0x01) {
      sawEof = true;
      break;
    } else if (type === 0x02) {
      base = ((data[0] << 8) | data[1]) << 4;
    } else if (type === 0x04) {
      base = (((data[0] << 8) | data[1]) << 16) >>> 0;
    }
    // 0x03 and 0x05 (start address) are not needed for flashing.
  }
  if (!sawEof) throw new DfuError('HEX file has no end-of-file record (truncated download?)');

  return blocks.map((b) => {
    const out = new Uint8Array(b.length);
    let p = 0;
    for (const part of b.parts) { out.set(part, p); p += part.length; }
    return { address: b.address, data: out };
  });
}

// ====================================================================
// Firmware image: one or more parts placed at absolute addresses
// ====================================================================

export class FirmwareImage {
  constructor() {
    this.blocks = [];
  }

  addHex(text, label = 'hex') {
    for (const b of parseIntelHex(text)) this.blocks.push({ ...b, label });
  }

  addBin(bytes, address, label = 'bin') {
    this.blocks.push({ address: address >>> 0, data: new Uint8Array(bytes), label });
  }

  // Sorted, merged, 4-byte aligned segments. Small gaps are filled with 0xFF
  // (the erased value), never 0x00, so untouched flash stays blank.
  segments() {
    const sorted = [...this.blocks].sort((a, b) => a.address - b.address);
    const merged = [];
    for (const b of sorted) {
      const last = merged[merged.length - 1];
      if (last) {
        const lastEnd = last.address + last.data.length;
        if (b.address < lastEnd) {
          throw new DfuError(`"${b.label}" overlaps "${last.label}" at ${hex32(b.address)}`);
        }
        if (b.address - lastEnd <= 16) {
          const joined = new Uint8Array(b.address + b.data.length - last.address).fill(0xff);
          joined.set(last.data, 0);
          joined.set(b.data, b.address - last.address);
          last.data = joined;
          last.label += ' + ' + b.label;
          continue;
        }
      }
      merged.push({ address: b.address, data: b.data, label: b.label });
    }
    return merged.map((s) => {
      const start = s.address & ~3;
      const end = (s.address + s.data.length + 3) & ~3;
      if (start === s.address && end === s.address + s.data.length) return s;
      const padded = new Uint8Array(end - start).fill(0xff);
      padded.set(s.data, s.address - start);
      return { address: start >>> 0, data: padded, label: s.label };
    });
  }

  get byteCount() {
    return this.segments().reduce((n, s) => n + s.data.length, 0);
  }

  // Human readable problems that will stop the firmware from starting.
  warnings() {
    const segs = this.segments();
    const out = [];
    if (!segs.length) return ['The firmware file is empty.'];
    const first = segs[0];
    if (first.address !== FLASH_BASE) {
      out.push(
        `This image starts at ${hex32(first.address)}, not ${hex32(FLASH_BASE)}. ` +
        'It was built for a bootloader, so it will only start if that bootloader is already on the board.'
      );
    }
    if (first.data.length >= 8) {
      const dv = new DataView(first.data.buffer, first.data.byteOffset, 8);
      const sp = dv.getUint32(0, true);
      const reset = dv.getUint32(4, true);
      if (sp < 0x20000000 || sp > 0x20020000) {
        out.push(`The first word (${hex32(sp)}) is not a valid stack pointer for this chip.`);
      }
      const inImage = segs.some((s) => (reset & ~1) >= s.address && (reset & ~1) < s.address + s.data.length);
      if (!(reset & 1) || !inImage) {
        out.push(`The reset vector (${hex32(reset)}) does not point into the firmware.`);
      }
    }
    return out;
  }
}

// ====================================================================
// DfuSe memory layout, e.g. "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,03*128Kg"
// ====================================================================

export function parseMemoryLayout(desc) {
  if (!desc || desc[0] !== '@') return null;
  const parts = desc.substring(1).split('/');
  const name = parts[0].trim();
  const sectors = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    let addr = parseInt(parts[i], 16);
    for (const spec of parts[i + 1].split(',')) {
      const m = /^\s*(\d+)\s*\*\s*(\d+)\s*([BKM ]?)\s*([a-g])\s*$/.exec(spec);
      if (!m) continue;
      const count = parseInt(m[1], 10);
      const mult = { K: 1024, M: 1024 * 1024 }[m[3]] || 1;
      const size = parseInt(m[2], 10) * mult;
      const flags = m[4].charCodeAt(0) - 'a'.charCodeAt(0) + 1;
      for (let c = 0; c < count; c++) {
        sectors.push({
          start: addr >>> 0,
          size,
          readable: !!(flags & 1),
          erasable: !!(flags & 2),
          writable: !!(flags & 4),
        });
        addr += size;
      }
    }
  }
  if (!sectors.length) return null;
  const last = sectors[sectors.length - 1];
  return { name, sectors, start: sectors[0].start, end: last.start + last.size };
}

// STM32F411xE: 4 x 16K, 1 x 64K, 3 x 128K. Used only if the device does not report a layout.
export const F411_LAYOUT = parseMemoryLayout('@Internal Flash  /0x08000000/04*016Kg,01*064Kg,03*128Kg');

// ====================================================================
// The device
// ====================================================================

export class StmDfuse {
  constructor(usbDevice, { log = () => {} } = {}) {
    this.dev = usbDevice;
    this.log = log;
    this.iface = 0;
    this.alt = 0;
    this.transferSize = 2048;
    this.layout = F411_LAYOUT;
  }

  async open() {
    const dev = this.dev;
    if (!dev.opened) await dev.open();
    if (dev.configuration === null) await dev.selectConfiguration(1);

    const config = await this.readConfigDescriptor().catch(() => null);

    // The ROM bootloader exposes one interface with several alternate settings
    // (Internal Flash, Option Bytes, OTP, Device Feature). We want Internal Flash.
    const candidates = [];
    for (const intf of dev.configuration.interfaces) {
      for (const alt of intf.alternates) {
        if (alt.interfaceClass !== 0xfe || alt.interfaceSubclass !== 0x01) continue;
        let name = alt.interfaceName;
        if (!name && config) name = await this.readAltName(config, intf.interfaceNumber, alt.alternateSetting);
        candidates.push({ intf: intf.interfaceNumber, alt: alt.alternateSetting, name });
      }
    }
    const found = candidates.find((c) => c.name && /internal flash/i.test(c.name)) || candidates[0];
    if (!found) throw new DfuError('This USB device has no DFU interface. Is it in DFU mode?');

    this.iface = found.intf;
    this.alt = found.alt;
    await dev.claimInterface(this.iface);
    await dev.selectAlternateInterface(this.iface, this.alt);

    if (config && config.transferSize) this.transferSize = config.transferSize;
    const layout = parseMemoryLayout(found.name);
    if (layout) this.layout = layout;
    else this.log(`Could not read the flash layout (${found.name || 'no name'}), assuming STM32F411.`, 'WARN');

    await this.resetState();
  }

  async close() {
    try { await this.dev.releaseInterface(this.iface); } catch (e) { /* already gone */ }
    try { await this.dev.close(); } catch (e) { /* already gone */ }
  }

  // Descriptors

  async readConfigDescriptor() {
    const head = await this.getDescriptor(0x02, 0, 9);
    const total = head.getUint16(2, true);
    const dv = await this.getDescriptor(0x02, 0, total);
    const out = { alts: [], transferSize: 0 };
    let current = null;
    for (let i = 0; i + 1 < dv.byteLength;) {
      const len = dv.getUint8(i);
      const type = dv.getUint8(i + 1);
      if (len < 2) break;
      if (type === 0x04) {
        current = { intf: dv.getUint8(i + 2), alt: dv.getUint8(i + 3), iInterface: dv.getUint8(i + 8) };
        out.alts.push(current);
      } else if (type === 0x21 && len >= 7) {
        out.transferSize = dv.getUint16(i + 5, true);
      }
      i += len;
    }
    return out;
  }

  async readAltName(config, intf, alt) {
    const entry = config.alts.find((a) => a.intf === intf && a.alt === alt);
    if (!entry || !entry.iInterface) return null;
    try {
      const dv = await this.getDescriptor(0x03, entry.iInterface, 255, 0x0409);
      const len = dv.getUint8(0);
      let s = '';
      for (let i = 2; i + 1 < len && i + 1 < dv.byteLength; i += 2) s += String.fromCharCode(dv.getUint16(i, true));
      return s;
    } catch (e) {
      return null;
    }
  }

  async getDescriptor(type, index, length, langId = 0) {
    const res = await this.dev.controlTransferIn({
      requestType: 'standard', recipient: 'device', request: 6,
      value: (type << 8) | index, index: langId,
    }, length);
    if (res.status !== 'ok') throw new DfuError('GET_DESCRIPTOR failed');
    return res.data;
  }

  // DFU requests

  async requestOut(request, value, data) {
    const res = await this.dev.controlTransferOut({
      requestType: 'class', recipient: 'interface', request, value, index: this.iface,
    }, data);
    if (res.status !== 'ok') throw new DfuError(`DFU request ${request} was rejected (${res.status})`);
    return res;
  }

  async requestIn(request, value, length) {
    const res = await this.dev.controlTransferIn({
      requestType: 'class', recipient: 'interface', request, value, index: this.iface,
    }, length);
    if (res.status !== 'ok') throw new DfuError(`DFU request ${request} was rejected (${res.status})`);
    return res.data;
  }

  async getStatus() {
    const dv = await this.requestIn(DFU_GETSTATUS, 0, 6);
    return {
      status: dv.getUint8(0),
      pollTimeout: dv.getUint8(1) | (dv.getUint8(2) << 8) | (dv.getUint8(3) << 16),
      state: dv.getUint8(4),
    };
  }

  clearStatus() { return this.requestOut(DFU_CLRSTATUS, 0); }
  abort() { return this.requestOut(DFU_ABORT, 0); }

  // Bring the device to dfuIDLE whatever state an earlier attempt left it in.
  async resetState() {
    for (let i = 0; i < 4; i++) {
      const st = await this.getStatus();
      if (st.state === STATE.dfuIDLE) return;
      if (st.state === STATE.dfuERROR) await this.clearStatus();
      else await this.abort();
    }
    const st = await this.getStatus();
    if (st.state !== STATE.dfuIDLE) {
      throw new DfuError(`Device is stuck in state ${STATE_NAMES[st.state] || st.state}. Re-enter DFU mode and try again.`);
    }
  }

  // Poll GETSTATUS (honouring bwPollTimeout) until the device leaves dfuDNBUSY.
  async waitWhileBusy(what, timeoutMs = 20000) {
    const t0 = Date.now();
    let transferErrors = 0;
    for (;;) {
      let st;
      try {
        st = await this.getStatus();
      } catch (e) {
        // The ROM bootloader cannot answer while it erases or programs; the
        // request fails or NAKs. Keep asking until the timeout.
        if (++transferErrors > 200 || Date.now() - t0 > timeoutMs) throw e;
        await sleep(20);
        continue;
      }
      if (st.state === STATE.dfuERROR) {
        await this.clearStatus().catch(() => {});
        throw new DfuError(`${what} failed: ${STATUS_TEXT[st.status] || 'status ' + st.status}`);
      }
      if (st.state !== STATE.dfuDNBUSY && st.state !== STATE.dfuDNLOAD_SYNC) return st;
      if (Date.now() - t0 > timeoutMs) throw new DfuError(`${what} timed out`);
      await sleep(Math.min(Math.max(st.pollTimeout, 1), 2000));
    }
  }

  // DNLOAD with wBlockNum = 0 carries a DfuSe command.
  async command(bytes, what) {
    try {
      await this.requestOut(DFU_DNLOAD, 0, bytes);
    } catch (e) {
      const st = await this.getStatus().catch(() => null);
      if (st && st.state === STATE.dfuERROR) await this.clearStatus().catch(() => {});
      throw new DfuError(`${what} was rejected by the bootloader`);
    }
    const st = await this.waitWhileBusy(what);
    if (st.state !== STATE.dfuDNLOAD_IDLE) {
      throw new DfuError(`${what}: unexpected state ${STATE_NAMES[st.state] || st.state}`);
    }
  }

  setAddress(addr) {
    return this.command(le32(CMD_SET_ADDRESS, addr), `Set address ${hex32(addr)}`);
  }

  eraseSector(addr) {
    return this.command(le32(CMD_ERASE, addr), `Erase sector at ${hex32(addr)}`);
  }

  // Write one chunk (<= transferSize). The address pointer is set before every
  // chunk and the data always goes in block 2, so the device writes exactly at
  // addr no matter how it computes block offsets. dfu-util does the same.
  async writeChunk(addr, data) {
    await this.setAddress(addr);
    await this.requestOut(DFU_DNLOAD, 2, data);
    const st = await this.waitWhileBusy(`Write at ${hex32(addr)}`);
    if (st.state !== STATE.dfuDNLOAD_IDLE) {
      throw new DfuError(`Write at ${hex32(addr)}: unexpected state ${STATE_NAMES[st.state] || st.state}`);
    }
  }

  // Read `length` bytes starting at addr. Like dfu-util: set the pointer once,
  // return to dfuIDLE, then UPLOAD blocks 2, 3, 4... of transferSize bytes,
  // which the bootloader reads from ((block - 2) * transferSize) + pointer.
  async read(addr, length, onBytes = () => {}) {
    const out = new Uint8Array(length);
    await this.abort();
    await this.setAddress(addr);
    await this.abort();
    let done = 0;
    for (let block = 2; done < length; block++) {
      const n = Math.min(this.transferSize, length - done);
      const dv = await this.requestIn(DFU_UPLOAD, block, n);
      if (dv.byteLength !== n) throw new DfuError(`Short read at ${hex32(addr + done)}`);
      out.set(new Uint8Array(dv.buffer, dv.byteOffset, n), done);
      done += n;
      onBytes(n);
    }
    await this.abort();
    return out;
  }

  sectorsFor(segments) {
    const list = [];
    for (const s of segments) {
      const end = s.address + s.data.length;
      if (s.address < this.layout.start || end > this.layout.end) {
        throw new DfuError(
          `"${s.label}" (${hex32(s.address)} to ${hex32(end - 1)}) does not fit in ${this.layout.name} ` +
          `(${hex32(this.layout.start)} to ${hex32(this.layout.end - 1)}).`
        );
      }
      for (const sec of this.layout.sectors) {
        if (sec.start < end && sec.start + sec.size > s.address) {
          if (!sec.erasable || !sec.writable) throw new DfuError(`Sector ${hex32(sec.start)} is write protected.`);
          if (!list.includes(sec)) list.push(sec);
        }
      }
    }
    return list.sort((a, b) => a.start - b.start);
  }

  // Erase, write and (optionally) verify a FirmwareImage.
  async flash(image, { verify = true, onProgress = () => {} } = {}) {
    const segments = image.segments();
    const sectors = this.sectorsFor(segments);
    const bytes = segments.reduce((n, s) => n + s.data.length, 0);

    // Progress is weighted roughly by time: erase is slow, verify is fast.
    const eraseWork = sectors.reduce((n, s) => n + s.size / 2, 0);
    const total = eraseWork + bytes + (verify ? bytes / 4 : 0);
    let work = 0;
    const tick = (n, phase) => { work += n; onProgress(Math.min(1, work / total), phase); };

    for (const sec of sectors) {
      this.log(`Erasing ${sec.size / 1024} KB sector at ${hex32(sec.start)}`);
      await this.eraseSector(sec.start);
      tick(sec.size / 2, 'Erasing');
    }

    for (const s of segments) {
      this.log(`Writing ${s.data.length} bytes to ${hex32(s.address)} (${s.label})`);
      for (let off = 0; off < s.data.length; off += this.transferSize) {
        const chunk = s.data.subarray(off, off + this.transferSize);
        await this.writeChunk(s.address + off, chunk);
        tick(chunk.length, 'Writing');
      }
    }

    if (verify) {
      await this.abort();
      for (const s of segments) {
        this.log(`Verifying ${s.data.length} bytes at ${hex32(s.address)}`);
        const back = await this.read(s.address, s.data.length, (n) => tick(n / 4, 'Verifying'));
        for (let i = 0; i < back.length; i++) {
          if (back[i] !== s.data[i]) {
            throw new DfuError(
              `Verify failed at ${hex32(s.address + i)}: wrote 0x${s.data[i].toString(16)}, read 0x${back[i].toString(16)}`
            );
          }
        }
      }
    }
    onProgress(1, 'Done');
  }

  // Ask the ROM bootloader to jump to the firmware. The device disconnects,
  // so errors after the request are expected and ignored.
  async leave(addr = FLASH_BASE) {
    await this.abort().catch(() => {});
    await this.setAddress(addr);
    await this.requestOut(DFU_DNLOAD, 0, new Uint8Array(0));
    try { await this.getStatus(); } catch (e) { /* device has gone */ }
  }
}

function le32(cmd, addr) {
  return new Uint8Array([cmd, addr & 0xff, (addr >>> 8) & 0xff, (addr >>> 16) & 0xff, (addr >>> 24) & 0xff]);
}
