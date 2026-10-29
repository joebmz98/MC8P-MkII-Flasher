# MC8P-MkII-Flasher

Web firmware flasher and knob-assignment editor for the **MC8P MkII MIDI
Controller** (.axs instruments). Runs in Chrome or Edge.

The start page offers two tools:

| Tool | Talks to MC8P over | Needs |
| --- | --- | --- |
| **Update firmware** (`index.html#flash`) | WebUSB, to the STM32F411 ROM DFU bootloader | MC8P in DFU mode |
| **Edit knob assignments** (`editor.html`) | Web MIDI + SysEx, while MC8P runs normally | Firmware v3.2 or later |

## Repo layout

| File | What it is |
| --- | --- |
| `index.html` | Start screen (choose a tool) and the flasher, at `#flash` |
| `editor.html` | MC8P Editor: per-knob messages, scenes and display settings over USB MIDI |
| `dfuse.js` | STM32 DfuSe over WebUSB: HEX/BIN parsing, erase, write, verify, start |
| `manifest.json` | Which firmware the "Latest release" option flashes |
| `firmware/` | Release builds |
| `test/` | Simulated STM32F411 ROM bootloader and tests (`npm test`) |

## The editor

Everything the panel's ASSIGN and SETTINGS menus change can be changed here:

- **Each knob:** 1 to 10 messages, each with MIDI channel (1-16 or OMNI),
  CC number, curve (NOR, INV, LOG, ILG) and output range (min to max).
  Messages can be copied to other knobs.
- **Scenes:** scene CC, Step or Custom mode, custom list length and order.
- **Panel:** edit knob, display theme (MkII, MkI, YX), display invert.

Changes apply on MC8P straight away so they can be tried out, and are kept
only after **Save to MC8P** (the same as the panel's save prompt). The editor
also shows the knobs moving live, can undo back to the last save, factory
reset, and download or load a JSON backup. **Try demo** runs the whole page
against a simulated MC8P.

The SysEx protocol is documented at the top of the firmware sketch
(`F0 7D 4D 38 <cmd> ... F7`).

## Hosting

Turn on GitHub Pages (Settings > Pages > Deploy from branch > `main` / root).
WebUSB and Web MIDI need HTTPS, which Pages provides.

## Releasing new firmware

1. In Arduino IDE, build with the **MC8P MkII MIDI Controller** board option.
2. **Sketch > Export Compiled Binary** and copy the `.bin` into `firmware/`.
3. Update `manifest.json`: the `path` (if the file name changed) and `version`.
4. Run `npm test` (Node 18+, no packages).
5. Commit and push.

## Settings survive a flash

MC8P keeps its knob assignments and settings on the separate W25Q64 SPI
flash chip, not in the STM32's own flash, so flashing firmware never touches
them.

## Debug options

- `?block=256` in the flasher URL forces smaller USB transfers.
- **Download Log** saves the full session log for bug reports.
