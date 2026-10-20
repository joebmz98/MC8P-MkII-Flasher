# MC8P MkII web flasher: what was wrong and what changed

## Short version

The old flasher could never have worked, even on a perfect board. It printed
"Flash operation completed successfully!" whatever happened. Run against a
simulated STM32F411 ROM bootloader, it left **97.5% of the bytes wrong** on a
blank chip and spent about **18 minutes** stuck in polling loops.

The new `index.html` + `dfuse.js` erase, write and read back every byte, and
report real errors. They pass 16 automated tests against the same simulated
bootloader (`node test/run-tests.js`).

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
