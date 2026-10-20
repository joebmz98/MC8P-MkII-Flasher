// STM32 DfuSe flashing over WebUSB, written for the STM32 system (ROM) bootloader.
// Protocol reference: ST AN3156 (USB DFU protocol used in the STM32 bootloader)
// and the USB DFU 1.1 spec.

export const FLASH_BASE = 0x08000000;

const DFU_DNLOAD = 1;
const DFU_UPLOAD = 2;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_GETSTATE = 5;
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

// On some Black Pill boards the ROM bootloader's USB receiver is marginal: it
// cannot take packets containing long runs of 1 bits (e.g. 0xFF 0xFF 0xFF...),
// which have few signal edges to stay in sync with. Seen on a real board: every
// packet with runs up to 25 bits got through, one with a 72 bit run never did.
// Two defences:
//  1. Words that are 0xFFFFFFFF are not sent at all: erased flash already
//     holds that value. This removes almost all long runs.
//  2. A failed transfer is retried at the same size once. If it fails again,
//     that block is split in half, and halves that fail are split again, down
//     to single bytes, so a long run ends up spread over separate USB packets
//     (each starts with a sync pattern). Once past the troublesome block,
//     full size blocks resume. If failures keep starting at full size with
//     nothing good in between, the full size itself is lowered.
const MIN_BLOCK = 1;
const USB_RETRIES = 24;
const STATUS_RETRIES = 2;
const ERASED_WORD = 0xffffffff;

export class StmDfuse {
  constructor(usbDevice, { log = () => {}, blockSize = 0, skipErased = true, minBlock = MIN_BLOCK } = {}) {
    this.dev = usbDevice;
    this.log = log;
    this.iface = 0;
    this.alt = 0;
    this.transferSize = 2048;
    this.requestedBlockSize = blockSize;
    this.blockSize = 2048;
    this.maxBlock = 2048;
    this.minBlock = minBlock;
    this.skipErased = skipErased;
    this.troubleStart = 0;    // the block currently being split
    this.troubleEnd = null;
    this.cleanAtMax = 0;      // full size blocks that worked since the last trouble
    this.hadTrouble = false;
    this.backToBack = 0;
    this.layout = F411_LAYOUT;
    this.usbErrors = 0;
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
    // Blocks are powers of two so every block is aligned to its own size.
    let limit = this.transferSize;
    if (this.requestedBlockSize > 0) limit = Math.min(limit, this.requestedBlockSize);
    this.maxBlock = 2 ** Math.floor(Math.log2(Math.max(this.minBlock, limit)));
    this.blockSize = this.maxBlock;
    const layout = parseMemoryLayout(found.name);
    if (layout) this.layout = layout;
    else this.log(`Could not read the flash layout (${found.name || 'no name'}), assuming STM32F411.`, 'WARN');

    const ver = [dev.deviceVersionMajor, dev.deviceVersionMinor, dev.deviceVersionSubminor];
    this.log(
      `Bootloader version ${ver.every((v) => v !== undefined) ? ver.join('.') : 'unknown'}, ` +
      `transfer size ${this.transferSize} (${config && config.transferSize ? 'from device' : 'default'}), ` +
      `block size ${this.blockSize}`
    );

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

  // GETSTATE, unlike GETSTATUS, never makes the bootloader act on a pending block.
  async getState() {
    const dv = await this.requestIn(DFU_GETSTATE, 0, 1);
    return dv.getUint8(0);
  }

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
        const err = new DfuError(`${what} failed: ${STATUS_TEXT[st.status] || 'status ' + st.status}`);
        err.deviceStatus = st.status;
        throw err;
      }
      if (st.state !== STATE.dfuDNBUSY && st.state !== STATE.dfuDNLOAD_SYNC) return st;
      if (Date.now() - t0 > timeoutMs) throw new DfuError(`${what} timed out`);
      if (st.pollTimeout > 0) await sleep(Math.min(st.pollTimeout, 2000));
    }
  }

  // DNLOAD with wBlockNum = 0 carries a DfuSe command. A stall means the
  // bootloader refused it; any other failure is a USB problem and is passed on
  // unchanged so the caller can retry.
  async command(bytes, what) {
    try {
      await this.requestOut(DFU_DNLOAD, 0, bytes);
    } catch (e) {
      if (!(e instanceof DfuError)) throw e;
      const st = await this.getStatus().catch(() => null);
      if (st && st.state === STATE.dfuERROR) await this.clearStatus().catch(() => {});
      const err = new DfuError(`${what} was rejected by the bootloader`);
      err.deviceStatus = st ? st.status : -1;
      throw err;
    }
    const st = await this.waitWhileBusy(what);
    if (st.state !== STATE.dfuDNLOAD_IDLE) {
      throw new DfuError(`${what}: unexpected state ${STATE_NAMES[st.state] || st.state}`);
    }
  }

  // After a failed transfer the bootloader can be in almost any state. Get it
  // back to dfuIDLE, tolerating further USB errors on the way.
  //
  // Careful: the bootloader accepts a DNLOAD as soon as the request arrives, so
  // when the data stops part way it sits in dfuDNLOAD-SYNC holding a block that
  // is part new data, part left over from the previous one. A GETSTATUS now
  // would make it program that block (and flash can't be un-written). So the
  // state is read with GETSTATE and a pending block is thrown away with ABORT.
  async recover() {
    for (let i = 0; i < 20; i++) {
      let state;
      try {
        state = await this.getState();
      } catch (e) {
        if (e && e.name === 'NotFoundError') throw e;
        await sleep(50);
        continue;
      }
      try {
        if (state === STATE.dfuIDLE) return;
        if (state === STATE.dfuERROR) await this.clearStatus();
        else if (state === STATE.dfuDNBUSY) await sleep(20); // finishing a complete block
        else await this.abort();
      } catch (e) {
        if (e && e.name === 'NotFoundError') throw e;
        await sleep(50);
      }
    }
    throw new DfuError('Lost contact with the bootloader after a USB error.');
  }

  // Decide whether a failed write/read is worth another go, shrinking the
  // block size for USB-level failures. Throws when it is time to give up.
  async retryOrThrow(e, attempt, what, chunk = null) {
    const text = `${(e && e.name) || 'Error'}: ${(e && e.message) || e}`;
    if (e && e.name === 'NotFoundError') {
      throw new DfuError(`The board disconnected while ${what}. Check the cable and re-enter DFU mode.`);
    }
    const isUsb = !(e instanceof DfuError);
    if (isUsb) this.usbErrors++;
    if (attempt > (isUsb ? USB_RETRIES : STATUS_RETRIES)) {
      if (!isUsb) throw e;
      const err = new DfuError(
        `USB transfers keep failing while ${what} (${text}), even in ${this.blockSize} byte blocks.`
      );
      err.usbUnreliable = true;
      throw err;
    }
    this.log(`Problem while ${what}: ${text}`, 'WARN');
    if (isUsb && chunk && attempt >= 2 && this.blockSize > this.minBlock) {
      if (this.troubleEnd === null) {
        // A new troublesome block: split it, then return to full size after it.
        this.troubleStart = chunk.addr;
        this.troubleEnd = chunk.addr + chunk.length;
        if (this.blockSize === this.maxBlock) {
          this.backToBack = this.hadTrouble && this.cleanAtMax === 0 ? this.backToBack + 1 : 0;
          this.hadTrouble = true;
          if (this.backToBack >= 3 && this.maxBlock > this.minBlock) {
            this.maxBlock >>= 1;
            this.backToBack = 0;
            this.log(`Full size blocks keep failing; using at most ${this.maxBlock} bytes from now on`, 'WARN');
          }
        }
      }
      this.blockSize = Math.max(this.minBlock, this.blockSize >> 1);
      this.log(`Retrying with ${this.blockSize} byte blocks`, 'WARN');
    } else {
      this.log(`Retrying (attempt ${attempt + 1})`, 'WARN');
    }
    await sleep(Math.min(50 * attempt, 300));
    await this.recover();
  }

  // Called after each good block. While splitting a block this is a binary
  // search: after a piece gets through, the next piece is as big as its place
  // in the split allows (so the half next to a bad spot is tried whole).
  // Once past the block that was being split, go back to full size.
  noteSuccess(nextAddr, n) {
    if (n === this.maxBlock) this.cleanAtMax++;
    if (this.troubleEnd === null) return;
    if (nextAddr >= this.troubleEnd) {
      this.troubleEnd = null;
      this.cleanAtMax = 0;
      this.blockSize = this.maxBlock;
      return;
    }
    const rel = nextAddr - this.troubleStart;
    this.blockSize = Math.min(this.maxBlock, rel & -rel);
  }

  // A new range starts somewhere else, so any split in progress no longer applies.
  startRange() {
    if (this.troubleEnd !== null) {
      this.troubleEnd = null;
      this.blockSize = this.maxBlock;
    }
  }

  // Split data into the parts that actually need writing: words that are
  // 0xFFFFFFFF are left out, because erased flash already reads 0xFFFFFFFF.
  // Returns [{ offset, length }], all word aligned.
  writeSpans(data) {
    if (!this.skipErased) return [{ offset: 0, length: data.length }];
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const spans = [];
    let start = -1;
    for (let i = 0; i < data.length; i += 4) {
      const blank = i + 4 <= data.length && dv.getUint32(i, true) === ERASED_WORD;
      if (blank) {
        if (start >= 0) { spans.push({ offset: start, length: i - start }); start = -1; }
      } else if (start < 0) {
        start = i;
      }
    }
    if (start >= 0) spans.push({ offset: start, length: data.length - start });
    return spans;
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

  // Write any length, chunk by chunk, retrying failed chunks. Rewriting a chunk
  // that was partly programmed is safe: the same bits are cleared again.
  async writeRange(addr, data, onBytes = () => {}) {
    let off = 0;
    let attempt = 0;
    this.startRange();
    while (off < data.length) {
      const n = Math.min(this.blockSize, data.length - off);
      try {
        await this.writeChunk(addr + off, data.subarray(off, off + n));
        off += n;
        attempt = 0;
        onBytes(n);
        this.noteSuccess(addr + off, n);
      } catch (e) {
        await this.retryOrThrow(e, ++attempt, `writing ${n} bytes at ${hex32(addr + off)}`, { addr: addr + off, length: n });
      }
    }
  }

  // Read one chunk: point at addr, go back to dfuIDLE, then UPLOAD block 2,
  // which the bootloader reads from the pointer itself. Same idea as writes.
  async readChunk(addr, n) {
    await this.abort();
    await this.setAddress(addr);
    await this.abort();
    const dv = await this.requestIn(DFU_UPLOAD, 2, n);
    if (dv.byteLength !== n) throw new DfuError(`Short read at ${hex32(addr)}`);
    return new Uint8Array(dv.buffer, dv.byteOffset, n);
  }

  // Read `length` bytes starting at addr.
  async read(addr, length, onBytes = () => {}) {
    const out = new Uint8Array(length);
    let done = 0;
    let attempt = 0;
    this.startRange();
    while (done < length) {
      const n = Math.min(this.blockSize, length - done);
      try {
        out.set(await this.readChunk(addr + done, n), done);
        done += n;
        attempt = 0;
        onBytes(n);
        this.noteSuccess(addr + done, n);
      } catch (e) {
        await this.retryOrThrow(e, ++attempt, `reading ${n} bytes at ${hex32(addr + done)}`, { addr: addr + done, length: n });
      }
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

    // What actually gets written: each segment minus its blank (0xFF) words.
    const parts = [];
    let total = 0;
    for (const s of segments) {
      for (const span of this.writeSpans(s.data)) {
        parts.push({ seg: s, address: s.address + span.offset, data: s.data.subarray(span.offset, span.offset + span.length) });
      }
      total += s.data.length;
    }
    const written = parts.reduce((n, p) => n + p.data.length, 0);
    const skipped = total - written;

    // Progress is weighted roughly by time: erase is slow, verify is fast.
    const eraseWork = sectors.reduce((n, sec) => n + sec.size / 2, 0);
    const allWork = eraseWork + written + (verify ? written / 4 : 0);
    let work = 0;
    const tick = (n, phase) => { work += n; onProgress(Math.min(1, work / allWork), phase); };

    for (const sec of sectors) {
      this.log(`Erasing ${sec.size / 1024} KB sector at ${hex32(sec.start)}`);
      for (let attempt = 1; ; attempt++) {
        try {
          await this.eraseSector(sec.start);
          break;
        } catch (e) {
          await this.retryOrThrow(e, attempt, `erasing ${hex32(sec.start)}`);
        }
      }
      tick(sec.size / 2, 'Erasing');
    }

    let lastSeg = null;
    for (const p of parts) {
      if (p.seg !== lastSeg) {
        this.log(`Writing ${p.seg.data.length} bytes to ${hex32(p.seg.address)} (${p.seg.label})`);
        lastSeg = p.seg;
      }
      await this.writeRange(p.address, p.data, (n) => tick(n, 'Writing'));
    }
    if (skipped) this.log(`Skipped ${skipped} bytes that were 0xFF (already blank after erase)`);
    if (this.usbErrors) {
      this.log(`Write finished after ${this.usbErrors} USB error(s), all of them recovered`, 'WARN');
    }

    if (verify) {
      // Blank words were not written; the erase already made them 0xFF.
      this.log(`Verifying the ${written} bytes written`);
      let check = parts;
      for (let pass = 1; ; pass++) {
        const bad = await this.findMismatches(check, (n) => tick(n / 4, 'Verifying'));
        if (!bad.count) break;
        this.log(
          `Verify found ${bad.count} wrong byte(s), first at ${hex32(bad.first.addr)} ` +
          `(wrote 0x${bad.first.want.toString(16)}, read 0x${bad.first.got.toString(16)})`, 'WARN'
        );
        if (pass > 3) {
          throw new DfuError(
            `Verify failed: ${bad.count} byte(s) still wrong after ${pass - 1} repair attempt(s), ` +
            `first at ${hex32(bad.first.addr)} (wrote 0x${bad.first.want.toString(16)}, read 0x${bad.first.got.toString(16)}).`
          );
        }
        // Flash bits can only be cleared, so the only way to fix a wrong byte
        // is to erase its whole sector and write that sector again.
        const sectorsToRedo = bad.sectors;
        this.log(`Repairing: erasing and rewriting ${sectorsToRedo.map((sec) => hex32(sec.start)).join(', ')}`, 'WARN');
        for (const sec of sectorsToRedo) {
          for (let attempt = 1; ; attempt++) {
            try {
              await this.eraseSector(sec.start);
              break;
            } catch (e) {
              await this.retryOrThrow(e, attempt, `erasing ${hex32(sec.start)}`);
            }
          }
        }
        check = clipToSectors(parts, sectorsToRedo);
        for (const p of check) await this.writeRange(p.address, p.data, (n) => tick(n, 'Repairing'));
      }
    }
    onProgress(1, 'Done');
  }

  // Read parts back; return how many bytes differ, the first one, and the
  // sectors that contain differences.
  async findMismatches(parts, onBytes) {
    const out = { count: 0, first: null, sectors: [] };
    for (const p of parts) {
      const back = await this.read(p.address, p.data.length, onBytes);
      for (let i = 0; i < back.length; i++) {
        if (back[i] === p.data[i]) continue;
        const addr = p.address + i;
        out.count++;
        if (!out.first) out.first = { addr, want: p.data[i], got: back[i] };
        const sec = this.layout.sectors.find((x) => addr >= x.start && addr < x.start + x.size);
        if (sec && !out.sectors.includes(sec)) out.sectors.push(sec);
      }
    }
    out.sectors.sort((a, b) => a.start - b.start);
    return out;
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

// The pieces of `parts` that fall inside the given sectors.
function clipToSectors(parts, sectors) {
  const out = [];
  for (const p of parts) {
    const end = p.address + p.data.length;
    for (const sec of sectors) {
      const a = Math.max(p.address, sec.start);
      const b = Math.min(end, sec.start + sec.size);
      if (a < b) out.push({ ...p, address: a, data: p.data.subarray(a - p.address, b - p.address) });
    }
  }
  return out.sort((x, y) => x.address - y.address);
}

function le32(cmd, addr) {
  return new Uint8Array([cmd, addr & 0xff, (addr >>> 8) & 0xff, (addr >>> 16) & 0xff, (addr >>> 24) & 0xff]);
}
