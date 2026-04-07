const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  send: (channel, data) => {
    const validChannels = [
      'login',
      'logout',
      'start-crawl',
      'open-course-detail',
      'export-data',
      'request-login-info',
      'minimize-window',
      'maximize-window',
      'close-window',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  receive: (channel, callback) => {
    const validChannels = [
      'login-success',
      'login-fail',
      'logout-success',
      'login-progress',
      'crawl-progress',
      'crawl-complete',
      'crawl-error',
      'saved-login-info',
      'user-info',
      'course-list',
      'course-detail',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  invoke: (channel, data) => {
    const validChannels = ['fetch-detail', 'download-lms-file', 'generate-ai-response'];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
  }
});
