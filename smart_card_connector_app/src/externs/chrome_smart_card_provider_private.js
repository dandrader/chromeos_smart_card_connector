chrome.smartCardProviderPrivate = {};

/**
 * @constructor
 */
chrome.smartCardProviderPrivate.RequestId = function() {};

/** @type {number} */
chrome.smartCardProviderPrivate.RequestId.prototype.childId;

/** @type {number} */
chrome.smartCardProviderPrivate.RequestId.prototype.frameRoutingId;

/** @type {number} */
chrome.smartCardProviderPrivate.RequestId.prototype.callId;

/** @type {!ChromeBaseEvent<function(!chrome.smartCardProviderPrivate.RequestId)>} */
chrome.smartCardProviderPrivate.onEstablishContextRequested;
