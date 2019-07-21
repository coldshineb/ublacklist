import dayjs, { Dayjs } from 'dayjs';
import {
  ISOString, Result, errorResult, successResult, SubscriptionId, Subscription, Options, getOptions, setOptions,
  sendMessage, addMessageListener,
  BackgroundPage,
} from './common';

const backgroundPage = window as BackgroundPage;

// #region Mutex

class Mutex {
  private queue: (() => Promise<void>)[] = [];

  lock<T>(func: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await Promise.resolve(func()));
        } catch (e) {
          reject(e);
        }
      });
      if (this.queue.length === 1) {
        this.dequeue();
      }
    });
  }

  private async dequeue(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    await this.queue[0]();
    this.queue.shift();
    this.dequeue();
  }
}

// #endregion Mutex

// #region Blacklist

const blacklistMutex = new Mutex();

backgroundPage.setBlacklist = async function (blacklist: string): Promise<void> {
  await blacklistMutex.lock(async () => {
    await setOptions({
      blacklist,
      timestamp: dayjs().toISOString(),
    });
  });
  // Request sync, but don't await it.
  backgroundPage.syncBlacklist();
};

backgroundPage.setSync = async function (sync: boolean): Promise<void> {
  await setOptions({ sync });
  backgroundPage.syncBlacklist();
};

interface RequestArgs {
  method: 'GET' | 'PATCH' | 'POST';
  path: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: string | object;
}

// #if BROWSER === 'chrome'
declare global {
  interface ErrorConstructor {
    captureStackTrace(targetObj: object, constructorOpt?: Function): void;
  }
}
// #endif

class RequestError extends Error {
  constructor(public code: number, message: string) {
    super(message);
// #if BROWSER === 'chrome'
    Error.captureStackTrace(this, RequestError);
// #endif
  }
}

class Client {
  constructor(private token: string) {
  }

  async request(args: RequestArgs, downloadType: 'text'): Promise<string>;
  async request(args: RequestArgs): Promise<any>;
  async request(args: RequestArgs, downloadType?: string): Promise<any> {
    const input = new URL('https://www.googleapis.com/');
    input.pathname = args.path;
    if (args.params) {
      input.search = new URLSearchParams(args.params).toString();
    }
    const init: RequestInit & { headers: Record<string, string> } = {
      method: args.method,
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    };
    if (args.body != null) {
      if (typeof args.body === 'string') {
        init.headers['Content-Type'] = 'text/plain';
        init.body = args.body;
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(args.body);
      }
    }
    const response = await fetch(input.toString(), init);
    if (!response.ok) {
      const { error: { code, message } } =
        await response.json() as { error: { code: number, message: string } };
      throw new RequestError(code, message);
    }
    if (downloadType === 'text') {
      return await response.text();
    } else {
      return await response.json();
    }
  }
}

interface File {
  id: string;
  modifiedTime: ISOString;
}

async function findFile(client: Client, filename: string): Promise<File | null> {
  const { files } = await client.request({
    method: 'GET',
    path: '/drive/v3/files',
    params: {
      corpora: 'user',
      q: `name = '${filename}' and 'root' in parents and trashed = false`,
      spaces: 'drive',
      fields: 'files(id, modifiedTime)',
    },
  }) as { files: File[] };
  return files.length ? files[0] : null;
}

async function downloadFile(client: Client, file: File): Promise<string> {
  return await client.request({
    method: 'GET',
    path: `/drive/v3/files/${file.id}`,
    params: {
      alt: 'media',
    },
  }, 'text');
}

async function uploadFile(client: Client, file: File, localBlacklist: string, localTimestamp: ISOString): Promise<void> {
  await client.request({
    method: 'PATCH',
    path: `/upload/drive/v3/files/${file.id}`,
    params: {
      uploadType: 'media',
    },
    body: localBlacklist,
  });
  await client.request({
    method: 'PATCH',
    path: `/drive/v3/files/${file.id}`,
    body: {
      modifiedTime: localTimestamp,
    },
  });
}

async function createFile(client: Client, filename: string): Promise<File> {
  return await client.request({
    method: 'POST',
    path: '/drive/v3/files',
    body: {
      name: filename,
    },
  }) as File;
}

let syncRunning: boolean = false;

backgroundPage.syncBlacklist = async function (): Promise<void> {
  if (syncRunning) {
    return;
  }
  syncRunning = true;
  try {
    await blacklistMutex.lock(async () => {
      const {
        blacklist: localBlacklist, 
        timestamp: localTimestamp, 
        sync, 
        syncFilename: filename
      } = await getOptions('blacklist', 'timestamp', 'sync', 'syncFilename');
      if (!sync) {
        return;
      }
      sendMessage('syncStart', {});
      try {
        const options: Partial<Options> = {};
        try {
          const token = await backgroundPage.getAuthToken(false);
          try {
            const client = new Client(token);
            const file = await findFile(client, filename);
            if (file) {
              const cloudTimestamp = file.modifiedTime;
              const timestampDiff = dayjs(localTimestamp).diff(cloudTimestamp, 'millisecond');
              if (timestampDiff < 0) {
                const cloudBlacklist = await downloadFile(client, file);
                options.blacklist = cloudBlacklist;
                options.timestamp = cloudTimestamp;
              } else if (timestampDiff > 0) {
                await uploadFile(client, file, localBlacklist, localTimestamp);
              }
            } else {
              const newFile = await createFile(client, filename);
              await uploadFile(client, newFile, localBlacklist, localTimestamp);
            }
            options.syncResult = successResult();
          } catch (e) {
            if (e instanceof RequestError && e.code === 401) {
              await backgroundPage.removeCachedAuthToken(token);
            }
            throw e;
          }
        } catch (e) {
          options.syncResult = errorResult(e.message);
        }
        setOptions(options);
        sendMessage('syncEnd', { result: options.syncResult });
      } catch (e) {
        sendMessage('syncEnd', { result: errorResult(e.message) });
        throw e;
      }
    });
  } finally {
    syncRunning = false;
  }
};

// #endregion Blacklist

// #region Subscriptions

const subscriptionsMutex = new Mutex();

backgroundPage.addSubscription = async function (subscription: Subscription): Promise<SubscriptionId> {
  return await subscriptionsMutex.lock(async () => {
    const {
      subscriptions,
      nextSubscriptionId: id
    } = await getOptions('subscriptions', 'nextSubscriptionId');
    subscriptions[id] = subscription;
    await setOptions({
      subscriptions,
      nextSubscriptionId: id + 1,
    });
    return id;
  });
};

backgroundPage.removeSubscription = async function (id: SubscriptionId): Promise<void> {
  await subscriptionsMutex.lock(async () => {
    const { subscriptions } = await getOptions('subscriptions');
    delete subscriptions[id];
    await setOptions({ subscriptions });
  });
};

const updateRunning = new Set<SubscriptionId>();

backgroundPage.updateSubscription = async function (id: SubscriptionId): Promise<void> {
  if (updateRunning.has(id)) {
    return;
  }
  updateRunning.add(id);
  try {
    // Use optimistic lock for 'subscriptions'.
    // Don't lock now.
    const { subscriptions: { [id]: subscription } } = await getOptions('subscriptions');
    if (!subscription) {
      return;
    }
    sendMessage('updateStart', { id });
    try {
      try {
        const response = await fetch(subscription.url);
        if (response.ok) {
          subscription.blacklist = await response.text();
          subscription.updateResult = successResult();
        } else {
          subscription.updateResult = errorResult(response.statusText);
        }
      } catch (e) {
        subscription.updateResult = errorResult(e.message);
      }
      // Lock now.
      await subscriptionsMutex.lock(async () => {
        const { subscriptions } = await getOptions('subscriptions');
        // 'subscriptions[id]' may be already removed.
        if (subscriptions[id]) {
          subscriptions[id] = subscription;
          await setOptions({ subscriptions });
        }
      });
      sendMessage('updateEnd', { id, result: subscription.updateResult });
    } catch (e) {
      sendMessage('updateEnd', { id, result: errorResult(e.message) });
      throw e;
    }
  } finally {
    updateRunning.delete(id);
  }
};

backgroundPage.updateAllSubscriptions = async function (): Promise<void> {
  // Don't lock now.
  const { subscriptions } = await getOptions('subscriptions');
  const promises = Object.keys(subscriptions).map(id => backgroundPage.updateSubscription(Number(id)));
  await Promise.all(promises);
};

// #endregion Subscriptions

// #region Auth
 
// #if BROWSER === 'chrome'
// For Chrome, simply use chrome.identity.getAuthToken.
backgroundPage.getAuthToken = function (interactive: boolean): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

backgroundPage.removeCachedAuthToken = function (token: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}
// #else
// For Firefox, use browser.identity.launchWebAuthFlow instead.
// See https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity/launchWebAuthFlow
const clientId = '304167046827-a53p7d9jopn9nvbo7e183t966rfcp9d1.apps.googleusercontent.com';
const scope = 'https://www.googleapis.com/auth/drive.file';

interface AuthCache {
  token: string;
  expirationDate: Dayjs;
}

let authCache: AuthCache | null = null;
const authCacheMutex = new Mutex();

backgroundPage.getAuthToken = async function (interactive: boolean): Promise<string> {
  return await authCacheMutex.lock(async () => {
    if (authCache && dayjs().isBefore(authCache.expirationDate)) {
      return authCache.token;
    }
    const authURL = 'https://accounts.google.com/o/oauth2/auth'
      + `?client_id=${clientId}`
      + '&response_type=token'
      + `&redirect_uri=${encodeURIComponent(browser.identity.getRedirectURL())}`
      + `&scope=${encodeURIComponent(scope)}`;
    const redirectURL = await browser.identity.launchWebAuthFlow({
      url: authURL,
      interactive,
    });
    const params = new URLSearchParams(new URL(redirectURL).hash.slice(1));
    if (params.has('error')) {
      throw new Error(params.get('error')!);
    }
    authCache = {
      token: params.get('access_token')!,
      expirationDate: dayjs().add(Number(params.get('expires_in')!), 'second'),
    };
    return authCache.token;
  });
};

backgroundPage.removeCachedAuthToken = async function (token: string): Promise<void> {
  if (authCache && token === authCache.token) {
    authCache = null;
  }
}
// #endif

// #endregion Auth

async function main(): Promise<void> {
  addMessageListener('setBlacklist', args => {
    backgroundPage.setBlacklist(args.blacklist);
  });

  const { syncInterval, updateInterval } = await getOptions('syncInterval', 'updateInterval');

  backgroundPage.syncBlacklist();
  setInterval(() => {
    backgroundPage.syncBlacklist()
  }, syncInterval * 60 * 1000);

  backgroundPage.updateAllSubscriptions();
  setInterval(() => {
    backgroundPage.updateAllSubscriptions();
  }, updateInterval * 60 * 1000);
}

main();
