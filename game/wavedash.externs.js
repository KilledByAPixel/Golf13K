/**
 * @fileoverview Closure externs for the Wavedash SDK the platform injects
 * as window.Wavedash. Only what wavedash.js calls. Not shipped: build.mjs
 * passes this to Closure for the --wavedash build so ADVANCED mode leaves
 * these property names alone.
 * @externs
 */

/** @record */
function WavedashSDK() {}
/** @param {Object=} config @return {boolean} */
WavedashSDK.prototype.init = function(config) {};
/** @param {string} id @param {boolean=} storeNow @return {boolean} */
WavedashSDK.prototype.setAchievement = function(id, storeNow) {};
/** @param {string} name @param {number} sortOrder @param {number} displayType @return {!Promise<!WavedashResponse>} */
WavedashSDK.prototype.getOrCreateLeaderboard = function(name, sortOrder, displayType) {};
/** @param {string} id @param {number} score @param {boolean} keepBest @return {!Promise<!WavedashResponse>} */
WavedashSDK.prototype.uploadLeaderboardScore = function(id, score, keepBest) {};
/** @return {!Promise<!WavedashResponse>} */
WavedashSDK.prototype.requestStats = function() {};
/** @param {string} id @return {number} */
WavedashSDK.prototype.getStat = function(id) {};
/** @param {string} id @param {number} value @param {boolean=} storeNow @return {boolean} */
WavedashSDK.prototype.setStat = function(id, value, storeNow) {};
/** @return {boolean} */
WavedashSDK.prototype.storeStats = function() {};
/** @param {string} path @return {!Promise<!WavedashResponse>} */
WavedashSDK.prototype.downloadRemoteFile = function(path) {};
/** @param {string} path @return {!Promise<!WavedashResponse>} */
WavedashSDK.prototype.uploadRemoteFile = function(path) {};
/** @param {string} path @param {!Uint8Array} data @return {!Promise<boolean>} */
WavedashSDK.prototype.writeLocalFile = function(path, data) {};
/** @param {string} path @return {!Promise<?Uint8Array>} */
WavedashSDK.prototype.readLocalFile = function(path) {};

/** @record */
function WavedashResponse() {}
/** @type {boolean} */ WavedashResponse.prototype.success;
/** @type {?WavedashLeaderboard} */ WavedashResponse.prototype.data;

/** @record */
function WavedashLeaderboard() {}
/** @type {string} */ WavedashLeaderboard.prototype.id;

/** @type {WavedashSDK|undefined} */
Window.prototype.Wavedash;
