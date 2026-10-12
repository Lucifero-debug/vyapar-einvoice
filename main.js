// main.js
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

let mainWindow;

// The deployed app this window shows: the Vercel project connected to this
// repo (vyapar-einvoice-ph2z, production domain). Change it here if a custom
// domain is added later -- the navigation lock below follows this origin.
const APP_URL = 'https://vyapar-einvoice-ph2z.vercel.app/';

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
