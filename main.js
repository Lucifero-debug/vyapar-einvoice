// main.js
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

let mainWindow;

// The deployed app this window shows. NOTE: still the original deployment;
// confirm the production domain before shipping a desktop build (see the
// release-readiness report).
const APP_URL = 'https://vyapaar-ten.vercel.app/';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    // The window shows a REMOTE site. With nodeIntegration on, any script that
    // site ran -- an XSS, a compromised dependency, a hijacked CDN -- had
    // Node.js: the shopkeeper's files, a shell, everything. The pages need
    // none of it; they are an ordinary website.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadURL(APP_URL);

  // The window stays on the app. A link elsewhere opens in the user's own
  // browser rather than inside this window, where it would inherit the app's
  // session cookies and look like part of the app.
  const appOrigin = new URL(APP_URL).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== appOrigin) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

    Menu.setApplicationMenu(null);
     mainWindow.setMenuBarVisibility(false);
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
