const CACHE_NAME = 'chouseikun-v5';

// ── FCM（プッシュ通知）バックグラウンド受信 ──
importScripts('https://www.gstatic.com/firebasejs/11.8.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.8.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDkczQ9y3u3XaPgWtwBkXm0wwt3bsOGsZ4",
  authDomain: "nomikai-42968.firebaseapp.com",
  projectId: "nomikai-42968",
  storageBucket: "nomikai-42968.firebasestorage.app",
  messagingSenderId: "372499119823",
  appId: "1:372499119823:web:bcf75f587b6ef9ef8cc1ba"
});

try {
  const messaging = firebase.messaging();
  // data-only メッセージを受け取り、自前で通知を表示
  messaging.onBackgroundMessage(payload => {
    const d = payload.data || {};
    const title = d.title || '調整くん';
    self.registration.showNotification(title, {
      body: d.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: d.url || './' },
      tag: d.tag || 'chouseikun-notify'
    });
  });
} catch (e) { /* messaging非対応環境 */ }

// 通知クリックで該当URLを開く
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.openWindow(url));
});

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
});

// ネットワーク優先（Firebase等の動的データはキャッシュしない）
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
