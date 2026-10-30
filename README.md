# MC8P-MkII-Flasher

Web tools for the **MC8P MkII MIDI Controller** (.axs instruments, STM32F411CEU6
Black Pill): a firmware flasher and a knob-assignment editor. Nothing to
install. They run in **Chrome or Edge on a computer** (not Firefox, Safari or
phones) and need a USB-C data cable.

Opening the site shows a start page with two tools:

| Tool | Opens | Talks to MC8P over | MC8P needs to be |
| --- | --- | --- | --- |
| **Update firmware** | `index.html#flash` | WebUSB, to the STM32 ROM DFU bootloader | In DFU mode |
| **Edit knob assignments** | `editor.html` | Web MIDI + SysEx | Running normally, firmware v3.2 or later |

The start page reads `manifest.json` and shows the latest release version on
the badge and the flasher card.

## Edit knob assignments (MC8P Editor)

### Using it

1. Plug MC8P into the computer and let it start up as normal.
2. Open **Edit knob assignments** and click **Connect MC8P**.
3. Choose **Allow** when the browser asks to control MIDI devices (the editor
   needs SysEx access). It finds the port named MC8P, or asks every port if
   the system names it differently.
4. Click a knob in the top row, edit it, and click **Save to MC8P** when you
   are happy.

**Try demo** runs the whole page against a simulated MC8P with no hardware.
In the demo, drag a knob up or down to turn it.

### What it can change

Everything the panel's ASSIGN and SETTINGS menus change:

- **Each knob:** 1 to 10 messages. Each message has a MIDI channel (1-16 or
  OMNI), CC number, curve and output range (min to max; as on the panel, min
  can't pass max). **Copy these messages to** copies a knob's whole list to
  another knob.
- **Curves:** NOR (low to high), INV (high to low), LOG (fine at the bottom,
  fast at the top), ILG (falls fast, then fine).
- **Scenes:** scene CC (sent on channel 1 when the scene changes, value =
  scene number, scene 1 = 0), Step or Custom mode, and for Custom the list
  length (1-12) and the scene each step jumps to (1-99).
- **Panel:** edit knob (the knob that sets values in the panel's own menus),
  display theme (MkII, MkI, YX) and display invert.

### How changes behave

- **Live:** edits go to MC8P straight away so you can try them, but are kept
  only after **Save to MC8P** (the same as the panel's save prompt).
  **Undo changes** goes back to the last save.
- **In sync with the panel:** the editor polls MC8P several times a second. It
  shows each knob's position and the value each message is sending right now,
  and re-reads everything if settings are changed on the panel itself.
- **Factory reset** restores the defaults (asks for confirmation first).
- **Download backup / Load backup** saves every setting to a JSON file on the
  computer, or loads one back.

### Can't connect?

- Use Chrome or Edge on a computer.
- If MIDI access was blocked, allow it again from the icon in the address bar.
- Close any app holding MC8P's MIDI port (DAW, MIDI monitor). On Windows only
  one program can use a port at a time.
- Older firmware does not answer the editor: update to v3.2 or later with the
  flasher first. Saved settings survive the update (see below).
- Previews embedded in another site can't reach MIDI devices. Open the page
  in its own tab.

### SysEx protocol

Messages are `F0 7D 4D 38 <cmd> <data...> F7` (7D = non-commercial ID,
`4D 38` = "M8"). Firmware 3.2 implements protocol version 1:

| Cmd | Request | Reply |
| --- | --- | --- |
| `01` | INFO | `41`: protocol, knob count, max messages, max scenes, version string |
| `02` / `03` | GET_POT / SET_POT `<knob> <count> (<ch> <cc> <curve> <min> <max>)×count` | `42`: the knob's stored list |
| `04` / `05` | GET_GLOBAL / SET_GLOBAL | `44`: edit knob, scene CC, mode, length, 12-step order, theme, invert |
| `06` | STATUS | `46`: screen, settings checksums, 8 raw knob positions, scene |
| `07` / `08` / `09` | SAVE / REVERT / RESET | |

Channel 16 means OMNI; curves are 0-3 in the order above. The full
description is at the top of the firmware sketch.

## Update firmware (flasher)

### Using it

1. Connect MC8P straight to the computer (not a hub).
2. Enter DFU mode: **hold BOOT0, tap NRST**, keep holding BOOT0 for about a
   second, then let go (or hold BOOT0 while plugging in). The OLED stays
   blank. It can take two or three tries.
3. Pick the firmware and click **Flash Firmware**, then choose
   **STM32 BOOTLOADER** in the popup.
4. Wait for **Done**. MC8P restarts by itself; if not, press NRST once.

### Options

- **Latest release:** the files listed in `manifest.json`, downloaded from the
  site.
- **Custom file:** a `.hex` or `.bin` you built. Prefer `.hex`, which carries
  its own address. For a `.bin`, enter the start address (default
  `0x08000000`; small numbers such as `0x4000` are taken as offsets from
  the start of flash).
- **Verify after writing** (on by default) reads back every byte written and
  repairs any bad sector, up to 3 times.
- **Start firmware when done** (on by default).

Some boards' ROM bootloader drops certain data patterns, so a few `WARN`
lines in the log are normal: the flasher skips blank words, re-sends failing
blocks in smaller pieces and checks the result. See `FIXES.md` for the full
story.

### Troubleshooting

- **STM32 BOOTLOADER not in the list:** the board isn't in DFU mode yet. Try
  again, try another cable (many USB-C cables are charge only).
- **Windows, "Access denied" / "Unable to claim interface":** install the
  WinUSB driver once with [Zadig](https://zadig.akeo.ie/) (Options > List All
  Devices > STM32 BOOTLOADER > WinUSB > Replace Driver).
- **Linux, can't open the device:** add a udev rule, e.g.
  `SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"`
  in `/etc/udev/rules.d/50-stm32-dfu.rules`, then replug.
- **Flashed but doesn't start:** release BOOT0 and press NRST. If the LED
  blinks quickly, the WeAct HID bootloader is on the board; press NRST again.
- `?block=256` on the flasher URL forces smaller USB transfers.
- **Download Log** saves the whole session log for bug reports.

## Settings survive a flash

MC8P keeps its knob assignments and settings on the separate W25Q64 SPI flash
chip, not in the STM32's own flash, so flashing firmware never touches them.

## Repo layout

| File | What it is |
| --- | --- |
| `index.html` | Start page (choose a tool) and the flasher, at `#flash` |
| `editor.html` | MC8P Editor, including the demo device |
| `theme.css` | 1-bit pixel theme (frames, buttons, fonts), the same file as the DCLK web tools |
| `assets/fonts/` | Alagard, Silkscreen, Pixelify Sans and VT323, with `LICENSES.txt` |
| `assets/icons/` | Browser tab and home-screen icons: the .axs instruments figure as 1-bit pixel art |
| `dfuse.js` | STM32 DfuSe over WebUSB: HEX/BIN parsing, erase, write, verify, start |
| `manifest.json` | Version and firmware parts the "Latest release" option flashes |
| `firmware/` | Release builds |
| `test/` | Simulated STM32F411 ROM bootloader and flasher tests (`npm test`) |
| `FIXES.md` | What was wrong with the old flasher and how this one works around the board's bootloader |
| `webdfu.js` | The old flasher's DFU code, no longer used by either page |

## Hosting

Turn on GitHub Pages (Settings > Pages > Deploy from branch > `main` / root).
WebUSB and Web MIDI both need HTTPS, which Pages provides.

## Releasing new firmware

1. In Arduino IDE, build with the **MC8P MkII MIDI Controller** board option.
2. **Sketch > Export Compiled Binary** and copy the `.hex` (preferred) or
   `.bin` into `firmware/`.
3. Update `manifest.json`:
   - `version`: shown on the start page, the badge and the release option.
   - `builds[0].parts`: each file to flash, in order. A `.hex` needs only
     `path`; a `.bin` also needs `offset` (e.g. `"0x4000"`). Parts must not
     overlap.
   - `note` (optional): shown after a successful flash of the release.
4. If the editor protocol changed, update `editor.html` to match and the
   "firmware v3.x or later" wording on both pages.
5. Run `npm test` (Node 18+, no packages).
6. Commit and push.
