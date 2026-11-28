// GolfHomie service worker: shows push notifications and handles taps on them.
// It does not cache pages, so the app is always the latest version from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: 'GolfHomie', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'GolfHomie', {
    body: m.body || '', tag: m.tag, renotify: !!m.tag, requireInteraction: !!m.requireInteraction,
    icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
    actions: (m.actions || []).slice(0, 2),
    data: { url: m.url || '/', bookingId: m.bookingId || null, signupId: m.signupId || null },
  }));
});

async function openApp(url) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) {
    if (new URL(c.url).origin === self.location.origin) { await c.focus(); c.postMessage({ go: url }); return; }
  }
  await self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (e) => {
  const n = e.notification, d = n.data || {};
  n.close();
  if ((e.action === 'in' || e.action === 'out') && d.bookingId) {
    // Answer "still in?" straight from the notification, without opening the app.
    e.waitUntil(fetch(`/api/bookings/${d.bookingId}/rsvp`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rsvp: e.action }),
    }).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return self.registration.showNotification(e.action === 'in' ? "✅ You're in" : "❌ You're out", { body: 'Your homies know.', tag: n.tag, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png' });
    }).catch(() => openApp(d.url)));
    return;
  }
  if ((e.action === 'approve' || e.action === 'decline') && d.signupId) {
    // An admin approving or declining a new sign-up right from the notification.
    e.waitUntil(fetch(`/api/admin/signups/${d.signupId}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: e.action === 'approve' }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(r.status);
      const x = await r.json();
      return self.registration.showNotification(x.approved ? `✅ ${x.name} is in` : `${x.name} was declined`, { body: x.approved ? 'They can log in now.' : 'Their account was removed.', tag: n.tag, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png' });
    }).catch(() => openApp(d.url)));
    return;
  }
  e.waitUntil(openApp(d.url || '/'));
});
