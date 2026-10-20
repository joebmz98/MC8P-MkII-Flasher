// Standalone WebDFU helper for STM32
class WebDFU {
  constructor(device) {
    this.device = device;
    this.ifaceNum = 0;
  }

  async connect() {
    await this.device.open();
    await this.device.selectConfiguration(1);

    for (const iface of this.device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === 0xFE && alt.interfaceSubclass === 0x01) {
          this.ifaceNum = iface.interfaceNumber;
          break;
        }
      }
    }
    await this.device.claimInterface(this.ifaceNum);
    await this.clearStatus();
  }

  async clearStatus() {
    return this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 4, // DFU_CLRSTATUS
      value: 0,
      index: this.ifaceNum
    });
  }

  async getStatus() {
    const res = await this.device.controlTransferIn({
      requestType: 'class',
      recipient: 'interface',
      request: 3, // DFU_GETSTATUS
      value: 0,
      index: this.ifaceNum
    }, 6);
    return new Uint8Array(res.data.buffer);
  }

  async eraseSector(address) {
    const cmd = new Uint8Array([0x44, address & 0xFF, (address >> 8) & 0xFF, (address >> 16) & 0xFF, (address >> 24) & 0xFF]);
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 1, // DFU_DNLOAD
      value: 0,
      index: this.ifaceNum
    }, cmd);
    await this.pollUntilReady();
  }

  async setAddress(address) {
    const cmd = new Uint8Array([0x21, address & 0xFF, (address >> 8) & 0xFF, (address >> 16) & 0xFF, (address >> 24) & 0xFF]);
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 1, // DFU_DNLOAD
      value: 0,
      index: this.ifaceNum
    }, cmd);
    await this.pollUntilReady();
  }

  async pollUntilReady() {
    let status = await this.getStatus();
    while (status[4] === 4 || status[4] === 5) { // dfuDNLOAD-BUSY or dfuMANIFEST-BUSY
      await new Promise(r => setTimeout(r, status[1] | (status[2] << 8) | (status[3] << 16)));
      status = await this.getStatus();
    }
    if (status[4] !== 2) { // Not in dfuDNLOAD-IDLE
      await this.clearStatus();
    }
  }

  async writeBlock(blockNum, data) {
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 1, // DFU_DNLOAD
      value: blockNum,
      index: this.ifaceNum
    }, data);
    await this.pollUntilReady();
  }
}