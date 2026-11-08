/*
 * 嗷呜计数 (Aowu Counter)
 * js/csinterface.js - minimal, self-written CSInterface implementation.
 *
 * This file does NOT copy Adobe's CSInterface.js. It only wraps the CEP
 * host object (window.__adobe_cep__) with the small API surface the panel
 * needs. It is safe to load in a normal browser (all methods degrade to
 * no-ops / empty values when CEP is absent).
 */
(function (global) {
  'use strict';

  function CSInterface() {
    // no state required
  }

  // Runs a  $.evalScript  string inside Photoshop's ExtendScript engine.
  CSInterface.prototype.evalScript = function (script, callback) {
    var cb = (typeof callback === 'function') ? callback : function () {};
    var cep = global.__adobe_cep__;
    if (!cep || typeof cep.evalScript !== 'function') {
      try { cb(''); } catch (e0) { /* ignore */ }
      return;
    }
    try {
      cep.evalScript(String(script), cb);
    } catch (err) {
      var message = 'EvalScript error: ';
      try { message += (err && err.message) ? err.message : String(err); } catch (e1) { /* ignore */ }
      try { cb(message); } catch (e2) { /* ignore */ }
    }
  };

  // CEP 12 on Windows returns getSystemPath('extension') as a file:/// URL
  // (e.g. "file:///C:/Users/.../com.aowu.perspective"). ExtendScript's File()
  // and cep.fs need a native Windows path, so normalize it here.
  function toNativePath(value) {
    var p = String(value || '');
    if (/^file:\/\/\//i.test(p)) {
      p = p.replace(/^file:\/\/\//i, '');
      p = p.replace(/\//g, '\\');
    } else if (/^file:\/\//i.test(p)) {
      p = p.replace(/^file:\/\//i, '');
      p = p.replace(/\//g, '\\');
    }
    return p;
  }

  // 'extension' | 'userData' | 'commonFiles' | 'myDocuments' | 'hostApplication'
  CSInterface.prototype.getSystemPath = function (pathType) {
    var cep = global.__adobe_cep__;
    if (!cep || typeof cep.getSystemPath !== 'function') {
      return '';
    }
    try {
      return toNativePath(cep.getSystemPath(String(pathType)));
    } catch (e) {
      return '';
    }
  };

  CSInterface.prototype.getHostEnvironment = function () {
    var cep = global.__adobe_cep__;
    if (!cep || typeof cep.getHostEnvironment !== 'function') {
      return null;
    }
    try {
      var raw = cep.getHostEnvironment();
      if (raw && typeof raw === 'object') {
        return raw;
      }
      return JSON.parse(String(raw));
    } catch (e) {
      return null;
    }
  };

  CSInterface.prototype.getExtensionID = function () {
    var cep = global.__adobe_cep__;
    if (!cep || typeof cep.getExtensionID !== 'function') {
      return '';
    }
    try {
      return String(cep.getExtensionID() || '');
    } catch (e) {
      return '';
    }
  };

  CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    var target = String(url || '');
    if (!target) {
      return false;
    }
    var cep = global.__adobe_cep__;
    try {
      if (cep && global.cep && global.cep.util &&
          typeof global.cep.util.openURLInDefaultBrowser === 'function') {
        global.cep.util.openURLInDefaultBrowser(target);
        return true;
      }
    } catch (e1) { /* ignore */ }
    try {
      if (cep && typeof cep.openURLInDefaultBrowser === 'function') {
        cep.openURLInDefaultBrowser(target);
        return true;
      }
    } catch (e2) { /* ignore */ }
    try {
      global.open(target, '_blank');
      return true;
    } catch (e3) {
      return false;
    }
  };

  // Resize the CEP panel window (works for floating panels; docked panels may be
  // constrained by Photoshop). Used by the v1.1.0 minimize-to-thin-bar feature.
  CSInterface.prototype.resizeContent = function (width, height) {
    var cep = global.__adobe_cep__;
    if (!cep || typeof cep.resizeContent !== 'function') {
      return false;
    }
    try {
      cep.resizeContent(Number(width) || 0, Number(height) || 0);
      return true;
    } catch (e) {
      return false;
    }
  };

  // Change the native panel/window title text. Photoshop draws the panel tab
  // title itself; passing a single space hides the visible title in minimized mode.
  CSInterface.prototype.setWindowTitle = function (title) {
    var cep = global.__adobe_cep__;
    if (!cep || typeof cep.invokeSync !== 'function') {
      return false;
    }
    try {
      cep.invokeSync('setWindowTitle', String(title === undefined || title === null ? '' : title));
      return true;
    } catch (e) {
      return false;
    }
  };

  // CEP host events, e.g. 'documentAfterActivate'
  CSInterface.prototype.addEventListener = function (type, listener) {
    var cep = global.__adobe_cep__;
    if (!cep || typeof cep.addEventListener !== 'function') {
      return false;
    }
    try {
      cep.addEventListener(String(type), listener);
      return true;
    } catch (e) {
      return false;
    }
  };

  CSInterface.prototype.removeEventListener = function (type, listener) {
    var cep = global.__adobe_cep__;
    if (!cep || typeof cep.removeEventListener !== 'function') {
      return false;
    }
    try {
      cep.removeEventListener(String(type), listener);
      return true;
    } catch (e) {
      return false;
    }
  };

  // Subset of the standard SystemPath constants.
  CSInterface.SystemPath = {
    USER_DATA: 'userData',
    COMMON_FILES: 'commonFiles',
    MY_DOCUMENTS: 'myDocuments',
    APPLICATION: 'application',
    EXTENSION: 'extension',
    HOST_APPLICATION: 'hostApplication'
  };

  global.CSInterface = CSInterface;
})(typeof window !== 'undefined' ? window : this);






