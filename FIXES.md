# MC8P MkII web flasher: what was wrong and what changed

## Short version

The old flasher could never have worked, even on a perfect board. It printed
"Flash operation completed successfully!" whatever happened. Run against a
simulated STM32F411 ROM bootloader, it left **97.5% of the bytes wrong** on a
blank chip and spent about **18 minutes** stuck in polling loops.

The new `index.html` + `dfuse.js` erase, write and read back every byte, and
report real errors. They pass 26 automated tests against a simulated
bootloader (`node test/run-tests.js`), including a model of the real board's
fault described below.

## What two real-board logs showed (Windows, Opera)

**Log 1:** connected, read the layout, erased all 5 sectors, then the first
2 KB write failed with "A transfer error has occurred".

**Log 2** (with retries and shrinking blocks): about 87% of the firmware went
in. A few blocks failed once and then worked, but the 64 bytes at
**0x08019740** failed every time, even alone. Those 64 bytes are:

```
ff ff ff ff ff ff ff ff ff e0 1c 00 7f 00 7f ff ...
```

That is one of the two packets in the whole firmware with the longest run of
1 bits (72 in a row; USB sends bytes lowest bit first). Every one of the 1,624
packets that went through had runs of 25 bits or less. Packets that are mostly
1 bits give the receiver very few signal edges to stay in sync with, so this
is the classic sign of a USB clock that is slightly off. Short requests have
no such runs, which is why they always worked.

The HID bootloader and tinyuf2 (UF2) set the board's clocks up themselves from
the 25 MHz crystal, and both of them carried this same firmware fine. Only the
chip's built-in ROM bootloader has the problem. A likely reason (not
confirmed): the ROM bootloader works out the crystal frequency using its own
rough internal oscillator, and 25 MHz is near the top of the range it accepts.

**Log 3** (new cable, motherboard port): every write got through, but the
read-back found a wrong byte at 0x08009400, right where a 1024 byte write had
failed twice. ST's DFU code accepts a write request as soon as it arrives,
before the data. When the data stops part way, the bootloader is left holding
a block that is part new data and part leftovers from the previous block. The
flasher's recovery then asked for the status (GETSTATUS), which in DFU means
"go ahead", so that half block got programmed. Flash bits can only go from 1
to 0, so the correct retry could not undo it. The read-back check caught it,
which is what it is there for. The new cable made no real difference, which
fits the theory above.

## What the flasher does about it now

1. **Skips blank words.** Any 4 bytes equal to `FF FF FF FF` are not sent: the
   erase already left them that way. This removes most long runs (the longest
   run in any packet drops from 80 bits to 35).
2. **Splits a failing block in half, again and again**, down to single bytes,
   like a binary search. A long run then ends up spread over separate USB
   packets, and each packet starts with a sync pattern the chip can lock onto.
   As soon as the bad spot is past, full 2 KB blocks resume.
3. **Throws away half-received blocks.** After a failed transfer it reads the
   state with GETSTATE (which has no side effects) and cancels any pending
   block with ABORT before doing anything else.
4. **Retries everything** (erase, write, read back), logs each problem, and
   only lowers the normal block size if full size blocks keep failing.
5. **Verifies, and repairs.** It reads back every byte it wrote (blank areas
   were checked by the erase). If anything is wrong, it erases just the
   affected sector(s), writes them again and re-checks, up to 3 times.

In the simulation fitted to the logs (packets with runs over 25 bits always
fail, random packet errors at the logged rate, and half-received blocks left
pending like ST's code does), the v2 settings get stuck at 0x08019740 and the
v3 recovery produces a verify failure, both just like the real board. This
version flashes and verifies everything, with no half block ever reaching
flash. Even if the chip programmed half blocks by itself, the repair step
erases and rewrites that sector and the result is still correct. 26 tests.

Expect some `WARN` lines in the log on this board; that is the flasher working
around the problem. Please send the log either way.

**If it still fails:** the fallback is UF2 (tinyuf2), which you already got
working. It does not use the ROM bootloader's USB at all. The web page can
still help there: offer the `.uf2` as a download and show "drag this onto the
MC8P drive".

## Bugs in the old flasher

1. **Wrong erase command.** It sent `0x44 + sector number`. The STM32 bootloader's
   erase command is `0x41` followed by a 4 byte address. The chip rejected it,
   the error was cleared silently, and nothing was ever erased.
2. **Only 2 of 5 sectors.** Even with the right command it only erased sectors 0
   and 1. The firmware reaches 0x0801AA0B, which spans sectors 0 to 4.
3. **Wrong block size.** It sent 1024 byte blocks with incrementing block
   numbers. The F411 bootloader works out the address as
   `(block - 2) x 2048 + pointer` (its transfer size is 2048), so every block
   after the first landed in the wrong place. The new code sets the address
   before every block, like dfu-util does.
4. **Wrong state number.** It waited for state 2 and called it "dfuDNLOAD-IDLE".
   That state is actually 5 (2 is dfuIDLE). So every wait ran its full
   100 x 100 ms timeout: about 10 seconds per block.
5. **Errors swallowed.** If the chip reported an error, the code cleared it and
   carried on, then always printed success.
6. **Zero padding instead of 0xFF.** The gap between the HID bootloader and the
   app was filled with 0x00. See the next section for why that matters.
7. **HEX parser ignored addresses.** It concatenated data bytes and threw away
   the address records, so any HEX file with a gap or an offset was scrambled.

## The WeAct HID bootloader (why "flash succeeded, code never ran")

I disassembled `WeAct_HID_Bootloader_F4x1.hex`. On every reset it:

1. Compares 12 bytes at **0x08003FF4** with the chip's unique ID.
   * Blank (0xFF): it writes the ID there, then **blinks the PC13 LED forever**.
     That is the first boot after installing it; one more reset fixes it.
   * Anything else (like the 0x00 padding the old flasher wrote): **blinks
     forever on every boot.** The app never starts.
2. Stays in bootloader mode if KEY (PA0) is held, or if RTC backup register
   19 holds 0x1234.
3. Otherwise jumps to the app at 0x08004000.

The app itself checks out: it is linked at 0x08004000, sets VTOR to
0x08004000, and configures a 25 MHz crystal to give 96 MHz and 48 MHz USB.

The new manifest still ships bootloader + app so it works today. The success
message tells people to press NRST once if the LED blinks.

## Recommended next step: drop the HID bootloader

The STM32's built-in DFU bootloader lives in ROM and cannot be erased, so a
second bootloader adds nothing for a web flasher, only one more way to fail.

1. In Arduino IDE, set **Tools > Upload method** to *STM32CubeProgrammer (DFU)*
   (or SWD) instead of *HID Bootloader 2.2*. This removes the 0x4000 offset.
   If the custom MC8P_MKII board entry has no such option, its
   `build.flash_offset` needs to be 0.
2. **Sketch > Export Compiled Binary.**
3. Check the new `.hex`: after `:020000040800F2` the next line should start
   `:10000000`, not `:10400000`.
4. Replace the manifest parts with just the HEX:

```json
{
  "name": "MC8P MkII MIDI Controller Firmware",
  "version": "v3.2",
  "builds": [
    {
      "chipFamily": "STM32F411",
      "parts": [
        { "path": "firmware/MC8P_MIDICONTROLLER_FIRMWARE_STM.ino.hex" }
      ]
    }
  ]
}
```

HEX parts use the addresses inside the file. BIN parts need `"offset"`
(relative to 0x08000000, or absolute).

## If the board still will not show up as "STM32 BOOTLOADER"

Software can't fix this part. On a Mac, check *System Information > USB* while in
DFU mode: if "STM32 BOOTLOADER" is not listed, the board is not in DFU mode.

* Hold BOOT0, tap NRST, keep BOOT0 held about a second. It can take a few tries.
* Use a short USB-C **data** cable, plugged straight into the computer.
* The Amazon boards are a "Wanjorlay" clone, not genuine WeAct. Clones vary.
* Try a bare board, not one fitted to the MC8P PCB. The ROM bootloader also
  listens on USART1 (PA9/PA10), and on this PCB those pins go to the mux select
  inputs. Noise there could make it pick serial instead of USB. That is a
  possibility, not something I have confirmed.
* Windows users need the WinUSB driver (Zadig) once. Macs need nothing.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Flasher page (same look, rewritten logic) |
| `dfuse.js` | STM32 DfuSe over WebUSB: HEX parsing, erase, write, verify, start |
| `manifest.json` | Which firmware the "Latest release" button flashes |
| `firmware/` | Unchanged copies of the current v3.1 files |
| `test/` | Simulated STM32F411 bootloader + tests, `node test/run-tests.js` |
| `package.json` | Only there so Node treats the `.js` files as modules |

`webdfu.js` from the old repo is no longer used and can be deleted.

New features: custom .hex/.bin upload, read-back verify, automatic start after
flashing, a progress bar, and plain-English error messages (including the
Windows driver case).
