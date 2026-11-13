import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../src/state/store.js';
import { evaluateIncomingMessage, evaluateIncomingCall, parseOwnerCommand } from '../src/trigger/policy.js';

const cfg = {
  ownerPhone: '905321112233',
  ownerChatId: '905321112233@c.us',
  cooldownMinutes: 120,
  missedRetryMinutes: 30,
  ownerActiveWindowMinutes: 15,
  thirdPartyOutreachHours: 24,
};

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpj-pol-'));
  return createStateStore(path.join(dir, 'state.json'));
}

test('ignores bot-originated fromMe messages without updating lastOwnerReplyAt', () => {
  const store = makeStore();
  store.markBotMessageId('bot-msg-1');
  const res = evaluateIncomingMessage(
    { id: 'bot-msg-1', from: '905551112233@c.us', to: '905551112233@c.us', fromMe: true, body: 'Onaylı mesaj' },
    { config: cfg, store, callInProgress: false, nowMs: 1_000_000 }
  );
  assert.equal(res.action, 'ignore');
  assert.equal(store.getChatState('905551112233@c.us').lastOwnerReplyAt, undefined);
});

test('human fromMe reply suppresses calls for 15 minutes and clears missed retry', () => {
  const store = makeStore();
  store.updateChatState('905551112233@c.us', { lastCallStatus: 'missed', lastCallAt: 1000, missedRetryCount: 0 });
  const r1 = evaluateIncomingMessage(
    { id: 'h-1', from: '905551112233@c.us', to: '905551112233@c.us', fromMe: true, body: 'Merhaba' },
    { config: cfg, store, callInProgress: false, nowMs: 100_000 }
  );
  assert.equal(r1.action, 'update_owner_reply');

  const r2 = evaluateIncomingMessage(
    { id: 'c-1', from: '905551112233@c.us', fromMe: false, type: 'chat', body: 'Teşekkürler' },
    { config: cfg, store, callInProgress: false, nowMs: 100_000 + 5 * 60_000 }
  );
  assert.equal(r2.action, 'ignore');
});

test('rejected call blocks retries within cooldown; missed call allows 1 retry after 30 min', () => {
  const store = makeStore();
  const t0 = 10_000_000;
  // Rejected call -> notify_only even after 40 minutes
  store.updateChatState('905550000001@c.us', { lastCallStatus: 'rejected', lastCallAt: t0 });
  const rejRes = evaluateIncomingMessage(
    { id: 'm1', from: '905550000001@c.us', fromMe: false, type: 'chat', body: 'Orada mısınız?' },
    { config: cfg, store, callInProgress: false, nowMs: t0 + 40 * 60_000 }
  );
  assert.equal(rejRes.action, 'notify_only');

  // Missed call -> notify_only at 20 min, notify_and_call at 31 min (once), notify_only after 2nd miss
  store.updateChatState('905550000002@c.us', { lastCallStatus: 'missed', lastCallAt: t0, missedRetryCount: 0 });
  const before30 = evaluateIncomingMessage(
    { id: 'm2', from: '905550000002@c.us', fromMe: false, type: 'chat', body: 'Bakabilir misiniz?' },
    { config: cfg, store, callInProgress: false, nowMs: t0 + 20 * 60_000 }
  );
  assert.equal(before30.action, 'notify_only');

  const after30 = evaluateIncomingMessage(
    { id: 'm3', from: '905550000002@c.us', fromMe: false, type: 'chat', body: 'Acil' },
    { config: cfg, store, callInProgress: false, nowMs: t0 + 31 * 60_000 }
  );
  assert.equal(after30.action, 'notify_and_call');

  store.updateChatState('905550000002@c.us', { lastCallStatus: 'missed', lastCallAt: t0 + 31 * 60_000, missedRetryCount: 1 });
  const afterSecondMiss = evaluateIncomingMessage(
    { id: 'm4', from: '905550000002@c.us', fromMe: false, type: 'chat', body: 'Tekrar yazıyorum' },
    { config: cfg, store, callInProgress: false, nowMs: t0 + 70 * 60_000 }
  );
  assert.equal(afterSecondMiss.action, 'notify_only');
});

test('third-party outreach (e.g. supplier Eren) sends quiet summary without ringing', () => {
  const store = makeStore();
  const now = 5_000_000;
  store.updateChatState('905559998877@c.us', { thirdPartyOutreachUntil: now + 24 * 3600_000 });
  const res = evaluateIncomingMessage(
    { id: 's1', from: '905559998877@c.us', fromMe: false, type: 'chat', body: 'Tamamdır abi', senderName: 'Eren' },
    { config: cfg, store, callInProgress: false, nowMs: now + 60_000 }
  );
  assert.equal(res.action, 'notify_only');
});

test('parses owner commands and handles normalized owner phone numbers', () => {
  const store = makeStore();
  const r = evaluateIncomingMessage(
    { id: 'o1', from: '05321112233@c.us', fromMe: false, type: 'chat', body: 'ara Ahmet' },
    { config: cfg, store, callInProgress: false, nowMs: 1000 }
  );
  assert.equal(r.action, 'owner_command');
  assert.deepEqual(r.command, { type: 'call_query', query: 'Ahmet' });
  assert.deepEqual(parseOwnerCommand('sustur 45'), { type: 'silence', minutes: 45 });
  assert.deepEqual(parseOwnerCommand('ara'), { type: 'call_latest' });
});

test('parseOwnerCommand handles Turkish casing, defaults, and edge cases', () => {
  assert.deepEqual(parseOwnerCommand('ara'), { type: 'call_latest' });
  assert.deepEqual(parseOwnerCommand('ARA'), { type: 'call_latest' });
  assert.deepEqual(parseOwnerCommand('  ara  '), { type: 'call_latest' });
  assert.deepEqual(parseOwnerCommand('ara Mehmet Bey'), { type: 'call_query', query: 'Mehmet Bey' });
  assert.deepEqual(parseOwnerCommand('ARA 05551112233'), { type: 'call_query', query: '05551112233' });

  // sustur defaults to 60 when argument omitted or non-positive/invalid
  assert.deepEqual(parseOwnerCommand('sustur'), { type: 'silence', minutes: 60 });
  assert.deepEqual(parseOwnerCommand('SUSTUR'), { type: 'silence', minutes: 60 });
  assert.deepEqual(parseOwnerCommand('sustur 30'), { type: 'silence', minutes: 30 });
  assert.deepEqual(parseOwnerCommand('sustur 0'), { type: 'silence', minutes: 60 });
  assert.deepEqual(parseOwnerCommand('sustur -10'), { type: 'silence', minutes: 60 });
  assert.deepEqual(parseOwnerCommand('sustur abc'), { type: 'silence', minutes: 60 });

  assert.deepEqual(parseOwnerCommand('devam'), { type: 'resume' });
  assert.deepEqual(parseOwnerCommand('DEVAM'), { type: 'resume' });
  assert.deepEqual(parseOwnerCommand('durum'), { type: 'status' });
  assert.deepEqual(parseOwnerCommand('DURUM'), { type: 'status' });

  // Unrecognized or non-string
  assert.deepEqual(parseOwnerCommand('araba'), { type: 'none' });
  assert.deepEqual(parseOwnerCommand('susturma'), { type: 'none' });
  assert.deepEqual(parseOwnerCommand('merhaba'), { type: 'none' });
  assert.deepEqual(parseOwnerCommand(''), { type: 'none' });
  assert.deepEqual(parseOwnerCommand(null), { type: 'none' });
  assert.deepEqual(parseOwnerCommand(undefined), { type: 'none' });
  assert.deepEqual(parseOwnerCommand(123), { type: 'none' });
});

test('ignores broadcast, group, status, and newsletter channels safely', () => {
  const store = makeStore();
  const cases = [
    { id: 'g-1', from: '123456789-987654@g.us', isGroup: true, body: 'Grup mesajı' },
    { id: 'g-2', from: '123456789-987654@g.us', body: 'Grup JID' },
    { id: 'b-1', from: 'status@broadcast', isStatus: true, body: 'Durum' },
    { id: 'b-2', from: '1203630@broadcast', isBroadcast: true, body: 'Duyuru' },
    { id: 'n-1', from: '12036302838@newsletter', isNewsletter: true, body: 'Kanal güncellemesi' },
    { id: 'n-2', from: '12036302838@newsletter', body: 'Kanal JID' },
  ];

  for (const c of cases) {
    const res = evaluateIncomingMessage(c, { config: cfg, store, callInProgress: false, nowMs: 1000 });
    assert.equal(res.action, 'ignore', `Expected ignore for ${c.id}`);
    assert.equal(res.reason, 'non_individual_chat');
  }
});

test('evaluates silence and callInProgress suppression properly', () => {
  const store = makeStore();
  const now = 2_000_000;

  // Silence active via store
  store.setSilencedUntil(now + 30 * 60_000);
  const rSilenced = evaluateIncomingMessage(
    { id: 'sil-1', from: '905553334455@c.us', fromMe: false, body: 'Acil durum' },
    { config: cfg, store, callInProgress: false, nowMs: now }
  );
  assert.equal(rSilenced.action, 'notify_only');
  assert.equal(rSilenced.reason, 'silenced');

  // Silence cleared, but call in progress
  store.setSilencedUntil(null);
  const rInProg = evaluateIncomingMessage(
    { id: 'prog-1', from: '905553334455@c.us', fromMe: false, body: 'İkinci mesaj' },
    { config: cfg, store, callInProgress: true, nowMs: now }
  );
  assert.equal(rInProg.action, 'notify_only');
  assert.equal(rInProg.reason, 'call_in_progress');
});

test('answered call enforces 120-minute cooldown and allows call afterwards', () => {
  const store = makeStore();
  const t0 = 50_000_000;
  store.updateChatState('905556667788@c.us', { lastCallStatus: 'answered', lastCallAt: t0 });

  // At 60 minutes (< 120): notify_only
  const duringCooldown = evaluateIncomingMessage(
    { id: 'ans-1', from: '905556667788@c.us', fromMe: false, body: 'Yine ben' },
    { config: cfg, store, callInProgress: false, nowMs: t0 + 60 * 60_000 }
  );
  assert.equal(duringCooldown.action, 'notify_only');

  // At 121 minutes (> 120): notify_and_call
  const afterCooldown = evaluateIncomingMessage(
    { id: 'ans-2', from: '905556667788@c.us', fromMe: false, body: 'Yeni sipariş vermek istiyorum' },
    { config: cfg, store, callInProgress: false, nowMs: t0 + 121 * 60_000 }
  );
  assert.equal(afterCooldown.action, 'notify_and_call');
  assert.equal(store.getPendingCallChatId(), '905556667788@c.us');
});

test('formats media placeholders into summaryText for non-text messages', () => {
  const store = makeStore();
  const res = evaluateIncomingMessage(
    {
      id: 'img-1',
      from: '905557778899@c.us',
      fromMe: false,
      type: 'image',
      body: 'Bu ürünün stoğu var mı?'
    },
    { config: cfg, store, callInProgress: false, nowMs: 10_000 }
  );
  assert.equal(res.action, 'notify_and_call');
  assert.equal(res.summaryText, '[Fotoğraf] Bu ürünün stoğu var mı?');
});

test('executes silence and resume state changes upon owner commands', () => {
  const store = makeStore();
  const t0 = 100_000;

  // Owner sends sustur 45
  const rSilence = evaluateIncomingMessage(
    { id: 'cmd-silence', from: '905321112233@c.us', fromMe: false, body: 'sustur 45' },
    { config: cfg, store, callInProgress: false, nowMs: t0 }
  );
  assert.equal(rSilence.action, 'owner_command');
  assert.deepEqual(rSilence.command, { type: 'silence', minutes: 45 });
  assert.equal(store.isSilenced(t0 + 10_000), true);
  assert.equal(store.isSilenced(t0 + 46 * 60_000), false);

  // Owner sends devam
  const rResume = evaluateIncomingMessage(
    { id: 'cmd-resume', from: '905321112233@c.us', fromMe: false, body: 'devam' },
    { config: cfg, store, callInProgress: false, nowMs: t0 + 5_000 }
  );
  assert.equal(rResume.action, 'owner_command');
  assert.deepEqual(rResume.command, { type: 'resume' });
  assert.equal(store.isSilenced(t0 + 10_000), false);
});

test('handles fromMe human replies with fallback to chatId or from and resets pending call', () => {
  const store = makeStore();
  store.setPendingCallChatId('905558889900@c.us');

  // fromMe reply with chatId instead of to
  const r = evaluateIncomingMessage(
    { id: 'reply-1', chatId: '905558889900@c.us', fromMe: true, body: 'Geri döndüm' },
    { config: cfg, store, callInProgress: false, nowMs: 500_000 }
  );
  assert.equal(r.action, 'update_owner_reply');
  assert.equal(r.targetChatId, '905558889900@c.us');
  assert.equal(store.getChatState('905558889900@c.us').lastOwnerReplyAt, 500_000);
  assert.equal(store.getPendingCallChatId(), null);
});

test('evaluateIncomingCall accepts 1:1 incoming voice call from owner even when silenced', () => {
  const store = makeStore();
  store.setSilencedUntil(999_999_999);
  const res = evaluateIncomingCall(
    {
      id: 'call-owner-1',
      from: '05321112233@c.us',
      phone: '905321112233',
      outgoing: false,
      fromMe: false,
      isGroup: false,
      isVideo: false,
      isCallLink: false,
    },
    { config: cfg, store, callInProgress: false }
  );
  assert.equal(res.action, 'answer_owner_call');
});

test('evaluateIncomingCall rejects non-owner, unresolved @lid, group, video, outgoing, call-link, and concurrent calls', () => {
  assert.equal(
    evaluateIncomingCall(null, { config: cfg }).action,
    'ignore'
  );
  assert.equal(
    evaluateIncomingCall(
      { id: 'c1', from: '905321112233@c.us', phone: '905321112233', outgoing: true },
      { config: cfg }
    ).reason,
    'outgoing_call'
  );
  assert.equal(
    evaluateIncomingCall(
      { id: 'c2', from: '905321112233@c.us', phone: '905321112233', isGroup: true },
      { config: cfg }
    ).reason,
    'group_call'
  );
  assert.equal(
    evaluateIncomingCall(
      { id: 'c3', from: '905321112233@c.us', phone: '905321112233', isVideo: true },
      { config: cfg }
    ).reason,
    'video_call'
  );
  assert.equal(
    evaluateIncomingCall(
      { id: 'c4', from: '905321112233@c.us', phone: '905321112233', isCallLink: true },
      { config: cfg }
    ).reason,
    'call_link'
  );
  assert.equal(
    evaluateIncomingCall(
      { id: 'c5', from: '777888999@lid', phone: '', isVideo: false },
      { config: cfg }
    ).reason,
    'unresolved_lid'
  );
  assert.equal(
    evaluateIncomingCall(
      { id: 'c6', from: '905551112233@c.us', phone: '905551112233', isVideo: false },
      { config: cfg }
    ).reason,
    'not_owner'
  );
  assert.equal(
    evaluateIncomingCall(
      { id: 'c7', from: '905321112233@c.us', phone: '905321112233', isVideo: false },
      { config: cfg, callInProgress: true }
    ).reason,
    'call_in_progress'
  );
});

test('routes free-form owner incoming messages (including resolved @lid phone) to owner_chat while ignoring owner fromMe non-commands', () => {
  const store = makeStore();

  // Normal incoming message from owner -> owner_chat
  const freeForm = evaluateIncomingMessage(
    { id: 'oc-1', from: '905321112233@c.us', phone: '905321112233', fromMe: false, body: 'Bu ay kaç müşteri geldi?' },
    { config: cfg, store, callInProgress: false, nowMs: 100_000 }
  );
  assert.equal(freeForm.action, 'owner_chat');
  assert.equal(freeForm.targetChatId, '905321112233@c.us');

  // Unresolved @lid in event.from but resolved owner phone in event.phone -> owner_chat
  const lidOwner = evaluateIncomingMessage(
    { id: 'oc-2', from: '777888999@lid', phone: '905321112233', fromMe: false, body: 'Eren ne dedi?' },
    { config: cfg, store, callInProgress: false, nowMs: 101_000 }
  );
  assert.equal(lidOwner.action, 'owner_chat');

  // Fast deterministic command still stays owner_command
  const fastCmd = evaluateIncomingMessage(
    { id: 'oc-3', from: '905321112233@c.us', phone: '905321112233', fromMe: false, body: 'durum' },
    { config: cfg, store, callInProgress: false, nowMs: 102_000 }
  );
  assert.equal(fastCmd.action, 'owner_command');
  assert.equal(fastCmd.command.type, 'status');

  // Outgoing manual fromMe non-command to ownerChatId is ignored (prevents echo loop)
  const selfNonCmd = evaluateIncomingMessage(
    { id: 'oc-4', from: '905321112233@c.us', to: '905321112233@c.us', fromMe: true, body: 'Manuel not' },
    { config: cfg, store, callInProgress: false, nowMs: 103_000 }
  );
  assert.equal(selfNonCmd.action, 'ignore');
});

test('tracks customer metadata and enforces lastTextReplyAt cooldown and aiVoiceProvider=none', () => {
  const store = makeStore();
  const custChat = '905559990001@c.us';
  const t0 = 5_000_000;

  // Text reply was recently approved & sent to customer
  store.updateChatState(custChat, { lastTextReplyAt: t0 });

  const duringTextCooldown = evaluateIncomingMessage(
    { id: 'tr-1', from: custChat, fromMe: false, body: 'Teşekkürler, yarın kaçta?' },
    { config: cfg, store, callInProgress: false, nowMs: t0 + 10 * 60_000 }
  );
  assert.equal(duringTextCooldown.action, 'notify_only');
  assert.equal(duringTextCooldown.reason, 'recent_text_reply_cooldown');

  const meta1 = store.getChatState(custChat);
  assert.equal(meta1.firstSeenAt, t0 + 10 * 60_000);
  assert.equal(meta1.lastCustomerMessageAt, t0 + 10 * 60_000);
  assert.equal(meta1.customerMessageCount, 1);

  // When voice AI is disabled (provider=none), customer message notifies owner instead of calling
  const noVoiceCfg = { ...cfg, aiVoice: { provider: 'none' } };
  const cust2 = '905559990002@c.us';
  const resNoVoice = evaluateIncomingMessage(
    { id: 'nv-1', from: cust2, fromMe: false, body: 'Fiyat alabilir miyim?' },
    { config: noVoiceCfg, store, callInProgress: false, nowMs: t0 + 20 * 60_000 }
  );
  assert.equal(resNoVoice.action, 'notify_only');
  assert.equal(resNoVoice.reason, 'voice_disabled');
  assert.equal(store.getPendingCallChatId(), null);
  assert.equal(store.getChatState(cust2).customerMessageCount, 1);

  const callNoVoice = evaluateIncomingCall(
    { id: 'c-nv', from: '905321112233@c.us', phone: '905321112233', isVideo: false },
    { config: noVoiceCfg }
  );
  assert.equal(callNoVoice.action, 'ignore');
  assert.equal(callNoVoice.reason, 'voice_disabled');
});
