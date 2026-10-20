// A simulated STM32F411 system (ROM) bootloader in DFU mode, shaped like a
// WebUSB USBDevice. It follows ST AN3156: DfuSe commands in block 0, data in
// blocks >= 2 written at ((block - 2) * wTransferSize) + address pointer, and
// flash that has to be erased before it can be written. Runs in Node and in a
// browser (inject it as navigator.usb to test the page without hardware).

const S = {
  dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6, dfuMANIFEST: 7, dfuUPLOAD_IDLE: 9, dfuERROR: 10,
};
const errVERIFY = 7, errADDRESS = 8, errSTALLEDPKT = 15, errTARGET = 1;

const FLASH_BASE = 0x08000000;
const SECTORS = [16, 16, 16, 16, 64, 128, 128, 128].map((k) => k * 1024);
const ALT_NAMES = [
  '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,03*128Kg',
  '@Option Bytes  /0x1FFFC000/01*016 e',
  '@OTP Memory /0x1FFF7800/01*512 e,01*016 e',
  '@Device Feature/0xFFFF0000/01*004 e',
];

export class MockStm32Dfu {
  constructor({
    transferSize = 2048,
    fillFlash = 0x00,          // contents left by an earlier flash; 0xFF means blank
    opDelayMs = 2,             // time an erase or write keeps the device busy
    nakWhileBusy = true,       // GETSTATUS during an operation fails, like the real chip
    reportAltNames = true,     // false: interfaceName is null, forcing the descriptor fallback
    // Fault injection, to imitate a board with an unreliable USB link:
    failOutAbove = null,       // DNLOAD data longer than this fails with a transfer error
    failInAbove = null,        // UPLOAD longer than this fails with a transfer error
    flakyRate = 0,             // chance that any data transfer fails
    seed = 1,                  // makes flakyRate repeatable
    unplugAfterWrites = null,  // device vanishes after this many data writes
    // Model of the real board's weakness: a 64 byte USB packet whose longest run
    // of 1 bits (sent LSB first) is longer than runLimit never gets through, and
    // any packet fails with packetErrorRate (the host retries a packet 3 times).
    runLimit = null,
    packetErrorRate = 0,
    // Like ST's DFU code, the bootloader accepts a DNLOAD at the setup stage, so
    // a data stage that dies part way leaves a half-new, half-stale block
    // pending in dfuDNLOAD-SYNC. A GETSTATUS then programs it; ABORT discards it.
    partialOnError = true,
    // Worst case: the chip programs the half-received block by itself.
    programOnError = 0,        // how many times to do that
    // The real ROM does not check what it programmed (the board's log showed a
    // wrong byte with no write error), so a bad write only shows up on read back.
    verifyWrites = false,
  } = {}) {
    this.verifyWrites = verifyWrites;
    this.partialOnError = partialOnError;
    this.programOnError = programOnError;
    this.buffer = new Uint8Array(transferSize);
    this.partialBlocksProgrammed = 0;
    this.runLimit = runLimit;
    this.packetErrorRate = packetErrorRate;
    this.failOutAbove = failOutAbove;
    this.failInAbove = failInAbove;
    this.flakyRate = flakyRate;
    this._seed = seed;
    this.unplugAfterWrites = unplugAfterWrites;
    this.dataWrites = 0;
    this.injectedFailures = 0;
    this.vendorId = 0x0483;
    this.productId = 0xdf11;
    this.productName = 'STM32  BOOTLOADER';
    this.manufacturerName = 'STMicroelectronics';
    this.serialNumber = '336A35763331';
    this.transferSize = transferSize;
    this.opDelayMs = opDelayMs;
    this.nakWhileBusy = nakWhileBusy;
    this.flash = new Uint8Array(512 * 1024).fill(fillFlash);
    this.opened = false;
    this.configuration = null;
    this.state = S.dfuIDLE;
    this.status = 0;
    this.pointer = FLASH_BASE;
    this.pending = null;
    this.busyUntil = 0;
    this.gone = false;
    this.jumpedTo = null;
    this.log = [];
    this._config = {
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 0,
        claimed: false,
        alternates: ALT_NAMES.map((name, i) => ({
          alternateSetting: i, interfaceClass: 0xfe, interfaceSubclass: 0x01, interfaceProtocol: 0x02,
          interfaceName: reportAltNames ? name : null, endpoints: [],
        })),
      }],
    };
    this.configurations = [this._config];
  }

  // Helpers for tests
  read(addr, len) { return this.flash.slice(addr - FLASH_BASE, addr - FLASH_BASE + len); }
  eraseAll() { this.flash.fill(0xff); }

  _rand() {
    this._seed = (this._seed * 1103515245 + 12345) & 0x7fffffff;
    return this._seed / 0x7fffffff;
  }

  // Index of the first 64 byte packet the modelled link drops, or -1.
  _droppedPacket(bytes) {
    if (this.runLimit === null && !this.packetErrorRate) return -1;
    for (let p = 0; p < bytes.length; p += 64) {
      const packet = bytes.subarray(p, p + 64);
      if (this.runLimit !== null && longestOnes(packet) > this.runLimit) return p / 64;
      let ok = false;
      for (let tries = 0; tries < 3 && !ok; tries++) ok = this._rand() >= this.packetErrorRate;
      if (!ok) return p / 64;
    }
    return -1;
  }

  _linkDrops(bytes) { return this._droppedPacket(bytes) >= 0; }

  _transferError() {
    this.injectedFailures++;
    const e = new Error('A transfer error has occurred.');
    e.name = 'NetworkError';
    throw e;
  }

  _alive() {
    if (this.gone) {
      const e = new Error('The device was disconnected.');
      e.name = 'NotFoundError';
      throw e;
    }
  }

  async open() { this._alive(); this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration(v) { this._alive(); if (v !== 1) throw new Error('bad config'); this.configuration = this._config; }
  async claimInterface(n) { this._alive(); this._config.interfaces[n].claimed = true; }
  async releaseInterface(n) { this._config.interfaces[n].claimed = false; }
  async selectAlternateInterface(n, alt) { this._alive(); this.alt = alt; }
  async reset() {}

  async controlTransferIn(setup, length) {
    this._alive();
    if (setup.requestType === 'standard' && setup.request === 6) return this._getDescriptor(setup, length);
    if (setup.requestType !== 'class') return { status: 'stall' };
    switch (setup.request) {
      case 3: return this._getStatus();
      case 5: // GETSTATE has no side effects, except that a finished operation is finished
        if (this.state === S.dfuDNBUSY && Date.now() >= this.busyUntil) this._execute();
        return ok(new Uint8Array([this.state]));
      case 2:
        if ((this.failInAbove !== null && length > this.failInAbove) || (length > 16 && this._rand() < this.flakyRate)) {
          this._transferError();
        }
        {
          const r = this._upload(setup.value, length);
          if (r.status === 'ok' && this._linkDrops(new Uint8Array(r.data.buffer))) this._transferError();
          return r;
        }
      default: return this._stall();
    }
  }

  async controlTransferOut(setup, data) {
    this._alive();
    if (setup.requestType !== 'class') return { status: 'stall' };
    const bytes = data ? new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data) : new Uint8Array(0);
    this.log.push({ req: setup.request, block: setup.value, len: bytes.length, cmd: bytes[0] });
    if (setup.request === 1 && setup.value >= 2) {
      if (this.unplugAfterWrites !== null && this.dataWrites >= this.unplugAfterWrites) this.gone = true;
      this._alive();
      this.dataWrites++;
      if (this.failOutAbove !== null && bytes.length > this.failOutAbove) this._transferError();
      const dropped = this._droppedPacket(bytes);
      if (dropped >= 0) {
        if (this.partialOnError && (this.state === S.dfuIDLE || this.state === S.dfuDNLOAD_IDLE) && bytes.length <= this.transferSize) {
          this.buffer.set(bytes.subarray(0, dropped * 64));
          const block = this.buffer.slice(0, bytes.length);
          this.pending = { block: setup.value, bytes: block, partial: true };
          this.state = S.dfuDNLOAD_SYNC;
          if (this.programOnError > 0) {
            this.programOnError--;
            this.partialBlocksProgrammed++;
            this._executingOnError = true;
            this._execute();
            this._executingOnError = false;
          }
        }
        this._transferError();
      }
      if (this._rand() < this.flakyRate) {
        // Half the time the chip got the data and only the handshake was lost.
        if (this._rand() < 0.5) this._dnload(setup.value, bytes);
        this._transferError();
      }
    }
    switch (setup.request) {
      case 1: return this._dnload(setup.value, bytes);
      case 4: // CLRSTATUS
        if (this.state === S.dfuERROR) { this.state = S.dfuIDLE; this.status = 0; }
        return { status: 'ok', bytesWritten: 0 };
      case 6: // ABORT
        if (this.state === S.dfuERROR) return this._stall();
        this.state = S.dfuIDLE;
        return { status: 'ok', bytesWritten: 0 };
      default: return this._stall();
    }
  }

  _stall(status = errSTALLEDPKT) {
    this.state = S.dfuERROR;
    this.status = status;
    return { status: 'stall' };
  }

  _getDescriptor(setup, length) {
    const type = setup.value >> 8, index = setup.value & 0xff;
    if (type === 0x02) {
      const parts = [[9, 2, 0, 0, 1, 1, 0, 0x80, 50]];
      ALT_NAMES.forEach((_, i) => parts.push([9, 4, 0, i, 0, 0xfe, 1, 2, 4 + i]));
      const ts = this.transferSize;
      parts.push([9, 0x21, 0x0b, 0xff, 0x00, ts & 0xff, ts >> 8, 0x1a, 0x01]);
      const all = Uint8Array.from(parts.flat());
      all[2] = all.length & 0xff; all[3] = all.length >> 8;
      return ok(all.slice(0, length));
    }
    if (type === 0x03 && index >= 4 && index < 4 + ALT_NAMES.length) {
      const s = ALT_NAMES[index - 4];
      const out = new Uint8Array(2 + s.length * 2);
      out[0] = out.length; out[1] = 3;
      for (let i = 0; i < s.length; i++) { out[2 + i * 2] = s.charCodeAt(i); out[3 + i * 2] = 0; }
      return ok(out.slice(0, length));
    }
    return { status: 'stall' };
  }

  _getStatus() {
    const reply = (pollTimeout) => ok(new Uint8Array([
      this.status, pollTimeout & 0xff, (pollTimeout >> 8) & 0xff, pollTimeout >> 16, this.state, 0,
    ]));
    if (this.state === S.dfuDNLOAD_SYNC) {
      // First GETSTATUS after a DNLOAD: report busy and start the operation.
      this.state = S.dfuDNBUSY;
      this.busyUntil = Date.now() + this.opDelayMs;
      return reply(this.opDelayMs);
    }
    if (this.state === S.dfuDNBUSY) {
      if (Date.now() < this.busyUntil) {
        if (this.nakWhileBusy) {
          const e = new Error('A transfer error has occurred.');
          e.name = 'NetworkError';
          throw e;
        }
        return reply(this.busyUntil - Date.now());
      }
      this._execute();
      return reply(0);
    }
    if (this.state === S.dfuMANIFEST_SYNC) {
      this.state = S.dfuMANIFEST;
      this.jumpedTo = this.pointer;
      const r = reply(0);
      this.gone = true; // the chip jumps to the firmware and drops off the bus
      return r;
    }
    return reply(0);
  }

  _dnload(block, bytes) {
    if (this.state !== S.dfuIDLE && this.state !== S.dfuDNLOAD_IDLE) return this._stall();
    if (bytes.length === 0) {
      if (this.state !== S.dfuDNLOAD_IDLE) return this._stall();
      this.state = S.dfuMANIFEST_SYNC;
      return { status: 'ok', bytesWritten: 0 };
    }
    if (bytes.length > this.transferSize) return this._stall();
    if (block === 0) {
      const cmd = bytes[0];
      const valid = (cmd === 0x21 && bytes.length === 5) || (cmd === 0x41 && (bytes.length === 5 || bytes.length === 1)) || cmd === 0x00 || cmd === 0x92;
      if (!valid) return this._stall();
    } else if (block === 1) {
      return this._stall();
    }
    if (block >= 2) this.buffer.set(bytes);
    this.pending = { block, bytes };
    this.state = S.dfuDNLOAD_SYNC;
    return { status: 'ok', bytesWritten: bytes.length };
  }

  _execute() {
    const { block, bytes, partial } = this.pending;
    if (partial && !this._executingOnError) this.partialBlocksProgrammed++;
    this.pending = null;
    const fail = (code) => { this.state = S.dfuERROR; this.status = code; };
    if (block === 0) {
      const cmd = bytes[0];
      const addr = bytes.length >= 5 ? (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0 : null;
      if (cmd === 0x21) {
        this.pointer = addr;
      } else if (cmd === 0x41 && addr === null) {
        this.flash.fill(0xff);
      } else if (cmd === 0x41) {
        let start = FLASH_BASE, hit = false;
        for (const size of SECTORS) {
          if (addr >= start && addr < start + size) { this.flash.fill(0xff, start - FLASH_BASE, start - FLASH_BASE + size); hit = true; break; }
          start += size;
        }
        if (!hit) return fail(errADDRESS);
      }
      this.state = S.dfuDNLOAD_IDLE;
      return;
    }
    const addr = ((block - 2) * this.transferSize + this.pointer) >>> 0;
    const off = addr - FLASH_BASE;
    if (addr < FLASH_BASE || off + bytes.length > this.flash.length) return fail(errTARGET);
    for (let i = 0; i < bytes.length; i++) {
      // Flash bits can only be programmed from 1 to 0; writing over old data corrupts it.
      this.flash[off + i] &= bytes[i];
    }
    if (this.verifyWrites) {
      for (let i = 0; i < bytes.length; i++) {
        if (this.flash[off + i] !== bytes[i]) return fail(errVERIFY);
      }
    }
    this.state = S.dfuDNLOAD_IDLE;
  }

  _upload(block, length) {
    if (this.state !== S.dfuIDLE && this.state !== S.dfuUPLOAD_IDLE) return this._stall();
    if (block < 2) return this._stall();
    const addr = ((block - 2) * this.transferSize + this.pointer) >>> 0;
    const off = addr - FLASH_BASE;
    if (addr < FLASH_BASE || off + length > this.flash.length) return this._stall(errADDRESS);
    this.state = S.dfuUPLOAD_IDLE;
    return ok(this.flash.slice(off, off + length));
  }
}

function longestOnes(bytes) {
  let best = 0, cur = 0;
  for (const b of bytes) {
    for (let i = 0; i < 8; i++) {
      if ((b >> i) & 1) { cur++; if (cur > best) best = cur; } else cur = 0;
    }
  }
  return best;
}

function ok(bytes) {
  const copy = new Uint8Array(bytes);
  return { status: 'ok', data: new DataView(copy.buffer) };
}

// A stand-in for navigator.usb that always "picks" the given device.
export function mockUsb(device) {
  return {
    async requestDevice() { return device; },
    async getDevices() { return [device]; },
    addEventListener() {},
  };
}
