/**
 * @license
 * Copyright 2021 Google Inc.
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

goog.provide('GoogleSmartCard.LibusbToWebusbAdaptor');

goog.require('GoogleSmartCard.Logging');
goog.require('goog.asserts');
goog.require('goog.log');
goog.require('goog.object');

goog.scope(function() {

const GSC = GoogleSmartCard;
const LibusbJsDevice = GSC.LibusbProxyDataModel.LibusbJsDevice;
const LibusbJsConfigurationDescriptor =
    GSC.LibusbProxyDataModel.LibusbJsConfigurationDescriptor;
const LibusbJsEndpointType = GSC.LibusbProxyDataModel.LibusbJsEndpointType;
const LibusbJsEndpointDescriptor =
    GSC.LibusbProxyDataModel.LibusbJsEndpointDescriptor;
const LibusbJsDirection = GSC.LibusbProxyDataModel.LibusbJsDirection;
const LibusbJsGenericTransferParameters =
    GSC.LibusbProxyDataModel.LibusbJsGenericTransferParameters;
const LibusbJsInterfaceDescriptor =
    GSC.LibusbProxyDataModel.LibusbJsInterfaceDescriptor;
const LibusbJsTransferRecipient =
    GSC.LibusbProxyDataModel.LibusbJsTransferRecipient;
const LibusbJsTransferRequestType =
    GSC.LibusbProxyDataModel.LibusbJsTransferRequestType;
const LibusbJsTransferResult = GSC.LibusbProxyDataModel.LibusbJsTransferResult;

const logger = GSC.Logging.getScopedLogger('LibusbToWebusbAdaptor');

class DeviceState {
  /** @param {!Object} webusbDevice The WebUSB USBDevice object. */
  constructor(webusbDevice) {
    /** @type {!Object} The WebUSB USBDevice object. */
    this.webusbDevice = webusbDevice;
    /** @type {!Set<number>} Active device handles. */
    this.handles = new Set();
    /**
     * @type {!Promise<void>|null} Promise for the ongoing device open request.
     */
    this.openOperationPromise = null;
    /**
     * @type {!Promise<void>|null} Promise for the ongoing device close request.
     */
    this.closeOperationPromise = null;
  }
};

/**
 * Implements the Libusb requests via the WebUSB API.
 */
GSC.LibusbToWebusbAdaptor = class extends GSC.LibusbToJsApiAdaptor {
  constructor() {
    super();
    /**
     * Mapping from IDs (generated by us) into `DeviceState` instances.
     * @type {!Map<number, !DeviceState>}
     */
    this.idToDeviceMap_ = new Map();
    /**
     * The counter that's used for generating new device IDs.
     * @type {number}
     */
    this.nextFreeDeviceId_ = 1;
    /**
     * The counter that's used for generating new device handles.
     * @type {number}
     */
    this.nextFreeDeviceHandle_ = 1;
  }

  /** @override */
  async listDevices() {
    const webusbDevices =
        /** @type {!Array<!Object>} */ (await navigator['usb']['getDevices']());

    // Keep references to all current USBDevice objects, since other WebUSB
    // functions take USBDevice as parameter. It's not possible to
    // programmatically recreate a USBDevice object, so we need to store them.
    this.updateDeviceMap_(webusbDevices);

    return webusbDevices.map(
        webusbDevice => this.convertWebusbDeviceToLibusb_(webusbDevice));
  }

  /** @override */
  async getConfigurations(deviceId) {
    const webusbDevice = this.getDeviceByIdOrThrow_(deviceId).webusbDevice;
    // Note: It's incorrect to check whether the configuration is active by
    // comparing it via "===" against `webusbDevice['configuration']`, because
    // Chrome produces different objects for USBDevice::configuration and for
    // USBDevice::configurations: see crbug.com/1274922. Hence the need to
    // compare by the configurationValue fields.
    const activeConfigurationValue = webusbDevice['configuration'] ?
        webusbDevice['configuration']['configurationValue'] :
        null;
    const libusbJsConfigurations = [];
    for (const webusbConfiguration of webusbDevice['configurations']) {
      const libusbJsConfiguration = getLibusbJsConfigurationDescriptor(
          webusbConfiguration, activeConfigurationValue);
      // WebUSB doesn't return extraData in USBConfiguration, so we need to
      // fetch it.
      /** @preserveTry */
      try {
        await fetchAndFillConfigurationExtraData(
            webusbDevice, libusbJsConfiguration);
      } catch (exc) {
        // Suppress errors of fetching extraData: they should be non-fatal.
        // Log only at the "fine" level, as this can quickly flood the logs.
        goog.log.fine(logger, `Failure fetching extra data: ${exc}`);
      }
      libusbJsConfigurations.push(libusbJsConfiguration);
    }
    return libusbJsConfigurations;
  }

  /** @override */
  async openDeviceHandle(deviceId) {
    const deviceState = this.getDeviceByIdOrThrow_(deviceId);
    // WebUSB doesn't have a concept of device handles, so generate a handle
    // from a counter.
    if (deviceState.handles.size === 0) {
      // Ask WebUSB to open the device, but only for the first opened handle.
      // Avoid concurrent WebUSB open()/close() calls, since WebUSB throws on
      // these, hence track the ongoing request's promise in the device state
      // and wait for it.
      if (!deviceState.openOperationPromise) {
        // Note: no "await" here, since we need to set `openOperationPromise`
        // synchronously and therefore let all subsequent requests wait on it.
        deviceState.openOperationPromise = openWebusbDevice(deviceState);
      }
      try {
        await deviceState.openOperationPromise;
      } finally {
        // Do this regardless of whether open succeeded, so we'll retry the
        // WebUSB open() for new `openDeviceHandle()` calls made later.
        deviceState.openOperationPromise = null;
      }
    }
    // WebUSB successfully opened the device. Generate a new handle and return.
    // Note: It's important to update `handles` only after all asynchronous
    // steps are completed, so that concurrent `openDeviceHandle()` calls wait
    // for the promises as well.
    const newHandle = this.nextFreeDeviceHandle_;
    ++this.nextFreeDeviceHandle_;
    deviceState.handles.add(newHandle);
    return newHandle;
  }

  /** @override */
  async closeDeviceHandle(deviceId, deviceHandle) {
    const deviceState = this.getDeviceByIdOrThrow_(deviceId);
    if (!deviceState.handles.has(deviceHandle))
      throw new Error(`Unknown device handle ${deviceHandle}`);
    // Forget the handle (do this synchronously).
    deviceState.handles.delete(deviceHandle);
    if (deviceState.handles.size > 0)
      return;
    // Ask WebUSB to close the device for the last closed handle. Note: the
    // `closeOperationPromise` field is set synchronously, so that subsequent
    // `openDeviceHandle()` calls will wait for it.
    deviceState.closeOperationPromise = deviceState.webusbDevice['close']();
    await deviceState.closeOperationPromise;
    goog.log.fine(logger, 'Successfully closed WebUSB device');
    // On successful completion, clean up the promise. Intentionally leave it
    // set on failures, so that all subsequent `openDeviceHandle()` calls abort.
    deviceState.closeOperationPromise = null;
  }

  /** @override */
  async claimInterface(deviceId, deviceHandle, interfaceNumber) {
    const deviceState =
        this.getDeviceByIdAndHandleOrThrow_(deviceId, deviceHandle);
    await deviceState.webusbDevice['claimInterface'](interfaceNumber);
  }

  /** @override */
  async releaseInterface(deviceId, deviceHandle, interfaceNumber) {
    const deviceState =
        this.getDeviceByIdAndHandleOrThrow_(deviceId, deviceHandle);
    await deviceState.webusbDevice['releaseInterface'](interfaceNumber);
  }

  /** @override */
  async resetDevice(deviceId, deviceHandle) {
    const deviceState =
        this.getDeviceByIdAndHandleOrThrow_(deviceId, deviceHandle);
    await deviceState.webusbDevice['reset']();
  }

  /** @override */
  async controlTransfer(deviceId, deviceHandle, parameters) {
    const deviceState =
        this.getDeviceByIdAndHandleOrThrow_(deviceId, deviceHandle);
    const webusbControlTransferParameters = {
      'requestType': getWebusbRequestType(parameters['requestType']),
      'recipient': getWebusbRecipient(parameters['recipient']),
      'request': parameters['request'],
      'value': parameters['value'],
      'index': parameters['index'],
    };
    let transferResult;
    if (parameters['dataToSend']) {
      transferResult = await deviceState.webusbDevice['controlTransferOut'](
          webusbControlTransferParameters, parameters['dataToSend']);
    } else {
      transferResult = await deviceState.webusbDevice['controlTransferIn'](
          webusbControlTransferParameters, parameters['lengthToReceive']);
    }
    return getLibusbJsTransferResultOrThrow(transferResult);
  }

  /** @override */
  async bulkTransfer(deviceId, deviceHandle, parameters) {
    return this.genericTransfer_(deviceId, deviceHandle, parameters);
  }

  /** @override */
  async interruptTransfer(deviceId, deviceHandle, parameters) {
    return this.genericTransfer_(deviceId, deviceHandle, parameters);
  }

  /**
   * @private
   * @param {!Object} webusbDevice The USBDevice object.
   * @return {number|null}
   */
  getDeviceId_(webusbDevice) {
    for (const deviceId of this.idToDeviceMap_.keys()) {
      if (this.idToDeviceMap_.get(deviceId).webusbDevice === webusbDevice)
        return deviceId;
    }
    return null;
  }

  /**
   * @private
   * @param {number} deviceId
   * @return {!DeviceState}
   */
  getDeviceByIdOrThrow_(deviceId) {
    const deviceState = this.idToDeviceMap_.get(deviceId);
    if (!deviceState)
      throw new Error(`No device with ID ${deviceId}`);
    return deviceState;
  }

  /**
   * @private
   * @param {number} deviceId
   * @param {number} deviceHandle
   * @return {!DeviceState}
   */
  getDeviceByIdAndHandleOrThrow_(deviceId, deviceHandle) {
    const deviceState = this.idToDeviceMap_.get(deviceId);
    if (!deviceState)
      throw new Error(`No device with ID ${deviceId}`);
    if (!deviceState.handles.has(deviceHandle))
      throw new Error(`No device handle ${deviceHandle}`);
    return deviceState;
  }

  /**
   * @private
   * @param {!Array<!Object>} webusbDevices The list of USBDevice objects.
   */
  updateDeviceMap_(webusbDevices) {
    /** @type {!Map<number, !DeviceState>} */
    const newIdToDeviceMap = new Map();
    for (const webusbDevice of webusbDevices) {
      let chosenDeviceId = this.getDeviceId_(webusbDevice);
      if (chosenDeviceId === null) {
        // This is a new device, so generate new ID and state for it.
        chosenDeviceId = this.nextFreeDeviceId_;
        this.nextFreeDeviceId_++;
        newIdToDeviceMap.set(chosenDeviceId, new DeviceState(webusbDevice));
      } else {
        // This is an already tracked device, so reuse its ID and state.
        newIdToDeviceMap.set(
            chosenDeviceId, this.idToDeviceMap_.get(chosenDeviceId));
      }
    }
    // Overwrite the map. Note that this drops the devices that disappeared from
    // the list.
    this.idToDeviceMap_ = newIdToDeviceMap;
  }

  /**
   * @private
   * @param {!Object} webusbDevice
   * @return {!LibusbJsDevice}
   */
  convertWebusbDeviceToLibusb_(webusbDevice) {
    const deviceId = this.getDeviceId_(webusbDevice);
    goog.asserts.assert(deviceId);
    /** @type {!LibusbJsDevice} */
    const libusbJsDevice = {
      'deviceId': deviceId,
      'vendorId': webusbDevice['vendorId'],
      'productId': webusbDevice['productId'],
      'version': (webusbDevice['deviceVersionMajor'] << 8) +
          (webusbDevice['deviceVersionMinor'] << 4) +
          webusbDevice['deviceVersionSubminor'],
    };
    if (webusbDevice['productName'])
      libusbJsDevice['productName'] = webusbDevice['productName'];
    if (webusbDevice['manufacturerName'])
      libusbJsDevice['manufacturerName'] = webusbDevice['manufacturerName'];
    if (webusbDevice['serialNumber'])
      libusbJsDevice['serialNumber'] = webusbDevice['serialNumber'];
    return libusbJsDevice;
  }

  /**
   * Performs a bulk or an interrupt transfer (this is determined by the type of
   * the endpoint specified via `parameters.endpointAddress`).
   * @private
   * @param {number} deviceId
   * @param {number} deviceHandle
   * @param {!LibusbJsGenericTransferParameters} parameters
   * @return {!Promise<!LibusbJsTransferResult>}
   */
  async genericTransfer_(deviceId, deviceHandle, parameters) {
    const deviceState =
        this.getDeviceByIdAndHandleOrThrow_(deviceId, deviceHandle);
    // According to the USB specification, the endpoint address contains the
    // endpoint number in bits 0..3.
    const endpointNumber = parameters['endpointAddress'] & 0xF;
    let transferResult;
    if (parameters['dataToSend']) {
      transferResult = await deviceState.webusbDevice['transferOut'](
          endpointNumber, parameters['dataToSend']);
    } else {
      transferResult = await deviceState.webusbDevice['transferIn'](
          endpointNumber, parameters['lengthToReceive']);
    }
    return getLibusbJsTransferResultOrThrow(transferResult);
  }
};

/**
 * @param {!Object} webusbConfiguration The WebUSB USBConfiguration value.
 * @param {number|null} activeConfigurationValue The active configuration's
 *     value.
 * @return {!LibusbJsConfigurationDescriptor}
 */
function getLibusbJsConfigurationDescriptor(
    webusbConfiguration, activeConfigurationValue) {
  return {
    'active':
        webusbConfiguration['configurationValue'] === activeConfigurationValue,
    'configurationValue': webusbConfiguration['configurationValue'],
    'interfaces': webusbConfiguration['interfaces']
                      .map(
                          webusbInterface =>
                              getLibusbJsInterfaceDescriptor(webusbInterface))
                      .filter(item => item !== null),
  };
}

/**
 * @param {!Object} webusbInterface The WebUSB USBInterface value.
 * @return {!LibusbJsInterfaceDescriptor|null}
 */
function getLibusbJsInterfaceDescriptor(webusbInterface) {
  if (webusbInterface['alternates'].length === 0) {
    // Only log in the Debug mode by default, since these errors might quickly
    // flood the application's logs.
    goog.log.fine(logger, `Ignoring WebUSB interface without alternates`);
    return null;
  }
  // Note: We're not using the "alternate" field here, since, contrary to the
  // WebUSB specification, Chrome's implementation typically sets this field to
  // null. See crbug.com/1093502.
  const webusbAlternateInterface = webusbInterface['alternates'][0];
  return {
    'interfaceNumber': webusbInterface['interfaceNumber'],
    'interfaceClass': webusbAlternateInterface['interfaceClass'],
    'interfaceSubclass': webusbAlternateInterface['interfaceSubclass'],
    'interfaceProtocol': webusbAlternateInterface['interfaceProtocol'],
    'endpoints': webusbAlternateInterface['endpoints']
                     .map(endpoint => getLibusbJsEndpointDescriptor(endpoint))
                     .filter(item => item !== null),
  };
}

/**
 * @param {!Object} webusbEndpoint The WebUSB USBEndpoint value.
 * @return {!LibusbJsEndpointDescriptor|null}
 */
function getLibusbJsEndpointDescriptor(webusbEndpoint) {
  // According to the USB specification, the endpoint address contains the
  // endpoint number in bits 0..3 and the direction in the bit 7.
  const endpointAddress = webusbEndpoint['endpointNumber'] +
      (webusbEndpoint['direction'] === 'in' ? 1 << 7 : 0);
  const endpointType = getLibusbJsEndpointType(webusbEndpoint['type']);
  if (!endpointType)
    return null;
  return {
    'endpointAddress': endpointAddress,
    'direction': webusbEndpoint['direction'] === 'in' ? LibusbJsDirection.IN :
                                                        LibusbJsDirection.OUT,
    'type': endpointType,
    'maxPacketSize': webusbEndpoint['packetSize'],
  };
}

/**
 * @param {string} webusbEndpointType The WebUSB USBEndpointType value.
 * @return {!LibusbJsEndpointType|null}
 */
function getLibusbJsEndpointType(webusbEndpointType) {
  switch (webusbEndpointType) {
    case 'bulk':
      return LibusbJsEndpointType.BULK;
    case 'interrupt':
      return LibusbJsEndpointType.INTERRUPT;
    case 'isochronous':
      return LibusbJsEndpointType.ISOCHRONOUS;
  }
  // Only log in the Debug mode by default, since these errors might quickly
  // flood the application's logs.
  goog.log.fine(logger, `Unknown WebUSB endpoint type: ${webusbEndpointType}`);
  return null;
}

/**
 * @param {!LibusbJsTransferRequestType} libusbJsTransferRequestType
 * @return {string} The WebUSB USBRequestType value
 */
function getWebusbRequestType(libusbJsTransferRequestType) {
  switch (libusbJsTransferRequestType) {
    case LibusbJsTransferRequestType.STANDARD:
      return 'standard';
    case LibusbJsTransferRequestType.CLASS:
      return 'class';
    case LibusbJsTransferRequestType.VENDOR:
      return 'vendor';
  }
  throw new Error(
      `Unknown LibusbJs transfer request type ${libusbJsTransferRequestType}`);
}

/**
 * @param {!LibusbJsTransferRecipient} libusbJsTransferRecipient
 * @return {string} The WebUSB USBRecipient value
 */
function getWebusbRecipient(libusbJsTransferRecipient) {
  switch (libusbJsTransferRecipient) {
    case LibusbJsTransferRecipient.DEVICE:
      return 'device';
    case LibusbJsTransferRecipient.INTERFACE:
      return 'interface';
    case LibusbJsTransferRecipient.ENDPOINT:
      return 'endpoint';
    case LibusbJsTransferRecipient.OTHER:
      return 'other';
  }
  throw new Error(
      `Unknown LibusbJs transfer recipient ${libusbJsTransferRecipient}`);
}

/**
 * @param {!Object} webusbTransferResult The WebUSB USBInTransferResult or
 *     USBOutTransferResult value.
 */
function getLibusbJsTransferResultOrThrow(webusbTransferResult) {
  if (webusbTransferResult['status'] !== 'ok') {
    throw new Error(
        `Transfer failed with status ${webusbTransferResult['status']}`);
  }
  if (!webusbTransferResult['data'])
    return {};
  return {'receivedData': webusbTransferResult['data']};
}

/**
 * @param {!DeviceState} deviceState
 * @return {!Promise<void>}
 */
async function openWebusbDevice(deviceState) {
  // First, wait for the ongoing WebUSB close() request if there's any (or
  // fail immediately if the last close() request failed).
  if (deviceState.closeOperationPromise)
    await deviceState.closeOperationPromise;
  // Second, execute the WebUSB open() method.
  await deviceState.webusbDevice['open']();
  goog.log.fine(logger, 'Successfully opened WebUSB device');
}

/**
 * Fetches class-/vendor-specific configuration/interface/endpoint descriptors
 * using special control transfers. The result is assigned into the
 * corresponding 'extraData' fields inside `libusbJsConfiguration`.
 * @param {!Object} webusbDevice The WebUSB USBDevice value.
 * @param {!LibusbJsConfigurationDescriptor} libusbJsConfiguration
 */
async function fetchAndFillConfigurationExtraData(
    webusbDevice, libusbJsConfiguration) {
  await webusbDevice['open']();
  /** @preserveTry */
  try {
    await fetchAndFillConfigurationExtraDataForOpenedDevice(
        webusbDevice, libusbJsConfiguration);
  } finally {
    // TODO(#429): Don't close if there are opened device handles.
    await webusbDevice['close']();
  }
}

/**
 * Same as `fetchAndFillConfigurationExtraData()`, but assumes the device to be
 * opened.
 * @param {!Object} webusbDevice The WebUSB USBDevice value.
 * @param {!LibusbJsConfigurationDescriptor} libusbJsConfiguration
 */
async function fetchAndFillConfigurationExtraDataForOpenedDevice(
    webusbDevice, libusbJsConfiguration) {
  const GET_DESCRIPTOR_REQUEST = 0x06;
  const CONFIGURATION_DESCRIPTOR_TYPE = 0x02;
  const INTERFACE_DESCRIPTOR_TYPE = 0x04;
  const ENDPOINT_DESCRIPTOR_TYPE = 0x05;
  const CONFIGURATION_DESCRIPTOR_LENGTH = 9;
  const INTERFACE_DESCRIPTOR_LENGTH = 9;
  const ENDPOINT_DESCRIPTOR_LENGTH = 7;

  const controlRequestValue = (CONFIGURATION_DESCRIPTOR_TYPE << 8) |
      (libusbJsConfiguration['configurationValue'] - 1);
  const controlTransferParameters = {
    'requestType': 'standard',
    'recipient': 'device',
    'request': GET_DESCRIPTOR_REQUEST,
    'value': controlRequestValue,
    'index': 0
  };

  // Determine the size of the whole descriptor hierarchy ("wTotalLength").
  let transferResult = await webusbDevice['controlTransferIn'](
      controlTransferParameters, CONFIGURATION_DESCRIPTOR_LENGTH);
  if (transferResult['status'] !== 'ok' || !transferResult['data'])
    return;
  const initialData = /** @type {!DataView} */ (transferResult['data']);
  const totalLength = initialData.getUint16(2, /*littleEndian=*/ true);

  // Read the whole descriptor hierarchy.
  transferResult = await webusbDevice['controlTransferIn'](
      controlTransferParameters, totalLength);
  if (transferResult['status'] !== 'ok' || !transferResult['data'])
    return;
  const descriptors = /** @type {!DataView} */ (transferResult['data']);
  if (descriptors.byteLength !== totalLength)
    return;

  // Parse descriptors one-by-one from the fetched concatenated blob. Maintain
  // pointers to the LibusbJs objects that correspond to the currently parsed
  // interface/endpoint descriptor.
  /** @type {!LibusbJsInterfaceDescriptor|undefined} */
  let currentInterface = undefined;
  /** @type {!LibusbJsEndpointDescriptor|undefined} */
  let currentEndpoint = undefined;
  for (let offset = 0; offset < totalLength;) {
    const descriptorLength = descriptors.getUint8(offset);
    if (descriptorLength < 2) {
      // This is a malformed descriptor - bail out immediately (so that, for
      // example, we don't hang because of a zero in the descriptor length
      // field).
      return;
    }
    if (offset + descriptorLength > totalLength) {
      // Ignore the truncated descriptor.
      break;
    }
    const descriptorType = descriptors.getUint8(offset + 1);
    switch (descriptorType) {
      case CONFIGURATION_DESCRIPTOR_TYPE: {
        if (descriptorLength < CONFIGURATION_DESCRIPTOR_LENGTH) {
          // Ignore the invalid (too short) descriptor.
          break;
        }
        // The current item is the configuration descriptor. There should be
        // only one such item returned and it should refer to
        // `libusbJsConfiguration`, so nothing needs to be done here.
        break;
      }
      case INTERFACE_DESCRIPTOR_TYPE: {
        if (descriptorLength < INTERFACE_DESCRIPTOR_LENGTH) {
          // Ignore the invalid (too short) descriptor.
          break;
        }
        // The current item is the interface descriptor. Parse the interface
        // number and switch the pointer to the corresponding
        // `LibusbJsInterfaceDescriptor`.
        const interfaceNumber = descriptors.getUint8(offset + 2);
        currentInterface = libusbJsConfiguration['interfaces'].find(
            libusbJsInterface =>
                libusbJsInterface['interfaceNumber'] === interfaceNumber);
        currentEndpoint = undefined;
        break;
      }
      case ENDPOINT_DESCRIPTOR_TYPE: {
        if (descriptorLength < ENDPOINT_DESCRIPTOR_LENGTH) {
          // Ignore the invalid (too short) descriptor.
          break;
        }
        // The current item is the endpoint descriptor. Parse the endpoint
        // address and switch the pointer to the corresponding
        // `LibusbJsEndpointDescriptor`.
        const endpointAddress = descriptors.getUint8(offset + 2);
        if (currentInterface) {
          currentEndpoint = currentInterface['endpoints'].find(
              libusbJsEndpoint =>
                  libusbJsEndpoint['endpointAddress'] === endpointAddress);
        } else {
          currentEndpoint = undefined;
        }
        break;
      }
      default: {
        // The current item is an unknown descriptor, so add it as extraData to
        // the current (the most nested one) LibusbJs object.
        const targetObject =
            currentEndpoint || currentInterface || libusbJsConfiguration;
        if (targetObject) {
          appendExtraData(
              new Uint8Array(
                  descriptors.buffer, descriptors.byteOffset + offset,
                  descriptorLength),
              targetObject);
        }
        break;
      }
    }
    // Jump to the next descriptor in the blob.
    offset += descriptorLength;
  }
}

/**
 * Appends the specified data to the 'extraData' property of the given LibusbJs
 * object.
 * @param {!Uint8Array} extraDataToAppend
 * @param {!LibusbJsConfigurationDescriptor|!LibusbJsInterfaceDescriptor|!LibusbJsEndpointDescriptor}
 *     libusbJsObject
 */
function appendExtraData(extraDataToAppend, libusbJsObject) {
  const oldExtraData =
      goog.object.get(libusbJsObject, 'extraData', new ArrayBuffer(0));
  const newData =
      new Uint8Array(oldExtraData.byteLength + extraDataToAppend.byteLength);
  newData.set(new Uint8Array(oldExtraData), 0);
  newData.set(extraDataToAppend, oldExtraData.byteLength);
  libusbJsObject['extraData'] = newData.buffer;
}

/**
 * Returns whether the API needed for this adaptor to work is available.
 * @static
 * @return {boolean}
 */
GSC.LibusbToWebusbAdaptor.isApiAvailable = function() {
  return navigator !== undefined && navigator['usb'] !== undefined;
};
});  // goog.scope
