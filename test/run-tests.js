// Run with: node test/run-tests.js   (Node 18 or newer, no packages needed)
// Flashes the real firmware files into a simulated STM32F411 ROM bootloader
// and checks every byte that ends up in its flash.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FirmwareImage, StmDfuse, parseIntelHex, parseMemoryLayout, DfuError, FLASH_BASE } from '../dfuse.js';
import { MockStm32Dfu } from './mock-stm32-dfu.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = (p) => join(root, p);
const appHex = readFileSync(file('firmware/MC8P_MIDICONTROLLER_FIRMWARE_STM.ino.hex'), 'utf8');
const appBin = new Uint8Array(readFileSync(file('firmware/MC8P_MIDICONTROLLER_FIRMWARE_STM.ino.bin')));
const blHex = readFileSync(file('firmware/WeAct_HID_Bootloader_F4x1.hex'), 'utf8');

let passed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.stack}`);
    process.exitCode = 1;
  }
}

function hidImage() {
  const img = new FirmwareImage();
  img.addHex(blHex, 'bootloader');
  img.addBin(appBin, FLASH_BASE + 0x4000, 'app');
  return img;
}

async function flashInto(mock, image, opts = {}) {
  const dfu = new StmDfuse(mock, { log: () => {} });
  await dfu.open();
  await dfu.flash(image, { verify: true, ...opts });
  return dfu;
}

console.log('Intel HEX and layout');

await test('app .hex parses to one block at 0x08004000 identical to the .bin', () => {
  const blocks = parseIntelHex(appHex);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].address, 0x08004000);
  assert.deepEqual(blocks[0].data, appBin);
});

await test('bootloader .hex parses to 16008 bytes at 0x08000000', () => {
  const blocks = parseIntelHex(blHex);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].address, 0x08000000);
  assert.equal(blocks[0].data.length, 16008);
});

await test('a corrupted HEX line is rejected', () => {
  const bad = appHex.replace(':104000000000022071670108C1670108C16701084B', ':104000000000022071670108C1670108C16701084C');
  assert.throws(() => parseIntelHex(bad), /checksum/);
});

await test('a truncated HEX file is rejected', () => {
  assert.throws(() => parseIntelHex(appHex.slice(0, 5000)), /end-of-file|Bad HEX/);
});

await test('F411 memory layout string parses into 8 sectors, 512 KB', () => {
  const l = parseMemoryLayout('@Internal Flash  /0x08000000/04*016Kg,01*064Kg,03*128Kg');
  assert.equal(l.sectors.length, 8);
  assert.equal(l.end - l.start, 512 * 1024);
  assert.equal(l.sectors[4].start, 0x08010000);
});

await test('overlapping parts are refused', () => {
  const img = new FirmwareImage();
  img.addHex(blHex, 'bootloader');
  img.addBin(appBin, FLASH_BASE + 0x1000, 'app');
  assert.throws(() => img.segments(), /overlaps/);
});

await test('an app built for 0x4000 on its own gets a warning', () => {
  const img = new FirmwareImage();
  img.addHex(appHex, 'app');
  assert.match(img.warnings().join(' '), /built for a bootloader/);
  assert.equal(hidImage().warnings().length, 0);
});

console.log('Flashing the simulated STM32F411 bootloader');

await test('HID bootloader + app: every byte lands where it should, gap stays 0xFF', async () => {
  const mock = new MockStm32Dfu({ fillFlash: 0x00 }); // dirty flash from an earlier attempt
  await flashInto(mock, hidImage());
  const bl = parseIntelHex(blHex)[0].data;
  assert.deepEqual(mock.read(0x08000000, bl.length), bl);
  const gap = mock.read(0x08000000 + bl.length, 0x4000 - bl.length);
  assert.ok(gap.every((b) => b === 0xff), 'bytes between bootloader and app (incl. the UID slot at 0x08003FF4) must be erased');
  assert.deepEqual(mock.read(0x08004000, appBin.length), appBin);
});

await test('single image at 0x08000000 (the recommended setup)', async () => {
  const mock = new MockStm32Dfu({ fillFlash: 0x5a });
  const img = new FirmwareImage();
  img.addBin(appBin, FLASH_BASE, 'app');
  await flashInto(mock, img);
  assert.deepEqual(mock.read(0x08000000, appBin.length), appBin);
});

await test('only the sectors the image touches are erased', async () => {
  const mock = new MockStm32Dfu({ fillFlash: 0x00 });
  await flashInto(mock, hidImage());
  const erases = mock.log.filter((l) => l.req === 1 && l.block === 0 && l.cmd === 0x41);
  assert.equal(erases.length, 5); // 4 x 16K + 1 x 64K covers 0x08000000 to 0x0801AA0B
  assert.ok(mock.read(0x08020000, 16).every((b) => b === 0x00), 'sector 5 untouched');
});

await test('works when the device does not report interface names', async () => {
  const mock = new MockStm32Dfu({ reportAltNames: false });
  const dfu = await flashInto(mock, hidImage());
  assert.equal(dfu.layout.sectors.length, 8);
  assert.equal(dfu.transferSize, 2048);
});

await test('works with a different transfer size (1024)', async () => {
  const mock = new MockStm32Dfu({ transferSize: 1024, fillFlash: 0x00 });
  await flashInto(mock, hidImage());
  assert.deepEqual(mock.read(0x08004000, appBin.length), appBin);
});

await test('recovers when an earlier session left the device in dfuERROR', async () => {
  const mock = new MockStm32Dfu();
  mock.state = 10; mock.status = 15;
  await flashInto(mock, hidImage());
  assert.deepEqual(mock.read(0x08004000, appBin.length), appBin);
});

await test('a failed write is reported, not swallowed', async () => {
  const mock = new MockStm32Dfu();
  const dfu = new StmDfuse(mock);
  await dfu.open();
  dfu.eraseSector = async () => {}; // pretend erase "succeeded" without erasing
  mock.flash.fill(0x00);
  await assert.rejects(dfu.flash(hidImage()), (e) => e instanceof DfuError && /still wrong after 3 repair/.test(e.message));
});

await test('a device-reported write error is reported', async () => {
  const mock = new MockStm32Dfu({ verifyWrites: true });
  const dfu = new StmDfuse(mock);
  await dfu.open();
  dfu.eraseSector = async () => {};
  mock.flash.fill(0x00);
  await assert.rejects(dfu.flash(hidImage()), (e) => e instanceof DfuError && /errVERIFY/.test(e.message));
});

await test('an image larger than the flash is refused before anything is erased', async () => {
  const mock = new MockStm32Dfu({ fillFlash: 0x11 });
  const img = new FirmwareImage();
  img.addBin(new Uint8Array(600 * 1024), FLASH_BASE, 'huge');
  const dfu = new StmDfuse(mock);
  await dfu.open();
  await assert.rejects(dfu.flash(img), /does not fit/);
  assert.ok(mock.read(0x08000000, 16).every((b) => b === 0x11));
});

await test('leave request makes the chip jump to 0x08000000', async () => {
  const mock = new MockStm32Dfu();
  const dfu = await flashInto(mock, hidImage());
  await dfu.leave(FLASH_BASE);
  assert.equal(mock.jumpedTo, FLASH_BASE);
});

const FAST = { opDelayMs: 0, nakWhileBusy: false };

console.log('Unreliable USB (the real-board failure: short requests work, 2 KB writes fail)');

await test('2 KB writes and reads fail: falls back to smaller blocks and still flashes everything', async () => {
  const mock = new MockStm32Dfu({ ...FAST, fillFlash: 0x00, failOutAbove: 512, failInAbove: 512 });
  const logs = [];
  const dfu = new StmDfuse(mock, { log: (m) => logs.push(m) });
  await dfu.open();
  await dfu.flash(hidImage(), { verify: true });
  assert.equal(dfu.blockSize, 512);
  assert.deepEqual(mock.read(0x08004000, appBin.length), appBin);
  assert.ok(logs.some((m) => /Retrying with 512 byte blocks/.test(m)));
});

await test('random transfer errors (some after the chip took the data) are retried', async () => {
  const mock = new MockStm32Dfu({ ...FAST, fillFlash: 0x00, flakyRate: 0.1, seed: 42 });
  await flashInto(mock, hidImage());
  assert.ok(mock.injectedFailures > 5, `only ${mock.injectedFailures} failures injected`);
  assert.deepEqual(mock.read(0x08000000, 16008), parseIntelHex(blHex)[0].data);
  assert.deepEqual(mock.read(0x08004000, appBin.length), appBin);
});

await test('a link that fails every data transfer ends with a clear USB error', async () => {
  const mock = new MockStm32Dfu({ ...FAST, failOutAbove: 0 });
  const dfu = new StmDfuse(mock);
  await dfu.open();
  await assert.rejects(dfu.flash(hidImage()), (e) => e.usbUnreliable === true && /even in 1 byte blocks/.test(e.message));
});

await test('unplugging mid-write gives a disconnect message', async () => {
  const mock = new MockStm32Dfu({ ...FAST, unplugAfterWrites: 3 });
  const dfu = new StmDfuse(mock);
  await dfu.open();
  await assert.rejects(dfu.flash(hidImage()), /disconnected/);
});

await test('block size can be forced lower (the ?block= option)', async () => {
  const mock = new MockStm32Dfu({ ...FAST, fillFlash: 0x00 });
  const dfu = new StmDfuse(mock, { blockSize: 256 });
  await dfu.open();
  await dfu.flash(hidImage());
  assert.equal(dfu.blockSize, 256);
  const writes = mock.log.filter((l) => l.req === 1 && l.block === 2);
  assert.ok(writes.every((w) => w.len <= 256));
  assert.deepEqual(mock.read(0x08004000, appBin.length), appBin);
});

console.log('Data-dependent failures (second real-board log: stuck at 0x08019740)');

// Model fitted to that log: packets with a run of more than 25 one-bits never
// get through, and about 1 in 5 packet attempts fails at random.
const REAL_BOARD = { ...FAST, runLimit: 25, packetErrorRate: 0.18, seed: 7 };

await test('v2 settings (no blank skipping, 64 byte minimum) get stuck at 0x08019740 like the real board', async () => {
  const mock = new MockStm32Dfu({ ...REAL_BOARD, fillFlash: 0x00 });
  const dfu = new StmDfuse(mock, { skipErased: false, minBlock: 64 });
  await dfu.open();
  await assert.rejects(dfu.flash(hidImage()), (e) => e.usbUnreliable === true && /0x08019740/.test(e.message));
});

await test('current settings flash and verify that same board', async () => {
  const mock = new MockStm32Dfu({ ...REAL_BOARD, fillFlash: 0x00 });
  const logs = [];
  const dfu = new StmDfuse(mock, { log: (m) => logs.push(m) });
  await dfu.open();
  await dfu.flash(hidImage(), { verify: true });
  assert.deepEqual(mock.read(0x08000000, 16008), parseIntelHex(blHex)[0].data);
  assert.deepEqual(mock.read(0x08004000, appBin.length), appBin);
  assert.ok(mock.injectedFailures > 0, 'the model should have dropped some transfers');
  assert.ok(logs.some((m) => /Skipped \d+ bytes that were 0xFF/.test(m)));
  assert.equal(dfu.blockSize, 2048, 'back to full size blocks afterwards');
  // Third real-board log: a write that died part way left a half block that
  // later got programmed. Recovery must throw such blocks away.
  assert.equal(mock.partialBlocksProgrammed, 0, 'no half-received block may reach flash');
  assert.ok(!logs.some((m) => /^Repairing/.test(m)), 'no repair should be needed');
});

await test('if the chip programs a half-received block itself, the sector is erased and rewritten', async () => {
  const mock = new MockStm32Dfu({ ...REAL_BOARD, fillFlash: 0x00, programOnError: 3 });
  const logs = [];
  const dfu = new StmDfuse(mock, { log: (m) => logs.push(m) });
  await dfu.open();
  await dfu.flash(hidImage(), { verify: true });
  assert.equal(mock.partialBlocksProgrammed, 3);
  assert.ok(logs.some((m) => /^Repairing: erasing and rewriting/.test(m)));
  assert.deepEqual(mock.read(0x08000000, 16008), parseIntelHex(blHex)[0].data);
  assert.deepEqual(mock.read(0x08004000, appBin.length), appBin);
});

await test('blank words are skipped, everything else is written', () => {
  const dfu = new StmDfuse(new MockStm32Dfu());
  const data = new Uint8Array([1, 2, 3, 4, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xff, 0xff, 0xff, 9, 9, 9, 9]);
  assert.deepEqual(dfu.writeSpans(data), [{ offset: 0, length: 4 }, { offset: 8, length: 4 }, { offset: 16, length: 4 }]);
  assert.deepEqual(new StmDfuse(new MockStm32Dfu(), { skipErased: false }).writeSpans(data), [{ offset: 0, length: 20 }]);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
