import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/ipc.js';

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;
const subscribe = <T>(channel: string, cb: (v: T) => void) => {
  const h = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

const api: Api = {
  getState: () => invoke('state:get'),
  refresh: () => invoke('poll:refresh'),
  onState: (cb) => subscribe('state', cb),
  onSignal: (cb) => subscribe('signal', cb),
  onTab: (cb) => subscribe('dashboard:tab', cb),
  getSettings: () => invoke('settings:get'),
  updateSettings: (patch) => invoke('settings:update', patch),
  getSchedule: () => invoke('schedule:get'),
  setSchedule: (s) => invoke('schedule:set', s),
  setMode: (m) => invoke('mode:set', m),
  getStats: (p, k, m) => invoke('stats:get', p, k, m),
  listNotes: () => invoke('notes:list'),
  addNote: (t, p) => invoke('notes:add', t, p),
  deleteNote: (id) => invoke('notes:delete', id),
  listAnomalies: () => invoke('anomalies:list'),
  setModel: (p, m, e) => invoke('model:set', p, m, e),
  startTask: (p) => invoke('task:start', p),
  stopTask: (p) => invoke('task:stop', p),
  openLogin: () => invoke('login:open'),
  login: {
    importSessionKey: (t) => invoke('login:import', t),
    openClaudeInBrowser: () => invoke('login:browser'),
    openInApp: () => invoke('login:in-app'),
    openPage: () => invoke('login:page'),
    openHelp: () => invoke('login:help'),
    tryDesktop: () => invoke('login:desktop'),
  },
  openDashboard: (tab) => invoke('dashboard:open', tab),
  runSpike: () => invoke('spike:run'),
  getProxy: () => invoke('proxy:get'),
  testProxy: () => invoke('proxy:test'),
  testSound: (k) => invoke('sound:test', k),
  exportData: (p, w, f, per, m) => invoke('export:data', p, w, f, per, m),
  pickSoundFile: () => invoke('sound:pick'),
  widget: {
    dragStart: () => ipcRenderer.send('widget:drag-start'),
    dragMove: (dx, dy) => ipcRenderer.send('widget:drag-move', dx, dy),
    dragEnd: () => ipcRenderer.send('widget:drag-end'),
    setSize: (w, h) => ipcRenderer.send('widget:set-size', w, h),
    setExpanded: (e) => invoke('widget:set-expanded', e),
    hide: () => ipcRenderer.send('widget:hide'),
  },
  isDemo: process.argv.includes('--demo'),
};

contextBridge.exposeInMainWorld('api', api);
