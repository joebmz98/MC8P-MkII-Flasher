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
    try {
      await this.device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 4, // DFU_CLRSTATUS
        value: 0,
        index: this.ifaceNum
      });
    } catch (e) {
      // Ignore if already clear
    }
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

  async setAddress(address) {
    const cmd = new Uint8Array([
      0x21, 
      address & 0xFF, 
      (address >> 8) & 0xFF, 
      (address >> 16) & 0xFF, 
      (address >> 24) & 0xFF
    ]);

    // Send Set Address Pointer command
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 1, // DFU_DNLOAD
      value: 0,
      index: this.ifaceNum
    }, cmd);

    // DFU state transition requirement: Must read status twice to clear DNLOAD state
    await this.getStatus();
    await this.getStatus();
  }

  async writeBlock(blockNum, data) {
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 1, // DFU_DNLOAD
      value: blockNum,
      index: this.ifaceNum
    }, data);

    // Read status twice after each block
    await this.getStatus();
    await this.getStatus();
  }
}