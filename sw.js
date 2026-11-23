// ACT Service Worker — Web Push only (no asset caching so GitHub Pages updates stay instant)

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_) {
      payload = { body: event.data.text() };
    }
  }

  const scopeUrl = self.registration.scope || './';
  const iconUrl = new URL('ACT%20Master%20App%20Icon.png', scopeUrl).href;

  const title = payload.title || 'ACT';
  const options = {
    body: payload.body || 'You have an update in ACT.',
    icon: payload.icon || iconUrl,
    badge: payload.badge || iconUrl,
    tag: payload.tag || 'act-receipt-alert',
    renotify: true,
    data: {
      url: payload.url || scopeUrl,
      mode: payload.mode || 'general'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const scopeUrl = self.registration.scope || './';
  const targetUrl = (event.notification.data && event.notification.data.url) || scopeUrl;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(scopeUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
