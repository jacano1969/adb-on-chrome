/*
 * Copyright 2013 Kenny Root
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

(function(exports) {
  var DEVICES = [
    // Nexus S
    {
      'vendorId' : 0x18D1,
      'productId' : 0x4E22,
    },

    // Nexus 10
    {
      'vendorId' : 0x18D1,
      'productId' : 0x4EE2,
    }
  ];

  var INPUT = 136;
  // 0x88
  var OUTPUT = 7;
  // 0x07
  //var INPUT = 131; // 0x83
  //var OUTPUT = 2; // 0x02

  /**
   * The expected USB interface descriptor number. This should be found by
   * looking at the interface descriptors and finding the one that has
   * class=255 and subclass=66.
   *
   * @const
   * @type {Number}
   */
  var ADB_INTERFACE = 1;

  /**
   * arg0 value for A_AUTH packet to request a token to be signed.
   *
   * @const
   * @type {Number}
   */
  var ADB_AUTH_TOKEN = 1;

  /**
   * arg0 value for A_AUTH packet to denote a signed token response.
   *
   * @const
   * @type {Number}
   */
  var ADB_AUTH_SIGNATURE = 2;

  /**
   * arg0 value for A_AUTH packet to denote a new public key when none of the
   * existing keys on the server were accepted.
   *
   * @const
   * @type {Number}
   */
  var ADB_AUTH_RSAPUBLICKEY = 3;

  var permissionObj = {
    permissions : [{
      'usbDevices' : DEVICES
    }]
  };

  /**
   * Creates an instance of the ADB server.
   *
   * @param {Number}
   *            port The TCP port to listen to for ADB connections
   */
  function AdbServer(port) {
    /** @private */
    this.port = port;
    /** @private */
    this.server = new TcpServer('127.0.0.1', port, {});
    /** @private */
    this.usb = chrome.usb;
    /** @private */
    this.devices = [];
    /** @private */
    this.sockets = {};
  }

  /**
   * Returns list of USB devices.
   */
  AdbServer.prototype.getDeviceInfos = function() {
    return DEVICES.slice(0);
  };

  /**
   * Sets the USB stack for unit testing.
   *
   * @param {Object} usb Chrome's USB API
   */
  AdbServer.prototype.setUsb = function(usb) {
    this.usb = usb;
  };

  /**
   * Starts the ADB server and listens on TCP socket.
   */
  AdbServer.prototype.start = function() {
    console.log('Started listening');
    this.server.listen(this._onAcceptCallback.bind(this));
  };

  AdbServer.prototype.stop = function() {
    console.log('Stopped listening');
    this.server.disconnect();
  };

  AdbServer.prototype._onAcceptCallback = function(tcpConnection) {
    var socket = new AdbSocket(this, tcpConnection);
    tcpConnection.addDataReceivedListener(socket._onDataReceived.bind(socket));
    tcpConnection.callbacks.disconnect = socket._onDisconnect.bind(socket);
    this.addSocket(socket);
  };

  /**
   * Used for testing.
   */
  AdbServer.prototype.addSocket = function(socket) {
    console.log('AdbServer adding socket ' + socket.id);
    this.sockets[socket.id] = socket;
  };

  /**
   * Deletes a socket by ID from the server. Should only be called
   * by the socket itself.
   */
  AdbServer.prototype.removeSocket = function(id) {
    delete this.sockets[id];
  };

  AdbServer.prototype.closeSocketsToDevice = function(device) {
    for (var socketId in this.sockets) {
      var socket = this.sockets[socketId];
      if (socket.device === device) {
        this.closeSocket(socketId);
      }
    }
  };

  /**
   * Scans through all the possible device info (vendor and product ID pairs), the devices
   * returned for each, and then returns all the devices that match an ADB descriptor in
   * the callback.
   */
  AdbServer.prototype._scanDevices = function(deviceInfos, filtered, devices, callback) {
    /* Base cases. */
    if (devices.length == 0) {
      if (deviceInfos.length == 0) {
        /* No more device IDs or devices from a previous device ID to scan. */
        callback(filtered);
      } else {
        /* We read all the devices for the previous ID. Scan a new one. */
        var deviceInfo = deviceInfos.shift();
        this.usb.findDevices(deviceInfo, function(devices) {
          this._scanDevices(deviceInfos, [], devices, callback);
        }.bind(this));
      }
      return;
    }

    var device = devices.shift();
    this.usb.listInterfaces(device, function(interfaces) {
      /* There was some kind of error. */
      if (interfaces === undefined) {
        this.usb.resetDevice(device, function() {
          // TODO retry the device
          console.log("reset device!");
        });
      }

      for (var intfIndex in interfaces) {
        var intf = interfaces[intfIndex];
        if (intf.interfaceClass === 0xFF && intf.interfaceSubclass === 0x42) {
          var inAddress = -1;
          var outAddress = -1;
          for (var endIdx in intf.endpoints) {
            var endpoint = intf.endpoints[endIdx];
            if (endpoint.type === "bulk") {
              if (endpoint.direction === "in") {
                inAddress = endpoint.address;
              } else {
                outAddress = endpoint.address;
              }
            }
          }
          if (inAddress !== -1 && outAddress !== -1) {
            filtered.push(new UsbDevice(device, this, intf.interfaceNumber, inAddress, outAddress));
          }
        }
      }
      this._scanDevices(deviceInfos, filtered, devices, callback);
    }.bind(this));
  };

  /**
   * Rescans the bus for known devices.
   */
  AdbServer.prototype._rescan = function(callback) {
    var deviceInfos = DEVICES.slice(0);
    this._scanDevices(deviceInfos, [], [], callback);
  };

  /**
   * Gets a list of UsbDevice currently discovered.
   * 
   * @this {AdbServer}
   * @param {Function} callback function to call when call is completed
   */
  AdbServer.prototype.getDevices = function(callback) {
    if (this.devices.length !== 0) {
      callback(this.devices);
    } else {
      this._rescan(callback);
    }
  };

  /**
   * Gets the socket associated with the given socket ID.
   *
   * @this {AdbServer}
   * @param {Number} id ID of socket
   */
  AdbServer.prototype.getSocketById = function(id) {
    return this.sockets[id];
  };

  /**
   * Close a socket that this server is tracking.
   *
   * @this {AdbServer}
   * @param {Number} id ID of socket to close.
   */
  AdbServer.prototype.closeSocket = function(id) {
    var socket = this.sockets[id];
    if (socket !== null) {
      socket.conn.disconnect();
    }
  };

  /**
   * Creates an ADB socket instance.
   * @constructor
   */
  function AdbPacket() {
    this.command = 0;
    this.arg0 = 0;
    this.arg1 = 0;
    this.data = new Uint8Array([]).buffer;
    this.data_length = 0;
    this.data_check = 0;
    this.magic = 0;
    this.callback = null;
  }

  /**
   * Parse a USB message header off the wire.
   *
   * @this {AdbPacket}
   * @param {ArrayBuffer} array message from the wire
   * @returns {Boolean} true if parsed correctly
   */
  AdbPacket.prototype.fromMessage = function(array) {
    try {
      var u32 = new Uint32Array(array);
      this.command = u32[0];
      this.arg0 = u32[1];
      this.arg1 = u32[2];
      this.data_length = u32[3];
      this.data_check = u32[4];
      this.magic = u32[5];
      return true;
    } catch (ex) {
      return false;
    }
  };

  /**
   * Checks to make sure the magic value matches the command.
   *
   * @this {AdbPacket}
   * @returns {Boolean} true if message and magic match
   */
  AdbPacket.prototype.isValid = function() {
    var magic = (this.command ^ 0xFFFFFFFF) >>> 0;
    return this.magic === magic;
  };

  /**
   * Sets the command for this packet and the magic value.
   *
   * @this {AdbPacket}
   * @param {Number} command sets the USB command
   */
  AdbPacket.prototype.setCommand = function(command) {
    this.command = command;
    this.magic = (command ^ 0xFFFFFFFF) >>> 0;
  };

  /**
   * Converts to a USB packet wire format.
   *
   * @this {AdbPacket}
   * @returns {ArrayBuffer} in USB wire format
   */
  AdbPacket.prototype.toMessage = function() {
    var array = new ArrayBuffer(24);
    var view = new Uint32Array(array);
    view[0] = this.command;
    view[1] = this.arg0;
    view[2] = this.arg1;
    view[3] = this.data_length;
    view[4] = this.data_check;
    view[5] = this.magic;
    return array;
  };

  /**
   * Sets the data, data length, and data checksum for outbound packets.
   *
   * @this {AdbPacket}
   * @param {ArrayBuffer} data the data payload for this packet
   */
  AdbPacket.prototype.setData = function(data) {
    this.data = new Uint8Array(data).buffer;
    this.data_length = this.data.byteLength;
    this.data_check = this._checksum(this.data);
  };

  /**
   * @this {AdbPacket}
   * @param {ArrayBuffer} data data to checksum
   * @returns {Number} in USB wire format
   * @private
   */
  AdbPacket.prototype._checksum = function(data) {
    var sum = 0;
    var byteArray = new Uint8Array(data);
    var len = byteArray.length;
    for (var i = 0; i < len; i++) {
      sum = (sum + byteArray[i]) % 0xFFFFFFFF;
    }
    return sum;
  };

  /**
   * @this {AdbPacket}
   * @returns {Boolean} true if data checksums correctly.
   */
  AdbPacket.prototype.isDataValid = function() {
    return this._checksum(this.data) === this.data_check;
  };

  /**
   * Sets the callback to call once the packet has been sent.
   * @this {AdbPacket}
   */
  AdbPacket.prototype.setCallback = function(callback) {
    this.callback = callback;
  };

  /**
   * @const
   */
  var ADBMESSAGE_SIZE = 24;

  /**
   * @const
   */
  var A_CNXN = 0x4e584e43;

  /**
   * @const
   */
  var A_OPEN = 0x4e45504f;

  /**
   * @const
   */
  var A_OKAY = 0x59414b4f;

  /**
   * @const
   */
  var A_CLSE = 0x45534c43;

  /**
   * @const
   */
  var A_WRTE = 0x45545257;

  /**
   * @const
   */
  var A_AUTH = 0x48545541;

  /**
   * Current version of the ADB USB protocol.
   *
   * @const
   */
  var A_VERSION = 0x01000000;

  /**
   * Enumeration state for UsbDevice objects.
   */
  var UsbState = {
    'OFFLINE' : 1,
    'BOOTLOADER' : 2,
    'FASTBOOT' : 3,
    'ONLINE' : 4
  };
  Object.freeze(UsbState);

  /**
   * Represents a USB device.
   *
   * @constructor
   * @param {Number} device USB device handle
   * @param {AdbServer} mapper mapper of connection ID to TCP session
   * @param {Number} inAddress endpoint address for input
   * @param {Number} outAddress endpoint address for output
   */
  function UsbDevice(device, mapper, interfaceNumber, inAddress, outAddress) {
    /** @private */
    this.usb = chrome.usb;
    /** @private */
    this.auth = new AuthManager();
    /** @private */
    this.device = device;
    /** @private */
    this.mapper = mapper;
    /** @private */
    this.state = UsbState.OFFLINE;
    /** @private */
    this.queue = [];
    /** @private */
    this.currentlyWriting = false;
    /** @private */
    this.onCnxn = null;
    /** @private */
    this.interfaceNumber = interfaceNumber;
    /** @private */
    this.outputDescriptor = outAddress;
    /** @private */
    this.inputDescriptor = inAddress;
    /** @private */
    this.serialNo = "";
    /** @private */
    this.banner = "";
    /** @private */
    this.maxData = 4096;
  }

  /**
   * Starts the USB device communication.
   */
  UsbDevice.prototype.initialize = function(callback) {
    this.auth.initialize(function() {
      console.log('Trying to claim USB interface ' + this.interfaceNumber);
      this.usb.claimInterface(this.device, this.interfaceNumber, function() {
        console.log('Claimed USB interface ' + this.interfaceNumber);
        this._onDeviceRead();
        this._sendConnectPacket(callback);
      }.bind(this));
    }.bind(this));
  };

  /**
   * Called when device should be disconnected.
   * @private
   */
  UsbDevice.prototype._disconnect = function(callback) {
    this.mapper.closeSocketsToDevice(this, function() {
      this.usb.releaseInterface(this.device, this.interfaceNumber, function() {
        this.usb.closeDevice(this.device, function() {
          if (callback !== null) {
            callback();
          }
        }.bind(this));
      }.bind(this));
    }.bind(this));
  };

  /**
   * Sets a USB object to use for all API calls. Used for mocking.
   * @param usb the USB object to use
   */
  UsbDevice.prototype.setUsb = function(usb) {
    this.usb = usb;
  };

  /**
   * Enqueues a packet to send to the USB device.
   * @param {AdbPacket} packet
   * @this {UsbDevice}
   * @private
   */
  UsbDevice.prototype._enqueuePacket = function(packet) {
    console.log('enqueued header (msg=' + packet.command + ', magic=' + packet.magic);
    this.queue.push(packet);

    if (!this.currentlyWriting) {
      this.currentlyWriting = true;
      this._clearDeviceQueue();
    }
  };

  UsbDevice.prototype._handleConnect = function(version, maxData, array) {
    console.log('CNXN processing');
    this.maxData = maxData;
    _arrayBufferToString(array, function(identity) {
      var parts = identity.split(":", 3);
      if (parts[0] === 'device') {
        this.serialNo = parts[1];
        this.banner = parts[2];
        this.state = UsbState.ONLINE;
        console.log('CNXN from ' + this.serialNo + ' ' + this.banner);
        if (this.onCnxn !== null) {
          this.onCnxn();
        }
      }
    }.bind(this));
  };

  UsbDevice.prototype._handleAuth = function(type, array) {
    console.log('AUTH processing: ' + type);
    if (type == ADB_AUTH_TOKEN) {
      if (this.authSent) {
        this.authSent = false;
        console.log('Sending public key');
        _stringToArrayBuffer(this.auth.key_public, function(dataArray) {
          var dataArrayPlusNull = new Uint8Array(dataArray.byteLength + 1);
          dataArrayPlusNull.set(new Uint8Array(dataArray));
          dataArrayPlusNull[dataArray.byteLength] = 0;
          this._sendAuthPacket(ADB_AUTH_RSAPUBLICKEY, dataArrayPlusNull.buffer);
        }.bind(this));
      } else {
        console.log('Signing token for auth');
        this.authSent = true;
        var signed = this.auth.sign(array);
        this._sendAuthPacket(ADB_AUTH_SIGNATURE, signed);
      }
    } else {
      console.log('Unknown AUTH type not implemented');
    }
  };

  UsbDevice.prototype._writeToSocket = function(socketId, data) {
    var socket = this.mapper.getSocketById(socketId);
    if (socket === undefined) {
      console.log("Cannot find socket id " + socketId);
      return;
    }

    _arrayBufferToString(data, function(text) {
      socket.conn.sendMessage(text);
    });
  };

  UsbDevice.prototype._closeSocket = function(socketId) {
    var socket = this.mapper.getSocketById(socketId);
    if (socket === undefined) {
      console.log("Cannot find socket id " + socketId);
      return;
    }

    socket.disconnect();
  };

  UsbDevice.prototype._setSocketPeerId = function(socketId, peerId) {
    var socket = this.mapper.getSocketById(socketId);
    if (socket === undefined) {
      console.log("Cannot find socket id " + socketId);
      return;
    }

    socket.peerId = peerId;
  };

  /**
   * Called when a full USB packet is received from the device.
   * @param {AdbPacket} packet
   */
  UsbDevice.prototype._receiveMessage = function(packet) {
    console.log('READ command ' + packet.command);
    switch ( packet.command ) {
      case A_CNXN:
        this._handleConnect(packet.arg0, packet.arg1, packet.data);
        break;
      case A_AUTH:
        this._handleAuth(packet.arg0, packet.data);
        break;
      case A_OPEN:
        // Devices can't open a connection to the host.
        this._sendClosePacket(0, packet.arg0);
        break;
      case A_CLSE:
        this._closeSocket(packet.arg1);
        break;
      case A_WRTE:
        console.log('WRTE from USB id ' + packet.arg0 + ' to socket ' + packet.arg1);
        this._writeToSocket(packet.arg1, packet.data);
        this._sendOkayPacket(packet.arg1, packet.arg0);
        break;
      case A_OKAY:
        console.log('OKAY not implemented peer=' + packet.arg0 + ', local=' + packet.arg1);
        this._setSocketPeerId(packet.arg1, packet.arg0);
        break;
      default:
        console.log('unknown command; disconnecting!');
        this._disconnect();
    }
  };

  /**
   * @param {String} text the text string to write to device
   * @private
   */
  UsbDevice.prototype._writeData = function(socketId, remoteId, text) {
    console.log('enqueued: ' + text);
    _stringToArrayBuffer(text, function(dataArray) {
      var message = new AdbPacket();
      message.setCommand(A_WRTE);
      message.arg0 = socketId;
      message.arg1 = remoteId;
      message.setData(dataArray);
      this._enqueuePacket(message);
    }.bind(this));
  };

  /**
   * Sends the USB "CNXN" packet.
   * @private
   */
  UsbDevice.prototype._sendConnectPacket = function(callback) {
    var message = new AdbPacket();
    message.setCommand(A_CNXN);
    message.arg0 = A_VERSION;
    message.arg1 = 4096;
    // "host::\0"
    message.setData(new Uint8Array([104, 111, 115, 116, 58, 58, 0]).buffer);
    this.onCnxn = callback;
    this._enqueuePacket(message);
  };

  /**
   * Sends the USB "OKAY" packet.
   * @private
   */
  UsbDevice.prototype._sendOkayPacket = function(socketId, peerId) {
    var message = new AdbPacket();
    message.setCommand(A_OKAY);
    message.arg0 = socketId;
    message.arg1 = peerId;
    this._enqueuePacket(message);
  };

  /**
   * Sends the USB "AUTH" packet.
   * @private
   */
  UsbDevice.prototype._sendAuthPacket = function(type, data) {
    var message = new AdbPacket();
    message.setCommand(A_AUTH);
    message.arg0 = type;
    message.setData(data);
    this._enqueuePacket(message);
  };

  /**
   * Sends the USB "CLSE" packet.
   * @private
   */
  UsbDevice.prototype._sendClosePacket = function(localId, remoteId, callback) {
    var message = new AdbPacket();
    message.setCommand(A_CLSE);
    message.arg0 = localId;
    message.arg1 = remoteId;
    message.setCallback(callback);
    this._enqueuePacket(message);
  };

  /**
   * Sends the USB "OPEN" packet.
   * @param ourId
   * @param service
   * @private
   */
  UsbDevice.prototype._sendOpenPacket = function(ourId, service) {
    console.log('sending open packet for service ' + service + ' as id ' + ourId);

    _stringToArrayBuffer(service, function(serviceArray) {
      var terminated = new Uint8Array(serviceArray.byteLength + 1);
      terminated.set(new Uint8Array(serviceArray));
      terminated[serviceArray.byteLength] = 0;

      var message = new AdbPacket();
      message.setCommand(A_OPEN);
      message.arg0 = ourId;
      message.arg1 = 0;
      message.setData(terminated.buffer);
      this._enqueuePacket(message);
    }.bind(this));
  };

  UsbDevice.prototype._sendDataArray = function( dataArray, callback ) {
     var transferOut = {
      'direction' : 'out',
      'endpoint' : this.outputDescriptor,
      'data' : dataArray
    };

    this.usb.bulkTransfer(this.device, transferOut, function(usbEvent) {
      console.log('WROTE it; result=' + usbEvent.resultCode);
      if (usbEvent.resultCode) {
        console.log(chrome.runtime.lastError.message);
        this._disconnect();
      } else {
        callback();
      }
    }.bind(this));
  };

  /**
   * Loops over the current outgoing queue until it's empty.
   *
   * @private
   */
  UsbDevice.prototype._clearDeviceQueue = function() {
    if (this.queue.length == 0) {
      console.log('queue cleared');
      this.currentlyWriting = false;
      return;
    }

    var packet = this.queue.shift();
    this._sendDataArray(packet.toMessage(), function() {
      if (packet.data_length) {
        console.log('enqueued data (' + packet.data_length + ')');
        this._sendDataArray(packet.data, function() {
          if (packet.callback !== null) {
            packet.callback();
          }
          this._clearDeviceQueue();
        }.bind(this));
      } else {
        if (packet.callback !== null) {
          packet.callback();
        }
        this._clearDeviceQueue();
      }
    }.bind(this));
  };


  UsbDevice.prototype._onDeviceRead = function() {
    console.log('scheduling read');
    var inTransfer = {
      'direction' : 'in',
      'endpoint' : this.inputDescriptor,
      'length' : ADBMESSAGE_SIZE
    };

    this.usb.bulkTransfer(this.device, inTransfer, function(usbEvent) {
      console.log('READ header result=' + usbEvent.resultCode);
      if (usbEvent.resultCode) {
        console.log("invalid packet; dropping");

        if (chrome.runtime.lastError) {
          console.log(chrome.runtime.lastError.message);
        }
        this._disconnect();
      } else {
        var message = new AdbPacket();
        console.log('READ usb packet size ' + usbEvent.data.byteLength);
        if (!message.fromMessage(usbEvent.data)) {
          console.log('could not parse USB header packet');
          this._disconnect();
        } else {
          if (!message.isValid()) {
            console.log('invalid magic');
            this._disconnect(function() {
              this.usb.resetDevice(this.device);
            }.bind(this));
          } else {
            if (message.data_length !== 0) {
              console.log('READ data of len=' + message.data_length);
              var inTransfer = {
                'direction' : 'in',
                'endpoint' : this.inputDescriptor,
                'length' : message.data_length
              };
              this.usb.bulkTransfer(this.device, inTransfer, function(usbEvent) {
                console.log('READ data result=' + usbEvent.resultCode);
                if (usbEvent.resultCode) {
                  console.log("could not parse USB data packet");
                  if (chrome.runtime.lastError) {
                    console.log(chrome.runtime.lastError.message);
                  }
                  this._disconnect(function() {
                    this.usb.resetDevice(this.device);
                  }.bind(this));
                } else {
                  message.data = usbEvent.data;
                  if (message.isDataValid()) {
                    this._receiveMessage(message);
                    this._onDeviceRead();
                  } else {
                    this._disconnect(function() {
                      this.usb.resetDevice(this.device);
                    }.bind(this));
                  }
                }
              }.bind(this));
            } else {
              this._receiveMessage(message);
              this._onDeviceRead();
            }
          }
        }
      }
    }.bind(this));
  };

  /**
   * Creates an ADB socket instance.
   *
   * @return {AdbSocket}
   * @type {Object}
   * @constructor
   */
  function AdbSocket(adbServer, tcpConnection) {
    /** @type {AdbServer} */
    this.adb = adbServer;
    /** @type {TcpConnection} */
    this.conn = tcpConnection;
    /** @type {String} */
    this.buffer = "";
    /** @type {Number} */
    this.expected = -1;
    /** @type {Function} */
    this._parser = this._addData.bind(this);
    /** @type {Number} */
    this.device = -1;
    /** @type {Array} */
    this.queue = [];
    /** @type {Boolean} */
    this.currentlyWriting = false;
    /** @type {Number} */
    this.id = new Monotonic().next();
    /** @type {Number} */
    this.peerId = -1;
  }

  /**
   * Attempts to parse a command from an incoming message.
   *
   * @param {String} command incoming message to process
   * @private
   */
  AdbSocket.prototype._onMessageReceived = function(command) {
    console.log("command: " + command);

    if (command === "host:version") {
      this.conn.sendMessage("OKAY" + lenPrefix("001f"));
    } else if (command === "host:devices") {
      this.adb._rescan(this._onDevicesScanned.bind(this));
    } else if (command === "host:transport-any") {
      this.adb.getDevices(this._onTransportAny.bind(this));
    } else {
      this.conn.sendMessage("FAIL" + lenPrefix("Unknown service: " + command));
    }
  };

  AdbSocket.prototype._onDevicesScanned = function(devices) {
    var msg;
    if (devices) {
      msg = "Number of devices: " + devices.length;
    } else {
      msg = "No devices.";
    }
    this.conn.sendMessage("OKAY" + lenPrefix(msg));
  };

  /**
   *
   * @param {Array.<UsbDevice>} devices
   * @private
   */
  AdbSocket.prototype._onTransportAny = function(devices) {
    if (typeof devices !== "object" || devices.length == 0) {
      this._fail("No devices");
      return;
    } else if (devices.length > 1) {
      this._fail("More than one device");
      return;
    }

    this.device = devices[0];
    this.device.initialize(function() {
      console.log("Claimed device " + this.device.device.handle);
      this._onMessageReceived = this._receiveServiceName.bind(this);
      this.conn.sendMessage("OKAY");
    }.bind(this));
  };

  AdbSocket.prototype._receiveServiceName = function(text) {
    this._parser = this._parserForWrite.bind(this);
    this.device._sendOpenPacket(this.id, text);
    this.conn.sendMessage('OKAY');
  };

  AdbSocket.prototype._parserForWrite = function(text) {
    console.log('Write from ' + this.id + ' to ' + this.peerId + ': ' + text);
    this.device._writeData(this.id, this.peerId, text);
  };

  AdbSocket.prototype._fail = function(msg) {
    this.conn.sendMessage("FAIL" + lenPrefix(msg));
  };

  AdbSocket.prototype._onDataReceived = function(text) {
    this._parser(text);
  };

  AdbSocket.prototype._onDisconnect = function(text) {
    this.adb.removeSocket(this.id);
  };

  AdbSocket.prototype.disconnect = function() {
    this.conn.disconnect();
  };

  AdbSocket.prototype._addData = function(text) {
    console.log('read ' + text.length + ' bytes: ' + text + ' (expected: ' + this.expected + ')');

    this.buffer += text;

    var bufLen = this.buffer.length;
    if (bufLen < 4) {
      return;
    }

    if (this.expected === -1) {
      this.expected = parseInt(this.buffer.slice(0, 4), 16);
      if (isNaN(this.expected)) {
        console.log('invalid format; disconnecting');
        this.conn.disconnect();
        return;
      }
      console.log('expected ' + this.expected);
    }

    var readSoFar = bufLen - 4;
    if (readSoFar >= this.expected) {
      console.log('read all expected data');
      var end = this.expected + 4;
      this.expected = -1;
      this._onMessageReceived(this.buffer.slice(4, end));
      this.buffer = this.buffer.slice(end);
    }
  };

  /**
   * Converts an array buffer to a string
   *
   * @private
   * @param {ArrayBuffer} buf The buffer to convert
   * @param {Function} callback The function to call when conversion is complete
   */
  function _arrayBufferToString(buf, callback) {
    var bb = new Blob([new Uint8Array(buf)]);
    var f = new FileReader();
    f.onload = function(e) {
      callback(e.target.result);
    };
    f.readAsText(bb);
  }

  /**
   * Converts a string to an array buffer
   *
   * @private
   * @param {String} str The string to convert
   * @param {Function} callback The function to call when conversion is complete
   */
  function _stringToArrayBuffer(str, callback) {
    var bb = new Blob([str]);
    var f = new FileReader();
    f.onload = function(e) {
      callback(e.target.result);
    };
    f.readAsArrayBuffer(bb);
  }

  /**
   * Wrapper function for error console.logging
   *
   * @param {String} msg message to write to console.
   */
  function error(msg) {
    console.error(msg);
  }

  /**
   * Adds the ADB length prefix to the string.
   *
   * @param {String} msg Message to prefix
   * @return {String} message with length prefix at beginning
   */
  function lenPrefix(msg) {
    var lenStr = msg.length.toString(16);
    while (lenStr.length < 4) {
      lenStr = "0" + lenStr;
    }
    return lenStr + msg;
  }


  exports.UsbDevice = UsbDevice;
  exports.UsbState = UsbState;
  exports.AdbServer = AdbServer;
  exports.AdbPacket = AdbPacket;
  exports.AdbSocket = AdbSocket;
} )(window); 